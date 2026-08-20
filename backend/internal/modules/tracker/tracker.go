// Package tracker is the daily-tracker model: one definition table, one entry
// table, and everything that distinguishes water from coffee from creatine
// living in columns rather than in code.
//
// # Read this before adding a field
//
// `Patch` below is the ONLY way a stored tracker field changes. That is not a
// stylistic preference — it is the guard against the failure this module was
// commissioned to avoid, which this repository has on file three times:
// `exercise`'s updateWithin blanked authored data in migrations 000052, 000057
// and 000061, each time because a column was added to a full-row SET clause and
// the restore path then wrote an empty value over a real one. All three were
// caught in review; none was caught by the suite.
//
// So the SET clause here is BUILT FROM THE PATCH, never written out. A field
// the caller did not mention is not in the statement at all, and therefore
// cannot be blanked. `patch_test.go` enumerates `Patch`'s fields by reflection
// and fails if one is unwired in either direction, so the fourth instance of
// that bug fails on the PR that introduces it rather than in review.
package tracker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

var (
	ErrNotFound      = errors.New("tracker: not found")
	ErrAlreadyExists = errors.New("tracker: already exists")
	ErrInvalidInput  = errors.New("tracker: invalid input")
)

// RenderStyle is how a tracker draws itself. Stored, so N78's athlete can
// override the automatic choice, and defaulted to "auto" so nobody has to.
const (
	RenderAuto   = "auto"
	RenderGlyphs = "glyphs"
	RenderBar    = "bar"
	RenderDose   = "dose"
)

var renderStyles = map[string]bool{
	RenderAuto: true, RenderGlyphs: true, RenderBar: true, RenderDose: true,
}

// The units a tracker may count in. Deliberately a small closed set: these are
// the ones the clients know how to render and convert, and an open string would
// let an athlete author a tracker no screen can display.
//
// "" is legal and means a bare count — "sessions", "cold showers".
var units = map[string]bool{
	"": true, "ml": true, "g": true, "mg": true, "cup": true, "dose": true, "count": true,
}

// A colour KEY, not a hex.
//
// The membership list lives with the palette (apps/mobile/constants/Colors.ts's
// `trackerColors`, which `scripts/validate_palette.mjs` measures for contrast
// and colour-blind separation). It is deliberately NOT restated here: a second
// copy of a list is a list that diverges, and this module has no way to check
// contrast anyway. What is enforced here is shape, so the column cannot become
// a dumping ground, and the client maps an unknown key to its default rather
// than rendering something illegible.
var colorKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,23}$`)

// Tracker is one athlete's daily tracker.
//
// **Every mutable field here has a matching field in Patch**, and
// `TestPatchCoversEveryMutableField` fails if that stops being true. Adding a
// column to this struct without adding it to Patch is how a field becomes
// un-editable; adding it to Patch without wiring `patchColumns` is how it
// becomes un-writable. Both are caught.
type Tracker struct {
	ID     string `json:"id"`
	UserID string `json:"user_id"`
	// Provisioning key; see the migration. Immutable — a preset row that
	// renamed its own preset would be provisioned a second time.
	Preset string `json:"preset"`

	Name        string   `json:"name"`
	Icon        string   `json:"icon"`
	ColorKey    string   `json:"color_key"`
	Unit        string   `json:"unit"`
	Increment   float64  `json:"increment"`
	Target      *float64 `json:"target"`
	RenderStyle string   `json:"render_style"`
	SortOrder   int      `json:"sort_order"`

	ArchivedAt *time.Time `json:"archived_at"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

// Entry is one tap.
type Entry struct {
	ID        string    `json:"id"`
	TrackerID string    `json:"tracker_id"`
	UserID    string    `json:"user_id"`
	LoggedOn  string    `json:"logged_on"`
	LoggedAt  time.Time `json:"logged_at"`
	Amount    float64   `json:"amount"`
	CreatedAt time.Time `json:"created_at"`
}

// Field distinguishes the three states a JSON key can be in, which `*T` cannot.
//
//	absent from the body   -> Set == false            -> column not touched
//	present and null       -> Set == true, Value nil  -> column set to NULL
//	present with a value   -> Set == true, Value set  -> column set to it
//
// The middle case is not academic: `target` is nullable because coffee is a
// count with no ceiling, so "clear my target" and "do not touch my target" are
// both things a PATCH has to be able to say. With `*float64` they are the same
// wire shape, and one of them silently wins.
type Field[T any] struct {
	Set   bool
	Value *T
}

