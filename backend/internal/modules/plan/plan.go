// Package plan is the training-plan domain: what an athlete intends to train,
// and on which day.
//
// It sits between `workout` (the template — what a session looks like) and
// `session` (what actually happened). Keeping all three apart is what makes
// prescribed-vs-actual answerable: a template has no date, a session is the
// actual, and neither can say what Tuesday was *for*.
//
// A plan is an intention. Nothing here ever marks one done: there is no status
// field, and the server never joins plans to sessions. Adherence is computed by
// the client on read — see `apps/mobile/lib/adherence.ts` for the rule and what
// it gives up, and the migration for why it stayed out of the database.
package plan

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrNotFound      = errors.New("plan: not found")
	ErrAlreadyExists = errors.New("plan: already exists")
	ErrInvalidInput  = errors.New("plan: invalid input")
)

// DayLayout is the only accepted form of `day` on the wire: a calendar date,
// no time, no zone. Matching the column type — see the migration for why a
// plan is dated rather than timestamped.
const DayLayout = "2006-01-02"

// MaxNotesLen mirrors the plans_notes_len CHECK. Enforced here too so the
// caller gets "notes are too long" rather than a constraint name.
const MaxNotesLen = 500

// Plan is one intended session on one day.
//
// `Day` is a string rather than a time.Time deliberately. It is a calendar
// square, and every round trip through time.Time invites a zone: marshalled as
// RFC3339 it would gain a midnight and a UTC offset, and a client in Los
// Angeles reading "2026-08-04T00:00:00Z" renders it as the 3rd. The JSON
// contract is "YYYY-MM-DD" and the type that survives that unchanged is a
// string.
type Plan struct {
	ID        string  `json:"id"`
	UserID    string  `json:"user_id"`
	Day       string  `json:"day"`
	Sport     string  `json:"sport"`
	WorkoutID *string `json:"workout_id"`
	// ClassPlanID points at a coach's class plan (`internal/modules/classplan`)
	// instead of a workout template — a scheduled BJJ class rather than a
	// scheduled strength/running session. Mutually exclusive with WorkoutID:
	// see the migration's `plans_one_template_kind` CHECK and this package's
	// Create/Update in postgres.go, which enforce the same rule ahead of the
	// database so the caller gets a message naming the conflict.
	ClassPlanID *string   `json:"class_plan_id"`
	Notes       string    `json:"notes"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// NewPlan is the input for creating one. The ID is client-supplied — the same
// contract sessions and activities use, and what makes an offline plan
// syncable without duplicating on retry.
type NewPlan struct {
	ID          string
	Day         string
	Sport       string
	WorkoutID   *string
	ClassPlanID *string
	Notes       string
}

// OptionalWorkoutID is a `workout_id` that can be absent, explicitly null, or
// set — three states, which a pointer cannot carry.
//
// **A `**string` does NOT work here, despite looking like it should.** For a
// settable pointer field `encoding/json` handles a literal `null` by calling
// `SetZero()` on the field itself, so `{"workout_id": null}` and `{}` both
// leave the outer pointer nil and are indistinguishable. That was the first
// implementation, and it made "clear the template" a silent no-op — the exact
// failure the three-state design exists to prevent. Verified against the
// stdlib rather than reasoned about.
//
// A named type with its own UnmarshalJSON works because `encoding/json`
// documents that it calls Unmarshaler **including when the input is a JSON
// null**, which is the one hook that can observe the difference.
type OptionalWorkoutID struct {
	// Present is true when the key appeared in the body at all.
	Present bool
	// Value is nil when the key appeared as an explicit null.
	Value *string
}

func (o *OptionalWorkoutID) UnmarshalJSON(b []byte) error {
	o.Present = true
	if string(b) == "null" {
		o.Value = nil
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	o.Value = &s
	return nil
}

// OptionalClassPlanID is `class_plan_id`'s three-state field, an exact mirror
// of OptionalWorkoutID for the identical reason — see that type's comment for
// why a `**string` cannot carry "absent" separately from "explicit null".
type OptionalClassPlanID struct {
	Present bool
	Value   *string
}

func (o *OptionalClassPlanID) UnmarshalJSON(b []byte) error {
	o.Present = true
	if string(b) == "null" {
		o.Value = nil
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	o.Value = &s
	return nil
}

// PlanUpdate is a partial update — nil fields are left unchanged.
//
// WorkoutID and ClassPlanID each have three states rather than two: absent
// (leave it alone), set (point at this template/class plan), and explicitly
// null (clear it, so the day is planned as a bare discipline). See
// OptionalWorkoutID for why each is a named type and not a pointer-to-pointer.
//
// The two are mutually exclusive on the resulting row — see Plan.ClassPlanID.
type PlanUpdate struct {
	Day         *string
	Sport       *string
	WorkoutID   OptionalWorkoutID
	ClassPlanID OptionalClassPlanID
	Notes       *string
}

// Range is an inclusive window of calendar days.
//
// Inclusive at both ends because the callers ask in whole weeks and whole
// months: "Monday to Sunday" and "the 1st to the 31st" both name their last
// day, and a half-open range would drop it. Both are "YYYY-MM-DD".
type Range struct {
	From string
	To   string
}

// ValidDay reports whether s is a bare calendar date.
//
// `time.Parse` with DayLayout rejects "2026-08-04T00:00:00Z" and "04/08/2026",
// which is the point: the column is a DATE, and accepting a timestamp here
// would silently truncate it using the server's idea of the zone.
func ValidDay(s string) bool {
	_, err := time.Parse(DayLayout, s)
	return err == nil
}

type Repository interface {
	// List returns the caller's plans in a day range, oldest first.
	List(ctx context.Context, userID string, r Range) ([]Plan, error)
	Get(ctx context.Context, userID, id string) (*Plan, error)
	Create(ctx context.Context, userID string, in NewPlan) (*Plan, error)
	Update(ctx context.Context, userID, id string, in PlanUpdate) (*Plan, error)
	Delete(ctx context.Context, userID, id string) error
}
