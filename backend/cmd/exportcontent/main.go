// Command exportcontent carries admin-authored catalog rows back into the seed
// JSON, so content created in a running environment can be reviewed, committed
// and promoted through the normal deploy.
//
// This is the half that makes admin authoring more than a local convenience.
// Without it, a technique added in staging exists only in staging's database:
// production never learns about it, and nothing reviews an id that becomes a
// permanent foreign key in athletes' training records.
//
// # WHICH FILES, AND WHY BOTH
//
// It writes TWO files, because they mean two different things and content that
// lands in only one of them is lost by a different route each time:
//
//   - techniques.json is the DEPLOY ARTIFACT. It is what `//go:embed` bakes
//     into the binary, what SeedData() returns, and what `cmd/seed` writes to
//     the database. Content that is not here is not in the deploy — so
//     -adopt would hand the row to a release that cannot reseed it, and the
//     next fresh environment simply would not have the technique.
//
//   - techniques.additions.json is the record of content NOT from the
//     spreadsheet. `scripts/import-exercise-catalog.py` rebuilds
//     techniques.json from the sheet and merges this file in. Content that is
//     not here is deleted by the next re-import, silently, because the sheet
//     is a full replacement rather than a patch.
//
// All 16 existing additions are present in both files. That is the invariant
// this command maintains, not an accident to be tidied up.
//
// USAGE
//
//	go run ./cmd/exportcontent                # write both files, touch nothing else
//	go run ./cmd/exportcontent -adopt         # ...and hand the rows to the deploy
//
// The two steps are separate on purpose. Until the JSON is committed AND
// deployed, the database row is the only copy, so -adopt before that would
// leave content owned by a deploy that does not carry it yet. The intended
// order is: export, review the diff, merge, deploy, then adopt.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"

	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

func main() {
	logger := httplog.For("exportcontent")

	var (
		seedOut = flag.String("seed", "internal/modules/technique/techniques.json",
			"the deploy artifact — embedded in the binary and seeded to the database")
		addOut = flag.String("additions", "internal/modules/technique/techniques.additions.json",
			"the non-spreadsheet record — merged back in by the importer")
		adopt = flag.Bool("adopt", false,
			"after writing, mark the exported rows source='seed' — only once the JSON is deployed")
	)
	flag.Parse()

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		logger.Error("DATABASE_URL must be set (see backend/.env.example)")
		os.Exit(1)
	}
	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		logger.Error("database: connect", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	repo := technique.NewPostgresRepository(pool)
	authored, err := repo.AdminAuthored(ctx)
	if err != nil {
		logger.Error("export: read", "err", err)
		os.Exit(1)
	}
	if len(authored) == 0 {
		logger.Info("export: nothing authored in the console; files untouched",
			"seed", *seedOut, "additions", *addOut)
		return
	}

	alreadyDeployed, err := idsIn(*seedOut)
	if err != nil {
		logger.Error("export: read the seed file", "err", err)
		os.Exit(1)
	}
	if err := refuseSheetOwned(*seedOut, *addOut, authored); err != nil {
		logger.Error("export: refused", "err", err)
		os.Exit(1)
	}

	// Written through one function so the two-file invariant has somewhere to be
	// tested. It previously lived inline in main(), which meant deleting the
	// techniques.json write left the entire suite green — the exact regression
	// this command's second revision exists to fix, invisible to its own tests.
	if err := run(*seedOut, *addOut, authored, logger); err != nil {
		logger.Error("export: write", "err", err)
		os.Exit(1)
	}

	if !*adopt {
		logger.Info("export: rows are still source='admin' — re-run with -adopt " +
			"once these files are committed and deployed, or the deploy will not own them")
		return
	}
	// Only ids the seed file ALREADY carried before this run touched it. An id
	// this export just added is by definition not committed, let alone deployed,
	// so adopting it hands content to a release that cannot reseed it and that
	// the console will no longer let anyone edit — the precise state the two
	// commands exist to keep apart. Without this, `-adopt` run for Monday's
	// batch also adopts the technique authored on Wednesday and written to the
	// file seconds earlier.
	ids := adoptable(alreadyDeployed, authored)
	if len(ids) == 0 {
		logger.Info("export: nothing to adopt — every authored row is new to the " +
			"seed file this run, so none of it is deployed yet; commit and deploy, then re-run")
		return
	}
	if skipped := len(authored) - len(ids); skipped > 0 {
		logger.Info("export: some rows were not adopted because this run is the "+
			"first to write them; commit and deploy, then re-run", "skipped", skipped)
	}
	if err := repo.AdoptAsSeeded(ctx, ids); err != nil {
		logger.Error("export: adopt", "err", err)
		os.Exit(1)
	}
	logger.Info("export: adopted; the deploy now owns these rows", "count", len(ids))
}

