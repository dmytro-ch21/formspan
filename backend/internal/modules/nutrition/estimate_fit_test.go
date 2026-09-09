package nutrition

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

/**
 * N533/#964 — "some foods from AI generation don't get saved".
 *
 * The reproduction, end to end and against the REAL validators: the model
 * returns an item the estimate accepts, the phone turns that item into a
 * saved food and a logged entry, and the server refuses both with a 400. The
 * refusal is permanent as far as the phone is concerned, so the food lives
 * only on that device — until a reinstall, when it is simply gone.
 *
 * The estimator now fits every item to what `Food.Validate` and
 * `Entry.Validate` accept, and these tests hold that end to end rather than
 * asserting a rune count: the property that matters is "a draft can always
 * be saved", and the rune count is only how it is achieved today.
 */

// The label a model is perfectly capable of producing when asked to describe
// "a burrito bowl": 68 runes, well over the 40 a saved food accepts.
const longLabel = "1 restaurant bowl with rice, beans, salsa and sour cream (about 400 g)"

// rawWith builds one well-formed model response around a name and a label.
func rawWith(name, label string) string {
	b, _ := json.Marshal(map[string]any{
		"items": []map[string]any{{
			"name": name, "serving_label": label, "servings": 1,
			"kcal": 720, "protein_g": 30, "carb_g": 80, "fat_g": 28, "fibre_g": 9,
			"portion_confidence": "medium", "assumption": "",
		}},
		"note": "", "meal_name": "",
	})
	return string(b)
}

// foodFromItem is the projection the phone's `savedFoodFrom` performs — the
// fields `Food.Validate` reads, taken straight from the drafted item. Kept
// minimal on purpose: what is under test is whether the item's name and
// label survive the validator, not the macro arithmetic.
func foodFromItem(it EstimatedItem) Food {
	return Food{
		ID: "2f0c8b5e-1b41-4a9e-9d0c-6b8f2d3e4a11", UserID: "u", Kind: KindFood,
		Name: it.Name, ServingLabel: it.ServingLabel,
		Macros: Macros{Kcal: it.Kcal, ProteinG: it.ProteinG, CarbG: it.CarbG, FatG: it.FatG, FibreG: it.FibreG},
		Source: SourceAI,
	}
}

// entryFromItem is the phone's `itemToEntry`, likewise.
func entryFromItem(it EstimatedItem) Entry {
	return Entry{
		ID: "3a1d9c6f-2c52-4b0f-8e1d-7c9a3e4f5b22", UserID: "u", EatenOn: "2026-09-08", Meal: MealLunch,
		Name: it.Name, Servings: it.Servings, ServingLabel: it.ServingLabel,
		Macros: Macros{Kcal: it.Kcal, ProteinG: it.ProteinG, CarbG: it.CarbG, FatG: it.FatG, FibreG: it.FibreG},
	}
}

// First, that the trap is real: WITHOUT the fit, the exact item the model
// returned is one the food validator refuses. This is the measurement that
// makes the tests below evidence rather than a tautology — if this ever
// passes validation, the limits have moved and the fit is doing nothing.
func TestAnUnfittedLongLabelIsWhatTheServerRefuses(t *testing.T) {
	var e Estimate
	if err := json.Unmarshal([]byte(rawWith("Burrito bowl", longLabel)), &e); err != nil {
		t.Fatal(err)
	}
	if err := ValidateEstimate(e); err != nil {
		t.Fatalf("the ESTIMATE must accept this item — that is the whole trap: %v", err)
	}
	f := foodFromItem(e.Items[0])
	if err := f.Validate(); err == nil {
		t.Fatalf("Food.Validate accepted a %d-rune label; the trap this ticket closes no longer exists, re-measure", utf8.RuneCountInString(longLabel))
	}
	en := entryFromItem(e.Items[0])
	if err := en.Validate(); err == nil {
		t.Fatalf("Entry.Validate accepted a %d-rune label; re-measure", utf8.RuneCountInString(longLabel))
	}
}

