package exercise

import (
	"slices"
	"testing"
)

// The per-pattern grip table, moved here with `OfferedGrips` (N16).
//
// These assertions ARE the specification: nothing server-side refuses an odd
// pairing, so the subsets are a question-quality rule rather than a constraint.
// They came from `session/grip_postgres_test.go`, which keeps the tests about
// what the DATABASE does with a stored grip.

// gripApplies is the emptiness of `OfferedGrips`, kept as a test helper rather
// than an exported function: the production question is "which grips", and the
// boolean had no caller once the table began being served.
func gripApplies(movementPattern string) bool {
	return len(OfferedGrips(movementPattern)) > 0
}

func TestOfferedGripsReturnsAFreshSliceEachCall(t *testing.T) {
	for _, p := range []string{"hinge", "carry", "olympic", "horizontal_push", "isolation"} {
		a, b := OfferedGrips(p), OfferedGrips(p)
		if len(a) == 0 {
			t.Fatalf("OfferedGrips(%q) is empty; the fixture is wrong", p)
		}
		if &a[0] == &b[0] {
			t.Errorf("OfferedGrips(%q) returns the SAME backing array twice — one caller "+
				"sorting or writing in place corrupts it for every later one", p)
		}
		// And prove it concretely rather than by pointer identity alone.
		a[0] = "hook"
		if OfferedGrips(p)[0] == "hook" && b[0] != "hook" {
			t.Errorf("writing to OfferedGrips(%q)'s result changed what later callers see", p)
		}
	}
}

func TestGripIsAskedWhereTheVocabularyCanAnswerIt(t *testing.T) {
	for _, p := range []string{
		"horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull", "isolation",
		// N9: these three were in the WITHHELD list until `mixed` and `hook`
		// existed. The inversion is the feature — 93 of 762 exercises, and the
		// ones where grip matters most.
		"hinge", "carry", "olympic",
	} {
		if !gripApplies(p) {
			t.Errorf("gripApplies(%q) = false, want true", p)
		}
	}
	for _, p := range []string{
		// Meaningless — no vocabulary would make the question worth asking.
		"squat", "lunge", "jump", "locomotion", "mobility", "core", "rotation", "grappling",
		// And an exercise whose pattern the client could not load.
		"",
	} {
		if gripApplies(p) {
			t.Errorf("gripApplies(%q) = true, want false", p)
		}
	}
}

// The per-pattern subsets, which are a question-quality rule rather than a
// constraint — nothing server-side refuses an odd pairing, so these assertions
// ARE the specification.
func TestOfferedGripsOffersOnlyWhatTheMovementCanUse(t *testing.T) {
	four := []string{"regular", "neutral", "reverse", "angled"}
	for _, p := range []string{
		"horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull", "isolation",
	} {
		if got := OfferedGrips(p); !slices.Equal(got, four) {
			t.Errorf("OfferedGrips(%q) = %v, want the original four", p, got)
		}
	}

	// The three new patterns, pinned as FULL SETS rather than by membership.
	//
	// Membership spot-checks were what shipped in #266, and review measured
	// four mutations surviving them: hinge losing `hook`, carry/olympic losing
	// `hook`, hinge losing `regular`, hinge gaining `reverse` — all green.
	// `hook` had no positive assertion anywhere, which is half of N9's headline
	// unpinned, and this table now has exactly one
	// production caller (the serializer), so this test is still the pin on
	// WHICH grips it names. An equality is the whole specification;
	// a `Contains` is one clause of it.
	if got := OfferedGrips("hinge"); !slices.Equal(got, []string{"regular", "neutral", "mixed", "hook"}) {
		t.Errorf("OfferedGrips(hinge) = %v, want regular/neutral/mixed/hook", got)
	}
	for _, p := range []string{"carry", "olympic"} {
		if got := OfferedGrips(p); !slices.Equal(got, []string{"regular", "neutral", "hook"}) {
			t.Errorf("OfferedGrips(%q) = %v, want regular/neutral/hook", p, got)
		}
	}

	// `mixed` on hinges ALONE, kept as its own assertion because it is the one
	// property the equalities above would still satisfy if every subset were
	// rewritten together by someone who thought mixed belonged on a carry.
	for _, p := range []string{
		"carry", "olympic", "horizontal_push", "horizontal_pull",
		"vertical_push", "vertical_pull", "isolation",
	} {
		if slices.Contains(OfferedGrips(p), "mixed") {
			t.Errorf("OfferedGrips(%q) offers mixed", p)
		}
	}

	// `neutral` on hinges and olympic lifts reads wrong and is not. Counted from
	// the seed catalog: 20 of `hinge`'s 55 rows are kettlebell, dumbbell or
	// hex-bar, and 12 of `olympic`'s 25 are kettlebell (11) or dumbbell (1).
	// Neither is a majority — olympic is 13 barbell — which is the point: both
	// buckets are split, so dropping either value strands a real half.
	for _, p := range []string{"hinge", "olympic"} {
		if !slices.Contains(OfferedGrips(p), "neutral") {
			t.Errorf("OfferedGrips(%q) dropped neutral; check the catalog before "+
				"deciding that is right", p)
		}
	}

	// The four originals stay OFF the new patterns where they are meaningless.
	for _, p := range []string{"hinge", "carry", "olympic"} {
		if slices.Contains(OfferedGrips(p), "angled") {
			t.Errorf("OfferedGrips(%q) offers angled", p)
		}
	}
	if slices.Contains(OfferedGrips("olympic"), "reverse") {
		t.Error("OfferedGrips(olympic) offers reverse")
	}

	// Emptiness IS GripApplies — asserted rather than assumed. The two agree by
	// construction today, but `GripApplies` is one edit away from being an
	// independent switch that happens to match, and nothing else would notice.
	for _, p := range []string{
		"horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull",
		"isolation", "hinge", "carry", "olympic", "squat", "core", "", "not_a_pattern",
	} {
		if gripApplies(p) != (len(OfferedGrips(p)) > 0) {
			t.Errorf("gripApplies(%q) = %v but GripsFor gives %d values — these have "+
				"come apart", p, gripApplies(p), len(OfferedGrips(p)))
		}
	}
	// Emptiness IS GripApplies, so the two can never disagree.
	for _, p := range []string{"squat", "core", ""} {
		if len(OfferedGrips(p)) != 0 {
			t.Errorf("OfferedGrips(%q) is non-empty but the question is meaningless", p)
		}
	}
}