// run merges the authored rows into BOTH catalog files and writes them.
//
// Both files or neither, as far as that is achievable across two files: every
// merge is staged before any write, so a parse error in the second cannot leave
// the first rewritten. A write failure after that is bounded — main() exits
// before -adopt, the database still holds the only authoritative copy, and
// re-running re-derives both files from it.
//
// techniques.json is written FIRST on purpose. If the second write fails, the
// half-state is "in the deploy artifact but not the additions record", which the
// next spreadsheet re-import cleans up by deleting the entry. The reverse
// half-state is a phantom: content the deploy never carries, which nothing
// removes and nobody can edit.
func run(seedPath, additionsPath string, authored []technique.Technique, logger *slog.Logger) error {
	type staged struct {
		what   string
		path   string
		merged []entry
		added  int
		upd    int
	}
	var plan []staged
	for _, f := range []struct{ what, path string }{
		{"seed", seedPath},
		{"additions", additionsPath},
	} {
		merged, added, upd, err := mergeInto(f.path, authored)
		if err != nil {
			return fmt.Errorf("%s: %w", f.what, err)
		}
		// The file is what go:embed bakes into the binary. An invalid entry here
		// fails SeedData() and takes the whole seed down on the next deploy —
		// far from the operator who could still fix it.
		for _, t := range authored {
			if err := technique.ValidateFields(t); err != nil {
				return fmt.Errorf("%s: %q would not seed: %w", f.what, t.ID, err)
			}
		}
		plan = append(plan, staged{f.what, f.path, merged, added, upd})
	}
	for _, p := range plan {
		if err := writeJSON(p.path, p.merged); err != nil {
			return fmt.Errorf("%s: %w", p.what, err)
		}
		logger.Info("export: wrote", "file", p.what, "path", p.path,
			"added", p.added, "updated", p.upd, "total", len(p.merged))
	}
	// Read back rather than trust the writes: one guard for a half write, a
	// silent dedupe, and a broken two-file invariant at once.
	//
	// Deliberately redundant. Removing the CALL leaves the suite green, because
	// every state it catches has its own test and the writes above are correct —
	// it earns its place at runtime, on a filesystem that lied, not in the test
	// matrix. verifyContains itself is tested.
	for _, p := range plan {
		if err := verifyContains(p.path, authored); err != nil {
			return fmt.Errorf("%s: %w", p.what, err)
		}
	}
	return nil
}

// verifyContains re-reads a written file and confirms it carries every id the
// export just put in it.
func verifyContains(path string, authored []technique.Technique) error {
	have, err := idsIn(path)
	if err != nil {
		return fmt.Errorf("verify: %w", err)
	}
	for _, t := range authored {
		if !have[t.ID] {
			return fmt.Errorf("%q is missing from %s after writing it", t.ID, filepath.Base(path))
		}
	}
	return nil
}

// adoptable narrows the authored rows to those the seed file ALREADY carried
// before this run touched it.
//
// An id this export just added is not committed, let alone deployed, so
// adopting it hands content to a release that cannot reseed it and that the
// console will no longer let anyone edit. Without this, `-adopt` intended for
// last week's batch also adopts the technique authored an hour ago and written
// to the file seconds earlier.
func adoptable(alreadyDeployed map[string]bool, authored []technique.Technique) []string {
	ids := make([]string, 0, len(authored))
	for _, t := range authored {
		if alreadyDeployed[t.ID] {
			ids = append(ids, t.ID)
		}
	}
	return ids
}

// refuseSheetOwned rejects any authored id the SPREADSHEET owns.
//
// An id in techniques.json but not in techniques.additions.json came from the
// sheet, and `scripts/import-exercise-catalog.py` regenerates those from the
// sheet on every run — so an admin edit to one would be silently reverted by
// the next import, long after the export looked like it worked. The importer
// also exits on "additions collide with sheet ids", so writing it to the
// additions file breaks the import outright.
//
// A hard error rather than a skip: skipping would silently drop content that
// has no other copy, which is the failure this whole command exists to prevent.
func refuseSheetOwned(seedPath, additionsPath string, authored []technique.Technique) error {
	seeded, err := idsIn(seedPath)
	if err != nil {
		return err
	}
	ours, err := idsIn(additionsPath)
	if err != nil {
		return err
	}
	var clashes []string
	for _, t := range authored {
		if seeded[t.ID] && !ours[t.ID] {
			clashes = append(clashes, t.ID)
		}
	}
	if len(clashes) > 0 {
		sort.Strings(clashes)
		return fmt.Errorf(
			"these ids are owned by the spreadsheet (present in %s but not %s), so the next "+
				"import would revert any edit to them and would refuse the additions file "+
				"outright: %v — edit the sheet and re-import, or give the technique a new id",
			filepath.Base(seedPath), filepath.Base(additionsPath), clashes)
	}
	return nil
}

