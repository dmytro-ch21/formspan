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
	"fmt"
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

	// Protocol is this item's own progression configuration (N494/#864,
	// phase 2 of #753 — see that ticket and #812's "phase 1/phase 2
	// boundary" history entry). Nil means nothing configured here; the
	// progression engine's priority chain (session.ResolveProtocol) then
	// falls through to the next level rather than treating a missing
	// Protocol as an error.
	Protocol *ItemProtocol `json:"protocol,omitempty"`
}

// ProgressionStrategy is how a workout item's progression should reason
// about advancing load over time — distinct from RepRange (progression.go
// in the session package), which decides the range's ENDPOINTS: this
// decides the SHAPE of the decision.
type ProgressionStrategy string

const (
	StrategyDoubleProgression     ProgressionStrategy = "double_progression"
	StrategyLinear                ProgressionStrategy = "linear"
	StrategyTopSetBackoff         ProgressionStrategy = "top_set_backoff"
	StrategyDifficultyProgression ProgressionStrategy = "difficulty_progression"
	// StrategyProgramControlled means don't reinterpret this at all — the
	// program's own numbers are the prescription, full stop. See
	// session.ResolveProtocol's priority-1 case.
	StrategyProgramControlled ProgressionStrategy = "program_controlled"
)

// ValidProgressionStrategy reports whether s is a known strategy.
func ValidProgressionStrategy(s ProgressionStrategy) bool {
	switch s {
	case StrategyDoubleProgression, StrategyLinear, StrategyTopSetBackoff,
		StrategyDifficultyProgression, StrategyProgramControlled:
		return true
	}
	return false
}

// RepCountMode says whether a workout item's reps are counted across the
// whole set (a barbell squat) or per side (a walking lunge, a single-arm
// row) — see ItemProtocol.
type RepCountMode string

const (
	RepCountTotal   RepCountMode = "total"
	RepCountPerSide RepCountMode = "per_side"
)

// ValidRepCountMode reports whether m is a known mode.
func ValidRepCountMode(m RepCountMode) bool {
	switch m {
	case RepCountTotal, RepCountPerSide:
		return true
	}
	return false
}

// SetRole is what one prescribed set within a per-set protocol (see
// ItemProtocol.Sets) is FOR. A top set and its backoffs are not
// interchangeable evidence — the same distinction ProgressV2's
// straightWorkingSetsWithWeight already makes for LOGGED sets
// (backend/internal/modules/session/progression_v2.go), applied here one
// level up, to what was PLANNED.
type SetRole string

const (
	SetRoleWarmup  SetRole = "warmup"
	SetRoleWorking SetRole = "working"
	SetRoleTopSet  SetRole = "top_set"
	SetRoleBackoff SetRole = "backoff"
	SetRoleAMRAP   SetRole = "amrap"
)

// ValidSetRole reports whether r is a known role.
func ValidSetRole(r SetRole) bool {
	switch r {
	case SetRoleWarmup, SetRoleWorking, SetRoleTopSet, SetRoleBackoff, SetRoleAMRAP:
		return true
	}
	return false
}

// SetPrescription is one planned set within a workout item's protocol —
// finer-grained than the item's own single TargetSets/TargetReps/
// TargetWeightKg, which can only describe one uniform set. A top-set/backoff
// scheme (one set at a top weight, three backoff sets lighter) has no single
// set of numbers that describes both, and the item's own Target* fields
// never tried to.
type SetPrescription struct {
	Role SetRole `json:"role"`
	// LoadKg is a specific prescribed weight for this set. Nil means no
	// fixed load was prescribed for it (e.g. an AMRAP backoff at "whatever
	// the top set left").
	LoadKg      *float64 `json:"load_kg,omitempty"`
	RepRangeMin *int     `json:"rep_range_min,omitempty"`
	RepRangeMax *int     `json:"rep_range_max,omitempty"`
	// EffortRIRMin/EffortRIRMax bound the reserve this set should finish
	// with, in reps in reserve — the same unit session.Set.RIR already
	// records, so a per-set prescription and a logged set describe effort
	// identically.
	EffortRIRMin *int `json:"effort_rir_min,omitempty"`
	EffortRIRMax *int `json:"effort_rir_max,omitempty"`
	RestSeconds  *int `json:"rest_seconds,omitempty"`
	// Optional marks a set the athlete may skip without the session reading
	// as incomplete — an "if time allows" backoff, say.
	Optional bool `json:"optional,omitempty"`
}

