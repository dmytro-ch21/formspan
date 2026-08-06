package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/modules/exercise"
	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
)

const seedFile = "../../internal/modules/technique/techniques.json"

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
}

// TestRewritingTheRealFilesChangesNothing is the load-bearing one.
//
// The whole promotion path rests on a reviewable diff: export, READ THE DIFF,
// merge, deploy, adopt. If re-serialising the catalog is not a no-op, the first
// export rewrites all 542 entries and the one review step standing between a
// typo and a permanent foreign key in athletes' training records is a
// whole-file rewrite nobody reads.
//
// Run against the real shipped file, not a fixture, because the property is
// "matches what Python wrote" and a fixture would only prove the code agrees
// with itself.
func TestRewritingTheRealFilesChangesNothing(t *testing.T) {
	for _, path := range []string{seedFile} {
		t.Run(filepath.Base(path), func(t *testing.T) {
			original, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			entries, err := readEntries(path)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if len(entries) == 0 {
				t.Fatal("parsed an empty catalog — the test would prove nothing")
			}

			out := filepath.Join(t.TempDir(), "out.json")
			if err := writeJSON(out, entries); err != nil {
				t.Fatalf("write: %v", err)
			}
			got, err := os.ReadFile(out)
			if err != nil {
				t.Fatalf("read back: %v", err)
			}
			if string(got) != string(original) {
				t.Errorf("re-serialising %s is not a no-op — every export would rewrite the whole file.\n%s",
					filepath.Base(path), firstDifference(string(original), string(got)))
			}
		})
	}
}

