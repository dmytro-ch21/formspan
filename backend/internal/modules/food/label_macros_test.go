package food

import (
	"context"
	"testing"
)

// The label macros (N52), and above all the sodium unit conversion.
//
// **Open Food Facts reports sodium in GRAMS; USDA reports it in MILLIGRAMS;
// this codebase stores milligrams.** Dropping the conversion stores a number
// 1000x too small, and nothing downstream catches it: it passes every CHECK, it
// is a plausible figure, and it looks like an ordinary rounding difference to
// anyone reading it. Sodium is also the one field an athlete managing blood
// pressure actually reads, so being quietly wrong is worse than being absent.
//
// The numbers below are MEASURED from the live provider while this was written,
// not invented — `sodium_100g` was 0.536 on one real product and 0.0428 on
// another. A test built from an assumption about the provider cannot falsify
// that assumption; these came from the provider.

// realProduct mirrors what Open Food Facts actually returned for a real
// packaged food, including the fields it omits.
const realProduct = `{"status":1,"product":{"product_name":"Original Potato Crisps","brands":"Lay's",
	"nutriments":{"energy-kcal_100g":536,"proteins_100g":3.5,"carbohydrates_100g":57,"fat_100g":32,
	"fiber_100g":4,"saturated-fat_100g":9,"sugars_100g":1,"added-sugars_100g":0,
	"sodium_100g":0.536,"salt_100g":1.34}}}`

func TestSodiumIsConvertedFromGramsToMilligrams(t *testing.T) {
	off := offServer(t, 200, realProduct)
	got, err := off.Resolve(context.Background(), "0038000138416")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.SodiumMG == nil {
		t.Fatal("sodium is nil though the provider stated it")
	}
	// 0.536 g is 536 mg. Storing 0.536 would be a 1000x understatement that
	// reads as an ordinary number.
	if *got.SodiumMG != 536 {
		t.Fatalf("sodium %v mg, want 536 — the provider sends GRAMS and this "+
			"codebase stores MILLIGRAMS, so a missing x1000 is a silent 1000x error",
			*got.SodiumMG)
	}
}

func TestTheOtherLabelMacrosAreCarriedThrough(t *testing.T) {
	off := offServer(t, 200, realProduct)
	got, err := off.Resolve(context.Background(), "0038000138416")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	for _, c := range []struct {
		name string
		got  *float64
		want float64
	}{
		{"saturated fat", got.SaturatedFatG, 9},
		{"sugar", got.SugarG, 1},
		{"added sugar", got.AddedSugarG, 0},
	} {
		if c.got == nil {
			t.Errorf("%s is nil though the provider stated it", c.name)
			continue
		}
		if *c.got != c.want {
			t.Errorf("%s %v, want %v", c.name, *c.got, c.want)
		}
	}
	// Added sugar of ZERO must survive as zero, not collapse to nil. The
	// provider said "no added sugar", which is a real fact about the food and a
	// different statement from "we do not know".
	if got.AddedSugarG == nil {
		t.Error("a stated zero became nil — that turns a fact into an absence")
	}
}

// The other half of the same rule, and the one this codebase gets wrong most
// often: an absent value must stay absent.
func TestAnAbsentLabelMacroStaysNilRatherThanBecomingZero(t *testing.T) {
	// Cholesterol is the real case — Open Food Facts carried it on NEITHER
	// product measured — so this is the ordinary path, not an edge case.
	off := offServer(t, 200, realProduct)
	got, err := off.Resolve(context.Background(), "0038000138416")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.CholesterolMG != nil {
		t.Fatalf("cholesterol is %v though the provider did not state it — "+
			"a zero here claims the food contains none", *got.CholesterolMG)
	}
}

// Salt is deliberately not stored. If somebody adds it, this says why not.
func TestSaltIsNotStoredBecauseItIsDerivable(t *testing.T) {
	off := offServer(t, 200, realProduct)
	got, err := off.Resolve(context.Background(), "0038000138416")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	// Measured on two real products: salt is EXACTLY sodium x 2.5.
	// 0.536 g sodium -> 1.34 g salt, and 0.0428 -> 0.107.
	const saltPerSodium = 2.5
	saltG := (*got.SodiumMG / gramsToMilligrams) * saltPerSodium
	if saltG != 1.34 {
		t.Fatalf("derived salt %v g, want the provider's own 1.34 — if this "+
			"stops holding, the ratio assumption behind not storing salt is wrong", saltG)
	}
}

// A product whose sodium would only be plausible in the WRONG unit must be
// refused rather than shown.
func TestAnImplausibleSodiumIsRefusedRatherThanShown(t *testing.T) {
	// 200 g of sodium per 100 g is impossible; in grams-read-as-milligrams it
	// would look like a big but sane 200 mg. Catching it here is what stops a
	// unit mistake upstream reaching an athlete as measured fact.
	const absurd = `{"status":1,"product":{"product_name":"Broken","brands":"X",
		"nutriments":{"energy-kcal_100g":100,"proteins_100g":1,"carbohydrates_100g":1,
		"fat_100g":1,"sodium_100g":200}}}`
	off := offServer(t, 200, absurd)
	if _, err := off.Resolve(context.Background(), "0000000000000"); err == nil {
		t.Fatal("a 200,000 mg sodium figure was accepted and would be shown as measured")
	}
}
