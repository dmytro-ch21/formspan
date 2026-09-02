package nutrition

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

func item(over func(*EstimatedItem)) EstimatedItem {
	it := EstimatedItem{
		Name: "Scrambled eggs", ServingLabel: "1 medium egg", Servings: 2,
		Kcal: 180, ProteinG: 12, CarbG: 1, FatG: 14,
		PortionConfidence: ConfidenceHigh, Assumption: "assumed a medium egg",
	}
	if over != nil {
		over(&it)
	}
	return it
}

func TestValidateEstimateAcceptsAnOrdinaryDraft(t *testing.T) {
	if err := ValidateEstimate(Estimate{Items: []EstimatedItem{item(nil)}}); err != nil {
		t.Fatalf("ordinary draft rejected: %v", err)
	}
}

func TestAnEmptyDraftIsARefusalRatherThanASuccess(t *testing.T) {
	// Zero items means the model could not read it as food. Returning that as
	// a successful empty draft would put an empty quick-add sheet in front of
	// the athlete with no explanation.
	err := ValidateEstimate(Estimate{})
	if !errors.Is(err, ErrEstimateRefused) {
		t.Fatalf("want ErrEstimateRefused, got %v", err)
	}
}

func TestNegativeAndNaNMacrosAreRejected(t *testing.T) {
	// THE POINT OF ValidateEstimate. Structured outputs guarantee that `kcal`
	// is a number; they cannot express a range, so the schema alone would let
	// every value here through to a numeric column.
	cases := map[string]EstimatedItem{
		"negative kcal":    item(func(i *EstimatedItem) { i.Kcal = -1 }),
		"negative protein": item(func(i *EstimatedItem) { i.ProteinG = -0.5 }),
		"negative serving": item(func(i *EstimatedItem) { i.Servings = -2 }),
		"NaN kcal":         item(func(i *EstimatedItem) { i.Kcal = math.NaN() }),
		"NaN fat":          item(func(i *EstimatedItem) { i.FatG = math.NaN() }),
		"+Inf carbs":       item(func(i *EstimatedItem) { i.CarbG = math.Inf(1) }),
		"-Inf kcal":        item(func(i *EstimatedItem) { i.Kcal = math.Inf(-1) }),
		"absurd kcal":      item(func(i *EstimatedItem) { i.Kcal = maxItemKcal + 1 }),
		"absurd grams":     item(func(i *EstimatedItem) { i.ProteinG = maxItemGrams + 1 }),
	}
	for name, it := range cases {
		t.Run(name, func(t *testing.T) {
			if err := ValidateEstimate(Estimate{Items: []EstimatedItem{it}}); err == nil {
				t.Fatal("accepted a value that cannot be eaten")
			}
		})
	}
}

func TestNaNIsCaughtByTheNotGreaterEqualForm(t *testing.T) {
	// The guard is `!(v >= 0)`, not `v < 0`, and the difference is only
	// visible on NaN: every comparison with NaN is false, so `v < 0` would
	// wave it through. Postgres numeric accepts 'NaN', so this would reach the
	// column and poison every sum it takes part in.
	nan := math.NaN()
	if nan < 0 {
		t.Fatal("premise broken: NaN < 0 should be false")
	}
	if !(nan >= 0) != true {
		t.Fatal("premise broken: !(NaN >= 0) should be true")
	}
	err := ValidateEstimate(Estimate{Items: []EstimatedItem{item(func(i *EstimatedItem) { i.Kcal = nan })}})
	if err == nil {
		t.Fatal("NaN kcal accepted — the guard has been rewritten as v < 0")
	}
}

func TestInfinityIsCaughtSeparatelyFromNaN(t *testing.T) {
	// The MIRROR of the NaN case, and it was a real gap here until this test
	// found it: the NaN-safe form `!(v >= 0)` lets +Inf straight through,
	// because `+Inf >= 0` is true. Postgres numeric accepts 'Infinity' as
	// readily as 'NaN', so it would have reached the column.
	if !(math.Inf(1) >= 0) {
		t.Fatal("premise broken: +Inf >= 0 should be true")
	}
	for _, v := range []float64{math.Inf(1), math.Inf(-1)} {
		err := ValidateEstimate(Estimate{Items: []EstimatedItem{
			item(func(i *EstimatedItem) { i.Kcal = v }),
		}})
		if err == nil {
			t.Fatalf("accepted kcal = %v", v)
		}
	}
}

func TestTheAbsurdityBoundsNeverFireOnRealFood(t *testing.T) {
	// These are absurdity bounds, not correctness ones. A rail that fires on
	// an ordinary meal is an unevidenced second opinion about somebody's
	// dinner — this module has been bitten by rails tuned too tight before.
	// A very large but real day: a 1kg steak, a litre of olive oil's worth of
	// fat, a competitive-eating portion.
	hearty := EstimatedItem{
		Name: "The whole tray", ServingLabel: "1 tray", Servings: 12,
		Kcal: 6000, ProteinG: 400, CarbG: 700, FatG: 300,
		PortionConfidence: ConfidenceLow, Assumption: "assumed the tray is full",
	}
	if err := ValidateEstimate(Estimate{Items: []EstimatedItem{hearty}}); err != nil {
		t.Fatalf("a large but real meal was rejected: %v", err)
	}
}

