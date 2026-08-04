package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
)

const (
	seedFile      = "../../internal/modules/technique/techniques.json"
	additionsFile = "../../internal/modules/technique/techniques.additions.json"
)

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
// export rewrites all 482 entries and the one review step standing between a
// typo and a permanent foreign key in athletes' training records is a
// whole-file rewrite nobody reads.
//
// Run against the real shipped files, not a fixture, because the property is
// "matches what Python wrote" and a fixture would only prove the code agrees
// with itself.
func TestRewritingTheRealFilesChangesNothing(t *testing.T) {
	for _, path := range []string{seedFile, additionsFile} {
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
// ENTIRE seed down — all 466 techniques, not just its own row.
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
	raw, err := json.Marshal([]entry{entryOf(bare)})
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

// The optional pair, from the same data: to_position is absent on 317 of 466
// entries and absent means "not recorded", which migration 000029 is explicit
// is a different fact from any value. Writing "" would be a lie.
func TestTheTwoOptionalKeysAreOmittedWhenEmpty(t *testing.T) {
	e := entryOf(technique.Technique{ID: "x", Name: "X"})
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
	e = entryOf(technique.Technique{ID: "x", Name: "X", Function: "advance", ToPosition: "Mount - Top"})
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
	// Not alphabetical, and not the struct's field order — the order the Python
	// importer emits, so an exported entry reads like its 481 neighbours.
	got := entryOf(technique.Technique{ID: "x", Name: "X", Function: "advance", ToPosition: "Mount - Top"})
	var gotKeys []string
	for _, p := range got {
		gotKeys = append(gotKeys, p.Key)
	}
	if strings.Join(gotKeys, ",") != strings.Join(keyOrder, ",") {
		t.Errorf("key order:\n  got:  %v\n  want: %v", gotKeys, keyOrder)
	}

	// And it is the order the real file uses, not just the order this file
	// declares — otherwise both could drift from the data together.
	real, err := readEntries(additionsFile)
	if err != nil {
		t.Fatalf("read additions: %v", err)
	}
	var realKeys []string
	for _, p := range real[0] {
		realKeys = append(realKeys, p.Key)
	}
	for i, k := range realKeys {
		if keyOrder[i] != k {
			t.Errorf("keyOrder[%d] = %q but the shipped file has %q", i, keyOrder[i], k)
		}
	}
}

// Go's encoder turns `&` into `\u0026` by default. Neither catalog file
// contains one TODAY, so nothing exercised SetEscapeHTML(false) until this —
// but "Over-Under & Double Under Pass" is an entirely ordinary thing to type
// into the console, and the escaped form would rewrite the entry unreadably
// and diverge from what the Python importer writes for the same content.
func TestAmpersandsSurviveUnescaped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "additions.json")
	merged, _, _, err := mergeInto(path, []technique.Technique{
		{ID: "x", Name: "Over-Under & Double Under", Description: "a < b > c"},
	})
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
	// The additions file predates this command and holds entries the console
	// never wrote. Replacing the file wholesale would silently delete content
	// that has no other copy — the exact failure this command exists to prevent,
	// committed by the command itself.
	path := filepath.Join(t.TempDir(), "additions.json")
	write(t, path, `[{"id":"hand-written","name":"By Hand","category":"Escape"}]`)

	merged, added, updated, err := mergeInto(path, []technique.Technique{
		{ID: "from-console", Name: "From Console", Category: "Pass"},
	})
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
	path := filepath.Join(dir, "additions.json")
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
// generated in spreadsheet order and sorting it would rewrite all 466 entries —
// the whole-file diff this design exists to avoid.
func TestAnUnsortedFileKeepsItsOrder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "techniques.json")
	write(t, path, `[{"id":"zebra","name":"Z"},{"id":"alpha","name":"A"}]`)

	merged, _, _, err := mergeInto(path, []technique.Technique{{ID: "middle", Name: "M"}})
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
	path := filepath.Join(t.TempDir(), "additions.json")
	write(t, path, `[{"id":"x","name":"Old Name","category":"Pass"}]`)

	merged, added, updated, err := mergeInto(path, []technique.Technique{
		{ID: "x", Name: "New Name", Category: "Pass"},
	})
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

// The collision rule, which is about WHO OWNS an id rather than whether it
// exists. All 16 current additions are in techniques.json too — that is the
// invariant, not a clash — so a rule of "refuse anything already seeded" would
// refuse every legitimate re-export.
func TestRefusesAnIDTheSpreadsheetOwnsButNotOneOfOurOwn(t *testing.T) {
	dir := t.TempDir()
	seed := filepath.Join(dir, "techniques.json")
	additions := filepath.Join(dir, "additions.json")
	write(t, seed, `[{"id":"from-sheet","name":"Sheet"},{"id":"ours","name":"Ours"}]`)
	write(t, additions, `[{"id":"ours","name":"Ours"}]`)

	err := refuseSheetOwned(seed, additions, []technique.Technique{{ID: "from-sheet", Name: "Clash"}})
	if err == nil {
		t.Fatal("exporting a spreadsheet-owned id was allowed — the next import would revert it")
	}
	if !strings.Contains(err.Error(), "from-sheet") {
		t.Errorf("the refusal does not name the offending id: %v", err)
	}

	// An id in BOTH files is ours, already promoted once. Re-exporting it is the
	// normal update path and must be allowed.
	if err := refuseSheetOwned(seed, additions, []technique.Technique{{ID: "ours", Name: "Edited"}}); err != nil {
		t.Errorf("re-exporting our own previously-promoted id was refused: %v", err)
	}
	// ...and a genuinely new id is fine.
	if err := refuseSheetOwned(seed, additions, []technique.Technique{{ID: "brand-new"}}); err != nil {
		t.Errorf("a new id was refused: %v", err)
	}
}

// The same rule against the REAL files: every existing addition must be
// re-exportable, or the first update to any of them is refused.
func TestEveryShippedAdditionIsStillExportable(t *testing.T) {
	entries, err := readEntries(additionsFile)
	if err != nil {
		t.Fatalf("read additions: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("no additions to check")
	}
	var authored []technique.Technique
	for _, e := range entries {
		authored = append(authored, technique.Technique{ID: e.id()})
	}
	if err := refuseSheetOwned(seedFile, additionsFile, authored); err != nil {
		t.Errorf("the shipped additions cannot be re-exported: %v", err)
	}
}

func TestAMissingAdditionsFileIsCreatedRatherThanFatal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "additions.json")
	merged, added, _, err := mergeInto(path, []technique.Technique{{ID: "x", Name: "X"}})
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
	path := filepath.Join(t.TempDir(), "additions.json")
	write(t, path, `[{"id":"broken",`)
	if _, _, _, err := mergeInto(path, []technique.Technique{{ID: "x", Name: "X"}}); err == nil {
		t.Error("a malformed file was silently replaced")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != `[{"id":"broken",` {
		t.Error("the malformed file was modified")
	}
}

func exportOnce(t *testing.T, path string, authored []technique.Technique) string {
	t.Helper()
	merged, _, _, err := mergeInto(path, authored)
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
