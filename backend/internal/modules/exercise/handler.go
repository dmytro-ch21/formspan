package exercise

import (
	"errors"
	"net/http"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

type Handler struct {
	repo Repository
	// mediaBaseURL is the public origin media is served from — an R2 custom
	// domain in production, or the r2.dev development URL. Kept out of the
	// database on purpose: storing absolute URLs on each row would pin the
	// bucket and CDN hostname into the data, so moving either would become a
	// migration instead of an env-var change.
	//
	// Empty is a supported state, not a misconfiguration: local dev and CI
	// have no bucket. Media then reports no URL rather than a broken one.
	mediaBaseURL string
}

func NewHandler(repo Repository, mediaBaseURL string) *Handler {
	return &Handler{repo: repo, mediaBaseURL: strings.TrimRight(mediaBaseURL, "/")}
}

// withMediaURLs fills in each asset's public URL from its storage key.
func (h *Handler) withMediaURLs(exercises []Exercise) {
	if h.mediaBaseURL == "" {
		return
	}
	for i := range exercises {
		for j := range exercises[i].Media {
			m := &exercises[i].Media[j]
			m.URL = h.mediaBaseURL + "/" + strings.TrimLeft(m.StorageKey, "/")
		}
	}
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
	h.withMediaURLs(exercises)
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
	one := []Exercise{*e}
	h.withMediaURLs(one)
	apihttp.WriteJSON(w, http.StatusOK, one[0])
}
