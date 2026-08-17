package exercise

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// `implements` exists because the old tonnage rule asked one question and read
// the answer to another.
//
// It derived the factor as `load_mode = 'per_side' AND NOT is_unilateral`.
// `is_unilateral` means "one LIMB at a time" — it is what drives the "8 reps
// here means 8 each side" hint — and the rule read it as "one IMPLEMENT moves".
// For a dumbbell walking lunge those disagree: two dumbbells, one leg.
//
// So whoever classified the lunge family had to choose which error to ship, and
// the two halves of the catalog chose differently. That is what these pin.

func TestTheLungeFamilyNoLongerDisagreesWithItself(t *testing.T) {
	catalog, err := SeedData()
	if err != nil {
		t.Fatalf("read seed catalog: %v", err)
	}
	by := make(map[string]Exercise, len(catalog))
	for _, e := range catalog {
		by[e.ID] = e
	}
	if len(by) == 0 {
		t.Fatal("empty catalog — this test would pass vacuously")
	}

	// The five movements that existed in both implements and answered
	// oppositely: dumbbell said one, kettlebell said two.
	for _, pair := range [][2]string{
		{"dumbbell-walking-lunge", "kettlebell-walking-lunge"},
		{"dumbbell-lateral-lunge", "kettlebell-lateral-lunge"},
		{"dumbbell-reverse-lunge", "kettlebell-reverse-lunge"},
		{"dumbbell-split-squat", "kettlebell-split-squat"},
		{"dumbbell-step-up", "kettlebell-step-up"},
	} {
		a, okA := by[pair[0]]
		b, okB := by[pair[1]]
		if !okA || !okB {
			t.Errorf("%s / %s: one of the pair is no longer in the catalog", pair[0], pair[1])
			continue
		}
		if a.Implements != b.Implements {
			t.Errorf("%s has %d implements and %s has %d — the same movement cannot "+
				"double for one implement and not the other",
				pair[0], a.Implements, pair[1], b.Implements)
		}
	}
}

func TestAOneLegMovementKeepsItsRepsHint(t *testing.T) {
	// The half that was being paid for the doubling. `is_unilateral` was
	// switched OFF on the kettlebell lunges purely so the old rule would return
	// 2 — which cost the athlete "8 reps here means 8 each side" on exactly the
	// movements that need it. Now the factor comes from `implements` and the
	// flag can mean what it says.
	catalog, err := SeedData()
	if err != nil {
		t.Fatalf("read seed catalog: %v", err)
	}
	for _, e := range catalog {
		if e.LoadMode != LoadModePerSide {
			continue
		}
		if !isLungeFamily(e.ID) {
			continue
		}
		if !e.IsUnilateral {
			t.Errorf("%s is a one-leg movement with is_unilateral=false — the only "+
				"reason to switch it off was to buy a doubling that `implements` "+
				"now provides", e.ID)
		}
		if e.Implements != 2 {
			t.Errorf("%s has %d implements — a lunge, split squat or step-up held "+
				"per hand is held in both", e.ID, e.Implements)
		}
	}
}

func TestNoCatalogRowClaimsAnImpossibleImplementCount(t *testing.T) {
	// The database CHECK allows 1 or 2. A seed file carrying 0 or 3 would fail
	// the deploy, which is the loud failure — but `NormalizeImplements` would
	// silently rescue a 0 into a 1 on the way in, so the file itself is worth
	// checking.
	catalog, err := SeedData()
	if err != nil {
		t.Fatalf("read seed catalog: %v", err)
	}
	for _, e := range catalog {
		if e.Implements != 1 && e.Implements != 2 {
			t.Errorf("%s has implements=%d, want 1 or 2", e.ID, e.Implements)
		}
		// A `total` movement is one implement by definition — the number typed
		// IS the whole load, so doubling it would count a goblet squat twice.
		if e.LoadMode == LoadModeTotal && e.Implements != 1 {
			t.Errorf("%s is load_mode=total with implements=%d: the logged weight is "+
				"already the whole load", e.ID, e.Implements)
		}
	}
}

