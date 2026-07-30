// Package session holds performed training sessions and the sets that
// actually happened in them.
//
// Deliberately distinct from the workout module, which holds the *plan*.
// Keeping them apart is what preserves the gap between prescribed and
// actual — the adherence signal that makes the history worth analysing. A
// session may follow a template or be entirely freeform.
//
// Sets are stored as rows rather than an aggregate because that's the shape
// of the truth: the third set is heavier, the last one is a drop, the first
// two were warm-ups. "3×5 @ 100" can't express any of that, and it's exactly
// the detail that makes a training log worth keeping.
package session

import (
	"context"
	"errors"
	"time"
)

type SetType string

const (
	SetTypeWarmup  SetType = "warmup"
	SetTypeWorking SetType = "working"
	SetTypeBackoff SetType = "backoff"
	SetTypeDrop    SetType = "drop"
	SetTypeAMRAP   SetType = "amrap"
	SetTypeFailure SetType = "failure"
)

func ValidSetType(s SetType) bool {
	switch s {
	case SetTypeWarmup, SetTypeWorking, SetTypeBackoff, SetTypeDrop, SetTypeAMRAP, SetTypeFailure:
		return true
	}
	return false
}

var (
	// ErrNotFound covers "no such session" and "not yours" alike —
	// deliberately the same error, so a caller can't probe for IDs. Same
	// reasoning as the workout module.
	ErrNotFound      = errors.New("session: not found")
	ErrAlreadyExists = errors.New("session: id already in use")
	ErrInvalidInput  = errors.New("session: invalid input")
	// ErrSportMismatch means a logged set's exercise belongs to a different
	// discipline than the session.
	ErrSportMismatch = errors.New("session: exercise sport does not match session sport")
)

// Set is one set actually performed.
//
// Every measure is optional because which ones apply is decided by the
// exercise's own load_type — a plank has no reps, a run has no weight. Same
// principle as the workout template: the catalog decides the shape.
//
// RIR and RPE are two views of the same quantity (RPE 8 ≈ 2 RIR). Both are
// stored because lifters are fluent in one or the other and rarely both;
// forcing a conversion at the moment someone has just finished a hard set is
// the wrong time to ask for arithmetic.
type Set struct {
	ExerciseID string  `json:"exercise_id"`
	Position   int     `json:"position"`
	SetType    SetType `json:"set_type"`

	Reps      *int     `json:"reps"`
	WeightKg  *float64 `json:"weight_kg"`
	Seconds   *int     `json:"seconds"`
	DistanceM *int     `json:"distance_m"`

	RIR *int     `json:"rir"`
	RPE *float64 `json:"rpe"`

	// Completed is the trigger for progressive volume: the summary counts
	// what's been done, not what's been planned. A template opens with every
	// set false, and each one ticks over as it's performed.
	Completed bool `json:"completed"`

	Notes string `json:"notes"`
}

