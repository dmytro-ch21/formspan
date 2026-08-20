package profile

import (
	"encoding/json"
	"net/http"
	"testing"
)

// TestValidActivityLevelIsPinnedToLiterals is one half of a deliberate
// duplication — `nutrition.Activities` is the other, and it carries the mirror
// of this test.
//
// A module here never imports a sibling, so the daily-movement vocabulary
// exists twice. What keeps the copies honest is that BOTH are pinned to string
// literals: an assertion of one against the other would be true by construction
// and would stay green the day somebody edited both, which is the drift worth
// catching. Pinned to literals, whichever side moves fails on its own.
func TestValidActivityLevelIsPinnedToLiterals(t *testing.T) {
	for _, ok := range []string{"sedentary", "light", "active"} {
		if !ValidActivityLevel(ok) {
			t.Errorf("%q is in the wire contract and was refused", ok)
		}
	}
}

func TestValidActivityLevelRefusesEverythingElse(t *testing.T) {
	// `moderate` and `very_active` are the textbook levels the truncated
	// ladder deliberately excludes — they already include exercise, which the
	// derivation adds separately, so accepting one double-counts every mat
	// class. The empty string is here because an absent JSON field decodes to
	// a nil pointer, never to "", so a "" that reaches the validator came from
	// a client sending an empty value and is a mistake rather than an omission.
	for _, bad := range []string{"", "moderate", "very_active", "Light", "LIGHT", "sedentary "} {
		if ValidActivityLevel(bad) {
			t.Errorf("%q was accepted; the vocabulary is sedentary|light|active", bad)
		}
	}
}

// The guard TESTED AT THE CALL SITE, for the same reason the username one is
// two files over: covering `ValidActivityLevel` says nothing about the
// if-statement that calls it, and there is NO CHECK constraint behind this
// column — the handler is the only enforcement. Delete the guard and these
// requests fall through toward a nil repository instead of returning 400,
// which is loudly red rather than quietly green.
func TestUpdateRejectsUnknownActivityLevelsAtTheHandler(t *testing.T) {
	cases := map[string]string{
		"textbook level the ladder excludes": `{"activity_level":"moderate"}`,
		"very active":                        `{"activity_level":"very_active"}`,
		"wrong case":                         `{"activity_level":"Light"}`,
		"empty string":                       `{"activity_level":""}`,
		"a number as a string":               `{"activity_level":"1.45"}`,
	}
	for name, body := range cases {
		rec := updateResponse(t, body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d", name, rec.Code)
		}
	}
}

// The CODE is part of the wire contract; the message is not. A client that
// cannot tell "you sent nonsense" from "the server broke" retries a request
// that will never succeed.
func TestUpdateReportsABadActivityLevelAsInvalidInput(t *testing.T) {
	rec := updateResponse(t, `{"activity_level":"moderate"}`)
	var out struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Error.Code != "invalid_input" {
		t.Fatalf("want invalid_input, got %q", out.Error.Code)
	}
}

func TestUpdateLetsAValidActivityLevelThrough(t *testing.T) {
	// The complement, and the half that catches a guard rewritten as
	// "if req.ActivityLevel != nil { 400 }". Every case above would still pass
	// against that, and the feature would be entirely unusable.
	//
	// Reaching the repository means panicking on the nil one — recovering that
	// panic IS the assertion, the same idiom TestUpdateTrimsBeforeValidating
	// uses.
	defer func() {
		if recover() == nil {
			t.Fatal("a valid activity level should pass validation and reach the repository")
		}
	}()
	updateResponse(t, `{"activity_level":"active"}`)
}

func TestUpdateLeavesTheActivityLevelAloneWhenTheKeyIsAbsent(t *testing.T) {
	// A PATCH that says nothing about the level must not be refused for it —
	// every other client on this endpoint sends a body with no activity_level
	// at all, and a guard that fired on nil would break all of them.
	defer func() {
		if recover() == nil {
			t.Fatal("a PATCH omitting activity_level must pass validation")
		}
	}()
	updateResponse(t, `{"display_name":"Dmytro"}`)
}
