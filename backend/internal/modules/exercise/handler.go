package exercise

import (
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler {
	return &Handler{repo: repo}
}

// List returns the catalog, optionally filtered by ?sport= and ?q=.
// Authenticated but not user-scoped — the catalog is the same for everyone.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	exercises, err := h.repo.List(r.Context(), Filter{
		Sport: r.URL.Query().Get("sport"),
		Query: r.URL.Query().Get("q"),
	})
	if err != nil {
		httplog.FromContext(r.Context()).Error("exercise: internal error", "err", err)
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "internal error")
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"exercises": exercises})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	e, err := h.repo.Get(r.Context(), r.PathValue("exerciseID"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "exercise not found")
			return
		}
		httplog.FromContext(r.Context()).Error("exercise: internal error", "err", err)
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "internal error")
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, e)
}