func TestAnUnknownConfidenceIsRejected(t *testing.T) {
	// The schema's enum makes this near-impossible from the model, but the
	// value also arrives through JSON unmarshalling, which does not enforce
	// enums — so a drifted upstream would deliver it silently.
	err := ValidateEstimate(Estimate{Items: []EstimatedItem{
		item(func(i *EstimatedItem) { i.PortionConfidence = "probably" }),
	}})
	if err == nil {
		t.Fatal("accepted an unknown portion_confidence")
	}
}

func TestFibreMayBeAbsentButNotNegative(t *testing.T) {
	// Null is "not stated" throughout this module, never zero.
	if err := ValidateEstimate(Estimate{Items: []EstimatedItem{item(nil)}}); err != nil {
		t.Fatalf("absent fibre rejected: %v", err)
	}
	neg := -3.0
	err := ValidateEstimate(Estimate{Items: []EstimatedItem{
		item(func(i *EstimatedItem) { i.FibreG = &neg }),
	}})
	if err == nil {
		t.Fatal("accepted negative fibre")
	}
}

func TestADraftLongerThanAMealIsRejected(t *testing.T) {
	many := make([]EstimatedItem, MaxEstimatedItems+1)
	for i := range many {
		many[i] = item(nil)
	}
	if err := ValidateEstimate(Estimate{Items: many}); err == nil {
		t.Fatalf("accepted %d items", len(many))
	}
}

// ---------------------------------------------------------------------------
// Input validation — everything that must fail BEFORE a token is spent.
// ---------------------------------------------------------------------------

func TestAnEmptyRequestIsRefusedBeforeSpendingAnything(t *testing.T) {
	err := EstimateInput{}.Validate()
	if !errors.Is(err, ErrNoInput) {
		t.Fatalf("want ErrNoInput, got %v", err)
	}
	// Whitespace is not a description.
	if err := (EstimateInput{Description: "   \n\t "}).Validate(); !errors.Is(err, ErrNoInput) {
		t.Fatalf("whitespace accepted as a description: %v", err)
	}
}

func TestAnOverLongDescriptionIsRejected(t *testing.T) {
	// A cost guard, not a safety one: this endpoint is the only place where an
	// unbounded input turns directly into somebody's money.
	in := EstimateInput{Description: strings.Repeat("a", MaxDescriptionRunes+1)}
	if err := in.Validate(); err == nil {
		t.Fatal("accepted a description over the cap")
	}
	// Counted in RUNES, not bytes — an emoji-heavy description is not four
	// times as expensive as an ASCII one.
	if err := (EstimateInput{Description: strings.Repeat("🍳", MaxDescriptionRunes)}).Validate(); err != nil {
		t.Fatalf("rejected %d runes as though they were bytes: %v", MaxDescriptionRunes, err)
	}
}

func TestAnOversizeOrWrongTypeImageIsRejected(t *testing.T) {
	big := EstimateInput{Image: make([]byte, MaxImageBytes+1), ImageMediaType: "image/jpeg"}
	if err := big.Validate(); err == nil {
		t.Fatal("accepted an image over the cap")
	}
	pdf := EstimateInput{Image: []byte("%PDF-1.7"), ImageMediaType: "application/pdf"}
	if err := pdf.Validate(); err == nil {
		t.Fatal("accepted a PDF as an image")
	}
}

func TestSourceDecidesWhichQuotaIsSpent(t *testing.T) {
	// The reason the two are counted apart: a photo is the dearer path, by
	// ~1.1x on the shipped model rather than the ~50x first assumed. Small
	// enough that the split is a precaution against a runaway photo loop, not
	// a cost control — see quota.go.
	if got := (EstimateInput{Description: "two eggs"}).Source(); got != SourceText {
		t.Fatalf("text input reported %q", got)
	}
	if got := (EstimateInput{Image: []byte{1}, ImageMediaType: "image/png"}).Source(); got != SourcePhoto {
		t.Fatalf("photo input reported %q", got)
	}
	// A photo WITH a description is still a photo — it is the image that costs.
	both := EstimateInput{Description: "the sauce is peanut", Image: []byte{1}, ImageMediaType: "image/png"}
	if got := both.Source(); got != SourcePhoto {
		t.Fatalf("photo-plus-text reported %q, so it would be billed as text", got)
	}
}

// ---------------------------------------------------------------------------
// The schema itself.
// ---------------------------------------------------------------------------

func TestTheSchemaMeetsWhatStructuredOutputsRequire(t *testing.T) {
	// Structured outputs require `additionalProperties: false` and every
	// property listed in `required`. A schema that violates either is rejected
	// by the API at call time — which is to say, in production, on the first
	// real request, having passed every local check.
	schema := EstimateSchema()
	assertClosed(t, "root", schema)

	props := schema["properties"].(map[string]any)
	items := props["items"].(map[string]any)
	itemSchema := items["items"].(map[string]any)
	assertClosed(t, "item", itemSchema)

	// And it must round-trip through JSON, because that is how it is sent.
	if _, err := json.Marshal(schema); err != nil {
		t.Fatalf("schema does not marshal: %v", err)
	}
}