func TestNormalizeImplementsFailsToOne(t *testing.T) {
	// Fails to the side that under-reports. Reading an unknown value as 2 would
	// invent weight nobody lifted, which is the worse of the two errors.
	for _, in := range []int{0, -1, 3, 99} {
		if got := NormalizeImplements(in); got != 1 {
			t.Errorf("NormalizeImplements(%d) = %d, want 1", in, got)
		}
	}
	if got := NormalizeImplements(2); got != 2 {
		t.Errorf("NormalizeImplements(2) = %d, want 2", got)
	}
}

func isLungeFamily(id string) bool {
	for _, w := range []string{"lunge", "split-squat", "step-up"} {
		if contains(id, w) {
			return true
		}
	}
	return false
}

// The 400, at the handler. The repository-level tests cover create, preserve
// and correct; this covers the branch in `decodeExercise` that refuses a count
// the column could never hold — which had no coverage at all.
func TestAnImpossibleImplementCountIsRejected(t *testing.T) {
	for _, n := range []string{"0", "3", "-1"} {
		body := `{"name":"X","sport":"strength","movement_pattern":"squat",` +
			`"load_type":"reps","implements":` + n + `}`
		rec := post(t, NewContentHandler(newFakeRepo()), body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("implements=%s got status %d, want 400: %s", n, rec.Code, rec.Body)
			continue
		}
		if !strings.Contains(rec.Body.String(), "implements") {
			t.Errorf("the refusal for implements=%s does not name the field: %s", n, rec.Body)
		}
	}
}

func TestBothLegalImplementCountsAreAccepted(t *testing.T) {
	// Or the refusal above proves only that the check fires on everything.
	for _, n := range []int{1, 2} {
		repo := newFakeRepo()
		body := `{"name":"X","sport":"strength","movement_pattern":"squat",` +
			`"load_type":"reps","implements":` + strconv.Itoa(n) + `}`
		if rec := post(t, NewContentHandler(repo), body); rec.Code != http.StatusOK {
			t.Fatalf("implements=%d got status %d: %s", n, rec.Code, rec.Body)
		}
		if repo.lastWritten.Implements != n {
			t.Fatalf("the handler stored implements=%d, want %d", repo.lastWritten.Implements, n)
		}
	}
}

// And a create that never mentions it is still accepted, defaulting to 1 —
// otherwise the check above would have made the field mandatory on every
// existing caller and every single-implement exercise.
func TestACreateWithoutImplementsDefaultsToOne(t *testing.T) {
	repo := newFakeRepo()
	if rec := post(t, NewContentHandler(repo), validCreate); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if repo.lastWritten.Implements != 1 {
		t.Fatalf("stored implements=%d, want 1", repo.lastWritten.Implements)
	}
}

// The catalog's naming convention, turned into a check.
//
// A bare movement name means TWO implements; a `one-arm-`/`single-arm-` prefix
// states one explicitly. That is not an opinion — it is what five of the six
// such pairs in the catalog already do (`kettlebell-row` x2 beside
// `one-arm-kettlebell-row` x1, and four more).
//
// So the sixth was a contradiction rather than a judgment call:
// `single-leg-dumbbell-romanian-deadlift` claimed ONE implement, identical to
// its own `one-arm-single-leg-...` twin — whose name is pointless unless the
// bare one is two-armed. Two dumbbells, one leg: the exact shape migration
// 000057 made expressible, hiding outside the lunge family that was swept.
//
// This is a STRUCTURAL rule rather than a word list, which is why it found a
// row the word list could not: it compares the catalog against itself instead
// of against somebody's vocabulary.
func TestABareMovementHoldsMoreThanItsOneArmedTwin(t *testing.T) {
	all, err := SeedData()
	if err != nil {
		t.Fatalf("seed data: %v", err)
	}
	by := make(map[string]Exercise, len(all))
	for _, e := range all {
		by[e.ID] = e
	}

	var pairs int
	for _, e := range all {
		if e.LoadMode != LoadModePerSide {
			continue
		}
		for _, prefix := range []string{"one-arm-", "single-arm-"} {
			twin, ok := by[prefix+e.ID]
			if !ok {
				continue
			}
			pairs++
			// RAW, not normalised. `NormalizeImplements` turns a 0 into a 1,
			// and `SeedData` does not validate the column — so normalising here
			// would make a twin written as `implements: 0` pass this test
			// silently, leaving one invariant test as the only thing standing
			// between the file and a meaningless value.
			if twin.Implements != 1 {
				t.Errorf("%s names one arm but holds %d implements",
					twin.ID, twin.Implements)
			}
			if e.Implements != 2 {
				t.Errorf("%s holds %d implements, the same as its explicit twin %s — "+
					"the twin's name says nothing unless the bare movement is two-armed, "+
					"so one of the pair is wrong",
					e.ID, e.Implements, twin.ID)
			}
		}
	}
	if pairs == 0 {
		t.Fatal("no bare/one-armed pairs found — the convention this checks has " +
			"disappeared from the catalog, so this test now proves nothing")
	}
}

