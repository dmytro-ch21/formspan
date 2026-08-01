// Package workout holds workout *templates* — an ordered list of exercises
// with target sets/reps/loads, e.g. "Push Day A".
//
// A template is deliberately distinct from a logged session (the `activity`
// module). Conflating them is the classic mistake: you lose the ability to
// say "I did 3 sets, not the 5 the plan called for" — and that gap between
// planned and actual is the adherence signal worth the most later.
//
// Two structural decisions worth knowing:
//
//   - **One discipline per workout.** Mixing isn't supported: a workout is
//     strength, running, or BJJ. Every item's exercise must match, which the
//     repository enforces rather than trusting the caller.
//
//   - **Goal is not sport.** Powerlifting, hypertrophy and endurance are all
//     things you do with the same barbell squat, so they can't live on the
//     exercise — they're a property of the *workout*. Only meaningful for
//     strength, hence optional.
//
// Ownership: a nil OwnerUserID means a VOLA-authored official template.
// Together with Visibility that covers both sharing cases — official
// templates, and a user publishing their own — without an ACL table.
package workout

import (
	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"

	"context"
	"errors"
	"time"
)

type Sport string

// Convenience constants for call sites that name a specific sport. These are
// NOT the membership list — see ValidSport. A discipline added to the registry
// without a constant here is fully supported; a constant here that the
// registry doesn't know fails ValidSport, which is the safe direction.
const (
	SportStrength Sport = "strength"
	SportRunning  Sport = "running"
	SportBJJ      Sport = "bjj"
)

type Goal string

const (
	GoalGeneral      Goal = "general"
	GoalPowerlifting Goal = "powerlifting"
	GoalHypertrophy  Goal = "hypertrophy"
	GoalEndurance    Goal = "endurance"
)

type Visibility string

const (
	VisibilityPrivate Visibility = "private"
	VisibilityPublic  Visibility = "public"
)

var (
	// ErrNotFound covers both "no such workout" and "exists but you may not
	// see it" — deliberately the same error, so probing for IDs can't
	// distinguish a private workout from a missing one.
	ErrNotFound = errors.New("workout: not found")

	ErrAlreadyExists = errors.New("workout: id already in use")
	ErrInvalidInput  = errors.New("workout: invalid input")

	// ErrForbidden means the caller may read this workout but not change it.
	ErrForbidden = errors.New("workout: not the owner")

	// ErrSportMismatch means an item's exercise belongs to a different sport
	// than the workout. Mixing disciplines isn't supported.
	ErrSportMismatch = errors.New("workout: exercise sport does not match workout sport")
)

// Item is one entry in a workout's ordered contents.
//
// Every target is optional because which ones apply is decided by the
// exercise's own load_type — a plank has no reps, a run has no weight. The
// catalog decides the shape; the template fills it in.
type Item struct {
	ExerciseID string `json:"exercise_id"`
	Position   int    `json:"position"`

	TargetSets      *int     `json:"target_sets"`
	TargetReps      *int     `json:"target_reps"`
	TargetWeightKg  *float64 `json:"target_weight_kg"`
	TargetSeconds   *int     `json:"target_seconds"`
	TargetDistanceM *int     `json:"target_distance_m"`

	Notes string `json:"notes"`
}

type Workout struct {
	ID string `json:"id"`
	// nil for a VOLA-authored official template.
	OwnerUserID *string    `json:"owner_user_id"`
	Name        string     `json:"name"`
	Sport       Sport      `json:"sport"`
	Goal        *Goal      `json:"goal"`
	Notes       string     `json:"notes"`
	Visibility  Visibility `json:"visibility"`
	Items       []Item     `json:"items"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// NewWorkout is the input to Create. ID is client-supplied so a workout can
// be created offline and synced idempotently, same as an activity.
type NewWorkout struct {
	ID          string
	OwnerUserID string
	Name        string
	Sport       Sport
	Goal        *Goal
	Notes       string
	Visibility  Visibility
	Items       []Item
}

// Filter narrows a listing. Mine and Shared are separate rather than one
// "scope" string so a caller can ask for both at once.
type Filter struct {
	Sport  Sport // empty means any
	Goal   Goal  // empty means any
	Mine   bool  // include the caller's own workouts
	Shared bool  // include public workouts (official + other users')
}

type Repository interface {
	// List returns workouts visible to userID per the filter, each with its
	// items loaded.
	List(ctx context.Context, userID string, f Filter) ([]Workout, error)
	// Get returns one workout if userID may see it, else ErrNotFound.
	Get(ctx context.Context, userID, id string) (*Workout, error)
	// Create is idempotent on the client-supplied ID for the same owner; a
	// different owner's ID collides with ErrAlreadyExists.
	Create(ctx context.Context, in NewWorkout) (*Workout, error)
	// ReplaceItems swaps the whole ordered list, owner-only.
	ReplaceItems(ctx context.Context, userID, workoutID string, items []Item) (*Workout, error)
	// Delete removes a workout, owner-only.
	Delete(ctx context.Context, userID, id string) error
}

// ValidGoal reports whether g is a known goal.
func ValidGoal(g Goal) bool {
	switch g {
	case GoalGeneral, GoalPowerlifting, GoalHypertrophy, GoalEndurance:
		return true
	}
	return false
}

// ValidSport reports whether s is a known sport.
//
// Delegates to the discipline registry rather than switching. The switch it
// replaced was one of four independent copies of the same closed set; a new
// discipline added to three of them and not this one compiled cleanly and
// returned 400 on write.
func ValidSport(s Sport) bool {
	return discipline.ValidSport(string(s))
}
