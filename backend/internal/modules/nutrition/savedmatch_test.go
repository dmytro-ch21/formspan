package nutrition

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// errNotAvailable stands in for a food store that cannot answer — a dropped
// pool, a statement timeout. Deliberately NOT ErrNotFound, which is the
// ordinary "nothing saved by that name" and must not be logged as a fault.
var errNotAvailable = errors.New("the food store is down")

// pngBytes is a real PNG magic number, because the handler SNIFFS the media
// type from the bytes rather than trusting the part header.
func pngBytes() []byte {
	return []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0}
}

// callMultipart drives the photo path.
func callMultipart(t *testing.T, h *EstimateHandler, description string, image []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("description", description)
	part, err := mw.CreateFormFile("image", "meal.png")
	if err != nil {
		t.Fatalf("form file: %v", err)
	}
	if _, err := part.Write(image); err != nil {
		t.Fatalf("write image: %v", err)
	}
	_ = mw.Close()

	r := httptest.NewRequest(http.MethodPost, "/v1/nutrition/estimate", &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r = r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: "eater"}))
	w := httptest.NewRecorder()
	h.Estimate(w, r)
	return w
}

// memFoods is a saved-food store with one row in it.
//
// It matches on the SAME normalised key the caller passes, and does no
// normalisation of its own — so a test that breaks NormalizeFoodName cannot be
// rescued by the fake being lenient. A stub that normalised both sides itself
// would supply the behaviour under test, which is the mistake this repo names
// in CLAUDE.md as "an array mock can silently supply the behaviour under test".
type memFoods struct {
	byNormalized map[string]Food
	asked        []string
	err          error
}

func (m *memFoods) FindFoodByNormalizedName(_ context.Context, userID, normalized string) (Food, error) {
	m.asked = append(m.asked, userID+"|"+normalized)
	if m.err != nil {
		return Food{}, m.err
	}
	f, ok := m.byNormalized[normalized]
	if !ok {
		return Food{}, ErrNotFound
	}
	return f, nil
}

func savedFood(name string) Food {
	fibre := 1.5
	return Food{
		ID: "11111111-2222-4333-8444-555555555555", UserID: "eater", Kind: KindFood,
		Name: name, ServingLabel: "1 skewer",
		Macros:    Macros{Kcal: 310, ProteinG: 28, CarbG: 4, FatG: 20, FibreG: &fibre},
		Source:    SourceAI,
		UpdatedAt: time.Date(2026, 8, 18, 9, 0, 0, 0, time.UTC),
	}
}

func withFood(name string) *memFoods {
	f := savedFood(name)
	return &memFoods{byNormalized: map[string]Food{NormalizeFoodName(name): f}}
}

// --------------------------------------------------------------- the rule

func TestNormalizeFoodNameFoldsOnlyHowSomethingWasTyped(t *testing.T) {
	same := [][2]string{
		{"Pork Shashlik", "pork shashlik"},
		{"  Pork Shashlik  ", "Pork Shashlik"},
		{"Pork\tShashlik", "Pork Shashlik"},
		{"Pork  Shashlik", "Pork Shashlik"},
		{"PORK SHASHLIK", "Pork Shashlik"},
		{"Pork\nShashlik", "Pork Shashlik"},
	}
	for _, p := range same {
		if a, b := NormalizeFoodName(p[0]), NormalizeFoodName(p[1]); a != b {
			t.Errorf("%q and %q should normalise the same, got %q and %q", p[0], p[1], a, b)
		}
	}
}

// The negative half, and it is the half the ticket actually asks for: a
// reviewer must be able to say why "Pork Shashlik (spicy)" did NOT match.
func TestNormalizeFoodNameKeepsWhatDistinguishesTwoFoods(t *testing.T) {
	different := [][2]string{
		{"Pork Shashlik", "Pork Shashlik (spicy)"},
		{"Pork Shashlik", "Pork Shashlik, no sauce"},
		{"Skyr 0%", "Skyr 10%"},
		{"Egg", "Eggs"},
		{"Chicken breast", "Chicken breasts"},
		{"Rice", "Rice pudding"},
	}
	for _, p := range different {
		if a, b := NormalizeFoodName(p[0]), NormalizeFoodName(p[1]); a == b {
			t.Errorf("%q and %q must NOT normalise the same, both gave %q", p[0], p[1], a)
		}
	}
}

func TestMatchableRefusesWhatCannotHonestlyMatch(t *testing.T) {
	long := strings.Repeat("a", MaxMatchableRunes+1)
	for _, tc := range []struct {
		name string
		in   EstimateInput
		want bool
	}{
		{"a plain description", EstimateInput{Description: "Pork Shashlik", ReuseSaved: true}, true},
		{"the caller asked for a fresh reading", EstimateInput{Description: "Pork Shashlik"}, false},
		{"a photo", EstimateInput{Description: "Pork Shashlik", Image: []byte{1}, ReuseSaved: true}, false},
		{"nothing typed", EstimateInput{Description: "   ", ReuseSaved: true}, false},
		{"longer than a name can be", EstimateInput{Description: long, ReuseSaved: true}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := tc.in.Matchable(); ok != tc.want {
				t.Fatalf("Matchable() = %v, want %v", ok, tc.want)
			}
		})
	}
}

