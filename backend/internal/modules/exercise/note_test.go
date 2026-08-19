package exercise

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

// The optional per-exercise note (N39): why a catalog value is what it is,
// shown to an athlete where the value is read.
//
// Four properties are load-bearing, and each test here fails if the code it
// covers is removed:
//
//  1. A PATCH that never mentions the note leaves it alone. This is the
//     `exercise_media` guarantee, and the reason it needs its own test is that
//     `media` gets it for free by having NO field, while `note` gets it only
//     from being a POINTER — a change to a plain string would compile, pass
//     every other test, and silently wipe an authored note on any save that
//     did not include one.
//  2. A note sent as empty still clears, or an explanation that stops being
//     true could never be removed.
//  3. The seeder writes the note, which is the whole ownership decision — see
//     migration 000061. A note omitted from `upsertSQL` would never reach a
//     fresh database.
//  4. The five rows W7 ruled actually carry the notes those rulings need,
//     which is what makes this a feature rather than an empty column.

func TestPatchDoesNotClearTheNoteByOmission(t *testing.T) {
	repo := newFakeRepo()
	h := NewContentHandler(repo)
	if rec := post(t, h, `{
		"name": "Single-Leg Kettlebell Romanian Deadlift",
		"sport": "strength",
		"movement_pattern": "hinge",
		"load_type": "weight_reps",
		"load_mode": "per_side",
		"implements": 1,
		"is_unilateral": true,
		"note": "One bell here, against two for the dumbbell version."
	}`); rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}

	// A save that edits something else entirely — the shape of every console
	// write that is not about the note.
	if rec := patch(t, h, "single-leg-kettlebell-romanian-deadlift",
		`{"movement_pattern":"squat"}`); rec.Code != http.StatusOK {
		t.Fatalf("patch: %d %s", rec.Code, rec.Body)
	}

	if got := repo.lastWritten.Note; got != "One bell here, against two for the dumbbell version." {
		t.Errorf("note was wiped by a patch that never mentioned it: %q", got)
	}
}

func TestANoteSentAsEmptyIsCleared(t *testing.T) {
	repo := newFakeRepo()
	h := NewContentHandler(repo)
	post(t, h, `{"name":"Face Pull","sport":"strength","movement_pattern":"horizontal_pull",
		"load_type":"weight_reps","note":"Counts once."}`)

	if rec := patch(t, h, "face-pull", `{"note":""}`); rec.Code != http.StatusOK {
		t.Fatalf("patch: %d %s", rec.Code, rec.Body)
	}
	if got := repo.lastWritten.Note; got != "" {
		t.Errorf("note %q, want cleared — an explanation that has stopped being true must be removable", got)
	}
}