// TestNamedCatalogRowsCarryTheirImplementCount pins specific ids to specific
// counts, and exists because every OTHER guard in these two files derives its
// expectation from the row's own name or load_mode.
//
// That shared weakness is not theoretical. Review measured three mutations that
// the name-derived guards all missed:
//
//   - Flipping `single-leg-dumbbell-romanian-deadlift` to `load_mode: "total"`
//     AND `implements: 1` together. The per_side filter then drops the pair from
//     the twin test, `total`+1 satisfies the invariant test, and no word list
//     matches — so the coordinated flip silently undoes this file's entire
//     reason for existing.
//   - Deleting `one-arm-single-leg-dumbbell-romanian-deadlift` outright. One
//     vanished pair is invisible to a `pairs == 0` floor.
//   - Reverting the name guard's factor back to the derivation migration 000057
//     retired. No catalog row distinguishes the two sources today, so that line
//     — the fix this file was written around — was itself revertible with
//     nothing going red.
//
// A name can be edited to match a wrong number. An id cannot: changing one here
// means changing this test, deliberately, which is the whole point.
func TestNamedCatalogRowsCarryTheirImplementCount(t *testing.T) {
	// Each id is here because a specific mutation reached it, not for coverage.
	want := map[string]int{
		// The row this sweep corrected, and its twin. The pair IS the
		// convention: the twin's "one-arm-" says nothing unless the bare
		// movement is two-armed.
		"single-leg-dumbbell-romanian-deadlift":         2,
		"one-arm-single-leg-dumbbell-romanian-deadlift": 1,
		// The mutation that left the whole suite green before this sweep:
		// doubling a row whose name says one arm.
		"one-arm-dumbbell-row": 1,
		// The mirror: halving a row whose name says two.
		"double-kettlebell-front-squat": 2,
	}

	all, err := SeedData()
	if err != nil {
		t.Fatalf("seed data: %v", err)
	}
	byID := make(map[string]Exercise, len(all))
	for _, e := range all {
		byID[e.ID] = e
	}

	for id, implements := range want {
		e, ok := byID[id]
		if !ok {
			// Deleting a row is a mutation too — and the one a floor check
			// cannot see.
			t.Errorf("%s is missing from the catalog; it is named here because a "+
				"guard depends on it existing", id)
			continue
		}
		// RAW, for the reason the twin test reads raw: SeedData does not
		// validate the column, so normalising would let a 0 pass as a 1.
		if e.Implements != implements {
			t.Errorf("%s holds %d implements, want %d", id, e.Implements, implements)
		}
		// The coordinated flip: the count above is only meaningful while the
		// row is still per_side, since `total` exempts it from every other
		// guard in this file.
		if NormalizeLoadMode(e.LoadMode) != LoadModePerSide {
			t.Errorf("%s is %q, want per_side — flipping the load_mode exempts "+
				"this row from every name-derived guard, so the count above "+
				"stops being checked by anything else",
				id, NormalizeLoadMode(e.LoadMode))
		}
	}
}
