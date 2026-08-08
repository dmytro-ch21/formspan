// Package body is the check-in domain: what the athlete weighs, what they
// measure, and what they are currently trying to do about it.
//
// # Two things, not one
//
// A **check-in** is a measurement taken on a calendar day. A **phase** is an
// intent that spans months — a cut, a lean bulk, making weight for a division.
// They are separate because they change on completely different clocks, and
// because a rate means nothing without both: "down 1.2kg in nine days" is only
// good or bad relative to what you were trying to do.
//
// # Why the goal is a span and not a field
//
// The smaller design is a `body_goal` column on the profile. It cannot express
// the case this product actually has: a BJJ athlete making 77.1kg by a specific
// Saturday. A target with no date has no rate, and a rate is the only thing
// that can tell somebody they are cutting too fast. Spans also keep history —
// the numbers you recorded in March are only readable against the phase you
// were in during March.
//
// # What this module deliberately does not do
//
// **It does not compute.** Trend weight, rate-versus-target, waist-to-height
// and the body-fat estimate are all derived, and they are derived on the
// client (`apps/mobile/lib/anthropometry.ts`) so the check-in card works with
// no signal — which is where a bathroom scale actually is. This module stores
// measurements and hands them back. The one exception is validation, because a
// number the server accepts is a number the server has to be able to explain.
package body

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var (
	ErrNotFound     = errors.New("body: not found")
	ErrInvalidInput = errors.New("body: invalid input")
	// ErrPhaseActive is a 409 rather than a 400: starting a second phase is a
	// legitimate request that conflicts with existing state, and the client's
	// answer is "end the current one first" rather than "fix your input".
	ErrPhaseActive = errors.New("body: a phase is already running")
)

// PhaseKind is what the athlete is trying to do.
//
// The vocabulary is the one the field actually uses, which is not the one a
// general fitness app uses: a "cut" is an energy deficit, a "lean bulk" a
// controlled surplus, a "recomposition" both at once, and "making weight" is
// the one specific to combat sport — a division, on a date.
//
// **Deliberately NOT the same type as a workout's Goal.** That one is
// powerlifting / hypertrophy / endurance, and it describes how a programme is
// written. They are different axes: a hypertrophy block runs perfectly well
// inside a cut, and one type covering both would make that unsayable.
type PhaseKind string

const (
	KindCut           PhaseKind = "cut"
	KindLeanBulk      PhaseKind = "lean_bulk"
	KindRecomposition PhaseKind = "recomposition"
	KindMaintenance   PhaseKind = "maintenance"
	KindMakingWeight  PhaseKind = "making_weight"
)

// PhaseKinds is the source of truth for the vocabulary — a client renders a
// picker from it, and the validator checks against it, so the two cannot
// disagree.
var PhaseKinds = []PhaseKind{
	KindCut, KindLeanBulk, KindRecomposition, KindMaintenance, KindMakingWeight,
}

func (k PhaseKind) valid() bool {
	for _, v := range PhaseKinds {
		if v == k {
			return true
		}
	}
	return false
}

// Side is which side the limb girths were taken on.
//
// One value per check-in rather than one per site: the rule that matters is
// consistency, and an athlete measuring a left thigh and a right arm has two
// series that cannot be compared to anything, including each other.
type Side string

const (
	SideLeft  Side = "left"
	SideRight Side = "right"
)

