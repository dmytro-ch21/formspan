// Package profile is the athlete profile domain: the account-level record
// linked to a Clerk user (module toggles, basic bio fields used for
// calorie/1RM calculations). BJJ-specific profile data (belt, stripes,
// academy, promotion history) belongs to the future bjj module, not here.
package profile

import (
	"context"
	"errors"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"
)

var (
	ErrNotFound      = errors.New("profile: not found")
	ErrAlreadyExists = errors.New("profile: already exists")
	ErrInvalidInput  = errors.New("profile: invalid input")
)

// Profile no longer carries module toggles. They moved to profile_modules
// rows behind GET/PATCH /v1/modules — see migration 000020 and the
// internal/platform/discipline registry. Four boolean columns meant a
// migration and ~13 unchecked edit sites per new discipline; rows mean none.
type Profile struct {
	UserID      string  `json:"user_id"`
	DisplayName *string `json:"display_name"`
	DateOfBirth *string `json:"date_of_birth"` // "YYYY-MM-DD"
	Sex         *string `json:"sex"`           // "male" | "female" | null
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

// NewProfile is the input for onboarding. Module enablement isn't set here —
// a user with no profile_modules row falls back to the registry's DefaultOn,
// which is what makes adding a discipline need no backfill.
type NewProfile struct {
	DisplayName *string
	DateOfBirth *string
	Sex         *string
}

// ProfileUpdate is a partial update — nil fields are left unchanged.
type ProfileUpdate struct {
	DisplayName *string
	DateOfBirth *string
	Sex         *string
	UnitSystem  *string
	TrackEffort *bool
}

// Module is one discipline as a client sees it: the registry's definition
// plus whether THIS user has it on. Served together so a client needs one
// request to render nav, chips and capabilities.
type Module struct {
	discipline.Module
	Enabled bool `json:"enabled"`
}

// ModulesFor merges the registry with a user's stored choices. A module with
// no stored row falls back to its registry default — the property that lets a
// new discipline ship without touching anyone's data.
func ModulesFor(stored map[string]bool) []Module {
	all := discipline.All()
	out := make([]Module, 0, len(all))
	for _, m := range all {
		enabled, ok := stored[m.Key]
		if !ok {
			enabled = m.DefaultOn
		}
		out = append(out, Module{Module: m, Enabled: enabled})
	}
	return out
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
	// ListModules returns only the choices this user has actually stored.
	// Absent keys are the caller's business — see ModulesFor — because the
	// default lives in the registry, not the database.
	ListModules(ctx context.Context, userID string) (map[string]bool, error)
	// SetModules upserts the given keys. Keys the caller doesn't mention are
	// left alone, so a client can PATCH one toggle without sending the rest.
	SetModules(ctx context.Context, userID string, enabled map[string]bool) error
}
