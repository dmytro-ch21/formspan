package friend

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
	"github.com/dmytro-ch21/vola/backend/internal/platform/objectstore"
)

// avatarReadTTL matches profile.avatarReadTTL exactly — short, because a
// presigned GET is a bearer credential for the object, minted fresh on every
// response and rendered immediately, so nothing here benefits from a longer
// life either.
const avatarReadTTL = 15 * time.Minute

type Handler struct {
	repo Repository
	// store is nil when object storage is not configured — a supported state
	// (local dev, CI), same as profile.Handler. present then mints no URLs at
	// all, and every card just carries the monogram fallback every client
	// already has.
	store *objectstore.Store
}

func NewHandler(repo Repository, store *objectstore.Store) *Handler {
	return &Handler{repo: repo, store: store}
}

// present mints presigned AvatarURLs for a batch of cards in place, mirroring
// profile.Handler.presentPublic's failure mode: a presign failure is logged
// and the card's AvatarURL is simply left empty — never turned into a
// request failure, because a friends list or feed page should not 500 over
// one signature.
//
// **Logs at most ONCE per CALL, unlike presentPublic** (which only ever
// presigns a single row, so the question does not arise there — `Pending`
// calls this twice, once per direction, so a request can still log twice).
// `PresignGet` only fails on a config-class problem — a malformed endpoint, a
// bad region — which cannot resolve between one card and the next inside the
// same call, so a naive per-row `continue` would warn identically up to
// `maxBadgeCount`/500 times for one broken deploy. Bailing out on the first
// failure is the same information at a sane volume, and every card after the
// first-failing one is left with its zero-value AvatarURL, same as if
// `h.store` were nil.
func (h *Handler) present(r *http.Request, cards []Card) {
	if h.store == nil {
		return
	}
	for i := range cards {
		if cards[i].AvatarKey == nil {
			continue
		}
		url, err := h.store.PresignGet(*cards[i].AvatarKey, avatarReadTTL, time.Now())
		if err != nil {
			httplog.FromContext(r.Context()).Warn("friend: could not presign avatar", "err", err)
			return
		}
		cards[i].AvatarURL = url
	}
}

func (h *Handler) Send(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	// One short handle; a cap costs nothing and bounds the allocation.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	var req struct {
		Username string `json:"username"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Username == "" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"send the username to add, e.g. {\"username\": \"dmytro_bjj\"}")
		return
	}
	if err := h.repo.Send(r.Context(), claims.UserID, req.Username); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) Accept(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Accept(r.Context(), claims.UserID, r.PathValue("username")); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) Remove(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Remove(r.Context(), claims.UserID, r.PathValue("username")); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) Friends(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	list, err := h.repo.Friends(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	h.present(r, list)
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"friends": list})
}

func (h *Handler) Pending(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	reqs, err := h.repo.Pending(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	h.present(r, reqs.Incoming)
	h.present(r, reqs.Outgoing)
	apihttp.WriteJSON(w, http.StatusOK, reqs)
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "no such user or request")
	case errors.Is(err, ErrNoUsername):
		// The caller's own state, so specific copy is safe and useful.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"claim a username in your profile before adding friends")
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	case errors.Is(err, ErrAlreadyExists):
		// One message for "already friends" AND "pending in either direction"
		// — splitting them tells a sender things about the other side's
		// choices that are not theirs to know.
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists,
			"already connected, or a request is pending")
	default:
		apihttp.WriteInternal(w, r, "friend", err)
	}
}
