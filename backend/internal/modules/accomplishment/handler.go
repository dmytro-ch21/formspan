package accomplishment

import (
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler {
	return &Handler{repo: repo}
}

// List returns the caller's BJJ accomplishments, earliest first.
//
// Read-only, and there is deliberately no write verb of any kind — not even an
// admin one. An accomplishment that could be granted is not evidence of
// anything, and the moment one can be set by hand every other one becomes a
// claim rather than a fact.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	// `tz` decides which calendar day a session-derived award falls on. It
	// defaults to UTC rather than being required, because the competition half
	// does not need it at all — those dates are already calendar dates — so a
	// caller that only wants those should not have to send one.
	tz := r.URL.Query().Get("tz")
	if tz == "" {
		tz = "UTC"
	}
	// Validated against Go's embedded tzdata, while the query resolves it
	// against POSTGRES's zone database — two authorities that can disagree
	// across tzdata releases. A name known to one and not the other passes here
	// and then fails in the query, surfacing as a generic 500 rather than a
	// 400. Rare, and it degrades safely; recorded so a future "why did tz=X
	// return 500" has an answer.
	if _, ok := ParseZone(tz); !ok {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"tz must be an IANA timezone name, e.g. Europe/Berlin")
		return
	}

	list, err := h.repo.List(r.Context(), claims.UserID, tz)
	if err != nil {
		// Every error here is ours: there is no user input beyond a validated
		// timezone, so nothing a caller sent can produce a domain error. The
		// raw error is never written out.
		apihttp.WriteInternal(w, r, "accomplishment", err)
		return
	}

	// A named envelope, matching `friend` and `curriculum`, so that the
	// "everything still unearned" list a client might want beside this can be
	// added later without that being a breaking change.
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"accomplishments": list})
}
