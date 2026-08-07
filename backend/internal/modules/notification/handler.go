package notification

import (
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

func (h *Handler) Pending(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	counts, err := h.repo.Pending(r.Context(), claims.UserID)
	if err != nil {
		// No domain errors here — every failure is a counter failing, which is
		// a 500. There is deliberately nothing a caller can do wrong: the
		// request has no input beyond who they are.
		apihttp.WriteInternal(w, r, "notification", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, pendingPayload(counts))
}

// pendingPayload shapes the response, and guarantees every registered key is
// present even at zero.
//
// A MISSING KEY AND A ZERO ARE DIFFERENT THINGS to a client: `counts.shares ??
// something` reads an absent key as "unknown" and a present zero as "nothing
// waiting", and a badge component that treats them alike will render for one
// and not the other. Since the registry decides the key set at boot, the
// response always carries all of them — a client never has to guess whether a
// key is missing because nothing is waiting or because this build has no such
// source. Extracted as a function for the reason share's is: auth's context
// key is unexported, so a handler test cannot get past the first line.
func pendingPayload(counts map[string]int) map[string]any {
	if counts == nil {
		counts = map[string]int{}
	}
	return map[string]any{"pending": counts}
}
