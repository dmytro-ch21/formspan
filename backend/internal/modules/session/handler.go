package session

import (
	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"

	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

type Handler struct{ repo Repository }

func NewHandler(repo Repository) *Handler { return &Handler{repo: repo} }

// maxSets bounds a single session. No real session comes close; anything
// larger is a mistake or an attempt to make the database work for nothing,
// and each set is a statement in a batch.
const maxSets = 500

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
		apihttp.WriteInternal(w, r, "session", err)
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

	if s := q.Get("sport"); s != "" && !discipline.ValidSport(s) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"sport must be one of: "+discipline.SportList())
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
	offset := 0
	if o := q.Get("offset"); o != "" {
		n, err := strconv.Atoi(o)
		if err != nil || n < 0 {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"offset must be zero or a positive integer")
			return
		}
		offset = n
	}
	// Bounded like every other free-text input here. A search box is the
	// easiest place to hand the database a megabyte.
	query := strings.TrimSpace(q.Get("q"))
	if len(query) > 100 {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"q must be 100 characters or fewer")
		return
	}

	// Optional date bounds, so the history page can list exactly the period
	// its calendar and totals describe. Resolved in the caller's zone for the
	// same reason History's are.
	loc := time.UTC
	if tz := q.Get("tz"); tz != "" {
		l, ok := parseZone(tz)
		if !ok {
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
	// History rejects this; so should the listing the same page calls
	// alongside it, rather than silently returning nothing.
	if !from.IsZero() && !to.IsZero() && to.Before(from) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"to must not be before from")
		return
	}

	page, err := h.repo.List(r.Context(), claims.UserID, Filter{
		Sport:      q.Get("sport"),
		ExerciseID: q.Get("exercise_id"),
		From:       from,
		To:         to,
		Query:      query,
		Limit:      limit,
		Offset:     offset,
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	// `sessions` stays the top-level key it has always been, so existing
	// callers that ignore the paging fields keep working unchanged.
	apihttp.WriteJSON(w, http.StatusOK, page)
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

	if s := q.Get("sport"); s != "" && !discipline.ValidSport(s) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"sport must be one of: "+discipline.SportList())
		return
	}

	// The caller's timezone decides which calendar day a session falls on.
	// Defaulting to UTC rather than guessing keeps the failure mode boring:
	// a client that doesn't send one gets consistent days, just not local ones.
	tz := q.Get("tz")
	if tz == "" {
		tz = "UTC"
	}
	loc, ok := parseZone(tz)
	if !ok {
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

// parseZone resolves an IANA name that *both* Go and Postgres will accept.
//
// The two disagree on exactly one name that matters: Go resolves "Local" to
// the server's own zone, Postgres rejects it outright. Letting it through
// meant the handler validated it happily and `AT TIME ZONE` then failed
// downstream, turning a bad parameter into a 500 — and the contract promises
// a 400. Every other divergence I could find (Zulu, EST5EDT, US/Pacific,
// Etc/GMT+5) is accepted by both.
//
// "Local" is also meaningless over HTTP: whose local? The caller's zone is
// the one thing the server can't infer, which is why `tz` exists at all.
func parseZone(tz string) (*time.Location, bool) {
	if tz == "" || strings.EqualFold(tz, "Local") {
		return nil, false
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, false
	}
	return loc, true
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

	// The rep range is a property of the session's goal, not the exercise —
	// the same squat is a 3-rep lift in a strength block and a 10-rep lift in
	// a hypertrophy one. The client knows which workout it's starting, so it
	// passes the goal rather than the server re-deriving it. Unknown or absent
	// values fall through to the general range, which is why this isn't
	// validated: a goal the server doesn't recognise is not a bad request, it
	// just doesn't narrow anything.
	goal := strings.TrimSpace(r.URL.Query().Get("goal"))

	efforts, err := h.repo.RecentEfforts(r.Context(), claims.UserID, ids)
	if err != nil {
		writeErr(w, r, err)
		return
	}

	best, err := h.repo.BestOneRMs(r.Context(), claims.UserID, ids)
	if err != nil {
		writeErr(w, r, err)
		return
	}

	now := time.Now().UTC()
	suggestions := make([]Suggestion, 0, len(ids))
	for _, id := range ids {
		// Zero value is the "never logged" case, and Progress reads it as
		// such — no history, so no claim.
		in := efforts[id]
		in.ExerciseID, in.Goal = id, goal

		s := Suggestion{ExerciseID: id, Plan: Progress(in, now)}

		// Estimated off the same top set the plan reasons from, so the two
		// always agree about which set they're describing.
		if s.LastWeightKg != nil && s.LastReps != nil {
			if est, ok := EstimateOneRM(*s.LastReps, *s.LastWeightKg, s.LastRIR, s.LastRPE); ok {
				s.EstimatedOneRMKg = &est
			}
		}
		if b, ok := best[id]; ok {
			v := b
			s.BestOneRMKg = &v
		}
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
	if !discipline.ValidSport(req.Sport) {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"sport must be one of: "+discipline.SportList())
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

// splitIDs parses a comma-separated exercise_ids parameter, matching how
// Suggestions reads the same shape.
func splitIDs(raw string) []string {
	out := []string{}
	for _, id := range strings.Split(raw, ",") {
		if id = strings.TrimSpace(id); id != "" {
			out = append(out, id)
		}
	}
	return out
}

// defaultRecordExercises is how many "most trained" stand in for an unset
// shortlist — enough to look considered, few enough to scan on a phone.
const defaultRecordExercises = 5

// maxRecordExercises bounds `scope=all`. The wide screen is where you go
// through everything you've trained rather than a shortlist, and 200 distinct
// exercises is far more than anyone accumulates in practice — but it still
// wants a ceiling rather than a promise to return a career.
const maxRecordExercises = 200

// Records returns the caller's personal records.
//
// With no `exercise_ids`, it answers for their pinned shortlist, falling back
// to what they train most. That fallback is the point: a records screen that
// opens empty and asks to be configured is one nobody configures.
func (h *Handler) Records(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var ids []string
	if raw := strings.TrimSpace(r.URL.Query().Get("exercise_ids")); raw != "" {
		ids = splitIDs(raw)
		if len(ids) > maxSuggestionIDs {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"too many exercise_ids")
			return
		}
	} else if r.URL.Query().Get("scope") == "all" {
		// Everything the caller has actually trained, most-used first. The
		// desk view browses the whole log; the phone gets a shortlist.
		all, err := h.repo.MostTrainedExercises(r.Context(), claims.UserID, maxRecordExercises)
		if err != nil {
			writeErr(w, r, err)
			return
		}
		ids = all
	} else {
		pinned, err := h.repo.PinnedExercises(r.Context(), claims.UserID)
		if err != nil {
			writeErr(w, r, err)
			return
		}
		ids = pinned
		if len(ids) == 0 {
			ids, err = h.repo.MostTrainedExercises(r.Context(), claims.UserID, defaultRecordExercises)
			if err != nil {
				writeErr(w, r, err)
				return
			}
		}
	}

	records, err := h.repo.Records(r.Context(), claims.UserID, ids)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"records": records})
}

func (h *Handler) PinnedExercises(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())
	ids, err := h.repo.PinnedExercises(r.Context(), claims.UserID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"exercise_ids": ids})
}

func (h *Handler) SetPinnedExercises(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.ClaimsFromContext(r.Context())

	var body struct {
		ExerciseIDs []string `json:"exercise_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput, "malformed JSON body")
		return
	}
	if len(body.ExerciseIDs) > maxPinned {
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"a shortlist is at most "+strconv.Itoa(maxPinned)+" exercises")
		return
	}
	// Duplicates would violate the primary key with a 500; they're a client
	// mistake, so say so.
	seen := map[string]bool{}
	for _, id := range body.ExerciseIDs {
		if id == "" {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"exercise_ids must not contain blanks")
			return
		}
		if seen[id] {
			apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
				"exercise_ids must not repeat")
			return
		}
		seen[id] = true
	}

	if err := h.repo.SetPinnedExercises(r.Context(), claims.UserID, body.ExerciseIDs); err != nil {
		writeErr(w, r, err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, map[string]any{"exercise_ids": body.ExerciseIDs})
}