func idsIn(path string) (map[string]bool, error) {
	entries, err := readEntries(path)
	if err != nil {
		return nil, err
	}
	ids := make(map[string]bool, len(entries))
	for _, e := range entries {
		ids[e.id()] = true
	}
	return ids, nil
}

// mergeInto folds the exported techniques into an existing catalog file.
//
// MERGE, not replace. Both files hold content this command never wrote — the
// additions file predates it by months, and techniques.json is 466 entries
// generated from the spreadsheet — so overwriting either would destroy content
// that has no other copy.
//
// Entries are matched by id and replaced; everything else is kept BYTE FOR
// BYTE, key order included. That is what makes the diff reviewable: without it
// the first export reorders every key of all 482 entries (Go marshals a map
// with its keys sorted, the files are written in semantic order) and buries the
// one real change in a whole-file rewrite. Nobody reads that diff, and the
// review step is the only thing standing between a typo and a permanent
// foreign key in athletes' training records.
func mergeInto(path string, authored []technique.Technique) (
	merged []entry, added, updated int, err error,
) {
	existing, err := readEntries(path)
	if err != nil {
		return nil, 0, 0, err
	}

	byID := make(map[string]entry, len(existing)+len(authored))
	order := make([]string, 0, len(existing)+len(authored))
	for _, e := range existing {
		id := e.id()
		if id == "" {
			return nil, 0, 0, fmt.Errorf("%s holds an entry with no id", path)
		}
		if _, dup := byID[id]; dup {
			// Keeping the last occurrence would DELETE the other on the next
			// write — the "content with no other copy" loss this command exists
			// to prevent, committed by the command. techniques.json cannot reach
			// this state (validate() rejects duplicate ids) but the additions
			// file has no such check.
			return nil, 0, 0, fmt.Errorf("%s holds two entries with id %q", path, id)
		}
		order = append(order, id)
		byID[id] = e
	}
	// Existing entries keep the file's own order. NEITHER file is in id order —
	// techniques.json is in spreadsheet order and the additions file inverts at
	// index 2 — so re-sorting would be the whole-file rewrite this function
	// exists to avoid. An earlier version sorted "if the file is already
	// sorted", which was dead code that read as a live rule.
	//
	// New ids are appended, sorted among themselves, so the output does not
	// depend on the order the database happened to return them in.
	var fresh []string
	for _, t := range authored {
		if _, exists := byID[t.ID]; exists {
			updated++
		} else {
			added++
			fresh = append(fresh, t.ID)
		}
		byID[t.ID] = entryOf(t)
	}
	sort.Strings(fresh)
	order = append(order, fresh...)

	merged = make([]entry, 0, len(order))
	for _, id := range order {
		merged = append(merged, byID[id])
	}
	return merged, added, updated, nil
}

// The key order both files are written in. Not alphabetical — it is the order
// the Python importer emits, and matching it is what keeps an exported entry
// visually consistent with its 481 neighbours.
//
// The two interior slots are load-bearing and were wrong in the first version,
// which appended both to the end. Measured against the shipped file: 462 of 466
// entries put `function` between `category` and `position`, and 149 put
// `to_position` between `position_detail` and `gi_no_gi`. That is not a style
// preference — `apply_taxonomy` inserts `function` after `category` and
// `carry_to_position` rebuilds each record to place `to_position` after
// `position_detail` (scripts/import-exercise-catalog.py), so appending them
// instead means the next spreadsheet re-import silently relocates both keys on
// every entry this command wrote, producing exactly the whole-file diff this
// design exists to prevent.
//
// `function` and `to_position` are also the only OPTIONAL keys, matching the
// data: to_position is absent on 317 of 466 entries, and absent means "not
// recorded", which migration 000029 is explicit is a different fact from any
// value.
//
// Everything else is ALWAYS written, empty string and empty list included. This
// is not cosmetic: aliases, setup_from, common_counters and common_next_moves
// are `TEXT[] NOT NULL` columns, an omitted key unmarshals to a nil slice, and
// pgx encodes a nil slice as NULL. Seeding one is a not-null violation inside
// UpsertAll's transaction, so a single exported technique with no aliases takes
// the ENTIRE seed down — every technique, not just its own row.
var keyOrder = []string{
	"id", "name", "aliases", "category", "function", "position",
	"position_detail", "to_position", "gi_no_gi", "typical_belt", "description",
	"when_to_use", "setup_from", "common_next_moves", "common_counters",
	"video_reference", "source_notes", "ibjjf_ruleset_id",
}

