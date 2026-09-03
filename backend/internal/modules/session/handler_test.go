package session

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
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
	NewHandler(nil, nil).Create(rec, req)
	return rec
}

func replaceSetsResponse(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/v1/sessions/ses-1/sets", strings.NewReader(body))
	req.SetPathValue("sessionID", "ses-1")
	rec := httptest.NewRecorder()
	NewHandler(nil, nil).ReplaceSets(rec, req)
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
	for _, g := range []Grip{GripRegular, GripNeutral, GripReverse, GripAngled, GripMixed, GripHook} {
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

// N191 — parseInSessionWeights is the transport-layer half of the in-session
// signal (see progression.go's Progress doc for the product decision). These
// pin the wire format independently of Progress itself, since a handler test
// against a real repository would need Postgres for something that is really
// just string parsing.
func TestParseInSessionWeights_ParsesEveryEntryPerExercise(t *testing.T) {
	got, err := parseInSessionWeights("squat:102.5,bench:80,squat:105")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got["squat"]) != 2 || got["squat"][0] != 102.5 || got["squat"][1] != 105 {
		t.Errorf("squat: got %v", got["squat"])
	}
	if len(got["bench"]) != 1 || got["bench"][0] != 80 {
		t.Errorf("bench: got %v", got["bench"])
	}
}

func TestParseInSessionWeights_EmptyIsEmpty(t *testing.T) {
	got, err := parseInSessionWeights("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("want an empty map, got %v", got)
	}
}

// A malformed entry is advisory data gone wrong, not a bad request — see the
// doc comment on parseInSessionWeights. Refusing the whole suggestion because
// one today_sets entry didn't parse would be worse than reasoning from the
// entries that did.
func TestParseInSessionWeights_DropsMalformedEntriesRatherThanFailing(t *testing.T) {
	got, err := parseInSessionWeights("squat:102.5,not-a-pair,bench:not-a-number,:80,squat:0,squat:-5,,squat:110")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got["squat"]) != 2 || got["squat"][0] != 102.5 || got["squat"][1] != 110 {
		t.Errorf("squat should keep only the two valid, positive entries: got %v", got["squat"])
	}
	if _, ok := got["bench"]; ok {
		t.Errorf("bench had no valid entry and should not appear at all, got %v", got["bench"])
	}
}

func TestParseInSessionWeights_RefusesTooManyEntries(t *testing.T) {
	items := make([]string, maxInSessionSetEntries+1)
	for i := range items {
		items[i] = "squat:100"
	}
	if _, err := parseInSessionWeights(strings.Join(items, ",")); err == nil {
		t.Error("want an error past maxInSessionSetEntries, got nil")
	}

	items = items[:maxInSessionSetEntries]
	if _, err := parseInSessionWeights(strings.Join(items, ",")); err != nil {
		t.Errorf("exactly the cap should still be accepted, got %v", err)
	}
}

// Found in backend review of N191: strconv.ParseFloat happily parses "NaN",
// "Inf" and "Infinity", and the w <= 0 filter alone lets every one of them
// through — NaN comparisons are always false (IEEE 754) and +Inf is
// positive. A NaN or Inf reaching applyInSessionSignal (progression.go)
// produces a non-finite AverageWeightKg, and encoding that fails the whole
// response AFTER apihttp.WriteJSON has already sent status 200 — corrupting
// every exercise in the request, not just the poisoned entry.
func TestParseInSessionWeights_RejectsNonFiniteAndOutOfRangeWeights(t *testing.T) {
	got, err := parseInSessionWeights("squat:NaN,squat:Inf,squat:-Inf,squat:Infinity,squat:100")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got["squat"]) != 1 || got["squat"][0] != 100 {
		t.Errorf("only the one finite, in-range entry should survive, got %v", got["squat"])
	}

	// A ceiling past any real lift, so a legitimate top-end deadlift never
	// gets caught by this — but math.MaxFloat64 does, which is the value
	// that overflows to +Inf the moment a handful of them are summed for the
	// average, even though each one parses as an ordinary finite float on
	// its own.
	got, err = parseInSessionWeights("squat:1.7976931348623157e+308,squat:200")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got["squat"]) != 1 || got["squat"][0] != 200 {
		t.Errorf("a finite value past maxInSessionWeightKg should be dropped, got %v", got["squat"])
	}
}

