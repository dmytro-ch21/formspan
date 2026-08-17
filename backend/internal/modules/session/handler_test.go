package session

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The wire code, asserted where it is actually produced.
//
// `invalid_grip` exists so a phone can tell "the server refused this grip" from
// every other bad input and repair itself — drop the grip, retry, keep the
// session. That makes the CODE the contract, and nothing else in this suite
// looks at it: `grip_postgres_test.go` asserts the Go sentinel, which the old
// code satisfied too, so it would stay green through a full revert of this
// behaviour. What can break it is quiet in exactly the same way — reverse the
// two cases in `writeErr` and the broader `ErrInvalidInput` swallows the
// narrower one; drop either endpoint's `errors.Is` and validation reports the
// generic code again. Either way the phone stops repairing, the session strands,
// and the whole backend suite stays green. Hence these.
//
// Both endpoints validate sets before they touch the repository, so `nil` is
// never called — the same posture as `theme/handler_test.go`. It is also a
// tripwire rather than a convenience: `ClaimsFromContext` returns a *pointer*,
// and `auth`'s context key is unexported, so a case that stopped being refused
// would reach `claims.UserID` and panic on nil rather than pass quietly.
func createResponse(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/sessions", strings.NewReader(body))
	NewHandler(nil).Create(rec, req)
	return rec
}

func replaceSetsResponse(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/v1/sessions/ses-1/sets", strings.NewReader(body))
	req.SetPathValue("sessionID", "ses-1")
	rec := httptest.NewRecorder()
	NewHandler(nil).ReplaceSets(rec, req)
	return rec
}

func responseErrorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body is not the error contract: %q", rec.Body.String())
	}
	return out.Error.Code
}

// A create body carrying one set, so the grip under test is the only variable.
func createBody(setJSON string) string {
	return `{"id":"ses-1","sport":"strength","name":"Test","sets":[` + setJSON + `]}`
}

func setsBody(setJSON string) string { return `{"sets":[` + setJSON + `]}` }

const (
	badGripSet  = `{"exercise_id":"bench-press","reps":5,"grip":"banana"}`
	badRPESet   = `{"exercise_id":"bench-press","reps":5,"rpe":11}`
	goodGripSet = `{"exercise_id":"bench-press","reps":5,"grip":"neutral"}`
)

// The create is the path that matters most, and the one that had no coverage at
// all: `remote = 0` is every session logged offline, and it validates the sets
// in its body before the repository ever sees them.
func TestCreateHandler_RefusesAnUnknownGripWithItsOwnCode(t *testing.T) {
	rec := createResponse(t, createBody(badGripSet))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if code := responseErrorCode(t, rec); code != "invalid_grip" {
		t.Errorf("want invalid_grip, got %q — the phone reads this code to decide "+
			"whether it may drop the grip and retry, so anything else strands the session",
			code)
	}
}

func TestReplaceSetsHandler_RefusesAnUnknownGripWithItsOwnCode(t *testing.T) {
	rec := replaceSetsResponse(t, setsBody(badGripSet))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if code := responseErrorCode(t, rec); code != "invalid_grip" {
		t.Errorf("want invalid_grip, got %q", code)
	}
}

// The other half, and the one that fails if somebody widens the grip case:
// every OTHER validation failure has to keep reporting `invalid_input`. A code
// that leaked onto unrelated failures would have the phone drop grips to settle
// a refusal about an RPE, and the retry would be refused identically forever.
func TestSetValidation_KeepsInvalidInputForEveryOtherRefusal(t *testing.T) {
	for _, tc := range []struct {
		name string
		rec  *httptest.ResponseRecorder
	}{
		{"create", createResponse(t, createBody(badRPESet))},
		{"replace sets", replaceSetsResponse(t, setsBody(badRPESet))},
	} {
		if tc.rec.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d", tc.name, tc.rec.Code)
		}
		if code := responseErrorCode(t, tc.rec); code != "invalid_input" {
			t.Errorf("%s: want invalid_input, got %q", tc.name, code)
		}
	}
}

// The message is not contract and is not asserted as one — but it is what the
// repair screen shows a person, and "which set" is the whole reason
// `validateSets` exists rather than letting the CHECK answer.
//
// The exact sentence is pinned because the obvious implementation cannot
// produce it: `fmt.Errorf("%w …", ErrInvalidGrip, …)` gets the sentinel chain
// right and drags that sentinel's own text onto the wire with it, so an athlete
// reads "session: invalid input: unknown grip (set 2)" in a list where every
// neighbouring line reads "set 2: RPE must be between 1 and 10". Hence
// `gripError`. Asserting only that "set 2" appears somewhere passes for both.
func TestGripRefusal_NamesTheOffendingSet(t *testing.T) {
	rec := replaceSetsResponse(t, `{"sets":[`+goodGripSet+`,`+badGripSet+`]}`)
	var out struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body is not the error contract: %q", rec.Body.String())
	}
	if out.Error.Message != "set 2: unknown grip" {
		t.Errorf("message is %q, want %q — a person reads this on the repair screen",
			out.Error.Message, "set 2: unknown grip")
	}
}

// The sentinel chain the message change must not cost. `writeErr` routes on
// these, so a `gripError` that stopped satisfying either would keep its tidy
// sentence and silently lose the code the client acts on.
func TestGripError_StillSatisfiesBothSentinels(t *testing.T) {
	err := validateSets([]Set{{ExerciseID: "bench-press", Grip: ptrGrip("banana")}})
	if !errors.Is(err, ErrInvalidGrip) {
		t.Errorf("%v does not wrap ErrInvalidGrip, so writeErr reports invalid_input", err)
	}
	if !errors.Is(err, ErrInvalidInput) {
		t.Errorf("%v does not wrap ErrInvalidInput, so every existing caller "+
			"that classifies validation failures stops recognising it", err)
	}
}

// A grip the enum does define must not be refused. Without this, `ValidGrip`
// could be inverted — or reduced to `false` — and every test above would still
// pass while the picker's four legal values became unsendable.
//
// A valid body goes on to the repository, so this asserts what it can from
// outside: whatever happens next, it is not a 400 blaming the grip.
func TestValidateSets_AcceptsTheGripsTheEnumDefines(t *testing.T) {
	for _, g := range []Grip{GripRegular, GripNeutral, GripReverse, GripAngled} {
		if err := validateSets([]Set{{ExerciseID: "bench-press", Grip: ptrGrip(g)}}); err != nil {
			t.Errorf("grip %q was refused: %v", g, err)
		}
	}
	// And an unrecorded grip stays legal — nil is "not recorded", never a
	// default, and refusing it would make every non-grip exercise unsendable.
	if err := validateSets([]Set{{ExerciseID: "bench-press"}}); err != nil {
		t.Errorf("an unrecorded grip was refused: %v", err)
	}
}