// entryOf renders a technique in the catalog files' shape.
func entryOf(t technique.Technique) entry {
	values := map[string]any{
		"id":                t.ID,
		"name":              t.Name,
		"aliases":           orEmpty(t.Aliases),
		"category":          t.Category,
		"position":          t.Position,
		"position_detail":   t.PositionDetail,
		"gi_no_gi":          t.GiNoGi,
		"typical_belt":      t.TypicalBelt,
		"description":       t.Description,
		"when_to_use":       t.WhenToUse,
		"setup_from":        orEmpty(t.SetupFrom),
		"common_next_moves": orEmpty(t.CommonNextMoves),
		"common_counters":   orEmpty(t.CommonCounters),
		"video_reference":   t.VideoReference,
		"source_notes":      t.SourceNotes,
		"ibjjf_ruleset_id":  t.IBJJFRulesetID,
	}
	if t.Function != "" {
		values["function"] = t.Function
	}
	if t.ToPosition != "" {
		values["to_position"] = t.ToPosition
	}

	var e entry
	for _, k := range keyOrder {
		v, ok := values[k]
		if !ok {
			continue
		}
		raw, err := rawJSON(v)
		if err != nil {
			// Only reachable if a string or []string fails to marshal, which
			// encoding/json does not do.
			panic(fmt.Sprintf("exportcontent: marshal %q: %v", k, err))
		}
		e = append(e, pair{Key: k, Val: raw})
	}
	return e
}

// orEmpty turns a nil slice into an empty one, so it serialises as `[]` rather
// than `null`. See keyOrder for what a `null` costs.
func orEmpty(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

// pair is one key and its raw value; entry is an ordered object.
//
// The files are read and written through this rather than map[string]any
// because a Go map has no order and marshals its keys sorted, which would
// rewrite every entry in both files on the first export.
type pair struct {
	Key string
	Val json.RawMessage
}

type entry []pair

func (e entry) id() string {
	for _, p := range e {
		if p.Key == "id" {
			var s string
			if err := json.Unmarshal(p.Val, &s); err != nil {
				return ""
			}
			return s
		}
	}
	return ""
}

func (e *entry) UnmarshalJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return fmt.Errorf("expected a JSON object, got %v", tok)
	}
	out := entry{}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return err
		}
		key, ok := keyTok.(string)
		if !ok {
			return fmt.Errorf("expected a string key, got %v", keyTok)
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		out = append(out, pair{Key: key, Val: raw})
	}
	if _, err := dec.Token(); err != nil { // the closing brace
		return err
	}
	*e = out
	return nil
}

func (e entry) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, p := range e {
		if i > 0 {
			buf.WriteByte(',')
		}
		key, err := rawJSON(p.Key)
		if err != nil {
			return nil, err
		}
		buf.Write(key)
		buf.WriteByte(':')
		buf.Write(p.Val)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// rawJSON marshals a value WITHOUT Go's default HTML escaping, which turns `&`
// into `&`. The catalog files are written by Python with
// ensure_ascii=False, so escaping here would rewrite every entry containing an
// ampersand and bury the real change.
func rawJSON(v any) (json.RawMessage, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return json.RawMessage(bytes.TrimRight(buf.Bytes(), "\n")), nil
}

// readEntries parses a catalog file, keeping each entry's key order. A missing
// file is an empty list, not an error — the additions file may not exist yet.
func readEntries(path string) ([]entry, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []entry{}, nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var entries []entry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return entries, nil
}

// writeJSON matches the files' existing formatting: two-space indent, a
// trailing newline, and no HTML escaping — byte-for-byte what
// `json.dumps(indent=2, ensure_ascii=False)` produces, so re-serialising an
// untouched entry is a no-op in the diff.
//
// Written to a temp file in the same directory and renamed, so an error partway
// through cannot leave a truncated catalog behind.
func writeJSON(path string, entries []entry) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".export-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name()) // no-op once the rename succeeds

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(entries); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(f.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