// suggestionsFakeRepo implements Repository with only RecentEfforts and
// BestOneRMs meaningful — everything else panics, so a test that touches an
// unexpected method fails loudly rather than silently returning a zero value.
// Only Suggestions is under test here.
type suggestionsFakeRepo struct {
	efforts map[string]ProgressionInput
	bestRMs map[string]float64
}

func (f *suggestionsFakeRepo) RecentEfforts(_ context.Context, _ string, ids []string) (map[string]ProgressionInput, error) {
	out := map[string]ProgressionInput{}
	for _, id := range ids {
		if in, ok := f.efforts[id]; ok {
			out[id] = in
		}
	}
	return out, nil
}

// RecentEffortsV2 (N473/#812) reuses the same fixture map RecentEfforts
// does — the real PostgresRepository's version differs from RecentEfforts
// only in ranking finished-only in SQL (see its own doc comment), and every
// fixture in this file that cares about that distinction already sets
// SessionEffort.Finished explicitly rather than relying on this fake to
// simulate the SQL-level filtering.
func (f *suggestionsFakeRepo) RecentEffortsV2(ctx context.Context, userID string, ids []string) (map[string]ProgressionInput, error) {
	return f.RecentEfforts(ctx, userID, ids)
}
func (f *suggestionsFakeRepo) BestOneRMs(_ context.Context, _ string, _ []string) (map[string]float64, error) {
	return f.bestRMs, nil
}
func (f *suggestionsFakeRepo) List(context.Context, string, Filter) (*SessionPage, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) History(context.Context, string, HistoryFilter) (*History, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) Records(context.Context, string, []string) ([]ExerciseRecords, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) LoadHistory(context.Context, string, string, LoadHistoryFilter) (*LoadHistory, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) PinnedExercises(context.Context, string) ([]string, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) SetPinnedExercises(context.Context, string, []string) error {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) MostTrainedExercises(context.Context, string, int) ([]string, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) Get(context.Context, string, string) (*Session, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) Create(context.Context, NewSession) (*Session, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) ReplaceSets(context.Context, string, string, []Set) (*Session, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) Finish(context.Context, string, string, time.Time) (*Session, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) Rename(context.Context, string, string, string) (*Session, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) SetIntent(context.Context, string, string, SessionIntent) (*Session, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) Reschedule(context.Context, string, string, time.Time) (*Session, error) {
	panic("not used by Suggestions")
}
func (f *suggestionsFakeRepo) Delete(context.Context, string, string) error {
	panic("not used by Suggestions")
}

