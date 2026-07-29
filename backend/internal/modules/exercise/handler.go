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

// maxQueryLen bounds the ?q= search term. No exercise name comes close, so
// anything longer is a mistake or an attempt to make the database work hard
// for nothing — cheaper to reject than to pattern-match against.
const maxQueryLen = 100

// List returns the catalog, optionally filtered by ?sport= and ?q=.
// Authenticated but not user-scoped — the catalog is the same for everyone.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	if len(query) > maxQueryLen {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "q is too long")
		return
	}

	exercises, err := h.repo.List(r.Context(), Filter{
		Sport: r.URL.Query().Get("sport"),
		Query: query,
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
