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
