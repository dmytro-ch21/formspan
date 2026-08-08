package feed

import (
	"net/http"
	"strconv"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct{ repo Repository }

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

// List serves GET /v1/feed.
//
// One route, one verb. There is no `GET /v1/feed/{id}` and there must not be:
// the feed row IS the whole of what a friend may see, so an endpoint that took
// a session id from somebody who does not own it would be a second, wider
// access path to exactly the data this module exists to keep narrow.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	q := r.URL.Query()

	limit, ok := parsePositive(q.Get("limit"))
	if !ok {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"limit must be a positive integer")
		return
	}
	limit, ok = ClampLimit(limit)
	if !ok {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"limit must be a positive integer")
		return
	}
	offset, ok := parsePositive(q.Get("offset"))
	if !ok {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"offset must be zero or a positive integer")
		return
	}

	page, err := h.repo.List(r.Context(), claims.UserID, limit, offset)
	if err != nil {
		apihttp.WriteInternal(w, r, "feed", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, page)
}

// parsePositive reads an optional non-negative integer parameter. Absent is
// zero and valid; anything unparseable or negative is a client bug and says so
// rather than being clamped, which would hide it.
func parsePositive(raw string) (int, bool) {
	if raw == "" {
		return 0, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}