func TestADraftFromASavedFoodSaysItWasNotGenerated(t *testing.T) {
	f := savedFood("Pork Shashlik")
	got := DraftFromSavedFood(f, EstimateInput{Description: "pork  SHASHLIK", ReuseSaved: true}, "pork shashlik")

	if got.Match == nil {
		t.Fatal("a reused draft must carry a match — its absence is what a client reads as 'generated'")
	}
	if got.Match.FoodID != f.ID || got.Match.Name != "Pork Shashlik" {
		t.Errorf("match should name the stored row: %+v", got.Match)
	}
	if got.Match.Rule != MatchExactName || got.Match.Normalized != "pork shashlik" {
		t.Errorf("match must be checkable from the response alone: %+v", got.Match)
	}
	if got.Match.FoodSource != SourceAI {
		t.Errorf("match must say how the STORED row was produced, got %q", got.Match.FoodSource)
	}
	if got.Model != "" {
		t.Errorf("no model produced this, so naming one is a false provenance claim: %q", got.Model)
	}
	if len(got.Items) != 1 {
		t.Fatalf("want one item, got %d", len(got.Items))
	}
	it := got.Items[0]
	if it.Servings != 1 {
		t.Errorf("one serving is the only quantity this can honestly propose, got %v", it.Servings)
	}
	if it.Kcal != 310 || it.ProteinG != 28 || it.FatG != 20 {
		t.Errorf("macros must come through unchanged: %+v", it)
	}
	if it.PortionConfidence != ConfidenceHigh {
		t.Errorf("the athlete defined this serving themselves, want high, got %q", it.PortionConfidence)
	}
	if it.Assumption != "" {
		t.Errorf("nothing was assumed, so an assumption would be invented: %q", it.Assumption)
	}
}

// A recipe's stored macros are already per-serving, which is the number a reuse
// must hand back. Written because `PerServing` returns f.Macros unchanged for a
// plain food and the two cases are easy to conflate.
func TestReusingARecipeGivesOnePortionOfIt(t *testing.T) {
	yield := 4.0
	f := Food{
		ID: "11111111-2222-4333-8444-555555555555", Kind: KindRecipe, Name: "Chilli",
		ServingLabel: "1 portion", YieldServings: &yield,
		Items: []RecipeItem{
			{Name: "mince", Quantity: 2, ServingLabel: "100 g", Macros: Macros{Kcal: 250, ProteinG: 20}},
			{Name: "beans", Quantity: 1, ServingLabel: "1 tin", Macros: Macros{Kcal: 300, CarbG: 50}},
		},
	}
	got := DraftFromSavedFood(f, EstimateInput{Description: "chilli", ReuseSaved: true}, "chilli")
	// (250*2 + 300*1) / 4 = 200
	if got.Items[0].Kcal != 200 {
		t.Fatalf("want one portion = 200 kcal, got %v", got.Items[0].Kcal)
	}
}

// --------------------------------------------------------- through the handler

// THE HEADLINE MEASUREMENT. The ticket's own words: "log the same food three
// times and the quota moves once".
func TestLoggingTheSameFoodThreeTimesGeneratesOnceAndMetersOnce(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	usage := &memUsage{}
	saved := &memFoods{byNormalized: map[string]Food{}}
	h := NewEstimateHandler(est, usage, saved)

	// First time: nothing saved yet, so it generates and is metered.
	if w := call(t, h, `{"description":"Pork Shashlik"}`); w.Code != http.StatusOK {
		t.Fatalf("first call: %d %s", w.Code, w.Body)
	}
	if est.calls != 1 || len(usage.rows) != 1 {
		t.Fatalf("first call should generate and meter once, got calls=%d rows=%d", est.calls, len(usage.rows))
	}

	// The athlete confirms, and the client saves the food. That is the step
	// N114 was reported for missing; from here on the row exists.
	saved.byNormalized["pork shashlik"] = savedFood("Pork Shashlik")

	for i, body := range []string{`{"description":"Pork Shashlik"}`, `{"description":"pork  shashlik "}`} {
		w := call(t, h, body)
		if w.Code != http.StatusOK {
			t.Fatalf("call %d: %d %s", i+2, w.Code, w.Body)
		}
		var got estimateResponse
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Estimate.Match == nil {
			t.Fatalf("call %d should have been reused, not generated", i+2)
		}
	}

	if est.calls != 1 {
		t.Errorf("the model must be called ONCE for three logs, got %d", est.calls)
	}
	if len(usage.rows) != 1 {
		t.Errorf("the allowance must move ONCE for three logs, got %d", len(usage.rows))
	}
}