// ExerciseProfile is a coarse category an exercise's progression protocol
// DEFAULTS from when nothing more specific is configured — see
// ItemProtocol.ExerciseProfile and, in the session package,
// ResolveProtocol's four-level priority order (program prescription →
// athlete config → exercise-profile default → abstain), of which a profile
// is only the third rung. Defaults, never authorities: #753/#864's whole
// point is that a profile must never override an explicit configuration.
//
// Defined here rather than as a column on the exercise catalog
// (internal/modules/exercise) because a profile is a choice about
// PROTOCOL — how progression should reason about an exercise — not
// something the catalog itself asserts about the movement. The same
// exercise can reasonably carry a different profile in different athletes'
// hands (an experienced lifter's accessory work vs. a novice's).
type ExerciseProfile string

const (
	ProfilePrimaryCompound        ExerciseProfile = "primary_compound"
	ProfileSecondaryCompoundLunge ExerciseProfile = "secondary_compound_lunge"
	ProfileIsolationAccessory     ExerciseProfile = "isolation_accessory"
	ProfileCalfHighRepAccessory   ExerciseProfile = "calf_high_rep_accessory"
	ProfileBodyweightDifficulty   ExerciseProfile = "bodyweight_difficulty_progression"
	ProfileTimedDistance          ExerciseProfile = "timed_distance"
)

// ValidExerciseProfile reports whether p is a known profile.
func ValidExerciseProfile(p ExerciseProfile) bool {
	switch p {
	case ProfilePrimaryCompound, ProfileSecondaryCompoundLunge, ProfileIsolationAccessory,
		ProfileCalfHighRepAccessory, ProfileBodyweightDifficulty, ProfileTimedDistance:
		return true
	}
	return false
}

// ItemProtocol is a workout item's own progression configuration (N494/#864,
// phase 2 of #753 — see docs/decisions/history.md's N473/#812 entry for the
// phase 1/phase 2 boundary this fills in). Every field is optional: a nil
// ItemProtocol, or one whose fields are all empty, means "nothing configured
// here", and session.ResolveProtocol falls through to the next priority
// level rather than treating that as an error or as a zero-value protocol.
//
// Persisted as one JSONB column (workout_items.protocol) rather than
// exploded into a dozen scalar columns, the same choice this codebase
// already made for nutrition_targets.basis: the per-set list in particular
// would otherwise need its own child table for what is, in practice, a
// handful of rows authored and read together and never queried
// independently of their parent item.
type ItemProtocol struct {
	ProgressionStrategy *ProgressionStrategy `json:"progression_strategy,omitempty"`
	RepRangeMin         *int                 `json:"rep_range_min,omitempty"`
	RepRangeMax         *int                 `json:"rep_range_max,omitempty"`
	TargetSets          *int                 `json:"target_sets,omitempty"`
	// TargetRIR/TargetRPE mirror session.Set's own RIR (*int) / RPE
	// (*float64) types — a prescription and a logged set describe effort in
	// the same unit.
	TargetRIR    *int          `json:"target_rir,omitempty"`
	TargetRPE    *float64      `json:"target_rpe,omitempty"`
	RepCountMode *RepCountMode `json:"rep_count_mode,omitempty"`
	// EquipmentIncrement is in kilograms, matching TargetWeightKg elsewhere
	// on this item — clients convert for display, same as every other
	// weight that crosses this wire.
	EquipmentIncrement *float64 `json:"equipment_increment,omitempty"`
	// ExerciseProfile lets an athlete or program tag which profile this item
	// should inherit defaults from without spelling out every field — see
	// session.ResolveProtocol. Any OTHER field also set explicitly on this
	// same ItemProtocol still wins over the tagged profile's default for
	// that one question; only a field left nil here falls through to it.
	ExerciseProfile *ExerciseProfile `json:"exercise_profile,omitempty"`

	Sets []SetPrescription `json:"sets,omitempty"`
}

