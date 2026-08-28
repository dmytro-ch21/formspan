package plan

import (
	"encoding/json"
	"errors"
	"net/http"
	"unicode/utf8"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

// maxBody bounds a request before it is buffered. A plan is a handful of short
// fields, and `MaxNotesLen` is only checked after a full decode — so without
// this the notes limit is enforced against something already in memory. Same
// 8 KiB `health` and `session` use.
const maxBody = 8 << 10

func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "plan not found")
	case errors.Is(err, ErrAlreadyExists):
		apihttp.WriteError(w, http.StatusConflict, apihttp.CodeAlreadyExists, "plan id already in use")
	case errors.Is(err, ErrInvalidInput):
		// Safe to surface: these name a value the caller sent, never anything
		// internal. See translatePgError, which strips the Postgres message.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, err.Error())
	default:
		apihttp.WriteInternal(w, r, "plan", err)
	}
}

// List returns the caller's plans over a day range.
//
// `from`/`to` are required rather than defaulted to "this week". A default
// would make the commonest client bug — forgetting to send the range — look
// like an empty calendar instead of a mistake, and the two are impossible to
// tell apart from the response.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	q := r.URL.Query()
	from, to := q.Get("from"), q.Get("to")
	if from == "" || to == "" {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"from and to are required (YYYY-MM-DD)")
		return
	}

	plans, err := h.repo.List(r.Context(), claims.UserID, Range{From: from, To: to})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	// Wrapped in an object rather than returned as a bare array: a top-level
	// array has nowhere to add a field later without breaking every client,
	// and this endpoint will want paging or a rollup eventually.
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"plans": plans})
}

type createRequest struct {
	ID          string  `json:"id"`
	Day         string  `json:"day"`
	Sport       string  `json:"sport"`
	WorkoutID   *string `json:"workout_id"`
	ClassPlanID *string `json:"class_plan_id"`
	Notes       string  `json:"notes"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	// Bounded before the whole body is buffered — a plan is a handful of short
	// fields, and `MaxNotesLen` is only checked after a full decode. Same limit
	// `health` and `session` use.
	var req createRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}

	if req.ID == "" {
		// Client-generated, like sessions and activities — see the migration.
		// Generating one here instead would break the offline retry contract:
		// a resent create would make a second plan rather than conflicting.
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "id is required")
		return
	}
	if !ValidDay(req.Day) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"day must be a calendar date (YYYY-MM-DD)")
		return
	}
	// Checked against the registry, not a literal list. The database's CHECK
	// would catch an unknown sport anyway, but only after a round trip and
	// with a constraint name for a message — and this is the same registry the
	// clients gate their UI on, so the two cannot drift.
	if !validSport(req.Sport) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "unknown sport")
		return
	}
	// Runes, not bytes: the CHECK is `char_length(notes) <= 500`, so counting
	// bytes rejects a 300-character Cyrillic or emoji note the database would
	// have accepted. `session.maxNameLen` already uses RuneCountInString.
	if utf8.RuneCountInString(req.Notes) > MaxNotesLen {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "notes are too long")
		return
	}

	p, err := h.repo.Create(r.Context(), claims.UserID, NewPlan{
		ID:          req.ID,
		Day:         req.Day,
		Sport:       req.Sport,
		WorkoutID:   req.WorkoutID,
		ClassPlanID: req.ClassPlanID,
		Notes:       req.Notes,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusCreated, p)
}

// updateRequest carries `workout_id` and `class_plan_id` as their Optional*
// types so "absent" and "explicitly null" stay distinguishable — see
// OptionalWorkoutID's own comment for why a `**string` cannot do this, and for
// the silent no-op it caused.
type updateRequest struct {
	Day         *string             `json:"day"`
	Sport       *string             `json:"sport"`
	WorkoutID   OptionalWorkoutID   `json:"workout_id"`
	ClassPlanID OptionalClassPlanID `json:"class_plan_id"`
	Notes       *string             `json:"notes"`
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	id := r.PathValue("planID")

	var req updateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&req); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "invalid JSON body")
		return
	}

	if req.Day != nil && !ValidDay(*req.Day) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"day must be a calendar date (YYYY-MM-DD)")
		return
	}
	if req.Sport != nil && !validSport(*req.Sport) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "unknown sport")
		return
	}
	if req.Notes != nil && utf8.RuneCountInString(*req.Notes) > MaxNotesLen {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "notes are too long")
		return
	}

	p, err := h.repo.Update(r.Context(), claims.UserID, id, PlanUpdate{
		Day:         req.Day,
		Sport:       req.Sport,
		WorkoutID:   req.WorkoutID,
		ClassPlanID: req.ClassPlanID,
		Notes:       req.Notes,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, p)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	if err := h.repo.Delete(r.Context(), claims.UserID, r.PathValue("planID")); err != nil {
		writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// validSport accepts only disciplines that can actually hold a session.
//
// The registry's own `ValidSport`, which is `is_sport` rather than merely
// "known": nutrition is a module a user can turn on, but "plan a nutrition
// session for Tuesday" has no session, no catalog and no screen behind it.
//
// Deliberately NOT gated on whether *this* user has the module enabled. A plan
// made before turning a discipline off must stay readable and deletable —
// otherwise turning BJJ off strands every mat day you had planned, with no
// way to clear them.
func validSport(key string) bool { return discipline.ValidSport(key) }
