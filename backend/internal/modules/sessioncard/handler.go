package sessioncard

import (
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct{ repo Repository }

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	card, err := h.repo.Card(r.Context(), claims.UserID, r.PathValue("sessionID"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			// One answer for absent, not-yours and still-running alike.
			apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound,
				"no finished session of yours with that id")
			return
		}
		apihttp.WriteInternal(w, r, "sessioncard", err)
		return
	}
	if card.Detail == nil {
		// `[]` rather than `null`, guaranteed at the handler for the reason the
		// share module documents: the contract says array, and a nil slice
		// makes every client special-case it.
		card.Detail = []Detail{}
	}
	apihttp.WriteJSON(w, http.StatusOK, card)
}