func TestADraftedItemCanAlwaysBeSavedAsAFoodAndLoggedAsAnEntry(t *testing.T) {
	cases := map[string]struct {
		name, label string
	}{
		"a long label":               {"Burrito bowl", longLabel},
		"an empty label":             {"Burrito bowl", ""},
		"a whitespace label":         {"Burrito bowl", "   "},
		"a long name":                {strings.Repeat("Chipotle chicken burrito bowl ", 6), "1 bowl"},
		"a multibyte label over 40":  {"Борщ", strings.Repeat("тарелка ", 8)},
		"a padded but fine label":    {"Eggs", "  1 medium egg  "},
		"exactly the limit":          {"Eggs", strings.Repeat("x", maxLabelRunes)},
		"one over, multibyte at cut": {"Eggs", strings.Repeat("é", maxLabelRunes+1)},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			est := &estimator{c: &fakeCompleter{raw: rawWith(tc.name, tc.label), model: "m"}}
			out, _, err := est.Estimate(context.Background(), EstimateInput{Description: "a bowl"})
			if err != nil {
				t.Fatalf("estimate: %v", err)
			}
			it := out.Items[0]
			f, en := foodFromItem(it), entryFromItem(it)
			if err := f.Validate(); err != nil {
				t.Errorf("a drafted item must be saveable as a food, got: %v (label %q, %d runes)", err, it.ServingLabel, utf8.RuneCountInString(it.ServingLabel))
			}
			if err := en.Validate(); err != nil {
				t.Errorf("a drafted item must be loggable as an entry, got: %v", err)
			}
			if it.ServingLabel == "" {
				t.Error("a label must never come back empty")
			}
			if strings.TrimSpace(it.ServingLabel) != it.ServingLabel || strings.TrimSpace(it.Name) != it.Name {
				t.Errorf("name %q / label %q must arrive trimmed", it.Name, it.ServingLabel)
			}
			if !utf8.ValidString(it.ServingLabel) || !utf8.ValidString(it.Name) {
				t.Error("a cut must never split a character")
			}
		})
	}
}

// The default is the honest one — "1 serving" claims nothing — and it is
// applied only when there was nothing, never over a label the model gave.
func TestAnEmptyLabelBecomesOneServingAndAGivenOneIsKept(t *testing.T) {
	for label, want := range map[string]string{"": DefaultServingLabel, "  ": DefaultServingLabel, "1 slice": "1 slice"} {
		est := &estimator{c: &fakeCompleter{raw: rawWith("Toast", label), model: "m"}}
		out, _, err := est.Estimate(context.Background(), EstimateInput{Description: "toast"})
		if err != nil {
			t.Fatalf("estimate: %v", err)
		}
		if got := out.Items[0].ServingLabel; got != want {
			t.Errorf("label %q -> %q, want %q", label, got, want)
		}
	}
}

// A name that is nothing but whitespace is still REFUSED, not defaulted.
// The label gets "1 serving" when it is empty because an empty label means
// "counted in servings"; an empty NAME means the model could not say what
// the food is, and no default is honest there. This guards against the fit
// ever growing a name default — NOT against the call order in
// `estimator.go`: ValidateEstimate trims before its own emptiness check, so
// that order was measured to be irrelevant (see the comment beside the
// call).
func TestAWhitespaceNameIsStillRefusedAfterTheFit(t *testing.T) {
	est := &estimator{c: &fakeCompleter{raw: rawWith("   ", "1 slice"), model: "m"}}
	_, _, err := est.Estimate(context.Background(), EstimateInput{Description: "toast"})
	if err == nil {
		t.Fatal("a blank name must be refused, not saved as an empty string")
	}
}

// The phone-shaped request, through the REAL handler, so the assertion is
// about what the wire refuses and not about a validator called in isolation.
// A nil repository is safe here because the request never reaches it — 400
// is written before the store is consulted — and that is what is asserted.
func TestTheWireRefusesTheUnfittedLabelWithA400(t *testing.T) {
	body, _ := json.Marshal(map[string]any{
		"kind": "food", "name": "Burrito bowl", "serving_label": longLabel,
		"kcal": 720, "protein_g": 30, "carb_g": 80, "fat_g": 28, "fibre_g": 9, "source": "ai",
	})
	r := httptest.NewRequest(http.MethodPut, "/v1/nutrition/foods/2f0c8b5e-1b41-4a9e-9d0c-6b8f2d3e4a11", strings.NewReader(string(body)))
	r.SetPathValue("id", "2f0c8b5e-1b41-4a9e-9d0c-6b8f2d3e4a11")
	r = withClaims(r, "user-1")
	w := httptest.NewRecorder()

	NewHandler(nil).SaveFood(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "serving_label") {
		t.Fatalf("the refusal must name the field, got: %s", w.Body.String())
	}
}

/**
 * N542/#977 — the same failure class as the label above, one field over.
 *
 * `sane` asked for `servings >= 0`; `Entry.Validate` requires `> 0` and the
 * `nutrition_entries` CHECK requires it again. So an item counted zero times
 * was a VALID estimate that the phone confirmed, wrote locally as a saved
 * food plus an entry, and could then never push — a permanent 400 the phone
 * classifies as final, leaving a row that exists on one device until a
 * reinstall takes it away.
 *
 * The tests below hold the same end-to-end property the label's do — a draft
 * can always be saved — rather than asserting a particular number, and they
 * are led by the measurement that makes them evidence: the UNFITTED item is
 * one the estimate accepts and the save refuses.
 */