// Phase is one span of intent.
type Phase struct {
	ID     string    `json:"id"`
	UserID string    `json:"user_id"`
	Kind   PhaseKind `json:"kind"`

	StartedOn string `json:"started_on"` // "YYYY-MM-DD"
	// TargetOn is when the athlete intends to be done. Required for
	// making_weight — a division has a date — and optional otherwise.
	TargetOn       *string  `json:"target_on"`
	TargetWeightKG *float64 `json:"target_weight_kg"`
	// EndedOn is nil while the phase is the live one.
	EndedOn *string `json:"ended_on"`
	Notes   string  `json:"notes"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Checkin is one day's measurements.
//
// Every measure is a pointer, and independently so. The daily check-in is a
// weight and nothing else; a weekly one adds whichever girths the athlete
// actually takes. Requiring the set would turn a ten-second habit into a
// five-minute one, and the habit is the whole feature.
type Checkin struct {
	UserID     string `json:"user_id"`
	MeasuredOn string `json:"measured_on"` // "YYYY-MM-DD"

	WeightKG *float64 `json:"weight_kg"`

	NeckCM      *float64 `json:"neck_cm"`
	ShouldersCM *float64 `json:"shoulders_cm"`
	ChestCM     *float64 `json:"chest_cm"`
	WaistCM     *float64 `json:"waist_cm"`
	HipsCM      *float64 `json:"hips_cm"`
	ThighCM     *float64 `json:"thigh_cm"`
	CalfCM      *float64 `json:"calf_cm"`
	UpperArmCM  *float64 `json:"upper_arm_cm"`
	ForearmCM   *float64 `json:"forearm_cm"`

	MeasuredSide Side `json:"measured_side"`

	// PhotoKey is the storage key, never a URL, and it is **not serialised to
	// clients**. A client receives `photo_url` instead — a short-lived
	// presigned link the handler mints per response — so the bucket layout
	// never reaches an app and a key alone grants nothing.
	PhotoKey *string `json:"-"`
	// PhotoURL is presigned and expires. Absent when there is no photo, or when
	// object storage is not configured.
	PhotoURL string `json:"photo_url,omitempty"`

	Notes string `json:"notes"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// girths returns every circumference with the label the error message uses, so
// validation and the client speak the same vocabulary.
func (c *Checkin) girths() []struct {
	name string
	v    *float64
	max  float64
} {
	return []struct {
		name string
		v    *float64
		max  float64
	}{
		{"neck", c.NeckCM, 100},
		{"shoulders", c.ShouldersCM, 250},
		{"chest", c.ChestCM, 250},
		{"waist", c.WaistCM, 250},
		{"hips", c.HipsCM, 250},
		{"thigh", c.ThighCM, 150},
		{"calf", c.CalfCM, 100},
		{"upper arm", c.UpperArmCM, 100},
		{"forearm", c.ForearmCM, 100},
	}
}

// Validate rejects what the schema's CHECK constraints would reject, with a
// sentence instead of a constraint name.
//
// The bounds are **sanity rails against a mis-keyed decimal**, not medical
// limits: a 700cm waist is a typo and a 7kg bodyweight is a typo, and catching
// them here is what stops one bad row dragging every derived average with it.
// Nothing here has an opinion about whether a real measurement is healthy.
func (c *Checkin) Validate() error {
	if !isDate(c.MeasuredOn) {
		return fmt.Errorf("%w: measured_on must be a date, as YYYY-MM-DD", ErrInvalidInput)
	}
	if c.MeasuredSide != "" && c.MeasuredSide != SideLeft && c.MeasuredSide != SideRight {
		return fmt.Errorf("%w: measured_side must be left or right", ErrInvalidInput)
	}
	if c.WeightKG != nil && (*c.WeightKG <= 0 || *c.WeightKG >= 500) {
		return fmt.Errorf("%w: weight must be between 0 and 500 kg", ErrInvalidInput)
	}
	for _, g := range c.girths() {
		if g.v != nil && (*g.v <= 0 || *g.v >= g.max) {
			return fmt.Errorf("%w: %s must be between 0 and %g cm", ErrInvalidInput, g.name, g.max)
		}
	}
	// A row with nothing on it is not a check-in. Rejecting it keeps an empty
	// save from creating a day that the trend then has to skip over.
	if c.WeightKG == nil && c.PhotoKey == nil && c.Notes == "" && !c.hasGirth() {
		return fmt.Errorf("%w: a check-in needs at least one measurement", ErrInvalidInput)
	}
	return nil
}

func (c *Checkin) hasGirth() bool {
	for _, g := range c.girths() {
		if g.v != nil {
			return true
		}
	}
	return false
}

// Validate checks a phase's own coherence.
//
// The date ordering is also a CHECK constraint; it is repeated here because a
// constraint violation cannot say *which* date is the problem, and "a weigh-in
// date is what makes this a target" is the sentence that actually helps.
func (p *Phase) Validate() error {
	if !p.Kind.valid() {
		return fmt.Errorf("%w: unknown phase kind %q", ErrInvalidInput, p.Kind)
	}
	if !isDate(p.StartedOn) {
		return fmt.Errorf("%w: started_on must be a date, as YYYY-MM-DD", ErrInvalidInput)
	}
	if p.TargetOn != nil {
		if !isDate(*p.TargetOn) {
			return fmt.Errorf("%w: target_on must be a date, as YYYY-MM-DD", ErrInvalidInput)
		}
		if *p.TargetOn < p.StartedOn {
			return fmt.Errorf("%w: target_on cannot be before started_on", ErrInvalidInput)
		}
	}
	if p.EndedOn != nil {
		if !isDate(*p.EndedOn) {
			return fmt.Errorf("%w: ended_on must be a date, as YYYY-MM-DD", ErrInvalidInput)
		}
		if *p.EndedOn < p.StartedOn {
			return fmt.Errorf("%w: ended_on cannot be before started_on", ErrInvalidInput)
		}
	}
	if p.TargetWeightKG != nil && (*p.TargetWeightKG <= 0 || *p.TargetWeightKG >= 500) {
		return fmt.Errorf("%w: target weight must be between 0 and 500 kg", ErrInvalidInput)
	}
	// Making weight without a date or a number is not making weight — it is a
	// cut with extra words, and the client's countdown has nothing to count.
	if p.Kind == KindMakingWeight {
		if p.TargetOn == nil {
			return fmt.Errorf("%w: making weight needs the date you weigh in on", ErrInvalidInput)
		}
		if p.TargetWeightKG == nil {
			return fmt.Errorf("%w: making weight needs the weight you have to make", ErrInvalidInput)
		}
	}
	return nil
}

// isDate accepts exactly "YYYY-MM-DD" and rejects anything Go would otherwise
// coerce. String comparison is used for ordering elsewhere in this file, which
// is only sound because the format is fixed-width — hence the strictness.
func isDate(s string) bool {
	if len(s) != 10 {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

// Repository is the storage port.
//
// `SaveCheckin` is an upsert keyed on (user, day) rather than a create/update
// pair, which is what makes a re-sent offline check-in idempotent — the same
// contract the activity outbox and session push already rely on.
type Repository interface {
	ListCheckins(ctx context.Context, userID, from, to string) ([]Checkin, error)
	GetCheckin(ctx context.Context, userID, on string) (Checkin, error)
	SaveCheckin(ctx context.Context, c Checkin) (Checkin, error)
	// AttachPhotoKey writes ONLY the photo key.
	//
	// Separate from SaveCheckin because that path replaces notes by design —
	// so minting an upload URL through it erased whatever the athlete had
	// written that morning, and reset `measured_side` on the way past. An
	// internal partial write has no business going through the full-save
	// contract. Raised in review.
	AttachPhotoKey(ctx context.Context, userID, on, key string) (Checkin, error)
	DeleteCheckin(ctx context.Context, userID, on string) error

	ListPhases(ctx context.Context, userID string) ([]Phase, error)
	ActivePhase(ctx context.Context, userID string) (Phase, error)
	CreatePhase(ctx context.Context, p Phase) (Phase, error)
	EndPhase(ctx context.Context, userID, id, on string) (Phase, error)
}