// The one join `parseInSessionWeights` and `Progress` are each tested in
// isolation but never together: `in.InSessionWorkingWeightsKg =
// todaySets[id]` at the call site in Suggestions. Delete that line and every
// test above still passes — parseInSessionWeights doesn't call Progress, and
// Progress's own tests build ProgressionInput by hand. This is the one test
// that would go red. Found in backend review of N191.
func TestSuggestionsHandler_TodaySetsReachesTheSignal(t *testing.T) {
	// A history-only baseline that resolves to add_reps at 80kg — same shape
	// as progression_test.go's baselineHypertrophyInput, reproduced here
	// because the wire path builds ProgressionInput from a map keyed by
	// exercise id rather than from the helper.
	reps6, kg80, rir2 := 6, 80.0, 2
	in := ProgressionInput{
		LoadType: "weight_reps", MovementPattern: "horizontal_push",
		Recent: []SessionEffort{{
			SessionID: "s1", PerformedAt: time.Now().Add(-2 * 24 * time.Hour),
			Sets: []Set{
				{ExerciseID: "bench-press", SetType: SetTypeWorking, Completed: true,
					Reps: &reps6, WeightKg: &kg80, RIR: &rir2},
				{ExerciseID: "bench-press", SetType: SetTypeWorking, Completed: true,
					Reps: &reps6, WeightKg: &kg80, RIR: &rir2},
			},
		}},
	}
	repo := &suggestionsFakeRepo{
		efforts: map[string]ProgressionInput{"bench-press": in},
		bestRMs: map[string]float64{},
	}
	h := NewHandler(repo, nil)

	req := httptest.NewRequest(http.MethodGet,
		"/v1/sessions/suggestions?exercise_ids=bench-press&goal=hypertrophy&today_sets=bench-press:95",
		nil)
	req = signedInSession(req, "user-1")
	rec := httptest.NewRecorder()
	h.Suggestions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var body struct {
		Suggestions []Suggestion `json:"suggestions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body did not decode: %v — %s", err, rec.Body.String())
	}
	if len(body.Suggestions) != 1 {
		t.Fatalf("want 1 suggestion, got %d", len(body.Suggestions))
	}
	s := body.Suggestions[0]

	// 95kg is 18.75% above the 80kg standing prescription — over the 10%
	// threshold, so the signal must have made it all the way through the
	// wire: query param -> parseInSessionWeights -> the handler's join ->
	// Progress -> JSON.
	if s.InSessionSignal == nil {
		t.Fatalf("today_sets=bench-press:95 against an 80kg prescription should reach "+
			"in_session_signal in the response body: %s", rec.Body.String())
	}
	if s.InSessionSignal.Code != InSessionAbove {
		t.Errorf("want %q, got %q", InSessionAbove, s.InSessionSignal.Code)
	}
	if s.InSessionSignal.AverageWeightKg != 95 {
		t.Errorf("average_weight_kg: want 95, got %v", s.InSessionSignal.AverageWeightKg)
	}
	// The standing prescription itself must be untouched by today_sets.
	if s.Code != ProgressAddReps || s.TargetWeightKg == nil || *s.TargetWeightKg != 80 {
		t.Errorf("the standing prescription must be unaffected by today_sets: code=%q weight=%v",
			s.Code, s.TargetWeightKg)
	}
}

func signedInSession(r *http.Request, userID string) *http.Request {
	return r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: userID}))
}

// fakeFlagSource is the smallest possible FlagSource: one key, one bool, no
// Postgres. errOnRead, if set, makes Enabled fail — proving the handler's
// "a flag error stays on v1" guard (newEngineEnabled) actually does that
// rather than propagating the error into a 500.
type fakeFlagSource struct {
	enabled   bool
	errOnRead error
}

func (f *fakeFlagSource) Enabled(context.Context, string) (bool, error) {
	if f.errOnRead != nil {
		return false, f.errOnRead
	}
	return f.enabled, nil
}

// goldenSquatFixture is the same reported shape used throughout
// progression_v2_test.go's golden test, reproduced here because the wire
// path builds ProgressionInput from the handler's map-keyed join rather than
// from progIn/squatIn.
func goldenSquatFixture(finished bool) ProgressionInput {
	sets := []Set{
		straightSet(12, lb228Kg, nil, nil),
		straightSet(12, lb228Kg, nil, nil),
		straightSet(12, lb228Kg, nil, nil),
		straightSet(3, lb335Kg, nil, nil),
	}
	return ProgressionInput{
		ExerciseID:      "back-squat",
		LoadType:        "weight_reps",
		MovementPattern: "squat",
		Recent: []SessionEffort{{
			SessionID:   "s1",
			PerformedAt: time.Now().Add(-24 * time.Hour),
			Sets:        sets,
			Finished:    finished,
		}},
	}
}

// TestSuggestionsHandler_FlagOffKeepsV1PathUnchanged is N473/#812's own
// wiring requirement made concrete: with the flag off (including a nil
// FlagSource — see NewHandler's doc comment), the endpoint must still
// reproduce the ORIGINAL reported bug byte-for-byte, because that is exactly
// what "unaffected for anyone not on the flag" promises. If this ever goes
// green with a different weight/reps pair, either v1 changed (forbidden) or
// something upstream of it did.
func TestSuggestionsHandler_FlagOffKeepsV1PathUnchanged(t *testing.T) {
	repo := &suggestionsFakeRepo{
		efforts: map[string]ProgressionInput{"back-squat": goldenSquatFixture(true)},
		bestRMs: map[string]float64{},
	}
	h := NewHandler(repo, &fakeFlagSource{enabled: false})

	req := httptest.NewRequest(http.MethodGet,
		"/v1/sessions/suggestions?exercise_ids=back-squat", nil)
	req = signedInSession(req, "user-1")
	rec := httptest.NewRecorder()
	h.Suggestions(rec, req)

	var body struct {
		Suggestions []Suggestion `json:"suggestions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body did not decode: %v — %s", err, rec.Body.String())
	}
	s := body.Suggestions[0]
	if s.TargetWeightKg == nil || !nearlyEqual(*s.TargetWeightKg, lb335Kg) || s.TargetReps == nil || *s.TargetReps != 8 {
		t.Fatalf("expected the unchanged v1 bug (335-equivalent x 8) with the flag off, "+
			"got weight=%v reps=%v", s.TargetWeightKg, s.TargetReps)
	}
}

