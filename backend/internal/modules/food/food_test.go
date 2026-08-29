package food

import "testing"

// naturalServing (N448) is the single definition of "the natural default
// serving" that both Get (which has the whole Portions slice) and Search
// (which asks Postgres for only the first row — see
// PostgresRepository.Search) are meant to agree on. Pure-function coverage
// here so the derivation logic itself is tested without a database, and the
// SQL LATERAL join is checked separately in postgres_test.go against a real
// food_catalog_portions table.
func TestNaturalServingReturnsTheFirstPortionsLabelAndGrams(t *testing.T) {
	label, grams := naturalServing([]Portion{
		{Seq: 1, Label: "1 can 8.4 fl oz", Grams: 258},
		{Seq: 2, Label: "1 fl oz", Grams: 30},
	})
	if label == nil || *label != "1 can 8.4 fl oz" {
		t.Errorf("label = %v, want \"1 can 8.4 fl oz\" — the FIRST portion, not any other", label)
	}
	if grams == nil || *grams != 258 {
		t.Errorf("grams = %v, want 258", grams)
	}
}

// The other 268 of 12,651 catalog rows: no portion data, so no natural
// serving — never a fabricated one standing in for something USDA never
// stated. This is the acceptance criterion the ticket calls out by name.
func TestNaturalServingIsNilForAFoodWithNoPortions(t *testing.T) {
	label, grams := naturalServing(nil)
	if label != nil {
		t.Errorf("label = %v, want nil", *label)
	}
	if grams != nil {
		t.Errorf("grams = %v, want nil", *grams)
	}

	label, grams = naturalServing([]Portion{})
	if label != nil || grams != nil {
		t.Error("an empty (non-nil) slice must also derive to nil, nil — length is what matters, not nilness")
	}
}

// naturalServing must return its OWN copies, not aliases into the caller's
// slice — a caller mutating portions[0] after the call (or Go reusing the
// loop variable's address, historically) must not retroactively change what
// was already handed out as "the" natural serving.
func TestNaturalServingDoesNotAliasTheInputSlice(t *testing.T) {
	portions := []Portion{{Seq: 1, Label: "1 large", Grams: 50}}
	label, grams := naturalServing(portions)
	portions[0].Label = "mutated"
	portions[0].Grams = 999

	if *label != "1 large" {
		t.Errorf("label changed after the input was mutated: got %q, want \"1 large\" — naturalServing must copy, not alias", *label)
	}
	if *grams != 50 {
		t.Errorf("grams changed after the input was mutated: got %v, want 50 — naturalServing must copy, not alias", *grams)
	}
}
