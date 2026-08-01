package workout

import (
	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"

	"encoding/json"
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct{ repo Repository }

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

// maxItems bounds a workout's length. No real session comes close, so
// anything longer is a mistake or an attempt to make the database work for
// nothing — each item is a statement in a batch.
const maxItems = 200

// writeErr maps domain errors to the API's error contract in one place, so
// every handler below reports the same situation the same way.
func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "workout not found")
	case errors.Is(err, ErrForbidden):
		apihttp.WriteError(w, http.StatusForbidden, apihttp.CodeForbidden, "not your workout")
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists, "workout id already in use")
	case errors.Is(err, ErrSportMismatch):
		// The message is safe to surface: it names an exercise and a sport
		// the caller already sent, not anything internal.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	default:
		apihttp.WriteInternal(w, r, "workout", err)
	}
}

// List returns workouts the caller can see. ?scope=mine|shared narrows;
// omitted means both.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	q := r.URL.Query()

	// Reject unknown enum values rather than silently returning []. An
	// unrecognised ?scope= used to fall through to "everything visible",
	// so a typo looked like it worked.
	scope := q.Get("scope")
	if scope != "" && scope != "mine" && scope != "shared" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"scope must be mine or shared")
		return
	}
	if s := q.Get("sport"); s != "" && !ValidSport(Sport(s)) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"sport must be one of: "+discipline.SportList())
		return
	}
	if g := q.Get("goal"); g != "" && !ValidGoal(Goal(g)) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"goal must be one of: general, powerlifting, hypertrophy, endurance")
		return
	}

	f := Filter{
		Sport:  Sport(q.Get("sport")),
		Goal:   Goal(q.Get("goal")),
		Mine:   scope == "" || scope == "mine",
		Shared: scope == "" || scope == "shared",
	}

	workouts, err := h.repo.List(r.Context(), claims.UserID, f)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"workouts": workouts})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	wk, err := h.repo.Get(r.Context(), claims.UserID, r.PathValue("workoutID"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, wk)
}

type createRequest struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Sport      Sport      `json:"sport"`
	Goal       *Goal      `json:"goal"`
	Notes      string     `json:"notes"`
	Visibility Visibility `json:"visibility"`
	Items      []Item     `json:"items"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if len(req.Items) > maxItems {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "too many items")
		return
	}
	if req.ID == "" || req.Name == "" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "id and name are required")
		return
	}
	if !ValidSport(req.Sport) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"sport must be one of: "+discipline.SportList())
		return
	}
	if req.Goal != nil && !ValidGoal(*req.Goal) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"goal must be one of: general, powerlifting, hypertrophy, endurance")
		return
	}
	if req.Visibility == "" {
		// Default private: sharing should be a deliberate act, never the
		// consequence of omitting a field.
		req.Visibility = VisibilityPrivate
	}
	if req.Visibility != VisibilityPrivate && req.Visibility != VisibilityPublic {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"visibility must be private or public")
		return
	}

	wk, err := h.repo.Create(r.Context(), NewWorkout{
		ID:          req.ID,
		OwnerUserID: claims.UserID, // never from the body
		Name:        req.Name,
		Sport:       req.Sport,
		Goal:        req.Goal,
		Notes:       req.Notes,
		Visibility:  req.Visibility,
		Items:       req.Items,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, wk)
}

type replaceItemsRequest struct {
	Items []Item `json:"items"`
}

// ReplaceItems swaps a workout's whole ordered contents — the natural shape
// for "add an exercise" and "reorder" alike, since both send the new list.
func (h *Handler) ReplaceItems(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var req replaceItemsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}
	if len(req.Items) > maxItems {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "too many items")
		return
	}
	for _, it := range req.Items {
		if it.ExerciseID == "" {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"every item needs an exercise_id")
			return
		}
	}

	wk, err := h.repo.ReplaceItems(r.Context(), claims.UserID, r.PathValue("workoutID"), req.Items)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, wk)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Delete(r.Context(), claims.UserID, r.PathValue("workoutID")); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
