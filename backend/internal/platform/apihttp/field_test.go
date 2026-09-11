package apihttp

import (
	"encoding/json"
	"testing"
)

// Field's three states, tested directly.
//
// It had no test of its own when it lived in `internal/modules/tracker` — its
// behaviour was covered, thoroughly, but only THROUGH two modules' fixtures
// (tracker's patch reflection, nutrition's HTTP restore-path tests). That was
// adequate while it had one caller. It is shared platform code with two
// independent callers now, and a type whose whole purpose is a distinction
// three lines wide should be able to demonstrate that distinction without
// standing up a Postgres fixture and an HTTP request to do it.
func TestFieldTellsAbsentFromNullFromValue(t *testing.T) {
	type body struct {
		A Field[float64] `json:"a"`
		B Field[float64] `json:"b"`
		C Field[float64] `json:"c"`
	}

	var got body
	// `a` is absent, `b` is null, `c` is a number — one document carrying all
	// three states, because the whole claim is that they are distinguishable
	// from each other, not that each parses in isolation.
	if err := json.Unmarshal([]byte(`{"b": null, "c": 4.5}`), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// ABSENT: UnmarshalJSON is never called for a key that is not there, which
	// is the entire mechanism. Nothing else in the type does any work.
	if got.A.Set {
		t.Errorf("absent key: Set = true; the column would be written")
	}
	if got.A.Value != nil {
		t.Errorf("absent key: Value = %v, want nil", *got.A.Value)
	}

	// NULL: stated, and stated as nothing. This is the state a `*float64`
	// cannot express, and the one whose loss turns this type back into a
	// pointer with extra steps.
	if !got.B.Set {
		t.Errorf("explicit null: Set = false; indistinguishable from absent")
	}
	if got.B.Value != nil {
		t.Errorf("explicit null: Value = %v, want nil", *got.B.Value)
	}

	// VALUE.
	if !got.C.Set {
		t.Errorf("stated value: Set = false")
	}
	if got.C.Value == nil || *got.C.Value != 4.5 {
		t.Errorf("stated value: Value = %v, want 4.5", got.C.Value)
	}
}

// A malformed value is an error rather than a silent zero — the failure mode
// that would put a 0 in a column where the caller wrote nonsense.
func TestFieldRefusesAValueOfTheWrongType(t *testing.T) {
	var got struct {
		A Field[float64] `json:"a"`
	}
	if err := json.Unmarshal([]byte(`{"a": "not a number"}`), &got); err == nil {
		t.Fatalf("want an error, got Set=%v Value=%v", got.A.Set, got.A.Value)
	}
}

// Of and Null build the two stated forms, for callers assembling one in Go.
// Null is the one worth pinning: it must be SET with a nil Value, which is the
// same field layout as an unset field except for the bool — so a constructor
// that forgot the bool would produce something that looks right and silently
// means "do not touch".
func TestOfAndNullBuildTheStatedForms(t *testing.T) {
	v := Of(4.5)
	if !v.Set || v.Value == nil || *v.Value != 4.5 {
		t.Errorf("Of(4.5) = {Set:%v Value:%v}", v.Set, v.Value)
	}
	n := Null[float64]()
	if !n.Set {
		t.Errorf("Null() must be SET — an unset field means \"leave it alone\", the opposite")
	}
	if n.Value != nil {
		t.Errorf("Null() Value = %v, want nil", *n.Value)
	}
}
