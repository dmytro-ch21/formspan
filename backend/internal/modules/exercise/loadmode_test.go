package exercise

import (
	"strings"
	"testing"
)

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

// TestNoMovementDoublesAWeightItDoesNotHold is the guard F3 exists for.
//
// The 142 `per_side` rows were classified by EQUIPMENT plus a hand-written
// exclusion list, and nobody read the result. Ten were wrong: seven
// single-implement movements marked `per_side` while their identical peers
// (goblet squat, halo, pullover) were correctly `total`; two alternating lifts
// doubling a dumbbell they move one at a time; and one "double dumbbell" lift
// counting single because `is_unilateral` had been set truthfully about the
// STANCE.
//
// That last one is the trap worth naming. `is_unilateral` answers "is one limb
// working" and `load_mode` answers "is the recorded number one implement", and
// only their product decides tonnage — so a row can be honest about both fields
// and still report half the work.
//
// This asserts what the names already say, in both directions. A heuristic, and
// deliberately so: it cannot know what a movement is, but it can insist that a
// row calling itself "single" does not double and one calling itself "double"
// does not halve.
//
// It catches NINE of the ten. `alternating` had to be added after review
// mutation-tested the claim that it caught all of them and found it did not —
// and the four corrections checked by hand beforehand happened to be four of
// the covered ones. A sample that agrees with you is not a check.
func TestNoMovementDoublesAWeightItDoesNotHold(t *testing.T) {
	all, err := SeedData()
	if err != nil {
		t.Fatalf("seed data: %v", err)
	}

	// Words meaning "the athlete holds ONE of these". `offset` and `suitcase`
	// are a load carried on one side; `svend` is a plate or bell squeezed
	// between the palms; `goblet` and `halo` are one bell in two hands.
	// NOTE these mean ONE IMPLEMENT, never one limb — and `single-` used to be
	// in this list, which is how `single-leg-dumbbell-romanian-deadlift` was
	// pinned at x1. That movement is two dumbbells and one leg; the guard was
	// reading "single" as being about the hands when the name is about the
	// legs. The same conflation migration 000057 removed from the tonnage rule,
	// surviving one level up in the test meant to protect it.
	//
	// `single-arm` is listed explicitly instead, so the word only counts when
	// it is actually about the arms.
	single := []string{
		"single-arm", "one-arm", "suitcase", "offset", "goblet",
		"svend", "halo", "russian-twist", "hip-thrust", "glute-bridge",
		// `alternating` was MISSING from the first version of this list, and
		// review found it by mutation: reverting the two alternating
		// corrections left this test green. Both of them are among the ten this
		// guard was written for, so it was covering eight of its own examples
		// while its comment claimed all ten. The four corrections I
		// mutation-checked happened to be four of the covered eight — a sample
		// that agreed with me.
		"alternating",
	}
	// Words meaning TWO, so the recorded weight is one of them.
	//
	// Scoped to rows that actually carry a hand implement, because "double" is
	// not always a count: `jump-rope-double-under` is the rope passing twice per
	// jump and holds nothing. The first version of this test failed on it, which
	// is the right way round — a guard that cannot tell a skipping term from a
	// pair of dumbbells is one the first person it annoys will delete.
	//
	// `renegade` is deliberately NOT here. A renegade row holds two implements
	// but rows one per rep, which is the alternating case — and the confirmed
	// ruling for alternating is x1. Asserting x2 for it would have locked that
	// contradiction into a test. Left unclassified rather than guessed at; see
	// the open item in the history entry.
	pair := []string{"double-", "dual-", "farmer"}
	holdsAnImplement := func(e Exercise) bool {
		for _, q := range e.Equipment {
			if q == "dumbbells" || q == "kettlebell" || q == "farmer-handles" {
				return true
			}
		}
		return false
	}

	for _, e := range all {
		// `implements` IS the factor since migration 000057. This block used to
		// derive it as `LoadMode == per_side && !IsUnilateral`, and kept doing
		// so after that migration replaced the rule — so it was asserting about
		// a value nothing computes any more.
		//
		// Demonstrated rather than assumed: giving `one-arm-dumbbell-row`
		// implements=2 — the exact bug this guard exists to catch — left the
		// whole suite green. A test that survives its own subject being
		// replaced is not a weaker test, it is a different one.
		factor := NormalizeImplements(e.Implements)
		for _, w := range single {
			if strings.Contains(e.ID, w) && factor != 1 {
				t.Errorf("%s: the name says %q — one implement — but it counts x2, "+
					"so every set reports double the weight actually moved", e.ID, w)
			}
		}
		for _, w := range pair {
			// A single-IMPLEMENT word wins where both appear, so those rows are
			// skipped here rather than being contradicted by the block above.
			// Deliberately not `single-`: that also matches `single-leg`, which
			// says nothing about how many implements are held.
			if strings.Contains(e.ID, "single-arm") || strings.Contains(e.ID, "one-arm") ||
				!holdsAnImplement(e) {
				continue
			}
			if strings.Contains(e.ID, w) && factor != 2 {
				t.Errorf("%s: the name says %q — two implements — but it counts x1, "+
					"so every set reports half the weight actually moved", e.ID, w)
			}
		}
	}
}

