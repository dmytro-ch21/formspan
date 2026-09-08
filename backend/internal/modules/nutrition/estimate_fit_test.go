package nutrition

import (
	"context"
	"encoding/json"
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
