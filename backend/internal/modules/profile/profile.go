// Package profile is the athlete profile domain: the account-level record
// linked to a Clerk user (module toggles, basic bio fields used for
// calorie/1RM calculations). BJJ-specific profile data (belt, stripes,
// academy, promotion history) belongs to the future bjj module, not here.
package profile

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"
)

var (
	ErrNotFound      = errors.New("profile: not found")
	ErrAlreadyExists = errors.New("profile: already exists")
	ErrInvalidInput  = errors.New("profile: invalid input")
	// ErrUsernameTaken is distinct from ErrAlreadyExists on purpose: both are
	// 409s, but "this profile already exists" and "somebody else has that
	// handle" are different facts and the client copy for them cannot be one
	// sentence. The repository tells them apart by constraint name.
	ErrUsernameTaken = errors.New("profile: username taken")
)

// Profile no longer carries module toggles. They moved to profile_modules
// rows behind GET/PATCH /v1/modules — see migration 000020 and the
// internal/platform/discipline registry. Four boolean columns meant a
// migration and ~13 unchecked edit sites per new discipline; rows mean none.
type Profile struct {
	UserID string `json:"user_id"`
	// Username is the unique, claimable handle — the lookup key the sharing
	// design is built on. Nil until claimed; claiming is opt-in until sharing
	// ships. Lowercase by validation ([a-z][a-z0-9_]{2,29}), case-insensitive
	// by index — see migration 000040 for the split of those two duties.
	//
	// DisplayName stays what it always was: free prose for showing, never for
	// finding. The two fields answer different questions and neither can do
	// the other's job.
	Username    *string `json:"username"`
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
//
// Username follows that rule, which means a claimed handle cannot be CLEARED
// through this path, only renamed. Deliberate: nothing references usernames by
// value (friends and shares will key on user_id), so a rename is free — but
// un-claiming has no consumer yet, and the module's nil-means-unchanged
// convention would need a Set flag to express it. Add that when someone
// actually needs to release a handle.
type ProfileUpdate struct {
	Username    *string
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

// usernamePattern is the whole format rule: 3–30 characters, lowercase
// letters, digits and underscore, starting with a letter.
//
// Lowercase-only rather than case-preserving-with-case-insensitive-compare:
// the catalog already has DisplayName for how a person wants their name to
// LOOK, so the handle can be strictly canonical — one spelling, no "is
// @Dmytro the same as @dmytro" question anywhere in the system. Starting with
// a letter keeps a handle from ever being confusable with a numeric id.
var usernamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,29}$`)

// ValidUsername reports whether a handle is claimable at all — format first,
// then the reserved list.
func ValidUsername(u string) bool {
	return usernamePattern.MatchString(u) && !reservedUsernames[u]
}

// reservedUsernames are handles nobody may claim.
//
// Two kinds live here, and both matter: names that would let an account
// impersonate the product or its staff (admin, vola, support…), and names
// that collide with words the UI or future routes use as path segments or
// pronouns (me, you, settings…). Validated in Go per the 000021 convention —
// this list will grow, and growing it must be a code change, not a migration.
var reservedUsernames = map[string]bool{
	"admin": true, "administrator": true, "moderator": true, "mod": true,
	"staff": true, "support": true, "help": true, "official": true,
	"security": true, "system": true, "root": true, "api": true,
	"vola": true, "formspan": true, "team": true,
	"me": true, "you": true, "self": true, "user": true, "users": true,
	"profile": true, "settings": true, "account": true, "friends": true,
	"share": true, "shares": true, "about": true, "everyone": true,
	"anonymous": true, "unknown": true, "deleted": true,
	"null": true, "undefined": true, "none": true, "test": true,
}
