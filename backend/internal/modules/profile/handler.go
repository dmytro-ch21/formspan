package profile

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
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

// ExerciseUnits returns the caller's per-exercise overrides as a map.
func (h *Handler) ExerciseUnits(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	units, err := h.repo.ListExerciseUnits(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"exercise_units": units})
}

// Modules returns the discipline registry merged with this user's choices.
//
// The registry AND the enablement in one response, on purpose: a client needs
// both to render anything (labels and capabilities from the registry, on/off
// from the user), and splitting them would mean two requests before the nav
// bar can draw — which on mobile is a visible rearrangement after first paint.
func (h *Handler) Modules(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	stored, err := h.repo.ListModules(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"modules": ModulesFor(stored)})
}

// setModulesRequest is a sparse map: {"bjj": false} toggles one module and
// leaves the rest alone. Not a full replacement, so two clients editing
// different toggles can't clobber each other.
type setModulesRequest map[string]bool

// SetModules toggles one or more modules for the caller.
func (h *Handler) SetModules(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req setModulesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if len(req) == 0 {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"at least one module is required")
		return
	}
	// Validate against the registry, not the database. An unknown key stored
	// here would be inert rather than harmful, but accepting it silently means
	// a client typo looks like it worked and the toggle never appears.
	for key := range req {
		if !discipline.Valid(key) {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"unknown module: "+key)
			return
		}
	}

	if err := h.repo.SetModules(r.Context(), claims.UserID, req); err != nil {
		writeError(w, r, err)
		return
	}

	// Return the full merged set, not just what changed: the client's next
	// render needs every module anyway, and a 204 would force a second GET.
	stored, err := h.repo.ListModules(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"modules": ModulesFor(stored)})
}

type setExerciseUnitRequest struct {
	// Null or empty clears the override, falling back to the profile default.
	UnitSystem *string `json:"unit_system"`
}

func (h *Handler) SetExerciseUnit(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	exerciseID := r.PathValue("exerciseID")
	if exerciseID == "" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "exercise id is required")
		return
	}

	var req setExerciseUnitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	unit := ""
	if req.UnitSystem != nil {
		unit = *req.UnitSystem
	}
	if unit != "" && !ValidUnitSystem(unit) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"unit_system must be metric or imperial")
		return
	}

	if err := h.repo.SetExerciseUnit(r.Context(), claims.UserID, exerciseID, unit); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type updateRequest struct {
	DisplayName *string `json:"display_name"`
	DateOfBirth *string `json:"date_of_birth"`
	Sex         *string `json:"sex"`
	UnitSystem  *string `json:"unit_system"`
	TrackEffort *bool   `json:"track_effort"`
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
		DisplayName: req.DisplayName,
		DateOfBirth: req.DateOfBirth,
		Sex:         req.Sex,
		UnitSystem:  req.UnitSystem,
		TrackEffort: req.TrackEffort,
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
		apihttp.WriteInternal(w, r, "profile", err)
	}
}
