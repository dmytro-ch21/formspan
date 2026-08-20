package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type fakeReleaser struct {
	calls []string // "userID/curriculumID", in order
	err   error
}

func (f *fakeReleaser) ReleaseFocusSource(_ context.Context, userID, curriculumID string) error {
	f.calls = append(f.calls, userID+"/"+curriculumID)
	return f.err
}

// withClaims mounts the handler behind a stand-in for RequireAuth, which is what
// puts the caller's id in the context on the real route.
func withClaims(userID string, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: userID})
		h.ServeHTTP(w, r.WithContext(ctx))
	})
}

func archiveRequest(t *testing.T, h http.Handler) *httptest.ResponseRecorder {
	t.Helper()
	// Through a mux, so PathValue("curriculumID") is populated the way it is in
	// main.go. Calling the handler directly would leave it empty and the test
	// would assert against a curriculum id of "".
	mux := http.NewServeMux()
	mux.Handle("DELETE /v1/curricula/{curriculumID}/enrollment", h)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete,
		"/v1/curricula/blue-belt/enrollment", nil))
	return rec
}

func TestLeavingARoadmapReleasesItsFocusClaimBeforeArchiving(t *testing.T) {
	// The ORDER is the property, not just the fact that both happen.
	//
	// Archive returns ErrNotFound once the enrolment is already archived, so
	// archive-then-release is not retry-safe: a release that failed once could
	// never be replayed, because the retry would 404 at the first step and the
	// athlete's roadmap techniques would stay in the wizard permanently.
	var order []string
	releaser := &fakeReleaser{}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		order = append(order, "archive")
		w.WriteHeader(http.StatusNoContent)
	})
	h := withClaims("user_123", releaseRoadmapFocus(
		&recordingReleaser{inner: releaser, order: &order}, next))

	rec := archiveRequest(t, h)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if len(order) != 2 || order[0] != "release" || order[1] != "archive" {
		t.Fatalf("sequence = %v, want [release archive]", order)
	}
	if len(releaser.calls) != 1 || releaser.calls[0] != "user_123/blue-belt" {
		t.Fatalf("release called with %v, want [user_123/blue-belt]", releaser.calls)
	}
}

func TestAFailedFocusReleaseDoesNotArchiveTheEnrollment(t *testing.T) {
	// Nothing changed, so say so and let the client retry. Archiving anyway
	// would leave an athlete un-enrolled from a roadmap whose techniques are
	// still in their focus list, with no future call able to reach them — which
	// is the reported bug, made permanent by the fix for it.
	archived := false
	h := withClaims("user_123", releaseRoadmapFocus(
		&fakeReleaser{err: errors.New("database is down")},
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			archived = true
			w.WriteHeader(http.StatusNoContent)
		})))

	rec := archiveRequest(t, h)

	if archived {
		t.Error("the enrolment was archived even though its focus rows could not be released")
	}
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
}

func TestLeavingARoadmapRefusesWithoutAnAuthenticatedCaller(t *testing.T) {
	// A guard whose outcome should be unreachable — the route is always mounted
	// inside RequireAuth — and it still needs a test, because a surviving
	// mutation would read as dead code and "the tests pass without it" is a
	// persuasive argument for deleting something load-bearing. What it protects
	// against is releasing rows for the empty user id, which is a cross-user
	// delete the moment the empty string names anybody.
	releaser := &fakeReleaser{}
	archived := false
	// No withClaims wrapper: this is the un-authenticated case.
	rec := archiveRequest(t, releaseRoadmapFocus(releaser,
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			archived = true
			w.WriteHeader(http.StatusNoContent)
		})))

	if len(releaser.calls) != 0 {
		t.Errorf("focus rows were released for an unauthenticated caller: %v", releaser.calls)
	}
	if archived {
		t.Error("the enrolment was archived for an unauthenticated caller")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

// recordingReleaser notes when the release happened relative to the archive.
type recordingReleaser struct {
	inner *fakeReleaser
	order *[]string
}

func (r *recordingReleaser) ReleaseFocusSource(ctx context.Context, userID, curriculumID string) error {
	*r.order = append(*r.order, "release")
	return r.inner.ReleaseFocusSource(ctx, userID, curriculumID)
}
