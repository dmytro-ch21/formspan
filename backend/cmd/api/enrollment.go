package main

import (
	"context"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// focusSourceReleaser is the half of bjj.FocusRepository this file needs.
//
// Narrowed to one method on purpose: this is the only place in the codebase
// that knows un-enrolling from a roadmap has anything to do with the focus list,
// and it should be able to say so without being handed the whole repository.
type focusSourceReleaser interface {
	ReleaseFocusSource(ctx context.Context, userID, curriculumID string) error
}

// releaseRoadmapFocus wraps DELETE /v1/curricula/{id}/enrollment so that leaving
// a roadmap also withdraws its claim on the athlete's focus list.
//
// WHY THIS LIVES IN THE COMPOSITION ROOT AND NOT IN EITHER MODULE.
//
// Enrolment writes focus THROUGH THE CLIENT: roadmapFocus.ts computes a list and
// PUTs it, because only the client can decide what to propose and show the
// athlete what it would evict. Un-enrolment goes THROUGH THE SERVER: it is one
// DELETE. The cleanup belonged to neither, which is why it was never written,
// and the athlete's roadmap techniques stayed in the reflection wizard after
// they switched the roadmap off.
//
// It cannot go in `curriculum`. That package's doc comment reserves the right to
// never read or write bjj_focus, so that following a syllabus cannot silently
// become being prescribed one, and that separation is worth keeping — it is the
// reason the two halves of this loop are legible at all. It should not go back
// in the client either: `apps/web` has the same un-enrolment button, a client
// that crashes between two calls restores the bug, and every future client would
// have to be told. So it goes where cross-module policy belongs — the one place
// that is already allowed to know about both.
//
// ORDER: release FIRST, then archive, and the composite is idempotent because of
// it. If the archive fails, a retry replays both: releasing is a no-op the second
// time, and only rows a curriculum itself placed are ever reachable, so releasing
// for a curriculum the athlete is not enrolled in cannot touch anything. The
// reverse order is NOT idempotent — Archive returns ErrNotFound once the
// enrolment is already archived, so a retry would 404 before ever reaching the
// release and the focus rows would be stranded permanently.
//
// A failed release therefore returns 500 and does not archive, which is the
// honest report: nothing changed, try again.
func releaseRoadmapFocus(releaser focusSourceReleaser, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set by RequireAuth, which this is always mounted inside. A missing
		// claim would mean an unauthenticated caller reached a route that cannot
		// be reached unauthenticated, so it is a wiring bug rather than an input
		// one — refuse rather than release rows for the empty user id, which
		// would be a cross-user delete if the empty string ever named anybody.
		claims, ok := auth.ClaimsFromContext(r.Context())
		if !ok || claims.UserID == "" {
			apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized,
				"authentication required")
			return
		}
		curriculumID := r.PathValue("curriculumID")
		if err := releaser.ReleaseFocusSource(r.Context(), claims.UserID, curriculumID); err != nil {
			apihttp.WriteInternal(w, r, "bjj", err)
			return
		}
		next.ServeHTTP(w, r)
	})
}