// firstDifference reports where two versions diverge, because "files differ" on
// a 566 KB file is not a usable failure message.
func firstDifference(want, got string) string {
	wl, gl := strings.Split(want, "\n"), strings.Split(got, "\n")
	for i := 0; i < len(wl) && i < len(gl); i++ {
		if wl[i] != gl[i] {
			return "line " + itoa(i+1) + ":\n  want: " + wl[i] + "\n  got:  " + gl[i]
		}
	}
	return "line counts differ: want " + itoa(len(wl)) + ", got " + itoa(len(gl))
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// TestAnExportedEntryCanActuallyBeSeeded is the other half of that: the file
// being pretty is worthless if the content in it cannot be loaded.
//
// A technique with no aliases produces `"aliases": []`, NOT an absent key. An
// absent key unmarshals to a nil slice, pgx encodes a nil slice as NULL, and
// aliases/setup_from/common_counters/common_next_moves are TEXT[] NOT NULL. The
// insert happens inside UpsertAll's transaction, so one such entry takes the
// ENTIRE seed down — all 542 techniques, not just its own row.
//
// This is asserted on the JSON rather than against a database so it runs
// everywhere; the not-null violation itself was reproduced against real
// Postgres when the behaviour was found.
func TestAnExportedEntryCanActuallyBeSeeded(t *testing.T) {
	bare := technique.Technique{
		ID: "x", Name: "X", Category: "Pass", Position: "Other",
		// every slice nil, every optional string empty — the shape the console
		// produces for a technique someone typed a name into and saved.
	}
	raw, err := json.Marshal([]entry{techniqueEntryOf(bare)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	// Round-trip through the type the seeder actually reads.
	var back []technique.Technique
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal as Technique: %v", err)
	}
	if len(back) != 1 {
		t.Fatalf("got %d techniques", len(back))
	}
	for _, c := range []struct {
		name string
		got  []string
	}{
		{"aliases", back[0].Aliases},
		{"setup_from", back[0].SetupFrom},
		{"common_counters", back[0].CommonCounters},
		{"common_next_moves", back[0].CommonNextMoves},
	} {
		if c.got == nil {
			t.Errorf("%s came back nil — pgx sends NULL and the NOT NULL column "+
				"fails the whole seed transaction", c.name)
		}
	}
}

// The optional pair, from the same data: to_position is absent on 372 of 542
// entries and absent means "not recorded", which migration 000029 is explicit
// is a different fact from any value. Writing "" would be a lie.
func TestTheTwoOptionalKeysAreOmittedWhenEmpty(t *testing.T) {
	e := techniqueEntryOf(technique.Technique{ID: "x", Name: "X"})
	keys := map[string]bool{}
	for _, p := range e {
		keys[p.Key] = true
	}
	for _, absent := range []string{"function", "to_position"} {
		if keys[absent] {
			t.Errorf("%q was written despite being empty", absent)
		}
	}
	// ...and present when they carry a value.
	e = techniqueEntryOf(technique.Technique{ID: "x", Name: "X", Function: "advance", ToPosition: "Mount - Top"})
	keys = map[string]bool{}
	for _, p := range e {
		keys[p.Key] = true
	}
	for _, present := range []string{"function", "to_position"} {
		if !keys[present] {
			t.Errorf("%q was dropped despite carrying a value", present)
		}
	}
}

func TestEntryKeysAreWrittenInTheFilesOwnOrder(t *testing.T) {
	got := techniqueEntryOf(technique.Technique{ID: "x", Name: "X", Function: "advance", ToPosition: "Mount - Top"})
	var gotKeys []string
	for _, p := range got {
		gotKeys = append(gotKeys, p.Key)
	}
	if strings.Join(gotKeys, ",") != strings.Join(techniqueKeyOrder, ",") {
		t.Errorf("key order:\n  got:  %v\n  want: %v", gotKeys, techniqueKeyOrder)
	}
}

// The order has to match the DATA, not just this file's own constant —
// otherwise both drift together and the diff stays broken while the test stays
// green. Checked as a SUBSEQUENCE per entry, because `function` and
// `to_position` are optional and an index-for-index comparison against an entry
// that omits them is what pinned the wrong order in place: the first version
// appended both to the end, and this test enforced it.
func TestKeyOrderMatchesEveryEntryInTheShippedCatalog(t *testing.T) {
	rank := make(map[string]int, len(techniqueKeyOrder))
	for i, k := range techniqueKeyOrder {
		rank[k] = i
	}
	for _, path := range []string{seedFile} {
		entries, err := readEntries(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		checked := 0
		for _, e := range entries {
			last, lastKey := -1, ""
			for _, p := range e {
				r, known := rank[p.Key]
				if !known {
					t.Errorf("%s: %s has key %q that techniqueKeyOrder does not list",
						filepath.Base(path), e.id(), p.Key)
					continue
				}
				if r < last {
					t.Errorf("%s: %s writes %q after %q, but techniqueKeyOrder has them the other way",
						filepath.Base(path), e.id(), p.Key, lastKey)
				}
				last, lastKey = r, p.Key
			}
			checked++
		}
		if checked == 0 {
			t.Errorf("%s: nothing checked", path)
		}
	}
}

// ...and specifically the two interior slots, named, because they are the ones
// that were wrong and a subsequence check over entries that omit them passes
// either way.
func TestTheTwoOptionalKeysSitWhereTheCatalogPutsThem(t *testing.T) {
	entries, err := readEntries(seedFile)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	seen := map[string]int{}
	for _, e := range entries {
		var keys []string
		for _, p := range e {
			keys = append(keys, p.Key)
		}
		for _, f := range []string{"function", "to_position"} {
			i := indexOf(keys, f)
			if i <= 0 || i+1 >= len(keys) {
				continue
			}
			seen[f+"|"+keys[i-1]+"|"+keys[i+1]]++
		}
	}
	// The placement the overwhelming majority of the catalog uses.
	for _, want := range []string{
		"function|category|position",
		"to_position|position_detail|gi_no_gi",
	} {
		if seen[want] < 100 {
			t.Fatalf("expected %q to be the dominant placement, saw it %d times "+
				"— the catalog changed and techniqueKeyOrder needs to follow", want, seen[want])
		}
	}
	// And techniqueKeyOrder agrees with it.
	if indexOf(techniqueKeyOrder, "function") != indexOf(techniqueKeyOrder, "category")+1 {
		t.Errorf("techniqueKeyOrder puts %q after category, want immediately after", techniqueKeyOrder[indexOf(techniqueKeyOrder, "category")+1])
	}
	if indexOf(techniqueKeyOrder, "to_position") != indexOf(techniqueKeyOrder, "position_detail")+1 {
		t.Errorf("techniqueKeyOrder does not put to_position immediately after position_detail: %v", techniqueKeyOrder)
	}
}

func indexOf(xs []string, want string) int {
	for i, x := range xs {
		if x == want {
			return i
		}
	}
	return -1
}

// Go's encoder turns `&` into `\u0026` by default. Neither catalog file
// contains one TODAY, so nothing exercised SetEscapeHTML(false) until this —
// but "Over-Under & Double Under Pass" is an entirely ordinary thing to type
// into the console, and the escaped form would rewrite the entry unreadably
// and diverge from what the Python importer writes for the same content.
func TestAmpersandsSurviveUnescaped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "techniques.json")
	merged, _, _, _, err := mergeInto(path, mapEntries([]technique.Technique{
		{ID: "x", Name: "Over-Under & Double Under", Description: "a < b > c"},
	}, techniqueEntryOf))
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if err := writeJSON(path, merged); err != nil {
		t.Fatalf("write: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	for _, escaped := range []string{`\u0026`, `\u003c`, `\u003e`} {
		if strings.Contains(string(raw), escaped) {
			t.Errorf("found %s in the output — Go's HTML escaping is on", escaped)
		}
	}
	if !strings.Contains(string(raw), "Over-Under & Double Under") {
		t.Errorf("the ampersand did not survive:\n%s", raw)
	}
}

func TestMergeKeepsHandAuthoredEntries(t *testing.T) {
	// The seed file holds 542 entries this command never wrote. Replacing it
	// wholesale would silently delete content that has no other copy — the exact
	// failure this command exists to prevent, committed by the command itself.
	path := filepath.Join(t.TempDir(), "techniques.json")
	write(t, path, `[{"id":"hand-written","name":"By Hand","category":"Escape"}]`)

	merged, added, updated, _, err := mergeInto(path, mapEntries([]technique.Technique{
		{ID: "from-console", Name: "From Console", Category: "Pass"},
	}, techniqueEntryOf))
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if added != 1 || updated != 0 {
		t.Errorf("added=%d updated=%d, want 1/0", added, updated)
	}
	ids := map[string]entry{}
	for _, e := range merged {
		ids[e.id()] = e
	}
	if _, ok := ids["hand-written"]; !ok {
		t.Error("the hand-authored entry was dropped")
	}
	if _, ok := ids["from-console"]; !ok {
		t.Error("the exported entry is missing")
	}
	// ...and the hand-authored entry is untouched, not reformatted.
	got, err := json.Marshal(ids["hand-written"])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(got) != `{"id":"hand-written","name":"By Hand","category":"Escape"}` {
		t.Errorf("hand-authored entry was rewritten: %s", got)
	}
}

func TestReExportIsByteIdentical(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "techniques.json")
	write(t, path, "[\n  {\n    \"id\": \"a-first\",\n    \"name\": \"A\"\n  },\n  {\n    \"id\": \"b-second\",\n    \"name\": \"B\"\n  }\n]\n")

	authored := []technique.Technique{{ID: "c-third", Name: "C", Category: "Pass"}}

	// One export, then a second with nothing changed. NOT warmed up first: the
	// earlier version of this test ran three rounds before capturing, which
	// would have hidden a first-write difference — the only one that matters,
	// since that is the diff a human reviews.
	first := exportOnce(t, path, authored)
	second := exportOnce(t, path, authored)
	if first != second {
		t.Errorf("a re-export with no changes produced a different file:\n%s",
			firstDifference(first, second))
	}

	var out []entry
	if err := json.Unmarshal([]byte(second), &out); err != nil {
		t.Fatalf("parse result: %v", err)
	}
	if len(out) != 3 || out[0].id() != "a-first" || out[2].id() != "c-third" {
		t.Errorf("an already-sorted file did not stay sorted by id: %v", ids(out))
	}
}

// A file that is NOT in id order keeps its order, because techniques.json is
// generated in spreadsheet order and sorting it would rewrite all 542 entries —
// the whole-file diff this design exists to avoid.
func TestAnUnsortedFileKeepsItsOrder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "techniques.json")
	write(t, path, `[{"id":"zebra","name":"Z"},{"id":"alpha","name":"A"}]`)

	merged, _, _, _, err := mergeInto(path, mapEntries([]technique.Technique{{ID: "middle", Name: "M"}}, techniqueEntryOf))
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	got := ids(merged)
	want := []string{"zebra", "alpha", "middle"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("order changed: got %v, want %v (appended, not sorted)", got, want)
	}
}

