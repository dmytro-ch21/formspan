package exercise

import "testing"

// TestSeedCatalogCarriesLoadMode is the regression for a bug that a migration
// alone could never have fixed.
//
// `load_mode` was added by migration 000052, which backfills EXISTING rows. A
// freshly created database has no rows to backfill: the seeder then inserts the
// whole catalog, and until this field was threaded through the upsert every one
// of them took the column default of 'total'. So the classification worked on
// the developer's database and silently did not exist in CI, on a new deploy,
// or for anybody who reset their local database — and the symptom would have
// been dumbbell tonnage quietly halving again, which is exactly what the
// migration was written to fix.
//
// The seed file is therefore the source of truth for it, as it is for every
// other catalog fact, and this asserts the file actually carries it.
func TestSeedCatalogCarriesLoadMode(t *testing.T) {
	all, err := SeedData()
	if err != nil {
		t.Fatalf("seed data: %v", err)
	}
	if len(all) == 0 {
		t.Fatal("no seed exercises")
	}

	byID := make(map[string]Exercise, len(all))
	modes := map[string]int{}
	for _, e := range all {
		byID[e.ID] = e
		modes[NormalizeLoadMode(e.LoadMode)]++
	}

	// Not vacuous: if every row were 'total' the assertions below would still
	// need a real per_side population to be meaningful.
	if modes[LoadModePerSide] < 50 {
		t.Fatalf("only %d per_side exercises — the catalog should classify well over "+
			"a hundred dumbbell and kettlebell movements", modes[LoadModePerSide])
	}

	for id, want := range map[string]string{
		// A pair of dumbbells: the number is one of them.
		"dumbbell-bench-press": LoadModePerSide,
		// One dumbbell, one hand: still per_side, and `is_unilateral` is what
		// stops it being doubled.
		"one-arm-dumbbell-row": LoadModePerSide,
		// A barbell is the whole load.
		"bench-press": LoadModeTotal,
		// ONE implement held in TWO hands. Equipment says dumbbells or
		// kettlebell, and classifying on equipment alone marks these per_side
		// and doubles them — inventing weight nobody lifted. These two are the
		// exact rows that caught it.
		"goblet-squat":     LoadModeTotal,
		"kettlebell-swing": LoadModeTotal,
	} {
		e, ok := byID[id]
		if !ok {
			t.Errorf("%s missing from the seed catalog", id)
			continue
		}
		if got := NormalizeLoadMode(e.LoadMode); got != want {
			t.Errorf("%s is %q, want %q", id, got, want)
		}
	}
}

// An unknown or absent value must read as 'total' — the safe side, because it
// under-reports rather than inventing load, and because it is what every row
// written before this existed means.
func TestNormalizeLoadModeFailsToTotal(t *testing.T) {
	for _, in := range []string{"", "per side", "PER_SIDE", "nonsense", "both"} {
		if got := NormalizeLoadMode(in); got != LoadModeTotal {
			t.Errorf("NormalizeLoadMode(%q) = %q, want %q", in, got, LoadModeTotal)
		}
	}
	if got := NormalizeLoadMode(LoadModePerSide); got != LoadModePerSide {
		t.Errorf("the one valid value did not survive: %q", got)
	}
}
