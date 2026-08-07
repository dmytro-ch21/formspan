package theme

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct{ repo Repository }

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

// reason pulls the human half out of a wrapped ErrInvalidInput.
func reason(err error) string {
	const marker = "theme: invalid input: "
	if i := strings.LastIndex(err.Error(), marker); i >= 0 {
		return err.Error()[i+len(marker):]
	}
	return "invalid input"
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "theme not found")
	case errors.Is(err, ErrInvalidInput):
		// Cut at the marker rather than trimming a prefix. The repository wraps
		// with its own context first — "theme: set: theme: invalid input: …" —
		// so the string does not START with the sentinel, and a TrimPrefix
		// returned the whole chain to the client. Every component is a fixed
		// string so nothing leaked, but the caller got constraint plumbing
		// instead of the sentence this module promises them.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, reason(err))
	default:
		apihttp.WriteInternal(w, r, "theme", err)
	}
}

// List returns the caller's themes for the weeks in [from, to].
//
// Both bounds required. An unbounded list would grow forever and every caller
// wants a window anyway — the week view wants one week, the review surface wants
// the range it is drawing.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	q := r.URL.Query()
	from, to := q.Get("from"), q.Get("to")
	if !ValidDay(from) || !ValidDay(to) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"from and to are required, as YYYY-MM-DD")
		return
	}
	if to < from {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"to must not be before from")
		return
	}

	themes, err := h.repo.List(r.Context(), claims.UserID, from, to)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"themes": themes})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	week := r.PathValue("weekStart")
	if !ValidDay(week) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"week must be YYYY-MM-DD")
		return
	}
	t, err := h.repo.Get(r.Context(), claims.UserID, week)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, t)
}

type setRequest struct {
	Title string `json:"title"`
	Notes string `json:"notes"`
}

// Set writes the theme for one week. PUT, because a week holds at most one and
// the caller names it — there is nothing to allocate and no id to return.
func (h *Handler) Set(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	week := r.PathValue("weekStart")
	if !ValidDay(week) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"week must be YYYY-MM-DD")
		return
	}
	// Checked here as well as by the CHECK, for the message rather than the
	// safety: a week that does not start on a Monday would silently overlap its
	// neighbours, and the caller should be told that in those words.
	if !IsMonday(week) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"a week must start on a Monday")
		return
	}

	// Capped like every other write in this codebase except `profile`, which
	// predates the practice. The worst legal payload is 580 runes — under 2.5 KB
	// even at four bytes each — so 8 KB is headroom rather than a limit anyone
	// meets.
	var req setRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	title, ok := CleanTitle(req.Title)
	if title == "" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "title is required")
		return
	}
	if !ok {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "title is too long")
		return
	}
	if !ValidNotes(req.Notes) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "notes are too long")
		return
	}

	t, err := h.repo.Set(r.Context(), claims.UserID, week, Input{Title: title, Notes: req.Notes})
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, t)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	week := r.PathValue("weekStart")
	if !ValidDay(week) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"week must be YYYY-MM-DD")
		return
	}
	if err := h.repo.Delete(r.Context(), claims.UserID, week); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