func TestExportUpdatesAnEntryItPreviouslyWrote(t *testing.T) {
	path := filepath.Join(t.TempDir(), "techniques.json")
	write(t, path, `[{"id":"x","name":"Old Name","category":"Pass"}]`)

	merged, added, updated, _, err := mergeInto(path, mapEntries([]technique.Technique{
		{ID: "x", Name: "New Name", Category: "Pass"},
	}, techniqueEntryOf))
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if added != 0 || updated != 1 {
		t.Errorf("added=%d updated=%d, want 0/1", added, updated)
	}
	raw, _ := json.Marshal(merged[0])
	if !strings.Contains(string(raw), `"New Name"`) {
		t.Errorf("entry not updated: %s", raw)
	}
}

func TestAMissingSeedFileIsCreatedRatherThanFatal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "techniques.json")
	merged, added, _, _, err := mergeInto(path, mapEntries([]technique.Technique{{ID: "x", Name: "X"}}, techniqueEntryOf))
	if err != nil {
		t.Fatalf("merge into a missing file: %v", err)
	}
	if added != 1 || len(merged) != 1 {
		t.Errorf("added=%d len=%d", added, len(merged))
	}
	if err := writeJSON(path, merged); err != nil {
		t.Fatalf("write into a missing directory: %v", err)
	}
}