// Validate checks internal consistency of an ItemProtocol before it is
// persisted. Never trust a client-supplied enum or range — Postgres can
// check a CHECK constraint on a scalar column, but everything here lives
// inside one JSONB column, so this is the one place that validation can
// happen. Returns ErrInvalidInput, matching this module's existing
// convention for a request the client got wrong (see translatePgError's own
// doc comment on why the underlying reason never needs to reach Postgres to
// be surfaced correctly).
//
// A nil receiver is valid and returns nil — an item with no protocol at all
// is not an error, so every call site can validate unconditionally rather
// than checking for nil first.
func (p *ItemProtocol) Validate() error {
	if p == nil {
		return nil
	}
	if p.ProgressionStrategy != nil && !ValidProgressionStrategy(*p.ProgressionStrategy) {
		return fmt.Errorf("%w: unknown progression_strategy", ErrInvalidInput)
	}
	if p.RepCountMode != nil && !ValidRepCountMode(*p.RepCountMode) {
		return fmt.Errorf("%w: unknown rep_count_mode", ErrInvalidInput)
	}
	if p.ExerciseProfile != nil && !ValidExerciseProfile(*p.ExerciseProfile) {
		return fmt.Errorf("%w: unknown exercise_profile", ErrInvalidInput)
	}
	if (p.RepRangeMin == nil) != (p.RepRangeMax == nil) {
		return fmt.Errorf("%w: rep_range_min and rep_range_max must be set together", ErrInvalidInput)
	}
	if p.RepRangeMin != nil {
		if *p.RepRangeMin <= 0 || *p.RepRangeMax <= 0 {
			return fmt.Errorf("%w: rep range must be positive", ErrInvalidInput)
		}
		if *p.RepRangeMin > *p.RepRangeMax {
			return fmt.Errorf("%w: rep_range_min must not exceed rep_range_max", ErrInvalidInput)
		}
	}
	if p.TargetSets != nil && *p.TargetSets <= 0 {
		return fmt.Errorf("%w: target_sets must be positive", ErrInvalidInput)
	}
	if p.TargetRIR != nil && (*p.TargetRIR < 0 || *p.TargetRIR > 10) {
		return fmt.Errorf("%w: target_rir must be between 0 and 10", ErrInvalidInput)
	}
	if p.TargetRPE != nil && (*p.TargetRPE < 0 || *p.TargetRPE > 10) {
		return fmt.Errorf("%w: target_rpe must be between 0 and 10", ErrInvalidInput)
	}
	if p.EquipmentIncrement != nil && *p.EquipmentIncrement <= 0 {
		return fmt.Errorf("%w: equipment_increment must be positive", ErrInvalidInput)
	}
	for i, sp := range p.Sets {
		if !ValidSetRole(sp.Role) {
			return fmt.Errorf("%w: sets[%d] has an unknown role", ErrInvalidInput, i)
		}
		if (sp.RepRangeMin == nil) != (sp.RepRangeMax == nil) {
			return fmt.Errorf("%w: sets[%d]'s rep range must be set together", ErrInvalidInput, i)
		}
		if sp.RepRangeMin != nil && *sp.RepRangeMin > *sp.RepRangeMax {
			return fmt.Errorf("%w: sets[%d]'s rep_range_min must not exceed rep_range_max", ErrInvalidInput, i)
		}
		if sp.LoadKg != nil && *sp.LoadKg < 0 {
			return fmt.Errorf("%w: sets[%d] has a negative load", ErrInvalidInput, i)
		}
		if sp.RestSeconds != nil && *sp.RestSeconds < 0 {
			return fmt.Errorf("%w: sets[%d] has a negative rest", ErrInvalidInput, i)
		}
		if sp.EffortRIRMin != nil && sp.EffortRIRMax != nil && *sp.EffortRIRMin > *sp.EffortRIRMax {
			return fmt.Errorf("%w: sets[%d]'s effort range is inverted", ErrInvalidInput, i)
		}
	}
	return nil
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
	Public bool  // include public plans (VOLA-authored + other users')
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
	// Rename changes a workout's name, owner-only. Separate from ReplaceItems
	// rather than folded into one update: the two are edited from different
	// places at different times, and a combined call would make renaming a
	// template require sending its whole item list back.
	Rename(ctx context.Context, userID, workoutID, name string) (*Workout, error)
	// Delete removes a workout, owner-only.
	Delete(ctx context.Context, userID, id string) error
	// Copy duplicates a workout the caller can SEE into one they OWN, with its
	// items, and returns the new one.
	//
	// **Visibility is the gate, not ownership** — and here that genuinely
	// includes other athletes, unlike sequences: `visibleTo` has a public arm,
	// so a community template published by somebody else is copyable by
	// design. That is what the browse shelf is FOR; without a copy path the
	// seeded plans are something you can read and never use.
	//
	// The copy lands PRIVATE regardless of what it was copied from, and owned
	// outright, so editing it cannot touch the original and a deploy
	// refreshing a seeded plan cannot reach into it.
	Copy(ctx context.Context, userID, id string) (*Workout, error)
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
