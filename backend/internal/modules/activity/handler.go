package activity

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/dmytro-ch21/formspan/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/formspan/backend/internal/platform/auth"
	"github.com/dmytro-ch21/formspan/backend/internal/platform/httplog"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler {
	return &Handler{repo: repo}
}

type createRequest struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind"`
	OccurredAt time.Time       `json:"occurred_at"`
	Notes      *string         `json:"notes"`
	Details    json.RawMessage `json:"details"`
}

// Create is self-scoped (RequireAuth): the caller creates their own
// activity. Idempotent on the client-supplied id — see Repository.Create.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if req.ID == "" || req.Kind == "" || req.OccurredAt.IsZero() {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "id, kind, and occurred_at are required")
		return
	}

	a, err := h.repo.Create(r.Context(), NewActivity{
		ID:         req.ID,
		UserID:     claims.UserID,
		Kind:       req.Kind,
		OccurredAt: req.OccurredAt,
		Notes:      req.Notes,
		Details:    req.Details,
		RequestID:  httplog.RequestIDFromContext(r.Context()),
		TraceID:    httplog.TraceIDFromContext(r.Context()),
	})
	if err != nil {
		httplog.FromContext(r.Context()).Error("activity: internal error", "err", err)
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "internal error")
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, a)
}

// List is self-scoped (RequireAuth): the caller's own activities.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	activities, err := h.repo.ListByUser(r.Context(), claims.UserID)
	if err != nil {
		httplog.FromContext(r.Context()).Error("activity: internal error", "err", err)
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "internal error")
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"activities": activities})
}

// AdminListUsers and AdminListUserActivities are wired under RequireAdmin
// in main.go, not RequireAuth — same repository as the self-scoped
// handlers above, different authorization.

func (h *Handler) AdminListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.repo.ListUsers(r.Context())
	if err != nil {
		httplog.FromContext(r.Context()).Error("activity: internal error", "err", err)
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "internal error")
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (h *Handler) AdminListUserActivities(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userID")
	activities, err := h.repo.ListByUser(r.Context(), userID)
	if err != nil {
		httplog.FromContext(r.Context()).Error("activity: internal error", "err", err)
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "internal error")
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"activities": activities})
}