// TestSuggestionsHandler_FlagOnUsesV2AndNeverInventsTheSet is the same
// fixture through the SAME endpoint with the flag on, confirming the wire
// path (query params -> ProgressionInput -> ProgressV2 -> JSON) actually
// reaches the fix rather than only the pure-function tests exercising it.
func TestSuggestionsHandler_FlagOnUsesV2AndNeverInventsTheSet(t *testing.T) {
	repo := &suggestionsFakeRepo{
		efforts: map[string]ProgressionInput{"back-squat": goldenSquatFixture(true)},
		bestRMs: map[string]float64{},
	}
	h := NewHandler(repo, &fakeFlagSource{enabled: true})

	req := httptest.NewRequest(http.MethodGet,
		"/v1/sessions/suggestions?exercise_ids=back-squat", nil)
	req = signedInSession(req, "user-1")
	rec := httptest.NewRecorder()
	h.Suggestions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Suggestions []Suggestion `json:"suggestions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body did not decode: %v — %s", err, rec.Body.String())
	}
	s := body.Suggestions[0]
	if s.TargetWeightKg != nil && nearlyEqual(*s.TargetWeightKg, lb335Kg) && s.TargetReps != nil && *s.TargetReps == 8 {
		t.Fatalf("GOLDEN TEST VIOLATION over the wire: got 335-equivalent x 8 with the "+
			"flag on. code=%s reason=%q", s.Code, s.Reason)
	}
}

// TestSuggestionsHandler_FlagSourceErrorStaysOnV1 is newEngineEnabled's own
// guard: a flags-table read failure must not turn into a 500, and must not
// silently switch a request onto the new engine either — it stays on the
// already-shipped v1 path, same as a nil FlagSource does.
func TestSuggestionsHandler_FlagSourceErrorStaysOnV1(t *testing.T) {
	repo := &suggestionsFakeRepo{
		efforts: map[string]ProgressionInput{"back-squat": goldenSquatFixture(true)},
		bestRMs: map[string]float64{},
	}
	h := NewHandler(repo, &fakeFlagSource{errOnRead: errors.New("connection reset")})

	req := httptest.NewRequest(http.MethodGet,
		"/v1/sessions/suggestions?exercise_ids=back-squat", nil)
	req = signedInSession(req, "user-1")
	rec := httptest.NewRecorder()
	h.Suggestions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("a flag-source error must not surface as a request failure, got %d: %s",
			rec.Code, rec.Body.String())
	}
	var body struct {
		Suggestions []Suggestion `json:"suggestions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body did not decode: %v — %s", err, rec.Body.String())
	}
	s := body.Suggestions[0]
	if s.TargetWeightKg == nil || !nearlyEqual(*s.TargetWeightKg, lb335Kg) || s.TargetReps == nil || *s.TargetReps != 8 {
		t.Fatalf("a flag read error must fail safe onto v1, got weight=%v reps=%v",
			s.TargetWeightKg, s.TargetReps)
	}
}