// rawServings builds one well-formed model response around a servings count.
func rawServings(servings float64) string {
	b, _ := json.Marshal(map[string]any{
		"items": []map[string]any{{
			"name": "Scrambled eggs", "serving_label": "1 medium egg", "servings": servings,
			"kcal": 180, "protein_g": 13, "carb_g": 1, "fat_g": 14, "fibre_g": 0,
			"portion_confidence": "medium", "assumption": "",
		}},
		"note": "", "meal_name": "",
	})
	return string(b)
}

// First, that the trap is real. If this test ever fails, the two limits have
// been brought together somewhere else and the fit below is doing nothing —
// re-measure rather than deleting it.
func TestAnUnfittedZeroServingsIsWhatTheServerRefuses(t *testing.T) {
	var e Estimate
	if err := json.Unmarshal([]byte(rawServings(0)), &e); err != nil {
		t.Fatal(err)
	}
	if err := ValidateEstimate(e); err != nil {
		t.Fatalf("the ESTIMATE must accept servings = 0 — that is the whole trap: %v", err)
	}
	en := entryFromItem(e.Items[0])
	if err := en.Validate(); err == nil {
		t.Fatal("Entry.Validate accepted servings = 0; the trap this ticket closes no longer exists, re-measure")
	}
}

// And that the fit closes it — without touching the numbers the athlete
// reads. The macros are the total for the quantity, so restating the count
// as one changes the entry's calories not at all; a test that only checked
// `Servings == 1` would pass just as well for a fit that halved the meal.
func TestAZeroServingsBecomesOneAndTheMacrosAreUntouched(t *testing.T) {
	est := &estimator{c: &fakeCompleter{raw: rawServings(0), model: "m"}}
	out, _, err := est.Estimate(context.Background(), EstimateInput{Description: "two eggs"})
	if err != nil {
		t.Fatalf("estimate: %v", err)
	}
	it := out.Items[0]
	if it.Servings != DefaultServings {
		t.Errorf("servings = %v, want %v", it.Servings, float64(DefaultServings))
	}
	if it.Kcal != 180 || it.ProteinG != 13 || it.CarbG != 1 || it.FatG != 14 {
		t.Errorf("the fit rewrote the meal: %+v", it)
	}
	en, f := entryFromItem(it), foodFromItem(it)
	if err := en.Validate(); err != nil {
		t.Errorf("a drafted item must be loggable as an entry, got: %v", err)
	}
	if err := f.Validate(); err != nil {
		t.Errorf("a drafted item must be saveable as a food, got: %v", err)
	}
}

// A count the model DID state is never rewritten, including a fractional one:
// half a burrito is a real portion, and a fit that rounded it up would log a
// meal nobody ate.
func TestAStatedServingsIsKept(t *testing.T) {
	for _, v := range []float64{0.5, 1, 2, 3.25} {
		est := &estimator{c: &fakeCompleter{raw: rawServings(v), model: "m"}}
		out, _, err := est.Estimate(context.Background(), EstimateInput{Description: "eggs"})
		if err != nil {
			t.Fatalf("servings %v: %v", v, err)
		}
		if got := out.Items[0].Servings; got != v {
			t.Errorf("servings %v was rewritten to %v", v, got)
		}
	}
}

// A NEGATIVE count is still REFUSED rather than fitted, and the asymmetry is
// the point: zero means the model did not state a count, and one is the
// honest reading of that; minus two is evidence the output is malformed, and
// inventing a portion from it would put a number nobody produced into the
// athlete's log. NaN is refused for the same reason — and `NaN == 0` being
// false is exactly what keeps the fit from swallowing it.
func TestANegativeOrNaNServingsIsRefusedRatherThanFitted(t *testing.T) {
	for _, raw := range []string{rawServings(-2), strings.Replace(rawServings(1), `"servings":1`, `"servings":-0.0001`, 1)} {
		est := &estimator{c: &fakeCompleter{raw: raw, model: "m"}}
		if _, _, err := est.Estimate(context.Background(), EstimateInput{Description: "eggs"}); err == nil {
			t.Errorf("a negative servings must be refused, not fitted: %s", raw)
		}
	}
	// NaN cannot be written as JSON, so it is set on the struct directly —
	// the fit is what is under test, not the decoder.
	e := Estimate{Items: []EstimatedItem{{
		Name: "Eggs", ServingLabel: "1 egg", Servings: math.NaN(),
		Kcal: 180, ProteinG: 13, CarbG: 1, FatG: 14, PortionConfidence: ConfidenceMedium,
	}}}
	e.fitToFood()
	if !math.IsNaN(e.Items[0].Servings) {
		t.Fatalf("the fit swallowed a NaN into %v — the guard has been rewritten as `<= 0`", e.Items[0].Servings)
	}
	if err := ValidateEstimate(e); err == nil {
		t.Fatal("a NaN servings must be refused")
	}
}

