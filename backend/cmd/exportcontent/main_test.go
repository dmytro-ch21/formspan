package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
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
	ids := map[string]bool{}
	for _, e := range merged {
		ids[e["id"].(string)] = true
	}
	if !ids["hand-written"] {
		t.Error("the hand-authored entry was dropped")
	}
	if !ids["from-console"] {
		t.Error("the exported entry is missing")
	}
	// ...and the hand-authored entry is untouched, not reformatted.
	for _, e := range merged {
		if e["id"] == "hand-written" && e["name"] != "By Hand" {
			t.Errorf("hand-authored entry was rewritten: %v", e)
		}
	}
}

func TestReExportIsByteIdentical(t *testing.T) {
	// Without this the promotion path is unusable: every export is a noisy
	// diff, so nobody reads the one review step standing between a typo and a
	// permanent foreign key in athletes' training records.
	dir := t.TempDir()
	path := filepath.Join(dir, "additions.json")
	write(t, path, `[{"id":"b-second","name":"B"},{"id":"a-first","name":"A"}]`)

	authored := []technique.Technique{
		{ID: "c-third", Name: "C", Category: "Pass", Aliases: []string{}},
	}
	for i := 0; i < 3; i++ {
		merged, _, _, err := mergeInto(path, authored)
		if err != nil {
			t.Fatalf("merge %d: %v", i, err)
		}
		if err := writeJSON(path, merged); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	first, _ := os.ReadFile(path)
	merged, _, _, _ := mergeInto(path, authored)
	_ = writeJSON(path, merged)
	again, _ := os.ReadFile(path)
	if string(first) != string(again) {
		t.Error("a re-export with no changes produced a different file")
	}

	// Sorted by id, so the order does not depend on what the database happened
	// to return or on insertion order.
	var out []map[string]any
	_ = json.Unmarshal(again, &out)
	if len(out) != 3 || out[0]["id"] != "a-first" || out[2]["id"] != "c-third" {
		t.Errorf("not sorted by id: %v", out)
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
	if merged[0]["name"] != "New Name" {
		t.Errorf("entry not updated: %v", merged[0])
	}
}

func TestEmptyValuesAreOmittedRatherThanWrittenAsEmpty(t *testing.T) {
	// `"to_position": ""` would be a lie: migration 000029 is explicit that
	// absent means "not recorded" and is a different fact from any value. It
	// also matches how the hand-authored entries are written, which keeps the
	// file reviewable as one thing rather than two styles.
	e := entryOf(technique.Technique{
		ID: "x", Name: "X", Category: "Pass",
		Aliases: []string{}, SetupFrom: []string{},
	})
	for _, absent := range []string{"to_position", "function", "description", "aliases", "setup_from", "ibjjf_ruleset_id"} {
		if _, present := e[absent]; present {
			t.Errorf("%q was written despite being empty", absent)
		}
	}
	if e["id"] != "x" || e["name"] != "X" || e["category"] != "Pass" {
		t.Errorf("a populated field was dropped: %v", e)
	}
}

func TestRefusesAnIDTheGeneratedCatalogAlreadyHolds(t *testing.T) {
	// The additions file is merged into the generated techniques.json by the
	// importer, which exits on "additions collide with sheet ids". Exporting a
	// colliding id breaks that import far from here and long after the export
	// looked like it worked.
	generated, err := technique.SeedData()
	if err != nil {
		t.Fatalf("seed data: %v", err)
	}
	if len(generated) == 0 {
		t.Fatal("the embedded catalog is empty")
	}
	taken := generated[0].ID

	err = refuseCollisions([]technique.Technique{{ID: taken, Name: "Clash"}})
	if err == nil {
		t.Fatalf("exporting %q was allowed — the importer would then refuse it", taken)
	}
	if !strings.Contains(err.Error(), taken) {
		t.Errorf("the refusal does not name the offending id: %v", err)
	}
	// ...and a genuinely new id is fine.
	if err := refuseCollisions([]technique.Technique{{ID: "definitely-not-in-the-sheet-xyz"}}); err != nil {
		t.Errorf("a new id was refused: %v", err)
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

func TestAnUnparseableAdditionsFileIsRefusedNotOverwritten(t *testing.T) {
	// Overwriting it would destroy hand-authored content on the strength of a
	// stray character.
	path := filepath.Join(t.TempDir(), "additions.json")
	write(t, path, `[{"id":"broken",`)
	if _, _, _, err := mergeInto(path, []technique.Technique{{ID: "x", Name: "X"}}); err == nil {
		t.Error("a malformed additions file was silently replaced")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != `[{"id":"broken",` {
		t.Error("the malformed file was modified")
	}
}