func TestAnUnparseableFileIsRefusedNotOverwritten(t *testing.T) {
	// Overwriting it would destroy hand-authored content on the strength of a
	// stray character.
	path := filepath.Join(t.TempDir(), "techniques.json")
	write(t, path, `[{"id":"broken",`)
	if _, _, _, _, err := mergeInto(path, mapEntries([]technique.Technique{{ID: "x", Name: "X"}}, techniqueEntryOf)); err == nil {
		t.Error("a malformed file was silently replaced")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != `[{"id":"broken",` {
		t.Error("the malformed file was modified")
	}
}

func exportOnce(t *testing.T, path string, authored []technique.Technique) string {
	t.Helper()
	merged, _, _, _, err := mergeInto(path, mapEntries(authored, techniqueEntryOf))
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if err := writeJSON(path, merged); err != nil {
		t.Fatalf("write: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	return string(raw)
}

func ids(entries []entry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.id())
	}
	return out
}

// techniqueCatalog builds what main() builds, so a test exercises the same
// wiring rather than a simplified stand-in.
func techniqueCatalog(seed string, authored []technique.Technique) catalog {
	return catalog{
		what: "techniques", seedPath: seed,
		entries: mapEntries(authored, techniqueEntryOf),
		ids:     idsOfTechniques(authored),
		adopt:   func(context.Context, []string) error { return nil },
		validate: func() error {
			for _, t := range authored {
				if err := technique.ValidateFields(t); err != nil {
					return fmt.Errorf("%q would not seed: %w", t.ID, err)
				}
			}
			return nil
		},
	}
}

// The export must ADD to the seed file rather than replace it: the file holds
// 542 entries this command never wrote, and losing them is the content loss it
// exists to prevent.
func TestTheSeedFileGainsTheEntryAndKeepsTheRest(t *testing.T) {
	dir := t.TempDir()
	seed := filepath.Join(dir, "techniques.json")
	write(t, seed, `[{"id":"already-there","name":"Existing","category":"Pass","position":"Other"}]`)

	authored := []technique.Technique{
		{ID: "new-one", Name: "New One", Category: "Pass", Position: "Other", GiNoGi: "Both"},
	}
	if _, err := run(techniqueCatalog(seed, authored), slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatalf("run: %v", err)
	}
	have, err := idsIn(seed)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !have["new-one"] {
		t.Error("the seed file does not carry the exported id — the deploy would not have it")
	}
	if !have["already-there"] {
		t.Error("the export replaced the catalog instead of merging into it")
	}
}

// The file it writes is what go:embed bakes into the binary, so an entry that
// cannot seed must fail here rather than on the next deploy.
func TestRunRefusesAnEntryThatWouldNotSeed(t *testing.T) {
	dir := t.TempDir()
	seed := filepath.Join(dir, "techniques.json")
	write(t, seed, `[]`)

	// Valid but for the function, which has no CHECK constraint in the schema —
	// so this validation is the only thing between a typo and a value no client
	// can render.
	_, err := run(techniqueCatalog(seed, []technique.Technique{
		{ID: "broken", Name: "Broken", Category: "Pass", Position: "Other",
			GiNoGi: "Both", Function: "not-a-real-function"},
	}), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil {
		t.Fatal("an entry that fails ValidateFields was written anyway")
	}
	if !strings.Contains(err.Error(), "broken") {
		t.Errorf("the error does not name the offending id: %v", err)
	}
	// Nothing was written — a refusal must not leave a half-export behind.
	raw, _ := os.ReadFile(seed)
	if string(raw) != `[]` {
		t.Errorf("the seed file was modified despite the refusal: %s", raw)
	}
}

// Keeping the last of two entries sharing an id would DELETE the other on the
// next write — the content loss this command exists to prevent, committed by
// the command. The shipped techniques.json cannot reach this state — validate()
// rejects a duplicate id long before a write — but mergeInto reads whatever is
// actually on disk, which is the only thing it can trust.
func TestADuplicateIDIsRefusedRatherThanSilentlyDeduped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "techniques.json")
	write(t, path, `[{"id":"x","name":"First"},{"id":"x","name":"Second"}]`)
	_, _, _, _, err := mergeInto(path, mapEntries([]technique.Technique{{ID: "y", Name: "Y"}}, techniqueEntryOf))
	if err == nil {
		t.Fatal("a duplicate id was silently deduped — one of the two entries would be deleted")
	}
	if !strings.Contains(err.Error(), `"x"`) {
		t.Errorf("the error does not name the duplicated id: %v", err)
	}
}