/**
 * The invariant N542 turns the two point-fixes into: an item the ESTIMATE
 * accepts is an item the SAVE accepts, for every numeric field, probed at
 * each field's own ceiling and just below it.
 *
 * This is the audit written as a test rather than as a table in a PR body.
 * Before this ticket it went red four ways at once — `kcal` at exactly
 * 20000, every macro from 2000 to 5000, fibre from 500 to 5000, and
 * `servings` at zero — each of which was a draft the phone would have
 * written locally and never been able to push.
 *
 * Note what it does NOT assert: that a given probe is accepted. A refused
 * draft is a fine outcome — the athlete is told and nothing is written. What
 * must never happen is the other order.
 */
func TestAnAcceptedDraftIsAlwaysASaveableOne(t *testing.T) {
	base := EstimatedItem{
		Name: "Scrambled eggs", ServingLabel: "1 medium egg", Servings: 2,
		Kcal: 180, ProteinG: 13, CarbG: 1, FatG: 14,
		PortionConfidence: ConfidenceMedium,
	}
	fibre := func(v float64) *float64 { return &v }
	probes := map[string]struct {
		mutate func(*EstimatedItem)
		wantOK bool
	}{
		"nothing changed":          {func(i *EstimatedItem) {}, true},
		"servings zero":            {func(i *EstimatedItem) { i.Servings = 0 }, true},
		"servings fractional":      {func(i *EstimatedItem) { i.Servings = 0.5 }, true},
		"servings just under":      {func(i *EstimatedItem) { i.Servings = maxItemServings - 0.5 }, true},
		"servings at the ceiling":  {func(i *EstimatedItem) { i.Servings = maxItemServings }, false},
		"servings negative":        {func(i *EstimatedItem) { i.Servings = -1 }, false},
		"kcal just under":          {func(i *EstimatedItem) { i.Kcal = maxItemKcal - 0.5 }, true},
		"kcal at the ceiling":      {func(i *EstimatedItem) { i.Kcal = maxItemKcal }, false},
		"kcal over":                {func(i *EstimatedItem) { i.Kcal = maxItemKcal + 1 }, false},
		"protein just under":       {func(i *EstimatedItem) { i.ProteinG = maxItemGrams - 0.5 }, true},
		"protein at the ceiling":   {func(i *EstimatedItem) { i.ProteinG = maxItemGrams }, false},
		"protein at the old bound": {func(i *EstimatedItem) { i.ProteinG = 5000 }, false},
		"carb just under":          {func(i *EstimatedItem) { i.CarbG = maxItemGrams - 0.5 }, true},
		"carb at the ceiling":      {func(i *EstimatedItem) { i.CarbG = maxItemGrams }, false},
		"carb at the old bound":    {func(i *EstimatedItem) { i.CarbG = 5000 }, false},
		"fat just under":           {func(i *EstimatedItem) { i.FatG = maxItemGrams - 0.5 }, true},
		"fat at the ceiling":       {func(i *EstimatedItem) { i.FatG = maxItemGrams }, false},
		"fat at the old bound":     {func(i *EstimatedItem) { i.FatG = 5000 }, false},
		"fibre just under":         {func(i *EstimatedItem) { i.FibreG = fibre(maxItemFibreG - 0.5) }, true},
		"fibre at the ceiling":     {func(i *EstimatedItem) { i.FibreG = fibre(maxItemFibreG) }, false},
		"fibre at the old bound":   {func(i *EstimatedItem) { i.FibreG = fibre(4999) }, false},
	}
	for name, tc := range probes {
		t.Run(name, func(t *testing.T) {
			it := base
			tc.mutate(&it)
			e := Estimate{Items: []EstimatedItem{it}}
			e.fitToFood()
			err := ValidateEstimate(e)

			// The estimate's OWN verdict is asserted, not merely observed.
			// An earlier draft of this test only checked saveability for
			// whatever happened to be accepted, and guarded that with a
			// "at least half the probes were accepted" ratio — which a
			// refusing probe added later would have broken for the wrong
			// reason, and which said nothing about WHICH probes ran. Stating
			// the expected verdict per probe pins each bound directly and
			// cannot pass while measuring nothing.
			if tc.wantOK && err != nil {
				t.Fatalf("the estimate refused a value the save accepts: %v", err)
			}
			if !tc.wantOK {
				if err == nil {
					t.Fatal("the estimate accepted a value at or beyond the save's own ceiling")
				}
				return
			}

			f, en := foodFromItem(e.Items[0]), entryFromItem(e.Items[0])
			if err := f.Validate(); err != nil {
				t.Errorf("the estimate accepted an item the FOOD save refuses: %v", err)
			}
			if err := en.Validate(); err != nil {
				t.Errorf("the estimate accepted an item the ENTRY save refuses: %v", err)
			}
		})
	}
}
