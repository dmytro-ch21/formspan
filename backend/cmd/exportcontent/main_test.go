package main

import (
	"encoding/json"
	"io"
	"log/slog"
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
	got := entryOf(technique.Technique{ID: "x", Name: "X", Function: "advance", ToPosition: "Mount - Top"})
	var gotKeys []string
	for _, p := range got {
		gotKeys = append(gotKeys, p.Key)
	}
	if strings.Join(gotKeys, ",") != strings.Join(keyOrder, ",") {
		t.Errorf("key order:\n  got:  %v\n  want: %v", gotKeys, keyOrder)
	}
}

// The order has to match the DATA, not just this file's own constant —
// otherwise both drift together and the diff stays broken while the test stays
// green. Checked as a SUBSEQUENCE per entry, because `function` and
// `to_position` are optional and an index-for-index comparison against an entry
// that omits them is what pinned the wrong order in place: the first version
// appended both to the end, and this test enforced it.
func TestKeyOrderMatchesEveryEntryInTheShippedCatalog(t *testing.T) {
	rank := make(map[string]int, len(keyOrder))
	for i, k := range keyOrder {
		rank[k] = i
	}
	for _, path := range []string{seedFile, additionsFile} {
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
					t.Errorf("%s: %s has key %q that keyOrder does not list",
						filepath.Base(path), e.id(), p.Key)
					continue
				}
				if r < last {
					t.Errorf("%s: %s writes %q after %q, but keyOrder has them the other way",
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
				"— the catalog changed and keyOrder needs to follow", want, seen[want])
		}
	}
	// And keyOrder agrees with it.
	if indexOf(keyOrder, "function") != indexOf(keyOrder, "category")+1 {
		t.Errorf("keyOrder puts %q after category, want immediately after", keyOrder[indexOf(keyOrder, "category")+1])
	}
	if indexOf(keyOrder, "to_position") != indexOf(keyOrder, "position_detail")+1 {
		t.Errorf("keyOrder does not put to_position immediately after position_detail: %v", keyOrder)
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

// The invariant the whole second revision is about, and it had NO test: the
// first version wrote only the additions file, and deleting the techniques.json
// write from the loop left the entire suite green.
func TestBothFilesGetTheEntryOrTheRunFails(t *testing.T) {
	dir := t.TempDir()
	seed := filepath.Join(dir, "techniques.json")
	additions := filepath.Join(dir, "additions.json")
	write(t, seed, `[{"id":"from-sheet","name":"Sheet","category":"Pass","position":"Other"}]`)
	write(t, additions, `[]`)

	authored := []technique.Technique{
		{ID: "new-one", Name: "New One", Category: "Pass", Position: "Other", GiNoGi: "Both"},
	}
	if err := run(seed, additions, authored, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatalf("run: %v", err)
	}
	for _, path := range []string{seed, additions} {
		have, err := idsIn(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if !have["new-one"] {
			t.Errorf("%s does not carry the exported id — content in only one file "+
				"is lost, by the deploy not having it or by the next re-import deleting it",
				filepath.Base(path))
		}
	}
	// ...and the sheet entry is still there, in both senses.
	have, _ := idsIn(seed)
	if !have["from-sheet"] {
		t.Error("the generated catalog lost an entry")
	}
}

// The file it writes is what go:embed bakes into the binary, so an entry that
// cannot seed must fail here rather than on the next deploy.
func TestRunRefusesAnEntryThatWouldNotSeed(t *testing.T) {
	dir := t.TempDir()
	seed := filepath.Join(dir, "techniques.json")
	additions := filepath.Join(dir, "additions.json")
	write(t, seed, `[]`)
	write(t, additions, `[]`)

	// Valid but for the function, which has no CHECK constraint in the schema —
	// so this validation is the only thing between a typo and a value no client
	// can render.
	err := run(seed, additions, []technique.Technique{
		{ID: "broken", Name: "Broken", Category: "Pass", Position: "Other",
			GiNoGi: "Both", Function: "not-a-real-function"},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
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
// the command. techniques.json cannot reach this state (validate() rejects it);
// the additions file has no such check.
func TestADuplicateIDIsRefusedRatherThanSilentlyDeduped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "additions.json")
	write(t, path, `[{"id":"x","name":"First"},{"id":"x","name":"Second"}]`)
	_, _, _, err := mergeInto(path, []technique.Technique{{ID: "y", Name: "Y"}})
	if err == nil {
		t.Fatal("a duplicate id was silently deduped — one of the two entries would be deleted")
	}
	if !strings.Contains(err.Error(), `"x"`) {
		t.Errorf("the error does not name the duplicated id: %v", err)
	}
}

func TestAdoptionSkipsWhatThisRunJustAdded(t *testing.T) {
	// The technique exported last week, committed and deployed.
	deployed := map[string]bool{"promoted-last-week": true}
	authored := []technique.Technique{
		{ID: "promoted-last-week"},
		{ID: "authored-an-hour-ago"},
	}
	got := adoptable(deployed, authored)
	if strings.Join(got, ",") != "promoted-last-week" {
		t.Errorf("adopted %v — an id this run first wrote is not deployed, so "+
			"adopting it hands content to a release that cannot reseed it", got)
	}
}

// New entries append in id order, so the output does not depend on the order
// the database happened to return the rows in.
func TestAppendedOrderDoesNotDependOnTheQueryOrder(t *testing.T) {
	run := func(authored []technique.Technique) []string {
		path := filepath.Join(t.TempDir(), "additions.json")
		write(t, path, `[{"id":"existing","name":"E"}]`)
		merged, _, _, err := mergeInto(path, authored)
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

	authored := []technique.Technique{{ID: "present"}, {ID: "absent"}}
	err := verifyContains(path, authored)
	if err == nil {
		t.Fatal("a file missing an exported id passed verification")
	}
	if !strings.Contains(err.Error(), "absent") {
		t.Errorf("the error does not name the missing id: %v", err)
	}
	// ...and a file that has everything passes.
	if err := verifyContains(path, []technique.Technique{{ID: "present"}}); err != nil {
		t.Errorf("a complete file was rejected: %v", err)
	}
}
