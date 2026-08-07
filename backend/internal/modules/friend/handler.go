package friend

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

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
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"friends": list})
}

func (h *Handler) Pending(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	reqs, err := h.repo.Pending(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
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
