package profile

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/dmytro-ch21/formspan/backend/internal/platform/auth"
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
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
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
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}

	p, err := h.repo.Create(r.Context(), claims.UserID, NewProfile{
		DisplayName: req.DisplayName,
		DateOfBirth: req.DateOfBirth,
		Sex:         req.Sex,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

type updateRequest struct {
	DisplayName      *string `json:"display_name"`
	DateOfBirth      *string `json:"date_of_birth"`
	Sex              *string `json:"sex"`
	BJJEnabled       *bool   `json:"bjj_enabled"`
	StrengthEnabled  *bool   `json:"strength_enabled"`
	NutritionEnabled *bool   `json:"nutrition_enabled"`
	RunningEnabled   *bool   `json:"running_enabled"`
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req updateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
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
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, ErrAlreadyExists):
		status = http.StatusConflict
	case errors.Is(err, ErrInvalidInput):
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