// TestTheSchemaAsksForAMealName is N472's own guard on the schema shape
// itself — `assertClosed` above already enforces "every property is in
// required", but says nothing about which properties EXIST, so a schema
// that silently dropped meal_name would still pass every other schema test.
func TestTheSchemaAsksForAMealName(t *testing.T) {
	props := EstimateSchema()["properties"].(map[string]any)
	if _, ok := props["meal_name"]; !ok {
		t.Fatal("schema has no meal_name property")
	}
}

func assertClosed(t *testing.T, label string, schema map[string]any) {
	t.Helper()
	if schema["additionalProperties"] != false {
		t.Fatalf("%s: additionalProperties is %v, want false", label, schema["additionalProperties"])
	}
	props, _ := schema["properties"].(map[string]any)
	required, _ := schema["required"].([]any)
	if len(props) != len(required) {
		t.Fatalf("%s: %d properties but %d required — structured outputs need every one listed",
			label, len(props), len(required))
	}
	have := map[string]bool{}
	for _, r := range required {
		have[r.(string)] = true
	}
	for name := range props {
		if !have[name] {
			t.Fatalf("%s: property %q is not in required", label, name)
		}
	}
}

func TestTheSchemaCarriesNoNumericBounds(t *testing.T) {
	// Structured outputs do NOT support minimum/maximum, and a schema carrying
	// them is rejected outright. This is also why ValidateEstimate exists — the
	// two are complements, not duplicates, and a future edit that "tightens"
	// the schema with a minimum would break every call.
	var walk func(any)
	walk = func(n any) {
		switch v := n.(type) {
		case map[string]any:
			for k, child := range v {
				if k == "minimum" || k == "maximum" || k == "minLength" || k == "maxLength" {
					t.Fatalf("schema carries %q, which structured outputs reject", k)
				}
				walk(child)
			}
		case []any:
			for _, child := range v {
				walk(child)
			}
		}
	}
	walk(EstimateSchema())
}

// ---------------------------------------------------------------------------
// Quota arithmetic.
// ---------------------------------------------------------------------------

// **This replaces a test asserting the OPPOSITE**, and the reversal is the
// point rather than an accident.
//
// The old test required the photo cap to be strictly below the text cap, on the
// stated grounds that "a photo costs ~50x a description". Measured on the
// shipped model it costs ~1.2–1.5x for the same meal, while ITEM COUNT moves
// the bill ~5x — so the old assertion pinned a distinction that does not exist
// and hid the one that does. See quota.go for the numbers.
//
// Asserting the collapse explicitly, rather than deleting the test, so a future
// session that reintroduces a per-path cap has to argue with a measurement
// instead of quietly restoring a guess.
func TestOneBudgetCoversBothPaths(t *testing.T) {
	textQ := NewQuota(0, nil)
	photoQ := NewQuota(0, nil)
	if textQ.Limit != photoQ.Limit {
		t.Fatal("the paths report different limits — there is one budget")
	}
	if textQ.Limit != DailyEstimates {
		t.Fatalf("limit = %d, want DailyEstimates (%d)", textQ.Limit, DailyEstimates)
	}
	// The property that actually matters to an athlete: a photo consumes the
	// same budget a description does, so nothing is stopped for the wrong
	// reason.
	spent := NewQuota(DailyEstimates-1, nil)
	if !spent.Allowed() {
		t.Fatal("blocked one call short of the budget")
	}
}

func TestQuotaAllowsUpToTheLimitAndNotBeyond(t *testing.T) {
	limit := DailyEstimates
	if q := NewQuota(limit-1, nil); !q.Allowed() {
		t.Fatalf("blocked at %d of %d", limit-1, limit)
	}
	if q := NewQuota(limit, nil); q.Allowed() {
		t.Fatalf("allowed a call at exactly the limit of %d", limit)
	}
}

func TestRemainingNeverGoesNegative(t *testing.T) {
	// Reachable by lowering the caps in a deploy while somebody is over the
	// new one. A negative "remaining" rendered in a client reads as a bug in
	// the app rather than as a cap that moved.
	q := NewQuota(DailyEstimates+7, nil)
	if q.Remaining != 0 {
		t.Fatalf("remaining = %d, want 0", q.Remaining)
	}
	if q.Allowed() {
		t.Fatal("allowed a call while over the limit")
	}
}

func TestResetsAtIsTheOldestCallAgingOut(t *testing.T) {
	oldest := time.Date(2026, 8, 18, 9, 0, 0, 0, time.UTC)
	q := NewQuota(3, &oldest)
	if q.ResetsAt == nil {
		t.Fatal("no resets_at with calls in the window")
	}
	if want := oldest.Add(QuotaWindow); !q.ResetsAt.Equal(want) {
		t.Fatalf("resets_at = %v, want %v", q.ResetsAt, want)
	}
	// Nothing used means nothing waiting to expire.
	if NewQuota(0, nil).ResetsAt != nil {
		t.Fatal("resets_at set with no usage")
	}
}