// TestTheRuledRowsStayRuled pins the five rows W7 escalated, now that a human
// has decided each one.
//
// **These rows were deliberately left UNGUARDED until now, and that was
// correct.** The heuristic above cannot see any of them — `pistol-squat` and
// `bottoms-up` match no word in either list, and `single-` is deliberately
// excluded because `single-leg` says nothing about how many implements are
// held. W7's own line says pinning a disputed row is the `renegade` mistake:
// asserting a value nobody has confirmed locks a guess into a test, where it
// then reads as settled. `renegade` is still unpinned for exactly that reason.
//
// What changed is not the evidence but the authority. A ruling is the one thing
// that converts these from guesses into facts, and a fact is what a pin is for.
// Names cannot settle any of them — that is why W7 existed — so this table is
// the ONLY thing standing between these values and the next catalog sweep.
//
// Both fields are pinned per row, because they are independent and only their
// product is tonnage: `is_unilateral` answers "is one limb working" and
// `implements` answers "how many of the logged weight move". A row can be
// honest about one and wrong about the other, which is the trap named above.
func TestTheRuledRowsStayRuled(t *testing.T) {
	all, err := SeedData()
	if err != nil {
		t.Fatalf("seed data: %v", err)
	}

	ruled := map[string]struct {
		unilateral bool
		implements int
		why        string
	}{
		// CHANGED by the ruling, on BOTH fields, and the one on the unsafe
		// side: at x2 this INVENTED tonnage, reporting double the weight
		// actually moved.
		//
		// Both halves were ruled explicitly, which matters because W7 predicted
		// this row would move on both fields together if it moved at all — its
		// `is_unilateral: false` was the corroboration for reading it as a
		// double press. Taking the x1 ruling alone would have left a one-bell
		// press that still does not tell an athlete "8 reps means 8 each side":
		// coherence half-restored is its own wrong state, not a smaller one.
		//
		// The result is the shape the four `one-arm-kettlebell-*` presses
		// already share (unilateral, x1, per_side).
		"bottoms-up-kettlebell-press": {true, 1, "one bell, one arm"},

		// CHANGED on the other axis. Two dumbbells, one leg — `implements`
		// stays 2 and tonnage is untouched; what was wrong is the stance flag,
		// which is what gives the athlete the "8 reps means 8 each side" hint.
		// Its two single-implement siblings already say true about the same
		// stance. This is precisely the case migration 000057 separated the
		// fields to express, surviving in the data after the rule was fixed.
		"double-dumbbell-kickstand-deadlift": {true, 2, "two implements, one leg"},

		// CONFIRMED unchanged. Recorded because "nobody has checked this" and
		// "a human checked this and it was right" are different states, and
		// only the second one justifies a pin. Without the ruling these three
		// would still belong in the unguarded set.
		"dumbbell-pistol-squat":   {true, 1, "one counterbalance weight"},
		"kettlebell-pistol-squat": {true, 1, "one counterbalance weight"},

		// CONFIRMED at x1 while its dumbbell twin `single-leg-dumbbell-romanian-deadlift`
		// stays at x2 — and that disagreement is now DELIBERATE.
		//
		// It is the cross-implement inconsistency F3 was opened for, and the
		// cross-implement argument said 2: the parent `dumbbell-`/`kettlebell-romanian-deadlift`
		// pair agree. The counter-reading, which the ruling took, is that the
		// dumbbell side splits into two rows (bare + `one-arm-`) while the
		// kettlebell side has only one, so this row IS the one-bell version.
		//
		// Pinned with that written down because the pair looks like an
		// oversight to anyone who finds it later, and the next sweep would
		// otherwise "fix" it back and re-invent tonnage on every set.
		"single-leg-kettlebell-romanian-deadlift": {true, 1, "one bell, one leg"},
	}

	seen := map[string]bool{}
	for _, e := range all {
		want, ok := ruled[e.ID]
		if !ok {
			continue
		}
		seen[e.ID] = true
		if got := NormalizeImplements(e.Implements); got != want.implements {
			t.Errorf("%s: implements = %d, ruled %d (%s) — every set now reports "+
				"%s the weight actually moved", e.ID, got, want.implements, want.why,
				map[bool]string{true: "double", false: "half"}[got > want.implements])
		}
		if e.IsUnilateral != want.unilateral {
			t.Errorf("%s: is_unilateral = %v, ruled %v (%s) — the per-side rep hint "+
				"is wrong, though tonnage is not", e.ID, e.IsUnilateral, want.unilateral, want.why)
		}
	}

	// A pin on a row that no longer exists is a pin on nothing, and it passes.
	// The catalog is regenerated by `cmd/exportcontent`, so an id can be renamed
	// out from under this table without anything else noticing.
	for id := range ruled {
		if !seen[id] {
			t.Errorf("%s: ruled by a human in W7 but no longer in the catalog — "+
				"the ruling has been silently discarded, not applied", id)
		}
	}
}