func TestAnUnboundedNoteIsRefused(t *testing.T) {
	rec := post(t, NewContentHandler(newFakeRepo()), `{
		"name": "Zercher Squat", "sport": "strength", "movement_pattern": "squat",
		"load_type": "weight_reps",
		"note": "`+strings.Repeat("x", maxNoteLen+1)+`"
	}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400: %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "note") {
		t.Errorf("body %s does not say which field was too long", rec.Body)
	}

	// And the boundary itself is inclusive, so a note exactly at the limit is
	// accepted — a test that only proves "too long fails" passes just as well
	// against an off-by-one that rejects the documented maximum.
	if rec := post(t, NewContentHandler(newFakeRepo()), `{
		"name": "Zercher Squat", "sport": "strength", "movement_pattern": "squat",
		"load_type": "weight_reps",
		"note": "`+strings.Repeat("x", maxNoteLen)+`"
	}`); rec.Code != http.StatusOK {
		t.Fatalf("a note of exactly %d was refused: %d %s", maxNoteLen, rec.Code, rec.Body)
	}
}

// The note has to reach a fresh database, which is the entire ownership
// decision behind migration 000061. `upsertSQL` is a pair of explicit column
// lists, so a note dropped from either is a note a deploy never writes — and
// nothing else in the suite would notice.
func TestTheSeederWritesTheNote(t *testing.T) {
	args := upsertArgs(Exercise{ID: "x", Name: "X", Note: "Counts once."})
	var found bool
	for _, a := range args {
		if s, ok := a.(string); ok && s == "Counts once." {
			found = true
		}
	}
	if !found {
		t.Fatal("upsertArgs does not carry Note — a deploy would write '' over every seeded note")
	}
	// The placeholder count has to match, or the query fails at runtime rather
	// than here. `$15` is the note.
	if want := strings.Count(upsertSQL, "$15"); want != 1 {
		t.Errorf("upsertSQL has %d $15 placeholders, want 1 — args and SQL have drifted", want)
	}
	for _, clause := range []string{
		"note",                              // the INSERT column list
		"note              = EXCLUDED.note", // the DO UPDATE SET
		"exercises.note",                    // the change-detection guard
		"EXCLUDED.note",
	} {
		if !strings.Contains(upsertSQL, clause) {
			t.Errorf("upsertSQL is missing %q — a seeded note would not round-trip", clause)
		}
	}
}

// The payoff. W7 ruled five rows a human had to settle, and N39 exists so those
// rulings are explained where an athlete reads them. An empty column ships just
// as green as a populated one, so this is the assertion that the feature is
// actually doing its job.
func TestTheRuledRowsCarryTheirExplanations(t *testing.T) {
	catalog, err := SeedData()
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	byID := map[string]Exercise{}
	for _, e := range catalog {
		byID[e.ID] = e
	}

	// Exactly the rows W7 ruled — see PR #311.
	for _, id := range []string{
		"bottoms-up-kettlebell-press",
		"double-dumbbell-kickstand-deadlift",
		"dumbbell-pistol-squat",
		"kettlebell-pistol-squat",
		"single-leg-kettlebell-romanian-deadlift",
	} {
		e, ok := byID[id]
		if !ok {
			t.Errorf("%s is not in the catalog", id)
			continue
		}
		if e.Note == "" {
			t.Errorf("%s was ruled by a human and carries no explanation — the ruling still reads as an oversight", id)
		}
	}

	// No seeded note may exceed the console's own limit.
	//
	// `UpsertAll` does not validate, so an over-long note committed to
	// exercises.json seeds perfectly well — and then makes the row UNSAVABLE in
	// the console: any unrelated PATCH re-validates the merged exercise and is
	// refused on a field the editor never touched, with no way to fix it except
	// shortening the note in the same request. The seeder failing loudly is not
	// an option (one bad row must not fail a deploy), so this is the check.
	for _, e := range catalog {
		if n := utf8.RuneCountInString(e.Note); n > maxNoteLen {
			t.Errorf("%s has a %d-character note (max %d) — it would seed fine and "+
				"then refuse every console edit to that row", e.ID, n, maxNoteLen)
		}
	}

	// The sharpest case, stated as the pair it is: the same movement, one bell
	// against two dumbbells, deliberately counted differently. If a future
	// change makes these agree, the note is now WRONG rather than merely
	// missing, and that is worse than having none.
	kb, db := byID["single-leg-kettlebell-romanian-deadlift"], byID["dumbbell-romanian-deadlift"]
	if kb.Implements == db.Implements {
		t.Fatalf("the kettlebell and dumbbell RDLs now both count %d implements — "+
			"%q explains a difference that no longer exists", kb.Implements, kb.Note)
	}
}

// Absent is the normal case, and the wire has to say so by saying nothing —
// `omitempty`. A client's whole handling is a falsy check, so a `"note": ""`
// on 757 rows is bytes for nothing and a second state to reason about.
func TestAnEmptyNoteIsNotSerialised(t *testing.T) {
	b, err := json.Marshal(Exercise{ID: "back-squat", Name: "Back Squat"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "note") {
		t.Errorf("an empty note reached the wire: %s", b)
	}

	b, err = json.Marshal(Exercise{ID: "x", Name: "X", Note: "Counts once."})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"note":"Counts once."`) {
		t.Errorf("a real note did not reach the wire: %s", b)
	}
}
