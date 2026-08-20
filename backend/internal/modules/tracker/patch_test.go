package tracker

import (
	"encoding/json"
	"reflect"
	"testing"
)

// These tests were written before postgres.go existed, on purpose.
//
// The bug they exist to prevent has shipped in this repository three times
// (exercise.updateWithin, migrations 000052 / 000057 / 000061) and every
// instance was caught by a human reading a diff. The shape is always the same:
// a column is added, the full-row SET clause grows, and a write path that meant
// to touch one field silently blanks another. A test written afterwards tends
// to test the fields that exist; these enumerate them, so the one you forget is
// the one that fails.
//
// `setAll` and `fieldNames` reflect over Patch. `patchColumns` does not — it is
// written out by hand. That asymmetry is deliberate: if both used reflection
// they would agree with each other by construction and prove nothing.

// setAll returns a Patch with every Field marked Set, without naming any of
// them. A new field is included the moment it is declared.
func setAll(t *testing.T) Patch {
	t.Helper()
	var p Patch
	v := reflect.ValueOf(&p).Elem()
	for i := 0; i < v.NumField(); i++ {
		set := v.Field(i).FieldByName("Set")
		if !set.IsValid() || set.Kind() != reflect.Bool {
			t.Fatalf("Patch.%s is not a Field[T] — it has no bool Set. Every patch "+
				"field must be a Field[T] or patchColumns cannot see it.",
				v.Type().Field(i).Name)
		}
		set.SetBool(true)
	}
	return p
}

// setOnly returns a Patch with exactly the i-th field marked Set.
func setOnly(t *testing.T, i int) Patch {
	t.Helper()
	var p Patch
	v := reflect.ValueOf(&p).Elem()
	v.Field(i).FieldByName("Set").SetBool(true)
	return p
}

func patchFieldCount() int { return reflect.TypeOf(Patch{}).NumField() }

// The fourth instance of the updateWithin bug looks exactly like this test
// failing: a column added to the write path with no patch field behind it, or a
// patch field the write path forgot.
func TestPatchColumnsCoversEveryPatchField(t *testing.T) {
	cols := patchColumns(setAll(t))
	if len(cols) != patchFieldCount() {
		t.Fatalf("patchColumns returned %d columns for %d patch fields.\n"+
			"A field with no column is silently un-writable; a column with no "+
			"field is how updateWithin blanked data three times.\ngot: %v",
			len(cols), patchFieldCount(), names(cols))
	}
	seen := map[string]bool{}
	for _, c := range cols {
		if c.name == "" {
			t.Fatal("patchColumns emitted a column with an empty name")
		}
		if seen[c.name] {
			t.Fatalf("patchColumns emitted %q twice — two patch fields write the "+
				"same column, so one of them cannot be observed", c.name)
		}
		seen[c.name] = true
	}
}

// The other half, and the important one: a patch that names nothing must
// produce a statement that touches nothing.
func TestEmptyPatchTouchesNoColumn(t *testing.T) {
	if cols := patchColumns(Patch{}); len(cols) != 0 {
		t.Fatalf("an empty patch produced %v — an unmentioned field must not "+
			"reach the SET clause at all", names(cols))
	}
	if !(Patch{}).IsEmpty() {
		t.Fatal("IsEmpty() is false for a patch that names nothing")
	}
}

// One field set must produce exactly one column. Anything else means a field is
// dragging a neighbour into the statement with it, which is the blanking bug in
// miniature.
func TestOneFieldSetProducesExactlyOneColumn(t *testing.T) {
	pt := reflect.TypeOf(Patch{})
	for i := 0; i < pt.NumField(); i++ {
		name := pt.Field(i).Name
		t.Run(name, func(t *testing.T) {
			cols := patchColumns(setOnly(t, i))
			if len(cols) != 1 {
				t.Fatalf("setting only %s produced %d columns (%v), want 1",
					name, len(cols), names(cols))
			}
		})
	}
}

// Every mutable column of Tracker must be reachable through Patch.
//
// Without this, adding a column to Tracker and to the create path — but not to
// Patch — produces a field an athlete can be given and can never change. That
// is a quieter defect than blanking and it is the one N78 would meet first.
func TestPatchCoversEveryMutableTrackerField(t *testing.T) {
	// Immutable by design, each for a stated reason:
	immutable := map[string]string{
		"ID":         "the identity; changing it is creating a different tracker",
		"UserID":     "ownership, set from the verified claims and never from a body",
		"Preset":     "the provisioning key; renaming it would provision a second copy",
		"ArchivedAt": "moved by Archive, which is a distinct verb with distinct copy",
		"CreatedAt":  "a fact about the past",
		"UpdatedAt":  "maintained by the write path itself",
	}
	patchFields := map[string]bool{}
	pt := reflect.TypeOf(Patch{})
	for i := 0; i < pt.NumField(); i++ {
		patchFields[pt.Field(i).Name] = true
	}
	tt := reflect.TypeOf(Tracker{})
	for i := 0; i < tt.NumField(); i++ {
		name := tt.Field(i).Name
		if _, ok := immutable[name]; ok {
			continue
		}
		if !patchFields[name] {
			t.Errorf("Tracker.%s has no Patch field, so nothing can ever change it.\n"+
				"Add it to Patch and patchColumns, or add it to the immutable map "+
				"in this test with the reason it cannot be edited.", name)
		}
	}
	// And the reverse, so the immutable list cannot rot: every name in it must
	// still be a field of Tracker.
	for name := range immutable {
		if _, ok := tt.FieldByName(name); !ok {
			t.Errorf("the immutable list names %q, which is no longer a Tracker field", name)
		}
	}
}

