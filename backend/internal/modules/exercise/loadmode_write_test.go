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

// An explicit empty string is the one wrong value that used to get through, and
// it is the likeliest one to be sent by accident.
//
// The check first lived in `write()`, on the MERGED exercise — by which point
// `applyTo`'s tail had already rewritten "" to `total` so a create need not
// mention the field. So `{"load_mode": ""}` on a per_side row flipped it and
// answered 200: the halving bug, straight past a check written to stop exactly
// that. A client with an empty placeholder option or a `?? ”` produces it
// without trying.
//
// It is judged on the request field now, before any merge.
func TestAnExplicitlyEmptyLoadModeIsRejected(t *testing.T) {
	t.Run("create", func(t *testing.T) {
		body := `{"name":"X","sport":"strength","movement_pattern":"squat",` +
			`"load_type":"reps","load_mode":""}`
		if rec := post(t, NewContentHandler(newFakeRepo()), body); rec.Code != http.StatusBadRequest {
			t.Fatalf("status %d, want 400: %s", rec.Code, rec.Body)
		}
	})

	t.Run("patch of a per_side row", func(t *testing.T) {
		// The case that actually loses data: the stored row is per_side, and
		// nothing about this request says otherwise on purpose.
		repo := newFakeRepo()
		repo.stored["dumbbell-bench-press"] = Exercise{
			ID: "dumbbell-bench-press", Name: "Dumbbell Bench Press", Sport: "strength",
			MovementPattern: "horizontal_push", LoadType: LoadTypeWeightReps, LoadMode: LoadModePerSide,
		}
		repo.sources["dumbbell-bench-press"] = "seed"

		rec := patch(t, NewContentHandler(repo), "dumbbell-bench-press", `{"load_mode":""}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status %d, want 400: %s", rec.Code, rec.Body)
		}
		// Names load_mode, so a 400 raised by some other check cannot satisfy
		// this — the point is which guard fired, not that something did.
		if !strings.Contains(rec.Body.String(), "load_mode") {
			t.Errorf("the refusal does not mention load_mode: %s", rec.Body)
		}
		if got := repo.stored["dumbbell-bench-press"].LoadMode; got != LoadModePerSide {
			t.Fatalf("the row is now %q — a rejected write must not have written", got)
		}
	})
}

// A PATCH is the composition the "" bug lived in, and every other handler test
// here drives create. This one drives the update path end to end.
func TestPatchCanSetLoadModeOnAStoredRow(t *testing.T) {
	repo := newFakeRepo()
	repo.stored["dumbbell-bench-press"] = Exercise{
		ID: "dumbbell-bench-press", Name: "Dumbbell Bench Press", Sport: "strength",
		MovementPattern: "horizontal_push", LoadType: LoadTypeWeightReps, LoadMode: LoadModeTotal,
	}
	repo.sources["dumbbell-bench-press"] = "seed"

	if rec := patch(t, NewContentHandler(repo), "dumbbell-bench-press",
		`{"load_mode":"per_side"}`); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	if got := repo.lastWritten.LoadMode; got != LoadModePerSide {
		t.Fatalf("the handler stored %q, want %q — correcting a misclassified row "+
			"is half of what T2 was", got, LoadModePerSide)
	}
}
