package session

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

type Handler struct{ repo Repository }

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

// maxSets bounds a single session. No real session comes close; anything
// larger is a mistake or an attempt to make the database work for nothing,
// and each set is a statement in a batch.
const maxSets = 500

var validSports = map[string]bool{"strength": true, "running": true, "bjj": true}

func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "session not found")
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists, "session id already in use")
	case errors.Is(err, ErrSportMismatch), errors.Is(err, ErrInvalidInput):
		// Safe to surface: these name an exercise or a value the caller sent,
		// never anything internal.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	default:
		httplog.FromContext(r.Context()).Error("session: internal error", "err", err)
		apihttp.WriteError(w, http.StatusInternalServerError, apihttp.CodeInternal, "internal error")
	}
}

// validateSets checks what the database's CHECK constraints would catch
// anyway, but with a message naming the offending set — a 400 saying "set 3:
// RPE must be 1-10" is actionable in a way "a value is out of range" isn't.
func validateSets(sets []Set) error {
	for i, s := range sets {
		at := "set " + strconv.Itoa(i+1) + ": "
		if s.ExerciseID == "" {
			return errors.New(at + "every set needs an exercise_id")
		}
		if s.SetType != "" && !ValidSetType(s.SetType) {
			return errors.New(at + "unknown set type")
		}
		if s.RPE != nil && (*s.RPE < 1 || *s.RPE > 10) {
			return errors.New(at + "RPE must be between 1 and 10")
		}
		if s.RIR != nil && (*s.RIR < 0 || *s.RIR > 20) {
			return errors.New(at + "RIR must be between 0 and 20")
		}
		// The measures the migration's CHECK enforces. Without these the
		// database answers "a value is out of range" with no set number,
		// which is exactly what this function exists to avoid.
		if s.Reps != nil && *s.Reps <= 0 {
			return errors.New(at + "reps must be greater than 0")
		}
		if s.WeightKg != nil && *s.WeightKg <= 0 {
			return errors.New(at + "weight must be greater than 0")
		}
		if s.Seconds != nil && *s.Seconds <= 0 {
			return errors.New(at + "seconds must be greater than 0")
		}
		if s.DistanceM != nil && *s.DistanceM <= 0 {
			return errors.New(at + "distance must be greater than 0")
		}
	}
	return nil
}

// List returns the caller's sessions, newest first.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	q := r.URL.Query()

	if s := q.Get("sport"); s != "" && !validSports[s] {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"sport must be one of: strength, running, bjj")
		return
	}
	limit := 0
	if l := q.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"limit must be a positive integer")
			return
		}
		limit = n
	}

	sessions, err := h.repo.List(r.Context(), claims.UserID, Filter{
		Sport:      q.Get("sport"),
		ExerciseID: q.Get("exercise_id"),
		Limit:      limit,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	s, err := h.repo.Get(r.Context(), claims.UserID, r.PathValue("sessionID"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	// The volume summary travels with the session so both clients report
	// identical numbers rather than each rolling their own arithmetic.
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{
		"session": s,
		"volume":  Summarise(s.Sets),
	})
}

type createRequest struct {
	ID        string     `json:"id"`
	WorkoutID *string    `json:"workout_id"`
	Sport     string     `json:"sport"`
	Name      string     `json:"name"`
	StartedAt *time.Time `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at"`
	Notes     string     `json:"notes"`
	Sets      []Set      `json:"sets"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if req.ID == "" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "id is required")
		return
	}
	if !validSports[req.Sport] {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"sport must be one of: strength, running, bjj")
		return
	}
	if len(req.Sets) > maxSets {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "too many sets")
		return
	}
	if err := validateSets(req.Sets); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
		return
	}
	if req.StartedAt == nil {
		// Client-supplied normally — the whole point is that logging can
		// happen after the fact — but defaulting to now keeps the simple
		// "start a session" call from needing a timestamp.
		now := time.Now().UTC()
		req.StartedAt = &now
	}

	s, err := h.repo.Create(r.Context(), NewSession{
		ID:        req.ID,
		UserID:    claims.UserID, // never from the body
		WorkoutID: req.WorkoutID,
		Sport:     req.Sport,
		Name:      req.Name,
		StartedAt: *req.StartedAt,
		EndedAt:   req.EndedAt,
		Notes:     req.Notes,
		Sets:      req.Sets,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"session": s, "volume": Summarise(s.Sets)})
}

type replaceSetsRequest struct {
	Sets []Set `json:"sets"`
}

// ReplaceSets swaps a session's whole ordered set list — the natural shape
// for "log another set" and "fix a typo in set 2" alike.
func (h *Handler) ReplaceSets(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req replaceSetsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if len(req.Sets) > maxSets {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "too many sets")
		return
	}
	if err := validateSets(req.Sets); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
		return
	}

	s, err := h.repo.ReplaceSets(r.Context(), claims.UserID, r.PathValue("sessionID"), req.Sets)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"session": s, "volume": Summarise(s.Sets)})
}

type finishRequest struct {
	EndedAt *time.Time `json:"ended_at"`
}

func (h *Handler) Finish(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req finishRequest
	// An empty body is fine — "finish now" is the common case.
	_ = json.NewDecoder(r.Body).Decode(&req)
	end := time.Now().UTC()
	if req.EndedAt != nil {
		end = *req.EndedAt
	}

	s, err := h.repo.Finish(r.Context(), claims.UserID, r.PathValue("sessionID"), end)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"session": s, "volume": Summarise(s.Sets)})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Delete(r.Context(), claims.UserID, r.PathValue("sessionID")); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