func TestAReusedDraftDoesNotTouchTheAllowanceEvenWhenItIsExhausted(t *testing.T) {
	usage := &memUsage{quotaFn: func() Quota { return NewQuota(DailyEstimates, nil) }}
	est := &fakeEstimator{out: goodEstimate()}
	h := NewEstimateHandler(est, usage, withFood("Pork Shashlik"))

	w := call(t, h, `{"description":"Pork Shashlik"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("a reuse spends nothing, so a spent allowance cannot refuse it: %d %s", w.Code, w.Body)
	}
	if est.calls != 0 {
		t.Errorf("no model call should have been made, got %d", est.calls)
	}
	if len(usage.rows) != 0 {
		t.Errorf("nothing was spent, so nothing may be metered, got %d rows", len(usage.rows))
	}

	// And the contrast, in the same test, so the exhaustion is real rather than
	// a fake that never refuses anything.
	if w := call(t, h, `{"description":"something never saved"}`); w.Code != http.StatusTooManyRequests {
		t.Fatalf("a GENERATION at the cap must still be refused, got %d", w.Code)
	}
}

func TestAnUnmatchedDescriptionStillGenerates(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	h := NewEstimateHandler(est, &memUsage{}, withFood("Pork Shashlik"))

	w := call(t, h, `{"description":"Pork Shashlik (spicy)"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var got estimateResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Estimate.Match != nil {
		t.Fatalf("a near miss must NOT substitute a different food: %+v", got.Estimate.Match)
	}
	if est.calls != 1 {
		t.Errorf("want one generation, got %d", est.calls)
	}
}

func TestAskingForAFreshReadingSkipsTheSavedFood(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	saved := withFood("Pork Shashlik")
	h := NewEstimateHandler(est, &memUsage{}, saved)

	w := call(t, h, `{"description":"Pork Shashlik","reuse":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if est.calls != 1 {
		t.Errorf("reuse:false must generate, got %d calls", est.calls)
	}
	if len(saved.asked) != 0 {
		t.Errorf("nothing should have been looked up at all, got %v", saved.asked)
	}
}

// Absent is NOT false. Every client written before N114 sends no `reuse` field
// at all, and reading that as an opt-out would ship the feature switched off
// for everybody who already has the app.
func TestAClientThatSaysNothingAboutReuseGetsIt(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	h := NewEstimateHandler(est, &memUsage{}, withFood("Pork Shashlik"))
	if w := call(t, h, `{"description":"Pork Shashlik"}`); w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if est.calls != 0 {
		t.Fatalf("the default must be to reuse, got %d model calls", est.calls)
	}
}

func TestAPhotoIsNeverAnsweredFromASavedFood(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	saved := withFood("Pork Shashlik")
	h := NewEstimateHandler(est, &memUsage{}, saved)

	w := callMultipart(t, h, "Pork Shashlik", pngBytes())
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if est.calls != 1 {
		t.Errorf("a photo asks what is on THIS plate; it must be read, got %d calls", est.calls)
	}
	if len(saved.asked) != 0 {
		t.Errorf("no lookup should have happened for a photo, got %v", saved.asked)
	}
}

// A broken food store must degrade to what happened before this feature
// existed, not to a failed request. The athlete's meal is still loggable.
func TestALookupFailureFallsBackToGenerating(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	h := NewEstimateHandler(est, &memUsage{}, &memFoods{err: errNotAvailable})

	w := call(t, h, `{"description":"Pork Shashlik"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("want a served draft, got %d %s", w.Code, w.Body)
	}
	if est.calls != 1 {
		t.Errorf("want a fallback generation, got %d calls", est.calls)
	}
}

// The security property, asserted rather than assumed: the lookup is scoped to
// the caller. It is enforced in SQL, and this pins that the handler passes the
// authenticated id rather than anything from the request.
func TestTheLookupIsScopedToTheCaller(t *testing.T) {
	saved := &memFoods{byNormalized: map[string]Food{}}
	h := NewEstimateHandler(&fakeEstimator{out: goodEstimate()}, &memUsage{}, saved)
	callAs(t, h, "athlete-b", `{"description":"Pork Shashlik"}`)
	if len(saved.asked) != 1 || saved.asked[0] != "athlete-b|pork shashlik" {
		t.Fatalf("want a lookup scoped to athlete-b, got %v", saved.asked)
	}
}

// A handler built with no food store behaves exactly as it did before N114.
// Every pre-existing test in this package runs that way, so this states it
// rather than leaving it as an accident of the fixtures.
func TestAHandlerWithNoFoodStoreJustGenerates(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	h := NewEstimateHandler(est, &memUsage{}, nil)
	if w := call(t, h, `{"description":"Pork Shashlik"}`); w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if est.calls != 1 {
		t.Fatalf("want one generation, got %d", est.calls)
	}
}
