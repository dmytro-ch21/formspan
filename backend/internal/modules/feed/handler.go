package feed

import (
	"net/http"
	"strconv"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
	"github.com/dmytro-ch21/vola/backend/internal/platform/objectstore"
)

// avatarReadTTL matches profile.avatarReadTTL and friend.avatarReadTTL
// exactly — short, because a presigned GET is a bearer credential for the
// object, minted fresh on every response and rendered immediately.
const avatarReadTTL = 15 * time.Minute

type Handler struct {
	repo Repository
	// store is nil when object storage is not configured — a supported state
	// (local dev, CI), same as profile.Handler and friend.Handler. present
	// then mints no URLs at all, and every row just carries the monogram
	// fallback every client already has.
	store *objectstore.Store
}

func NewHandler(repo Repository, store *objectstore.Store) *Handler {
	return &Handler{repo: repo, store: store}
}

// present mints presigned AvatarURLs for a page of items in place, mirroring
// profile.Handler.presentPublic and friend.Handler.present: a presign failure
// is logged and the row's AvatarURL is simply left empty, never turned into a
// request failure — a feed page should not 500 over one signature.
//
// **Logs at most once, not once per row** — see friend.Handler.present's
// identical comment. `PresignGet` only fails on a config-class problem, which
// cannot resolve between one item and the next in the same page, so a page of
// up to `MaxLimit`/100 rows with a broken store would otherwise warn 100
// times for one cause. Every item from the first failure on is left with its
// zero-value AvatarURL, same as if `h.store` were nil.
func (h *Handler) present(r *http.Request, items []Item) {
	if h.store == nil {
		return
	}
	for i := range items {
		if items[i].AvatarKey == nil {
			continue
		}
		url, err := h.store.PresignGet(*items[i].AvatarKey, avatarReadTTL, time.Now())
		if err != nil {
			httplog.FromContext(r.Context()).Warn("feed: could not presign avatar", "err", err)
			return
		}
		items[i].AvatarURL = url
	}
}

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
	h.present(r, page.Items)
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