// Absent, null and present are three states, and `*T` only has two.
//
// This is what makes "clear my coffee limit" expressible without "do not touch
// my coffee limit" accidentally meaning the same thing.
func TestFieldDistinguishesAbsentFromNull(t *testing.T) {
	var absent Patch
	if err := json.Unmarshal([]byte(`{"name":"Water"}`), &absent); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if absent.Target.Set {
		t.Fatal("target was not in the body but decoded as Set — an absent field would be written")
	}
	if !absent.Name.Set || absent.Name.Value == nil || *absent.Name.Value != "Water" {
		t.Fatalf("name did not decode: %+v", absent.Name)
	}

	var explicit Patch
	if err := json.Unmarshal([]byte(`{"target":null}`), &explicit); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !explicit.Target.Set {
		t.Fatal(`{"target":null} must decode as Set — it is how an athlete removes a target`)
	}
	if explicit.Target.Value != nil {
		t.Fatalf("explicit null decoded as a value: %v", *explicit.Target.Value)
	}
	cols := patchColumns(explicit)
	if len(cols) != 1 || cols[0].name != "target" || cols[0].value != (*float64)(nil) {
		t.Fatalf("an explicit null must reach the statement as a nil *float64, got %#v", cols)
	}

	var value Patch
	if err := json.Unmarshal([]byte(`{"target":2000}`), &value); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !value.Target.Set || value.Target.Value == nil || *value.Target.Value != 2000 {
		t.Fatalf("target 2000 did not decode: %+v", value.Target)
	}
}

// Validate must not object to a patch that names nothing it cares about, and
// must object to each field it does.
func TestPatchValidate(t *testing.T) {
	cases := []struct {
		name string
		body string
		ok   bool
	}{
		{"empty is structurally valid", `{}`, true},
		{"a target alone", `{"target":2500}`, true},
		{"target null means no ceiling", `{"target":null}`, true},
		{"target zero is not a way to say none", `{"target":0}`, false},
		{"negative target", `{"target":-1}`, false},
		{"blank name", `{"name":""}`, false},
		{"null name", `{"name":null}`, false},
		{"null icon", `{"icon":null}`, false},
		{"empty icon is fine", `{"icon":""}`, true},
		{"unknown unit", `{"unit":"gallons"}`, false},
		{"empty unit is a bare count", `{"unit":""}`, true},
		{"ml", `{"unit":"ml"}`, true},
		{"zero increment", `{"increment":0}`, false},
		{"unknown render style", `{"render_style":"spiral"}`, false},
		{"auto render style", `{"render_style":"auto"}`, true},
		{"hex colour is not a palette key", `{"color_key":"#408D96"}`, false},
		{"upper case colour key", `{"color_key":"Water"}`, false},
		{"palette key", `{"color_key":"water"}`, true},
		{"null sort order", `{"sort_order":null}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var p Patch
			if err := json.Unmarshal([]byte(c.body), &p); err != nil {
				if c.ok {
					t.Fatalf("decode: %v", err)
				}
				return
			}
			err := p.Validate()
			if c.ok && err != nil {
				t.Fatalf("want valid, got %v", err)
			}
			if !c.ok && err == nil {
				t.Fatal("want invalid, got nil")
			}
		})
	}
}

// New expresses itself as a complete Patch, so the two validators cannot
// disagree about what a legal unit or colour key is.
func TestNewValidateSharesThePatchRules(t *testing.T) {
	base := New{
		ID: "t1", Name: "Water", ColorKey: "water", Unit: "ml",
		Increment: 250, RenderStyle: RenderGlyphs,
	}
	if err := base.Validate(); err != nil {
		t.Fatalf("a complete tracker should validate: %v", err)
	}
	bad := base
	bad.Unit = "gallons"
	if err := bad.Validate(); err == nil {
		t.Fatal("New.Validate accepted a unit Patch.Validate rejects")
	}
	missing := base
	missing.ID = ""
	if err := missing.Validate(); err == nil {
		t.Fatal("New.Validate accepted an empty id")
	}
}

func TestIsDateIsFixedWidth(t *testing.T) {
	for _, s := range []string{"2026-08-20", "2026-01-01"} {
		if !IsDate(s) {
			t.Errorf("IsDate(%q) = false", s)
		}
	}
	for _, s := range []string{"", "2026-1-1", "2026-08-20T00:00:00Z", "20260820", "not a date"} {
		if IsDate(s) {
			t.Errorf("IsDate(%q) = true", s)
		}
	}
}

func names(cols []patchColumn) []string {
	out := make([]string, 0, len(cols))
	for _, c := range cols {
		out = append(out, c.name)
	}
	return out
}
