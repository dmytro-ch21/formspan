package profile

import (
	"encoding/json"
	"errors"
	"net/http"

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

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	p, err := h.repo.Get(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, p)
}

type createRequest struct {
	DisplayName *string `json:"display_name"`
	DateOfBirth *string `json:"date_of_birth"`
	Sex         *string `json:"sex"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}

	p, err := h.repo.Create(r.Context(), claims.UserID, NewProfile{
		DisplayName: req.DisplayName,
		DateOfBirth: req.DateOfBirth,
		Sex:         req.Sex,
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusCreated, p)
}

type updateRequest struct {
	DisplayName      *string `json:"display_name"`
	DateOfBirth      *string `json:"date_of_birth"`
	Sex              *string `json:"sex"`
	BJJEnabled       *bool   `json:"bjj_enabled"`
	StrengthEnabled  *bool   `json:"strength_enabled"`
	NutritionEnabled *bool   `json:"nutrition_enabled"`
	RunningEnabled   *bool   `json:"running_enabled"`
	UnitSystem       *string `json:"unit_system"`
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req updateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}

	if req.UnitSystem != nil && !ValidUnitSystem(*req.UnitSystem) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"unit_system must be metric or imperial")
		return
	}

	p, err := h.repo.Update(r.Context(), claims.UserID, ProfileUpdate{
		DisplayName:      req.DisplayName,
		DateOfBirth:      req.DateOfBirth,
		Sex:              req.Sex,
		BJJEnabled:       req.BJJEnabled,
		StrengthEnabled:  req.StrengthEnabled,
		NutritionEnabled: req.NutritionEnabled,
		RunningEnabled:   req.RunningEnabled,
		UnitSystem:       req.UnitSystem,
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, p)
}

// writeError maps domain errors to the shared error response shape. Anything
// unmapped is treated as internal: the real error is logged server-side but
// never sent to the client, to avoid leaking implementation details (e.g.
// raw database errors) over the wire.
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, err.Error())
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists, err.Error())
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	default:
		httplog.FromContext(r.Context()).Error("profile: internal error", "err", err)
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "internal error")
	}
}
