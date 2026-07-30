// Package profile is the athlete profile domain: the account-level record
// linked to a Clerk user (module toggles, basic bio fields used for
// calorie/1RM calculations). BJJ-specific profile data (belt, stripes,
// academy, promotion history) belongs to the future bjj module, not here.
package profile

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound      = errors.New("profile: not found")
	ErrAlreadyExists = errors.New("profile: already exists")
	ErrInvalidInput  = errors.New("profile: invalid input")
)

type Profile struct {
	UserID           string  `json:"user_id"`
	DisplayName      *string `json:"display_name"`
	DateOfBirth      *string `json:"date_of_birth"` // "YYYY-MM-DD"
	Sex              *string `json:"sex"`           // "male" | "female" | null
	BJJEnabled       bool    `json:"bjj_enabled"`
	StrengthEnabled  bool    `json:"strength_enabled"`
	NutritionEnabled bool    `json:"nutrition_enabled"`
	RunningEnabled   bool    `json:"running_enabled"`
	// UnitSystem is display only — "metric" | "imperial". Training data is
	// stored in kilograms and metres regardless, so changing it can never
	// alter a recorded number, only how it's shown and entered.
	UnitSystem string `json:"unit_system"`
	// TrackEffort decides whether the clients collect RIR and RPE at all.
	// On by default: the progression rule is built on them, and silently
	// withholding its only input would make the app look broken rather
	// than simple.
	TrackEffort bool      `json:"track_effort"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// NewProfile is the input for onboarding. Module toggles aren't set here —
// they take their DB defaults (BJJ/strength/nutrition on, running off) and
// get changed afterward via Update, matching the J1 onboarding flow.
type NewProfile struct {
	DisplayName *string
	DateOfBirth *string
	Sex         *string
}

// ProfileUpdate is a partial update — nil fields are left unchanged.
type ProfileUpdate struct {
	DisplayName      *string
	DateOfBirth      *string
	Sex              *string
	BJJEnabled       *bool
	StrengthEnabled  *bool
	NutritionEnabled *bool
	RunningEnabled   *bool
	UnitSystem       *string
	TrackEffort      *bool
}

// ValidUnitSystem guards the only two the clients can render.
func ValidUnitSystem(v string) bool { return v == "metric" || v == "imperial" }

type Repository interface {
	Get(ctx context.Context, userID string) (*Profile, error)
	// ListExerciseUnits returns the caller's per-exercise overrides. A missing
	// key means "use the profile default" — there is deliberately no third
	// state, so clearing an override is a delete rather than a value.
	ListExerciseUnits(ctx context.Context, userID string) (map[string]string, error)
	// SetExerciseUnit stores an override, or removes it when unit is empty.
	SetExerciseUnit(ctx context.Context, userID, exerciseID, unit string) error
	Create(ctx context.Context, userID string, in NewProfile) (*Profile, error)
	Update(ctx context.Context, userID string, in ProfileUpdate) (*Profile, error)
}
