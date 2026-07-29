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
// would poison any load calculation built on top. ExerciseIDs is the one
// field that still counts them — it answers "what did I train", not "how
// hard did I train".
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
	Limit      int    // 0 means the repository default
}

type Repository interface {
	List(ctx context.Context, userID string, f Filter) ([]Session, error)
	// LastPerformances returns, per requested exercise, the top working set of
	// the most recent session containing it. Missing keys mean "never logged".
	LastPerformances(ctx context.Context, userID string, exerciseIDs []string) (map[string]Performance, error)
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