type Session struct {
	ID     string `json:"id"`
	UserID string `json:"user_id"`
	// The template followed, if any. Nil for a freeform session, and also
	// nil once a followed template has been deleted — history outlives the
	// plan it came from.
	WorkoutID *string `json:"workout_id"`
	Sport     string  `json:"sport"`
	Name      string  `json:"name"`

	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at"`
	Notes     string     `json:"notes"`

	Sets      []Set     `json:"sets"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Volume is the derived summary a client would otherwise recompute.
//
// Warm-ups are excluded from working volume deliberately: counting them
// inflates every number and makes a light day look like a hard one, which
// would poison any load calculation built on top.
//
// ExerciseIDs is the one field that counts *everything* — warm-ups and sets
// that were planned but never performed. It answers "what is this session
// about", not "what did I complete", which is why an opened template
// reports its exercises alongside zero working volume.
type Volume struct {
	WorkingSets int      `json:"working_sets"`
	TotalReps   int      `json:"total_reps"`
	TonnageKg   float64  `json:"tonnage_kg"`
	HardestRPE  float64  `json:"hardest_rpe"` // over working sets only
	ExerciseIDs []string `json:"exercise_ids"`
}

// Summarise computes working volume for a session. Kept in the domain rather
// than in SQL or a client so both platforms report identical numbers.
func Summarise(sets []Set) Volume {
	v := Volume{ExerciseIDs: []string{}}
	seen := map[string]bool{}
	for _, s := range sets {
		if !seen[s.ExerciseID] {
			seen[s.ExerciseID] = true
			v.ExerciseIDs = append(v.ExerciseIDs, s.ExerciseID)
		}
		// Planned but not yet performed contributes nothing. This is what
		// makes the header climb as you work rather than start at the total.
		if !s.Completed {
			continue
		}
		// Warm-ups count toward no working-volume measure — not sets, not
		// tonnage, and not the hardest RPE. They stay in ExerciseIDs above,
		// because "what did I train" does include an exercise you only
		// warmed up on.
		if s.SetType == SetTypeWarmup {
			continue
		}
		if s.RPE != nil && *s.RPE > v.HardestRPE {
			v.HardestRPE = *s.RPE
		}
		v.WorkingSets++
		if s.Reps != nil {
			v.TotalReps += *s.Reps
			if s.WeightKg != nil {
				v.TonnageKg += float64(*s.Reps) * *s.WeightKg
			}
		}
	}
	return v
}

// NewSession is the input to Create.
type NewSession struct {
	ID        string
	UserID    string
	WorkoutID *string
	Sport     string
	Name      string
	StartedAt time.Time
	EndedAt   *time.Time
	Notes     string
	Sets      []Set
}

// Filter narrows a listing. A zero Filter returns the caller's recent
// sessions.
type Filter struct {
	Sport      string // empty means any
	ExerciseID string // sessions containing this exercise; empty means any
	// From and To bound started_at as a half-open range: From <= t < To.
	// The *handler* is what widens a caller's inclusive `to=2026-03-03` to the
	// exclusive instant here, so a direct repository caller must pass the
	// exclusive bound itself. Zero means unbounded.
	From time.Time
	To   time.Time
	// Query matches the session's name, case-insensitively, anywhere in it.
	// Names are the only free text a session has, and "leg day" is how people
	// actually remember one.
	Query  string
	Limit  int // 0 means the repository default
	Offset int // rows to skip, for paging
}

// SessionPage is one page of a listing plus how many rows the filter matched
// in total.
//
// Total comes back with the page rather than from a second endpoint because
// the two must describe the same filter — a count that disagrees with the
// rows is worse than no count, and it's exactly what happens when they're
// fetched separately and one of them changes.
type SessionPage struct {
	Sessions []Session `json:"sessions"`
	Total    int       `json:"total"`
	Limit    int       `json:"limit"`
	Offset   int       `json:"offset"`
}

// HistoryFilter bounds a history rollup. Unlike Filter the range is required —
// an unbounded aggregate over a training career is not a page, it's a report.
type HistoryFilter struct {
	Sport string    // empty means any
	From  time.Time // inclusive
	To    time.Time // exclusive
	// TZ is an IANA name used to bucket sessions into calendar days. It has
	// to be the caller's, not the server's: training at 19:00 in New York is
	// 23:00 UTC, and bucketing that in UTC puts a Tuesday session on the
	// calendar's Wednesday — visibly wrong on the one view whose whole job is
	// showing which days you trained. Validated by the handler.
	TZ string
}

// HistoryDay is one calendar day's training, in the caller's own timezone.
//
// Days with no training are absent rather than zero-filled: the range already
// says which days exist, and sending ~365 empty objects to draw gaps the
// client can infer is wasted on every request.
type HistoryDay struct {
	Date            string   `json:"date"` // YYYY-MM-DD, caller's timezone
	Sessions        int      `json:"sessions"`
	WorkingSets     int      `json:"working_sets"`
	TotalReps       int      `json:"total_reps"`
	TonnageKg       float64  `json:"tonnage_kg"`
	DurationSeconds int      `json:"duration_seconds"`
	Sports          []string `json:"sports"`
}

// HistoryTotals is a period's training in one line.
//
// Exercises counts *distinct* exercises across the period, which is why it
// can't be derived by summing the days — training bench on Monday and again
// on Thursday is one exercise, not two.
type HistoryTotals struct {
	Sessions        int     `json:"sessions"`
	WorkingSets     int     `json:"working_sets"`
	TotalReps       int     `json:"total_reps"`
	TonnageKg       float64 `json:"tonnage_kg"`
	DurationSeconds int     `json:"duration_seconds"`
	Exercises       int     `json:"exercises"`
	// Days on which anything was logged. The denominator for "how often am I
	// actually training", which sessions alone doesn't answer — two sessions
	// in one day is not two days of training.
	ActiveDays int `json:"active_days"`
}

// SportCount powers the filter chips: how much of this period was each sport.
type SportCount struct {
	Sport    string `json:"sport"`
	Sessions int    `json:"sessions"`
}

// History is the analytical surface behind the web history page.
//
// Previous holds the immediately preceding window of the same length, which
// is what makes the totals mean anything — "182 tonnes" is a number, "182
// tonnes, up 12%" is a fact about your training. It's computed over the same
// sport filter, so switching to BJJ compares BJJ against BJJ.
type History struct {
	From     string        `json:"from"` // YYYY-MM-DD, echoed back
	To       string        `json:"to"`
	Totals   HistoryTotals `json:"totals"`
	Previous HistoryTotals `json:"previous"`
	Days     []HistoryDay  `json:"days"`
	Sports   []SportCount  `json:"sports"`
}

type Repository interface {
	List(ctx context.Context, userID string, f Filter) (*SessionPage, error)
	// History rolls a date range up per day plus period totals. Aggregated in
	// SQL rather than by listing sessions and calling Summarise, because a
	// year of training is thousands of set rows and the page needs six
	// numbers. TestHistoryAgreesWithSummarise pins the two together.
	History(ctx context.Context, userID string, f HistoryFilter) (*History, error)
	// LastPerformances returns, per requested exercise, the top working set of
	// the most recent session containing it. Missing keys mean "never logged".
	LastPerformances(ctx context.Context, userID string, exerciseIDs []string) (map[string]Performance, error)
	// BestOneRMs returns the highest estimated one-rep max in the caller's
	// history per requested exercise. Missing keys mean "no estimate".
	BestOneRMs(ctx context.Context, userID string, exerciseIDs []string) (map[string]float64, error)
	// Records derives every personal record the caller holds for the named
	// exercises. Derived rather than stored — see the implementation.
	Records(ctx context.Context, userID string, exerciseIDs []string) ([]ExerciseRecords, error)
	// PinnedExercises is the athlete's chosen shortlist for their profile.
	PinnedExercises(ctx context.Context, userID string) ([]string, error)
	SetPinnedExercises(ctx context.Context, userID string, exerciseIDs []string) error
	// MostTrainedExercises backs the default shortlist, so the records view
	// says something useful before anyone configures it.
	MostTrainedExercises(ctx context.Context, userID string, limit int) ([]string, error)
	Get(ctx context.Context, userID, id string) (*Session, error)
	// Create is idempotent on the client-supplied ID for the same user; a
	// different user's ID collides with ErrAlreadyExists.
	Create(ctx context.Context, in NewSession) (*Session, error)
	// ReplaceSets swaps the whole ordered list — the natural shape for
	// "log another set" and "fix a typo" alike.
	ReplaceSets(ctx context.Context, userID, sessionID string, sets []Set) (*Session, error)
	Finish(ctx context.Context, userID, sessionID string, endedAt time.Time) (*Session, error)
	Delete(ctx context.Context, userID, id string) error
}
