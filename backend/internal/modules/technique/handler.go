package technique

import (
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
)

type Handler struct{ repo Repository }

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

// maxQueryLen bounds ?q= — no technique name comes close, so anything longer
// is a mistake or an attempt to make the database work for nothing.
const maxQueryLen = 100

// List returns the library, optionally filtered by ?position=, ?category=,
// ?gi= and ?q=. Authenticated but not user-scoped: reference content is the
// same for everyone.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if len(q.Get("q")) > maxQueryLen {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "q is too long")
		return
	}
	if gi := q.Get("gi"); gi != "" && gi != "Gi Only" && gi != "No-Gi Only" && gi != "Both" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			`gi must be one of: "Gi Only", "No-Gi Only", "Both"`)
		return
	}

	techniques, err := h.repo.List(r.Context(), Filter{
		Position: q.Get("position"),
		Category: q.Get("category"),
		GiNoGi:   q.Get("gi"),
		Query:    q.Get("q"),
	})
	if err != nil {
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"techniques": techniques})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	t, err := h.repo.Get(r.Context(), r.PathValue("techniqueID"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "technique not found")
			return
		}
		apihttp.WriteInternal(w, r, "technique", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, t)
}
