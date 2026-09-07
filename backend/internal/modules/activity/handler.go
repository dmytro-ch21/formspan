package activity

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
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

// maxCreateBody bounds the request before it is buffered. `Details` is a
// free-form envelope around whatever module-specific payload rides alongside
// an activity (N164/#541) — there is no per-field cap to lean on the way a
// bounded array elsewhere has one, so this picks a flat ceiling generous
// enough for a substantial nested JSON blob (comparable to a workout
// summary) while still refusing an unbounded "make the server allocate
// forever" body.
const maxCreateBody = 64 << 10

// Create is self-scoped (RequireAuth): the caller creates their own
// activity. Idempotent on the client-supplied id — see Repository.Create.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req createRequest
	if err := apihttp.DecodeJSON(w, r, maxCreateBody, &req); err != nil {
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
		if errors.Is(err, ErrAlreadyExists) {
			// The client-generated ID collides with another user's activity.
			// Report it rather than returning their row (which would be an
			// IDOR) or silently dropping this one.
			httplog.FromContext(r.Context()).Warn("activity: id belongs to another user", "activity_id", req.ID)
			apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists, "activity id already in use")
			return
		}
		apihttp.WriteInternal(w, r, "activity", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, a)
}

// List is self-scoped (RequireAuth): the caller's own activities.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	activities, err := h.repo.ListByUser(r.Context(), claims.UserID)
	if err != nil {
		apihttp.WriteInternal(w, r, "activity", err)
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
		apihttp.WriteInternal(w, r, "activity", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"users": users})
}

// AdminGetUser is the per-athlete admin view — summary plus recent sessions.
//
// Replaces AdminListUserActivities as the user-detail page's source. That one
// reads `activities`, which has had no writer since the in-app logging form
// was removed, so the page was permanently empty while the account's real
// training sat unread in `sessions`.
func (h *Handler) AdminGetUser(w http.ResponseWriter, r *http.Request) {
	detail, err := h.repo.GetUser(r.Context(), r.PathValue("userID"))
	if errors.Is(err, ErrNotFound) {
		// A wrong id must read as wrong. Returning an empty summary instead
		// is what made the old page unfalsifiable: "no data" and "no such
		// user" rendered identically.
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "user not found")
		return
	}
	if err != nil {
		apihttp.WriteInternal(w, r, "activity", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, detail)
}

// AdminListUserActivities is no longer what the admin console renders — see
// AdminGetUser. It stays because it is the only read path for the `activities`
// rows that predate the logging form's removal; deleting it would strand them.
func (h *Handler) AdminListUserActivities(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userID")
	activities, err := h.repo.ListByUser(r.Context(), userID)
	if err != nil {
		apihttp.WriteInternal(w, r, "activity", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"activities": activities})
}
