package featureflag

import (
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler {
	return &Handler{repo: repo}
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	flags, err := h.repo.List(r.Context())
	if err != nil {
		apihttp.WriteInternal(w, r, "featureflag", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"flags": flags})
}
