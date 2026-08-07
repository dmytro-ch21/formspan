package share

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct {
	repo Repository
	reg  Registry
}

func NewHandler(repo Repository, reg Registry) *Handler {
	return &Handler{repo: repo, reg: reg}
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	// Three short fields; a cap costs nothing and bounds the allocation.
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var body struct {
		ToUsername   string `json:"to_username"`
		ResourceType string `json:"resource_type"`
		ResourceID   string `json:"resource_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			`send {"to_username": "...", "resource_type": "sequence", "resource_id": "..."}`)
		return
	}
	in := New{
		ToUsername:   body.ToUsername,
		ResourceType: body.ResourceType,
		ResourceID:   body.ResourceID,
	}
	if err := in.Validate(h.reg); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"to_username, resource_type and resource_id are all required, and resource_type must be something this app can share")
		return
	}
	if err := h.repo.Create(r.Context(), claims.UserID, in); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) Inbox(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	cards, err := h.repo.Inbox(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, sharesPayload(cards))
}

func (h *Handler) Sent(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	cards, err := h.repo.Sent(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, sharesPayload(cards))
}

func (h *Handler) Accept(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	out, err := h.repo.Accept(r.Context(), claims.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	// The new copy's own id, so the client navigates to the recipient's thing
	// rather than to the sender's — which they cannot open.
	apihttp.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Delete(r.Context(), claims.UserID, r.PathValue("id")); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		// ONE message for every miss: no such share, not addressed to you,
		// not your friend, not a resource you can see. Each distinct answer
		// would confirm something to somebody it should not.
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound,
			"no such share, or nothing to share it with")
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists,
			"you already sent them this, and they haven't answered yet")
	case errors.Is(err, ErrGone):
		// 410 rather than 404, because the recipient DID receive something and
		// deserves to know it evaporated instead of wondering what they broke.
		apihttp.WriteError(w, http.StatusGone, apihttp.CodeNotFound,
			"the sender deleted this before you accepted it")
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"that is not something this app can share")
	default:
		apihttp.WriteInternal(w, r, "share", err)
	}
}

// sharesPayload wraps either list in the response envelope, guaranteeing `[]`
// rather than `null` for an empty one.
//
// HERE rather than in the repository, because the contract declares
// `type: array` and that is a promise of the ENDPOINT — it should not depend on
// which Repository implementation is wired in. The technique module documents
// review making exactly this mutation (nil slice instead of empty) and its
// suite staying green.
//
// A plain function rather than inline code because it is the only part of
// these handlers a test can reach: `auth`'s context key is unexported, so a
// handler test cannot inject claims and cannot get past the first line of
// either method. Extracting the shaping is what makes the promise testable at
// all, and the handlers below are its only callers.
func sharesPayload[T any](cards []T) map[string]any {
	if cards == nil {
		cards = []T{}
	}
	return map[string]any{"shares": cards}
}