func TestAdoptionSkipsWhatThisRunJustAdded(t *testing.T) {
	// What the merge reported as already in the file WITH THIS CONTENT: the
	// technique exported last week, committed and deployed.
	deployed := []string{"promoted-last-week"}
	authored := []technique.Technique{
		{ID: "promoted-last-week"},
		{ID: "authored-an-hour-ago"},
	}
	got := adoptable(deployed, idsOfTechniques(authored))
	if strings.Join(got, ",") != "promoted-last-week" {
		t.Errorf("adopted %v — an id this run first wrote is not deployed, so "+
			"adopting it hands content to a release that cannot reseed it", got)
	}
}

// The case step 2 introduced, and the one an id-based check gets wrong.
//
// Before the console could edit seeded rows, every admin row had an id the file
// had never seen, so "is the id in the file?" was a fine proxy for "is it
// deployed?". An EDITED seeded row breaks that: its id was in the file all
// along, carrying the OLD text. Adopt it and the deploy owns a row it has a
// stale version of, and the next release re-seeds that stale text over the
// edit — silently, which is the whole failure class this command exists to
// prevent.
func TestAdoptionSkipsASeededRowThisRunEdited(t *testing.T) {
	dir := t.TempDir()
	seed := filepath.Join(dir, "techniques.json")

	original := technique.Technique{ID: "was-seeded", Name: "Original",
		Category: "Pass", Position: "Other", GiNoGi: "Both"}
	promoted := technique.Technique{ID: "already-promoted", Name: "Same",
		Category: "Pass", Position: "Other", GiNoGi: "Both"}
	// The file is written through the SAME mapper the export uses, so its
	// entries carry every key a real seed file has. A hand-written abbreviated
	// fixture makes every row look changed — correctly, which is why it proves
	// nothing about the rule under test.
	if err := writeJSON(seed, mapEntries(
		[]technique.Technique{original, promoted}, techniqueEntryOf)); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	edited := original
	edited.Name = "Edited In The Console"
	authored := []technique.Technique{
		edited,   // same id as a file entry, different content
		promoted, // exported before and unchanged since — genuinely deployed
	}
	unchanged, err := run(techniqueCatalog(seed, authored),
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	got := adoptable(unchanged, idsOfTechniques(authored))
	if strings.Join(got, ",") != "already-promoted" {
		t.Errorf("adoptable = %v, want only already-promoted — adopting the row "+
			"this run edited hands the deploy content it does not carry, and the "+
			"next release reverts the edit", got)
	}
}

// New entries append in id order, so the output does not depend on the order
// the database happened to return the rows in.
func TestAppendedOrderDoesNotDependOnTheQueryOrder(t *testing.T) {
	run := func(authored []technique.Technique) []string {
		path := filepath.Join(t.TempDir(), "techniques.json")
		write(t, path, `[{"id":"existing","name":"E"}]`)
		merged, _, _, _, err := mergeInto(path, mapEntries(authored, techniqueEntryOf))
		if err != nil {
			t.Fatalf("merge: %v", err)
		}
		return ids(merged)
	}
	forward := run([]technique.Technique{{ID: "aaa"}, {ID: "zzz"}})
	backward := run([]technique.Technique{{ID: "zzz"}, {ID: "aaa"}})
	if strings.Join(forward, ",") != strings.Join(backward, ",") {
		t.Errorf("order depends on the query: %v vs %v", forward, backward)
	}
	// ...and the existing entry keeps its position at the front.
	if forward[0] != "existing" {
		t.Errorf("the existing entry moved: %v", forward)
	}
}

// The read-back guard's own logic. The call site is redundant by design — see
// run() — but the check has to actually detect a missing id, or it is decoration
// that would pass a half-written file straight through.
func TestVerifyContainsDetectsAMissingID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "catalog.json")
	write(t, path, `[{"id":"present","name":"P"}]`)

	err := verifyContains(path, []string{"present", "absent"})
	if err == nil {
		t.Fatal("a file missing an exported id passed verification")
	}
	if !strings.Contains(err.Error(), "absent") {
		t.Errorf("the error does not name the missing id: %v", err)
	}
	// ...and a file that has everything passes.
	if err := verifyContains(path, []string{"present"}); err != nil {
		t.Errorf("a complete file was rejected: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Exercises. The same invariants as techniques, plus one this catalog has and
// that one does not: media the export cannot see.
// ---------------------------------------------------------------------------

const exerciseSeedFile = "../../internal/modules/exercise/exercises.json"

func exerciseCatalog(seed string, authored []exercise.Exercise) catalog {
	return catalog{
		what: "exercises", seedPath: seed,
		entries:  mapEntries(authored, exerciseEntryOf),
		ids:      idsOfExercises(authored),
		adopt:    func(context.Context, []string) error { return nil },
		preserve: exercisePreserve,
		validate: func() error {
			for _, e := range authored {
				if err := exercise.ValidateForWrite(e); err != nil {
					return fmt.Errorf("%q would not seed: %w", e.ID, err)
				}
			}
			return nil
		},
	}
}

func anExercise(id, name string) exercise.Exercise {
	return exercise.Exercise{
		ID: id, Name: name, Sport: "strength", MovementPattern: "squat",
		LoadType: exercise.LoadTypeWeightReps,
	}
}

// The load-bearing one, same as its technique counterpart: if re-serialising
// the catalog is not a no-op, the first export rewrites all 504 entries and the
// review step the promotion path depends on is a whole-file diff nobody reads.
//
// Run against the real shipped file, because the property is "matches what
// Python wrote" and a fixture would only prove the code agrees with itself.
func TestRewritingTheRealExerciseCatalogChangesNothing(t *testing.T) {
	original, err := os.ReadFile(exerciseSeedFile)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	entries, err := readEntries(exerciseSeedFile)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("parsed an empty catalog — the test would prove nothing")
	}

	out := filepath.Join(t.TempDir(), "out.json")
	if err := writeJSON(out, entries); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != string(original) {
		t.Errorf("re-serialising exercises.json is not a no-op — every export would "+
			"rewrite the whole file.\n%s", firstDifference(string(original), string(got)))
	}
}

// The key order has to match the DATA, not just this file's constant, or both
// drift together and the diff stays broken while the test stays green.
func TestExerciseKeyOrderMatchesTheShippedCatalog(t *testing.T) {
	rank := make(map[string]int, len(exerciseKeyOrder))
	for i, k := range exerciseKeyOrder {
		rank[k] = i
	}
	entries, err := readEntries(exerciseSeedFile)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	for _, e := range entries {
		last, lastKey := -1, ""
		for _, p := range e {
			r, known := rank[p.Key]
			if !known {
				t.Fatalf("%s has key %q that exerciseKeyOrder does not list", e.id(), p.Key)
			}
			if r < last {
				t.Fatalf("%s writes %q after %q, but exerciseKeyOrder has them the other way",
					e.id(), p.Key, lastKey)
			}
			last, lastKey = r, p.Key
		}
	}
}

// An exported exercise must actually be loadable. Media is written as `[]`, and
// the list columns as `[]` rather than omitted — they are `TEXT[] NOT NULL`, so
// an absent key unmarshals to nil, pgx sends NULL, and one such entry fails the
// entire seed transaction.
func TestAnExportedExerciseCanBeSeeded(t *testing.T) {
	bare := exercise.Exercise{
		ID: "x", Name: "X", Sport: "strength",
		MovementPattern: "squat", LoadType: exercise.LoadTypeWeightReps,
	}
	raw, err := json.Marshal([]entry{exerciseEntryOf(bare)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back []exercise.Exercise
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal as Exercise: %v", err)
	}
	if len(back) != 1 {
		t.Fatalf("got %d exercises", len(back))
	}
	for _, c := range []struct {
		name string
		got  []string
	}{
		{"primary_muscles", back[0].PrimaryMuscles},
		{"secondary_muscles", back[0].SecondaryMuscles},
		{"equipment", back[0].Equipment},
	} {
		if c.got == nil {
			t.Errorf("%s came back nil — pgx sends NULL and the NOT NULL column "+
				"fails the whole seed transaction", c.name)
		}
	}
	if back[0].Media == nil {
		t.Error("media came back nil rather than an empty list")
	}
}

// The rule this catalog needs and techniques do not.
//
// The write path cannot author media and AdminAuthored does not select it, so
// every exported exercise carries `"media": []`. Re-exporting an exercise a
// deploy later gave media to must NOT reset that — the bytes are still in the
// bucket and this file is the only record of where.
func TestReExportingDoesNotWipeMediaTheFileAlreadyHas(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "exercises.json")
	write(t, path, `[{"id":"zercher-squat","name":"Zercher Squat","media":[{"kind":"demo","storage_key":"exercises/zercher/demo.mp4"}]}]`)

	merged, added, updated, _, err := mergeInto(path,
		mapEntries([]exercise.Exercise{anExercise("zercher-squat", "Zercher Squat (edited)")}, exerciseEntryOf),
		"media")
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if added != 0 || updated != 1 {
		t.Fatalf("added=%d updated=%d, want 0/1", added, updated)
	}
	raw, err := json.Marshal(merged[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), "exercises/zercher/demo.mp4") {
		t.Errorf("media was wiped by the re-export: %s", raw)
	}
	// ...and the edit still landed.
	if !strings.Contains(string(raw), "Zercher Squat (edited)") {
		t.Errorf("the edit did not land: %s", raw)
	}
}

// ...but a NEW entry gets `[]`, not a missing key — the file has `media` on all
// 504 entries.
func TestANewExerciseGetsAnEmptyMediaList(t *testing.T) {
	raw, err := json.Marshal(exerciseEntryOf(anExercise("new-one", "New One")))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"media":[]`) {
		t.Errorf("no empty media list: %s", raw)
	}
}

func TestTheExerciseSeedFileGainsTheEntry(t *testing.T) {
	dir := t.TempDir()
	seed := filepath.Join(dir, "exercises.json")
	write(t, seed, `[{"id":"already-there","name":"Existing"}]`)

	c := exerciseCatalog(seed, []exercise.Exercise{anExercise("zercher-squat", "Zercher Squat")})
	if _, err := run(c, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatalf("run: %v", err)
	}
	have, err := idsIn(seed)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !have["zercher-squat"] {
		t.Error("the seed file does not carry the exported id")
	}
	if !have["already-there"] {
		t.Error("the export replaced the catalog instead of merging into it")
	}
}

func TestRunRefusesAnExerciseThatWouldNotSeed(t *testing.T) {
	dir := t.TempDir()
	seed := filepath.Join(dir, "exercises.json")
	write(t, seed, `[]`)

	bad := anExercise("broken", "Broken")
	bad.MovementPattern = "not-a-real-pattern"
	_, err := run(exerciseCatalog(seed, []exercise.Exercise{bad}),
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil {
		t.Fatal("an exercise that fails validation was written anyway")
	}
	raw, _ := os.ReadFile(seed)
	if string(raw) != `[]` {
		t.Errorf("the seed file was modified despite the refusal: %s", raw)
	}
}

// A catalog with no validator must be refused rather than written unchecked —
// the field is easy to forget when adding a third library.
func TestACatalogWithNoValidatorIsRefused(t *testing.T) {
	dir := t.TempDir()
	seed := filepath.Join(dir, "s.json")
	write(t, seed, `[]`)
	_, err := run(catalog{what: "unchecked", seedPath: seed,
		entries: mapEntries([]exercise.Exercise{anExercise("x", "X")}, exerciseEntryOf)},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil {
		t.Fatal("a catalog with no validator was written")
	}
}

// The WIRING, not the mechanism.
//
// `TestReExportingDoesNotWipeMediaTheFileAlreadyHas` passes "media" to
// mergeInto as a literal, so it proves carryOver works and says nothing about
// whether the exercise catalog asks for it. The first version of this test
// built its own catalog and had the same blind spot — deleting `preserve` from
// main() stayed green. It goes through `catalogsFor`, which is what main uses.
//
// This matters more than a normal wiring test because the failure is a DELETE:
// `upsertMedia`'s prune is not scoped to `source = 'seed'`, so a re-seed of an
// entry whose JSON says `"media": []` removes that exercise's media rows even
// though the row itself is admin-owned and correctly skipped.
func TestTheExerciseCatalogActuallyAsksToPreserveMedia(t *testing.T) {
	dir := t.TempDir()
	p := filePaths{
		techSeed: filepath.Join(dir, "techniques.json"),
		exSeed:   filepath.Join(dir, "exercises.json"),
	}
	const withMedia = `[{"id":"jefferson-curl","name":"Jefferson Curl","media":[{"kind":"demo","storage_key":"exercises/jc/demo.mp4"}]}]`
	write(t, p.exSeed, withMedia)

	noop := func(context.Context, []string) error { return nil }
	cats := catalogsFor(p, nil, noop,
		[]exercise.Exercise{anExercise("jefferson-curl", "Jefferson Curl (edited)")}, noop)

	var ex catalog
	for _, c := range cats {
		if c.what == "exercises" {
			ex = c
		}
	}
	if _, err := run(ex, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatalf("run: %v", err)
	}
	for _, path := range []string{p.exSeed} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if !strings.Contains(string(raw), "exercises/jc/demo.mp4") {
			t.Errorf("%s lost its media on re-export — the next re-seed would DELETE "+
				"the exercise_media rows for an asset still in the bucket:\n%s",
				filepath.Base(path), raw)
		}
		if !strings.Contains(string(raw), "Jefferson Curl (edited)") {
			t.Errorf("%s did not take the edit", filepath.Base(path))
		}
	}
}

// ...and the technique catalog must NOT preserve anything, or an edit to a
// field the file already holds would be silently discarded.
func TestTheTechniqueCatalogPreservesNothing(t *testing.T) {
	noop := func(context.Context, []string) error { return nil }
	for _, c := range catalogsFor(filePaths{}, nil, noop, nil, noop) {
		if c.what == "techniques" && len(c.preserve) != 0 {
			t.Errorf("the technique catalog preserves %v — contentReturning selects "+
				"every technique column, so nothing is the file's alone", c.preserve)
		}
	}
}

// Each catalog must adopt against its OWN repository. The switch this replaced
// had no default, so swapping the two — adopting exercises against the
// techniques table — survived the entire suite.
func TestEachCatalogAdoptsAgainstItsOwnRepository(t *testing.T) {
	var got []string
	record := func(name string) func(context.Context, []string) error {
		return func(context.Context, []string) error {
			got = append(got, name)
			return nil
		}
	}
	cats := catalogsFor(filePaths{}, nil, record("techniques"), nil, record("exercises"))
	for _, c := range cats {
		if c.adopt == nil {
			t.Fatalf("the %s catalog has no adopt function", c.what)
		}
		if err := c.adopt(context.Background(), []string{"x"}); err != nil {
			t.Fatalf("adopt: %v", err)
		}
		if got[len(got)-1] != c.what {
			t.Errorf("the %s catalog adopted against %q", c.what, got[len(got)-1])
		}
	}
}
