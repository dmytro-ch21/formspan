package food

import (
	"strings"
	"testing"
)

// The seed file is generated, but it is also editable, and these are the
// mistakes a diff does not show.

func TestSeedDataParsesAndValidates(t *testing.T) {
	foods, err := SeedData()
	if err != nil {
		t.Fatal(err)
	}
	if len(foods) == 0 {
		t.Fatal("the catalog is empty")
	}
	for _, f := range foods {
		if err := f.Validate(); err != nil {
			t.Errorf("%s: %v", f.ID, err)
		}
		if f.Source != SourceSeed {
			t.Errorf("%s: source = %q, want seed — a seeded row that arrives as admin is immediately out of deploy management", f.ID, f.Source)
		}
		if f.ServingLabel != SeedServingLabel {
			t.Errorf("%s: serving_label = %q, want %q", f.ID, f.ServingLabel, SeedServingLabel)
		}
		// Every number must be checkable against its source. A catalog whose
		// selling point over the AI estimator is that it is exact cannot carry
		// figures nobody can verify.
		if f.ExternalID == nil || *f.ExternalID == "" {
			t.Errorf("%s: no external_id", f.ID)
		}
		if f.ExternalSource == nil || *f.ExternalSource != "usda" {
			t.Errorf("%s: external_source = %v, want usda", f.ID, f.ExternalSource)
		}
	}
}

func TestSeedIDsAreUniqueSlugs(t *testing.T) {
	foods, err := SeedData()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, f := range foods {
		if seen[f.ID] {
			t.Errorf("duplicate id %q — one food silently overwrites another", f.ID)
		}
		seen[f.ID] = true
		if !validSlug.MatchString(f.ID) {
			t.Errorf("id %q is not a slug, and the column CHECK will reject it mid-deploy", f.ID)
		}
	}
}

// Fibre is nullable and that is NOT zero. If the importer ever "helpfully"
// filled absent fibre with 0, every fibre figure in the catalog would be
// dragged down and nothing would report it.
func TestSeedKeepsUnstatedFibreNull(t *testing.T) {
	foods, err := SeedData()
	if err != nil {
		t.Fatal(err)
	}
	nulls := 0
	for _, f := range foods {
		if f.FibreG == nil {
			nulls++
		}
	}
	if nulls == 0 {
		t.Fatal("no row has null fibre — either the source changed or absent fibre is being written as 0, which is a different claim")
	}
}

// The validator has to reject what it exists to reject. Each case is a
// mutation of a good row; if any passes, that guard is decoration.
func TestSeedValidatorRejectsBadContent(t *testing.T) {
	good := seedFood{
		ID: "ok", Name: "Ok", Category: "dairy", Market: "us",
		ExternalID: "1", ServingGrams: 100, KCal: 1,
	}
	cases := map[string]func(*seedFood){
		"no id":          func(f *seedFood) { f.ID = "" },
		"id not a slug":  func(f *seedFood) { f.ID = "Not A Slug" },
		"no name":        func(f *seedFood) { f.Name = "" },
		"no category":    func(f *seedFood) { f.Category = "" },
		"no market":      func(f *seedFood) { f.Market = "" },
		"no external id": func(f *seedFood) { f.ExternalID = "" },
		"zero serving":   func(f *seedFood) { f.ServingGrams = 0 },
		"negative macro": func(f *seedFood) { f.ProteinG = -1 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			bad := good
			mutate(&bad)
			if err := validate([]seedFood{bad}); err == nil {
				t.Fatalf("validate accepted %s", name)
			}
		})
	}

	// And it must accept a good one, or every case above passes vacuously.
	if err := validate([]seedFood{good}); err != nil {
		t.Fatalf("validate rejected a good row: %v", err)
	}
}

// An empty seed file would seed nothing and the catalog would report itself
// empty at runtime. Better a deploy failure than a mystery.
func TestSeedValidatorRejectsAnEmptyFile(t *testing.T) {
	if err := validate(nil); err == nil {
		t.Fatal("validate accepted an empty catalog")
	}
}

func TestSeedDuplicateIDIsRejected(t *testing.T) {
	f := seedFood{ID: "dup", Name: "A", Category: "c", Market: "us", ExternalID: "1", ServingGrams: 100}
	err := validate([]seedFood{f, f})
	if err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("err = %v, want a duplicate-id error", err)
	}
}