// UnmarshalJSON runs only when the key is PRESENT in the object — that is the
// whole mechanism. encoding/json never calls it for an absent key, so `Set`
// stays false and the column stays out of the statement.
func (f *Field[T]) UnmarshalJSON(b []byte) error {
	f.Set = true
	if string(b) == "null" {
		f.Value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	f.Value = &v
	return nil
}

// MarshalJSON exists so a Patch can round-trip in tests and logs; an unset
// field marshals as null, which is lossy, and nothing depends on it.
func (f Field[T]) MarshalJSON() ([]byte, error) { return json.Marshal(f.Value) }

// Of builds a set field. For tests and for callers assembling a patch in Go.
func Of[T any](v T) Field[T] { return Field[T]{Set: true, Value: &v} }

// Null builds a field explicitly set to null.
func Null[T any]() Field[T] { return Field[T]{Set: true} }

// Patch is a partial update. See the package doc.
type Patch struct {
	Name        Field[string]  `json:"name"`
	Icon        Field[string]  `json:"icon"`
	ColorKey    Field[string]  `json:"color_key"`
	Unit        Field[string]  `json:"unit"`
	Increment   Field[float64] `json:"increment"`
	Target      Field[float64] `json:"target"`
	RenderStyle Field[string]  `json:"render_style"`
	SortOrder   Field[int]     `json:"sort_order"`
}

// patchColumn is one column the patch actually names.
type patchColumn struct {
	name  string
	value any
}

// patchColumns is the single place a Patch field becomes a column.
//
// It returns only what the caller SET. That is what makes an unmentioned field
// impossible to blank: the column never appears in the UPDATE at all. There is
// no `else` branch writing a zero value, and there must never be one.
func patchColumns(p Patch) []patchColumn {
	var cols []patchColumn
	add := func(name string, set bool, v any) {
		if set {
			cols = append(cols, patchColumn{name: name, value: v})
		}
	}
	// Written out per field rather than by reflection: reflection here would
	// make the wiring invisible, and the test that guards it uses reflection
	// precisely so the two cannot agree with each other by construction.
	add("name", p.Name.Set, deref(p.Name.Value))
	add("icon", p.Icon.Set, deref(p.Icon.Value))
	add("color_key", p.ColorKey.Set, deref(p.ColorKey.Value))
	add("unit", p.Unit.Set, deref(p.Unit.Value))
	add("increment", p.Increment.Set, deref(p.Increment.Value))
	// Target keeps its pointer: nil here is a real value (SQL NULL), where for
	// the others nil would mean "null into a NOT NULL column" and is rejected
	// by Validate before it reaches the database.
	add("target", p.Target.Set, p.Target.Value)
	add("render_style", p.RenderStyle.Set, deref(p.RenderStyle.Value))
	add("sort_order", p.SortOrder.Set, deref(p.SortOrder.Value))
	return cols
}

// deref turns a nil pointer into a typed zero. Only reached for NOT NULL
// columns, and only after Validate has refused an explicit null for one.
func deref[T any](p *T) any {
	if p == nil {
		var zero T
		return zero
	}
	return *p
}

// Validate checks a patch in isolation — the fields it names, nothing else.
//
// It cannot check the RESULT of applying the patch, and that matters: "is the
// target a whole number of increments" is a question about the merged row, and
// deliberately not asked. An athlete whose target is 2000 ml and increment 250
// who then sets the increment to 300 gets 6.67 cups, and the client renders 7
// glyphs with the last one partly filled rather than the server refusing an
// edit that is not wrong.
func (p Patch) Validate() error {
	if p.Name.Set {
		if p.Name.Value == nil || *p.Name.Value == "" {
			return fmt.Errorf("%w: name is required", ErrInvalidInput)
		}
		if len(*p.Name.Value) > 60 {
			return fmt.Errorf("%w: name is too long", ErrInvalidInput)
		}
	}
	if p.Icon.Set {
		if p.Icon.Value == nil {
			return fmt.Errorf("%w: icon cannot be null; use an empty string", ErrInvalidInput)
		}
		if len(*p.Icon.Value) > 16 {
			return fmt.Errorf("%w: icon is too long", ErrInvalidInput)
		}
	}
	if p.ColorKey.Set {
		if p.ColorKey.Value == nil || !colorKeyPattern.MatchString(*p.ColorKey.Value) {
			return fmt.Errorf("%w: color_key must be a lowercase palette key", ErrInvalidInput)
		}
	}
	if p.Unit.Set {
		if p.Unit.Value == nil || !units[*p.Unit.Value] {
			return fmt.Errorf("%w: unrecognised unit", ErrInvalidInput)
		}
	}
	if p.Increment.Set {
		if p.Increment.Value == nil || !(*p.Increment.Value > 0) {
			return fmt.Errorf("%w: increment must be greater than zero", ErrInvalidInput)
		}
	}
	// Target is the one field for which null is legal — it is how an athlete
	// says "no ceiling, just count".
	if p.Target.Set && p.Target.Value != nil && !(*p.Target.Value > 0) {
		return fmt.Errorf("%w: target must be greater than zero, or null for no target", ErrInvalidInput)
	}
	if p.RenderStyle.Set {
		if p.RenderStyle.Value == nil || !renderStyles[*p.RenderStyle.Value] {
			return fmt.Errorf("%w: unrecognised render_style", ErrInvalidInput)
		}
	}
	if p.SortOrder.Set && p.SortOrder.Value == nil {
		return fmt.Errorf("%w: sort_order cannot be null", ErrInvalidInput)
	}
	return nil
}

// IsEmpty reports a patch that names nothing.
//
// Rejected rather than treated as a no-op: a PATCH whose body did not decode
// into any known field is far more likely a client sending the wrong shape than
// an athlete asking for nothing, and answering 200 to it hides that for as long
// as nobody looks at the screen.
func (p Patch) IsEmpty() bool { return len(patchColumns(p)) == 0 }

// New is everything needed to create a tracker. Unlike Patch this is complete
// by construction, so there is no partial-write hazard on the create path — and
// therefore no second dynamic SET clause anywhere in this module.
type New struct {
	ID          string   `json:"id"`
	Preset      string   `json:"preset"`
	Name        string   `json:"name"`
	Icon        string   `json:"icon"`
	ColorKey    string   `json:"color_key"`
	Unit        string   `json:"unit"`
	Increment   float64  `json:"increment"`
	Target      *float64 `json:"target"`
	RenderStyle string   `json:"render_style"`
	SortOrder   int      `json:"sort_order"`
}

// Validate reuses the patch validator by expressing New as a complete patch, so
// the two can never disagree about what a legal name or unit is.
func (n New) Validate() error {
	if n.ID == "" {
		return fmt.Errorf("%w: id is required", ErrInvalidInput)
	}
	if len(n.ID) > 64 {
		return fmt.Errorf("%w: id is too long", ErrInvalidInput)
	}
	if len(n.Preset) > 32 {
		return fmt.Errorf("%w: preset is too long", ErrInvalidInput)
	}
	p := Patch{
		Name:        Of(n.Name),
		Icon:        Of(n.Icon),
		ColorKey:    Of(n.ColorKey),
		Unit:        Of(n.Unit),
		Increment:   Of(n.Increment),
		RenderStyle: Of(n.RenderStyle),
		SortOrder:   Of(n.SortOrder),
	}
	if n.Target != nil {
		p.Target = Of(*n.Target)
	} else {
		p.Target = Null[float64]()
	}
	return p.Validate()
}

// NewEntry is one tap, as the client describes it.
type NewEntry struct {
	ID       string    `json:"id"`
	LoggedOn string    `json:"logged_on"`
	LoggedAt time.Time `json:"logged_at"`
	Amount   float64   `json:"amount"`
}

func (e NewEntry) Validate() error {
	if e.ID == "" || len(e.ID) > 64 {
		return fmt.Errorf("%w: entry id is required", ErrInvalidInput)
	}
	if !IsDate(e.LoggedOn) {
		return fmt.Errorf("%w: logged_on must be YYYY-MM-DD", ErrInvalidInput)
	}
	if e.LoggedAt.IsZero() {
		return fmt.Errorf("%w: logged_at is required", ErrInvalidInput)
	}
	if !(e.Amount > 0) {
		return fmt.Errorf("%w: amount must be greater than zero", ErrInvalidInput)
	}
	return nil
}

// IsDate accepts exactly "YYYY-MM-DD".
//
// Copied in spirit from body.isDate, and strict for the same reason: dates are
// compared and ordered as strings throughout this module, which is only sound
// while the format is fixed-width. time.Parse alone would accept "2026-1-1".
func IsDate(s string) bool {
	if len(s) != 10 {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

// Repository is the storage port.
type Repository interface {
	// EnsureDefaults provisions the default presets for an athlete who has none
	// of them yet. Idempotent by the (user_id, preset) unique index rather than
	// by a "have I done this" flag, so two concurrent calls converge.
	EnsureDefaults(ctx context.Context, userID string, presets []New) error
	// List returns the athlete's live trackers, archived ones excluded.
	List(ctx context.Context, userID string) ([]Tracker, error)
	// Create stores a new tracker. Idempotent on the client-supplied id.
	Create(ctx context.Context, userID string, in New) (*Tracker, error)
	// Update applies a partial patch. Fields the patch does not name are left
	// exactly as they are — the guarantee this whole module is built around.
	Update(ctx context.Context, userID, id string, p Patch) (*Tracker, error)
	// Archive hides a tracker without touching its entries.
	Archive(ctx context.Context, userID, id string) error
	// Entries returns every entry across the athlete's trackers in a local-day
	// window, oldest first. One request serves a whole screen of cards.
	Entries(ctx context.Context, userID, from, to string) ([]Entry, error)
	// LogEntry records one tap. Idempotent on the client-supplied id.
	LogEntry(ctx context.Context, userID, trackerID string, in NewEntry) (*Entry, error)
	// DeleteEntry removes one tap. Deleting one that is already gone is not an
	// error — a retried delete is the common case on a flaky connection.
	DeleteEntry(ctx context.Context, userID, trackerID, entryID string) error
}
