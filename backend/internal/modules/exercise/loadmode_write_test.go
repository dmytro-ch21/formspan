package exercise

import (
	"net/http"
	"strings"
	"testing"
)

// The console can author `load_mode` now. Before this, `createWithin` never
// wrote the column, so every exercise created in the admin console took the
// column default `total` — including dumbbell ones, which then reported half
// their real tonnage forever, with no endpoint able to correct them. That was
// `T2`, and it is the per-side halving bug reissued for new content.
//
// These cover the merge semantics, which are where it can go wrong quietly.
// The repository-level proofs live in loadmode_postgres_test.go.

func ptr[T any](v T) *T { return &v }

func TestAnAuthoredExerciseCanBePerSide(t *testing.T) {
	got := exerciseRequest{LoadMode: ptr(LoadModePerSide)}.applyTo(Exercise{})
	if got.LoadMode != LoadModePerSide {
		t.Fatalf("load_mode %q, want %q — a console-authored dumbbell exercise "+
			"that cannot be marked per_side halves its own tonnage", got.LoadMode, LoadModePerSide)
	}
}

func TestCreatingWithoutSayingDefaultsToTotal(t *testing.T) {
	// The common case: most exercises are not per-side, so the field should be
	// optional. `total` is also the column's own default, so the API and the
	// database agree about what silence means.
	got := exerciseRequest{}.applyTo(Exercise{})
	if got.LoadMode != LoadModeTotal {
		t.Fatalf("load_mode %q, want %q for a create that never mentioned it",
			got.LoadMode, LoadModeTotal)
	}
}

// The trap this whole change had to avoid.
//
// `updateWithin` deliberately did not write `load_mode` — that omission is what
// guaranteed an edit could not clear a value a deploy had set, the same
// reasoning that keeps media out of the write. Adding the column to the SET
// clause removes that guarantee and replaces it with this one: the handler
// merges onto the STORED row (`GetExercise`, which selects `load_mode` from a
// NOT NULL column), so a PATCH that never mentions the field writes the same
// value back.
//
// If that merge ever stops happening — a handler that builds its Exercise from
// the request alone, say — every edit to a dumbbell exercise silently reverts
// it to `total`, and nothing else in this package would notice.
func TestAnEditThatIgnoresLoadModeLeavesItAlone(t *testing.T) {
	stored := Exercise{ID: "dumbbell-bench-press", Name: "Dumbbell Bench Press", LoadMode: LoadModePerSide}
	got := exerciseRequest{Name: ptr("Dumbbell Bench Press (Flat)")}.applyTo(stored)
	if got.LoadMode != LoadModePerSide {
		t.Fatalf("load_mode %q after an edit that never mentioned it, want %q — "+
			"renaming an exercise must not halve its tonnage", got.LoadMode, LoadModePerSide)
	}
}

func TestAnEditCanCorrectAWronglyClassifiedRow(t *testing.T) {
	// The other half of T2: before this, no endpoint could fix a row that was
	// already wrong. A misclassified dumbbell exercise was permanent.
	stored := Exercise{ID: "dumbbell-bench-press", LoadMode: LoadModeTotal}
	got := exerciseRequest{LoadMode: ptr(LoadModePerSide)}.applyTo(stored)
	if got.LoadMode != LoadModePerSide {
		t.Fatalf("load_mode %q, want %q — a wrong classification must be fixable",
			got.LoadMode, LoadModePerSide)
	}
}

// Strict on the API write path, tolerant in the seeder, and the asymmetry is
// deliberate — including WHERE the check lives.
//
// It is NOT in `ValidateForWrite`, which `cmd/exportcontent` shares: that step
// asks "would this seed?", and an unrecognised load_mode WOULD seed, as
// `total`, because `NormalizeLoadMode` fails it closed so one bad row cannot
// break a deploy. Putting it there failed an export over something that would
// have worked — two of that command's tests went red, which is how this was
// found.
//
// On an API write there is one author waiting for a response, and coercing
// `per_sied` to `total` for them is the dumbbell-halving bug arriving through a
// spelling mistake, invisible until somebody notices their tonnage is out by
// half. So it lives on the handler.
func TestAnUnknownLoadModeIsRejectedRatherThanCoerced(t *testing.T) {
	body := `{"name":"X","sport":"strength","movement_pattern":"squat",` +
		`"load_type":"reps","load_mode":"per_sied"}`
	rec := post(t, NewContentHandler(newFakeRepo()), body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400 — a misspelled load_mode was accepted, and it "+
			"coerces to 'total', halving the exercise: %s", rec.Code, rec.Body)
	}
	// Names the offending value and the legal set, like every other refusal here.
	for _, want := range []string{"per_sied", LoadModeTotal, LoadModePerSide} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("body %s does not mention %q", rec.Body, want)
		}
	}
}

// The legal values still pass, or the refusal above proves only that the check
// fires on everything.
func TestBothLegalLoadModesAreAccepted(t *testing.T) {
	for _, mode := range []string{LoadModeTotal, LoadModePerSide} {
		t.Run(mode, func(t *testing.T) {
			repo := newFakeRepo()
			body := `{"name":"X","sport":"strength","movement_pattern":"squat",` +
				`"load_type":"reps","load_mode":"` + mode + `"}`
			if rec := post(t, NewContentHandler(repo), body); rec.Code != http.StatusOK {
				t.Fatalf("status %d for load_mode %q: %s", rec.Code, mode, rec.Body)
			}
			if repo.lastWritten.LoadMode != mode {
				t.Fatalf("the handler stored load_mode %q, want %q", repo.lastWritten.LoadMode, mode)
			}
		})
	}
}

// And a create that never mentions it is still accepted, defaulting to total —
// otherwise the check above would have made the field mandatory, breaking every
// existing caller and every non-dumbbell exercise's authoring flow.
func TestACreateWithoutLoadModeIsStillAccepted(t *testing.T) {
	repo := newFakeRepo()
	if rec := post(t, NewContentHandler(repo), validCreate); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if repo.lastWritten.LoadMode != LoadModeTotal {
		t.Fatalf("stored load_mode %q, want %q", repo.lastWritten.LoadMode, LoadModeTotal)
	}
}
