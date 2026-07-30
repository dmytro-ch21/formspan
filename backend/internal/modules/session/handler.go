package session

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
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

	// Optional date bounds, so the history page can list exactly the period
	// its calendar and totals describe. Resolved in the caller's zone for the
	// same reason History's are.
	loc := time.UTC
	if tz := q.Get("tz"); tz != "" {
		l, err := time.LoadLocation(tz)
		if err != nil {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"tz must be an IANA timezone name, e.g. Europe/Berlin")
			return
		}
		loc = l
	}
	var from, to time.Time
	if v := q.Get("from"); v != "" {
		t, ok := parseDay(v, loc)
		if !ok {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"from must be a date in YYYY-MM-DD form")
			return
		}
		from = t
	}
	if v := q.Get("to"); v != "" {
		t, ok := parseDay(v, loc)
		if !ok {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"to must be a date in YYYY-MM-DD form")
			return
		}
		to = t.AddDate(0, 0, 1) // inclusive of the named day
	}

	sessions, err := h.repo.List(r.Context(), claims.UserID, Filter{
		Sport:      q.Get("sport"),
		ExerciseID: q.Get("exercise_id"),
		From:       from,
		To:         to,
		Limit:      limit,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

// maxHistoryDays bounds a history range. Five years is longer than anyone has
// been using this app and keeps a single request from scanning a career.
const maxHistoryDays = 366 * 5

// History answers "what has my training looked like" over a date range:
// per-day totals for the calendar, period totals, and the same totals for the
// preceding window so the numbers can be read as a direction rather than a
// quantity.
func (h *Handler) History(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	q := r.URL.Query()

	if s := q.Get("sport"); s != "" && !validSports[s] {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"sport must be one of: strength, running, bjj")
		return
	}

	// The caller's timezone decides which calendar day a session falls on.
	// Defaulting to UTC rather than guessing keeps the failure mode boring:
	// a client that doesn't send one gets consistent days, just not local ones.
	tz := q.Get("tz")
	if tz == "" {
		tz = "UTC"
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"tz must be an IANA timezone name, e.g. Europe/Berlin")
		return
	}

	// Dates, not timestamps: the caller is asking about calendar days, and
	// midnight is resolved in their zone rather than the server's.
	from, ok := parseDay(q.Get("from"), loc)
	if !ok {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"from must be a date in YYYY-MM-DD form")
		return
	}
	to, ok := parseDay(q.Get("to"), loc)
	if !ok {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"to must be a date in YYYY-MM-DD form")
		return
	}
	if to.Before(from) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"to must not be before from")
		return
	}
	// `to` names a day the caller wants included, so the range runs to the
	// end of it. An off-by-one here silently drops today's session — the one
	// most likely to be looked for.
	to = to.AddDate(0, 0, 1)
	if to.Sub(from) > maxHistoryDays*24*time.Hour {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"range must be five years or less")
		return
	}

	history, err := h.repo.History(r.Context(), claims.UserID, HistoryFilter{
		Sport: q.Get("sport"),
		From:  from,
		To:    to,
		TZ:    tz,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, history)
}

// parseDay reads YYYY-MM-DD as midnight in loc. An empty string is rejected:
// the range is required, and defaulting it would make "no dates" mean
// something different from what any caller intended.
func parseDay(s string, loc *time.Location) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.ParseInLocation("2006-01-02", s, loc)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// maxSuggestionIDs bounds a suggestions request. A workout is a handful of
// movements; anything larger is a scrape of the catalog.
const maxSuggestionIDs = 100

// Suggestions answers "what should I load today" for a list of exercises,
// from what the caller actually did last time.
func (h *Handler) Suggestions(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	raw := r.URL.Query().Get("exercise_ids")
	ids := []string{}
	for _, id := range strings.Split(raw, ",") {
		if id = strings.TrimSpace(id); id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"exercise_ids is required")
		return
	}
	if len(ids) > maxSuggestionIDs {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"too many exercise_ids")
		return
	}

	last, err := h.repo.LastPerformances(r.Context(), claims.UserID, ids)
	if err != nil {
		writeErr(w, r, err)
		return
	}

	now := time.Now().UTC()
	suggestions := make([]Suggestion, 0, len(ids))
	for _, id := range ids {
		var p *Performance
		if v, ok := last[id]; ok {
			p = &v
		}
		s := Suggest(p, now)
		// Suggest can't know the id when there's no history to carry it.
		s.ExerciseID = id
		suggestions = append(suggestions, s)
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"suggestions": suggestions})
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
