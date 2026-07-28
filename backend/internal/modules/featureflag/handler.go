package featureflag

import (
	"net/http"

	"github.com/dmytro-ch21/formspan/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/formspan/backend/internal/platform/httplog"
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
		httplog.FromContext(r.Context()).Error("featureflag: internal error", "err", err)
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "internal error")
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"flags": flags})
}
