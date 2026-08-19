// Command exportcontent carries admin-authored catalog rows back into the seed
// JSON, so content created in a running environment can be reviewed, committed
// and promoted through the normal deploy.
//
// This is the half that makes admin authoring more than a local convenience.
// Without it, a technique added in staging exists only in staging's database:
// production never learns about it, and nothing reviews an id that becomes a
// permanent foreign key in athletes' training records.
//
// # WHICH FILE
//
// One file per catalog: techniques.json and exercises.json, the DEPLOY
// ARTIFACTS. Each is what `//go:embed` bakes into the binary, what SeedData()
// returns, and what `cmd/seed` writes to the database. Content that is not
// there is not in the deploy — so -adopt would hand the row to a release that
// cannot reseed it, and the next fresh environment simply would not have it.
//
// It used to write TWO files each. The second, `*.additions.json`, recorded
// which rows did NOT come from the authoring spreadsheet, because
// `scripts/import-exercise-catalog.py` rebuilt the seed file from that sheet as
// a FULL REPLACEMENT and would otherwise have deleted them. The spreadsheet was
// retired in 2026-08 (see docs/decisions/content-authoring-design.md), the
// importer no longer runs, and with nothing regenerating the seed file there is
// nothing for a second file to protect content from. Every row is now equally
// repo-owned, which is the whole point of the retirement.
//
// USAGE
//
//	go run ./cmd/exportcontent                # write the seed files, nothing else
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

	"github.com/dmytro-ch21/vola/backend/internal/modules/exercise"
	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

func main() {
	logger := httplog.For("exportcontent")

	var (
		techSeed = flag.String("techniques", "internal/modules/technique/techniques.json",
			"the technique deploy artifact — embedded in the binary and seeded to the database")
		exSeed = flag.String("exercises", "internal/modules/exercise/exercises.json",
			"the exercise deploy artifact")
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

	techRepo := technique.NewPostgresRepository(pool)
	exRepo := exercise.NewPostgresRepository(pool)

	techniques, err := techRepo.AdminAuthored(ctx)
	if err != nil {
		logger.Error("export: read techniques", "err", err)
		os.Exit(1)
	}
	exercises, err := exRepo.AdminAuthored(ctx)
	if err != nil {
		logger.Error("export: read exercises", "err", err)
		os.Exit(1)
	}
	if len(techniques) == 0 && len(exercises) == 0 {
		logger.Info("export: nothing authored in the console; files untouched")
		return
	}

	catalogs := catalogsFor(
		filePaths{*techSeed, *exSeed},
		techniques, techRepo.AdoptAsSeeded,
		exercises, exRepo.AdoptAsSeeded,
	)

	// Which ids the seed file ALREADY carried WITH EXACTLY THIS CONTENT, decided
	// during the merge and before the write. Adoption is scoped to these, and
	// content rather than id is what the test has to be.
	//
	// It was ids alone until step 2 of the content-authoring design, and that
	// was sound while every admin row was console-CREATED: a fresh id absent
	// from the file meant "not deployed yet". Step 2 lets the console edit
	// SEEDED rows, whose ids were in the file all along with the old content —
	// so an id test adopts them on the first run, handing the deploy a row it
	// carries a stale version of, which the next release then re-seeds straight
	// over the edit. Byte-equality covers both cases with one rule.
	deployed := map[string][]string{}
	for _, c := range catalogs {
		if len(c.entries) == 0 {
			logger.Info("export: nothing authored", "catalog", c.what)
			continue
		}
		unchanged, err := run(c, logger)
		if err != nil {
			logger.Error("export: write", "catalog", c.what, "err", err)
			os.Exit(1)
		}
		deployed[c.what] = unchanged
	}

	if !*adopt {
		logger.Info("export: rows are still source='admin' — re-run with -adopt " +
			"once these files are committed and deployed, or the deploy will not own them")
		return
	}
	adoptedAny := false
	for _, c := range catalogs {
		ids := adoptable(deployed[c.what], c.ids)
		if skipped := len(c.ids) - len(ids); skipped > 0 {
			logger.Info("export: some rows were not adopted because this run is the "+
				"first to write them; commit and deploy, then re-run",
				"catalog", c.what, "skipped", skipped)
		}
		if len(ids) == 0 {
			continue
		}
		if c.adopt == nil {
			logger.Error("export: adopt", "catalog", c.what, "err",
				fmt.Errorf("no adopt function — refusing to report an adoption that did not happen"))
			os.Exit(1)
		}
		if err := c.adopt(ctx, ids); err != nil {
			logger.Error("export: adopt", "catalog", c.what, "err", err)
			os.Exit(1)
		}
		adoptedAny = true
		logger.Info("export: adopted; the deploy now owns these rows",
			"catalog", c.what, "count", len(ids))
	}
	if !adoptedAny {
		logger.Info("export: nothing to adopt — every authored row is new to the " +
			"seed files this run, so none of it is deployed yet; commit and deploy, then re-run")
	}
}

// filePaths is the two files an export touches.
type filePaths struct{ techSeed, exSeed string }

// catalogsFor builds what the export runs over.
//
// Extracted from main() because main() has no test, and the wiring here is
// load-bearing in two places that are invisible from inside run(): which
// catalog preserves `media`, and which repository each catalog adopts against.
// The first version of these tests built their own catalogs, so deleting either
// wiring from main() left the whole suite green — which is the same shape of
// gap this command has now shipped twice.
func catalogsFor(
	p filePaths,
	techniques []technique.Technique,
	adoptTechniques func(context.Context, []string) error,
	exercises []exercise.Exercise,
	adoptExercises func(context.Context, []string) error,
) []catalog {
	return []catalog{
		{
			what: "techniques", seedPath: p.techSeed,
			entries: mapEntries(techniques, techniqueEntryOf),
			ids:     idsOfTechniques(techniques),
			adopt:   adoptTechniques,
			// Nothing to preserve: contentReturning selects every technique
			// column, so no key in techniques.json is the file's alone.
			validate: func() error {
				for _, t := range techniques {
					if err := technique.ValidateFields(t); err != nil {
						return fmt.Errorf("%q would not seed: %w", t.ID, err)
					}
				}
				return nil
			},
		},
		{
			what: "exercises", seedPath: p.exSeed,
			entries:  mapEntries(exercises, exerciseEntryOf),
			ids:      idsOfExercises(exercises),
			adopt:    adoptExercises,
			preserve: exercisePreserve,
			validate: func() error {
				for _, e := range exercises {
					if err := exercise.ValidateForWrite(e); err != nil {
						return fmt.Errorf("%q would not seed: %w", e.ID, err)
					}
				}
				return nil
			},
		},
	}
}

// mapEntries renders a catalog's rows through its own entryOf.
func mapEntries[T any](rows []T, render func(T) entry) []entry {
	out := make([]entry, 0, len(rows))
	for _, r := range rows {
		out = append(out, render(r))
	}
	return out
}

func idsOfTechniques(ts []technique.Technique) []string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.ID)
	}
	return out
}

func idsOfExercises(es []exercise.Exercise) []string {
	out := make([]string, 0, len(es))
	for _, e := range es {
		out = append(out, e.ID)
	}
	return out
}

// catalog is one library's worth of an export: the two files it lives in, the
// rows to fold in, and which keys the FILE owns rather than the database.
//
// Both catalogs go through the same code because the invariant is the same and
// it is the invariant that is easy to get wrong — content in only one of the two
// files is lost, by the deploy not carrying it or by the next re-import deleting
// it. One implementation means one place for that to be right.
type catalog struct {
	what     string // "techniques" | "exercises", for the log line
	seedPath string
	entries  []entry
	ids      []string
	// preserve names keys whose existing value in the FILE wins over the
	// exported one. See mergeInto.
	preserve []string
	// adopt hands this catalog's rows to the deploy. A field rather than a
	// switch on `what`: the switch had no default, so a catalog whose name
	// matched neither case logged a successful adoption having adopted nothing,
	// and swapping the two repositories survived the entire suite.
	adopt func(context.Context, []string) error
	// validate checks every row would actually seed, and runs INSIDE run()
	// before anything is written.
	//
	// Per-catalog because each library has its own validator, and inside run()
	// rather than in main() because main() has no test — that is precisely how
	// the two-file invariant shipped broken here once, invisible to its own
	// suite. A nil validate is a programming error, not "no rules".
	validate func() error
}

// run merges the authored rows into the catalog's seed file and writes it.
//
// A write failure is bounded: main() exits before -adopt, the database still
// holds the only authoritative copy, and re-running re-derives the file from
// it.
func run(c catalog, logger *slog.Logger) ([]string, error) {
	// Before any write: the file is what go:embed bakes into the binary, so an
	// entry that cannot seed takes the next deploy down, far from the operator
	// who could still fix it.
	if c.validate == nil {
		return nil, fmt.Errorf("%s: no validator — refusing to write unchecked content", c.what)
	}
	if err := c.validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", c.what, err)
	}

	// Merge before write, still: a parse error must not leave a half-written
	// file behind. One file makes that trivial where it used to need staging.
	merged, added, upd, unchanged, err := mergeInto(c.seedPath, c.entries, c.preserve...)
	if err != nil {
		return nil, err
	}
	if err := writeJSON(c.seedPath, merged); err != nil {
		return nil, err
	}
	logger.Info("export: wrote", "catalog", c.what, "path", c.seedPath,
		"added", added, "updated", upd, "total", len(merged))

	// Read back rather than trust the write: one guard for a half write and a
	// silent dedupe at once.
	//
	// Deliberately redundant. Removing the CALL leaves the suite green, because
	// every state it catches has its own test and the write above is correct —
	// it earns its place at runtime, on a filesystem that lied, not in the test
	// matrix. verifyContains itself is tested.
	if err := verifyContains(c.seedPath, c.ids); err != nil {
		return nil, err
	}
	return unchanged, nil
}

// entriesEqual compares two entries by their serialized form, key order
// included — the same bytes writeJSON would produce, so "equal" means the file
// would not change.
func entriesEqual(a, b entry) bool {
	x, errA := a.MarshalJSON()
	y, errB := b.MarshalJSON()
	if errA != nil || errB != nil {
		// Unmarshalable here means unwritable later; treat it as "changed" so
		// the row is not adopted on the strength of a comparison that failed.
		return false
	}
	return bytes.Equal(x, y)
}

// verifyContains re-reads a written file and confirms it carries every id the
// export just put in it.
func verifyContains(path string, ids []string) error {
	have, err := idsIn(path)
	if err != nil {
		return fmt.Errorf("verify: %w", err)
	}
	for _, id := range ids {
		if !have[id] {
			return fmt.Errorf("%q is missing from %s after writing it", id, filepath.Base(path))
		}
	}
	return nil
}

// adoptable narrows the authored rows to those the seed file already carried
// with exactly this content before this run.
//
// Content, not id. A row this export just ADDED is not committed, let alone
// deployed, so adopting it hands content to a release that cannot reseed it.
// A row this export just CHANGED is the same problem wearing a familiar id:
// the file had it, but with the old text, so the deploy would re-seed that old
// text straight over the edit. Both mean "the deploy does not carry this yet",
// and byte-equality is the one test that catches both.
//
// Without it, `-adopt` intended for last week's batch also adopts the row
// edited an hour ago and written to the file seconds earlier.
func adoptable(alreadyDeployed, ids []string) []string {
	deployed := make(map[string]bool, len(alreadyDeployed))
	for _, id := range alreadyDeployed {
		deployed[id] = true
	}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if deployed[id] {
			out = append(out, id)
		}
	}
	return out
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
// MERGE, not replace. The file holds content this command never wrote — 542
// techniques and 504 exercises, hand-authored in the repo — so overwriting it
// would destroy content that has no other copy.
//
// Entries are matched by id and replaced; everything else is kept BYTE FOR
// BYTE, key order included. That is what makes the diff reviewable: without it
// the first export reorders every key of all 542 entries (Go marshals a map
// with its keys sorted, the files are written in semantic order) and buries the
// one real change in a whole-file rewrite. Nobody reads that diff, and the
// review step is the only thing standing between a typo and a permanent
// foreign key in athletes' training records.
func mergeInto(path string, authored []entry, preserve ...string) (
	merged []entry, added, updated int, unchanged []string, err error,
) {
	existing, err := readEntries(path)
	if err != nil {
		return nil, 0, 0, nil, err
	}

	byID := make(map[string]entry, len(existing)+len(authored))
	order := make([]string, 0, len(existing)+len(authored))
	for _, e := range existing {
		id := e.id()
		if id == "" {
			return nil, 0, 0, nil, fmt.Errorf("%s holds an entry with no id", path)
		}
		if _, dup := byID[id]; dup {
			// Keeping the last occurrence would DELETE the other on the next
			// write — the "content with no other copy" loss this command exists
			// to prevent, committed by the command. The shipped catalog cannot
			// reach this state — validate() rejects duplicate ids long before a
			// write — but this reads whatever is actually on disk.
			return nil, 0, 0, nil, fmt.Errorf("%s holds two entries with id %q", path, id)
		}
		order = append(order, id)
		byID[id] = e
	}
	// Existing entries keep the file's own order. The catalog is NOT in id order
	// — it is in the order the spreadsheet that seeded it used, with everything
	// authored since appended — so re-sorting would be the whole-file rewrite
	// this function exists to avoid. An earlier version sorted "if the file is
	// already sorted", which was dead code that read as a live rule.
	//
	// New ids are appended, sorted among themselves, so the output does not
	// depend on the order the database happened to return them in.
	var fresh []string
	for _, e := range authored {
		id := e.id()
		if prev, exists := byID[id]; exists {
			updated++
			// Some keys are the FILE's, not the database's. `media` is the one
			// that matters: the write path cannot author it and the export does
			// not read it, so re-exporting an exercise a deploy later gave media
			// to would otherwise reset it to `[]` — deleting the only record of
			// an asset that is still sitting in the bucket.
			e = carryOver(prev, e, preserve)
			// The file ALREADY held exactly this content. That, and only that,
			// means the deploy carries it — which is the question -adopt has to
			// answer. See adoptable.
			if entriesEqual(prev, e) {
				unchanged = append(unchanged, id)
			}
		} else {
			added++
			fresh = append(fresh, id)
		}
		byID[id] = e
	}
	sort.Strings(fresh)
	order = append(order, fresh...)

	merged = make([]entry, 0, len(order))
	for _, id := range order {
		merged = append(merged, byID[id])
	}
	sort.Strings(unchanged)
	return merged, added, updated, unchanged, nil
}

// carryOver copies the named keys from the existing entry onto the new one,
// when the existing entry has them. See mergeInto for why.
func carryOver(prev, next entry, keys []string) entry {
	for _, k := range keys {
		var kept json.RawMessage
		for _, p := range prev {
			if p.Key == k {
				kept = p.Val
			}
		}
		if kept == nil {
			continue
		}
		for i := range next {
			if next[i].Key == k {
				next[i].Val = kept
			}
		}
	}
	return next
}

// The key order both files are written in. Not alphabetical — it is the order
// the Python importer emits, and matching it is what keeps an exported entry
// visually consistent with its 633 neighbours.
//
// The two interior slots are load-bearing and were wrong in the first version,
// which appended both to the end. Measured against the shipped file: 538 of 542
// entries put `function` between `category` and `position`, and 170 put
// `to_position` between `position_detail` and `gi_no_gi`. That is not a style
// preference — `apply_taxonomy` inserts `function` after `category` and
// `carry_to_position` rebuilds each record to place `to_position` after
// `position_detail` (scripts/import-exercise-catalog.py), so appending them
// instead means the next spreadsheet re-import silently relocates both keys on
// every entry this command wrote, producing exactly the whole-file diff this
// design exists to prevent.
//
// `function` and `to_position` are also the only OPTIONAL keys, matching the
// data: to_position is absent on 372 of 542 entries, and absent means "not
// recorded", which migration 000029 is explicit is a different fact from any
// value.
//
// Everything else is ALWAYS written, empty string and empty list included. This
// is not cosmetic: aliases, setup_from, common_counters and common_next_moves
// are `TEXT[] NOT NULL` columns, an omitted key unmarshals to a nil slice, and
// pgx encodes a nil slice as NULL. Seeding one is a not-null violation inside
// UpsertAll's transaction, so a single exported technique with no aliases takes
// the ENTIRE seed down — every technique, not just its own row.
var techniqueKeyOrder = []string{
	"id", "name", "aliases", "category", "function", "position",
	"position_detail", "to_position", "gi_no_gi", "typical_belt", "description",
	"when_to_use", "setup_from", "common_next_moves", "common_counters",
	"video_reference", "source_notes", "ibjjf_ruleset_id",
}

// entryOf renders a technique in the catalog files' shape.
func techniqueEntryOf(t technique.Technique) entry {
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
	for _, k := range techniqueKeyOrder {
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

// exerciseKeyOrder is the order exercises.json is written in — the order the
// importer emits, so an exported entry reads like its 503 neighbours.
//
// Every key is ALWAYS written, matching the file: all 504 entries carry all 12,
// including `"instructions": ""` on 443 of them and `"media": []` on 500. There
// is no key here where absent means something different from empty, which is
// what makes this simpler than the technique order.
//
// `note` is written the same unconditional way, and is the same kind of key:
// empty on nearly every row, and meaning exactly what an absent one would. It
// is deliberately NOT in exercisePreserve — unlike `media`, the console CAN
// author it and AdminAuthored DOES read it, so the database owns it and
// carrying it into the file is the whole point. See migration 000061.
var exerciseKeyOrder = []string{
	"id", "name", "sport", "movement_pattern", "movement_pattern_detail",
	"primary_muscles", "secondary_muscles", "equipment", "load_type",
	"is_unilateral", "load_mode", "implements", "instructions", "note", "media",
}

// exercisePreserve names the keys the FILE owns rather than the database.
//
// Declared here rather than inline in main() because it is load-bearing and
// main() has no test: deleting it leaves the whole suite green, and the
// consequence is a real DELETE. `upsertMedia`'s prune is NOT scoped to
// `source = 'seed'` the way the exercise upsert above it is, so re-seeding an
// entry whose JSON says `"media": []` removes that exercise's `exercise_media`
// rows even when the row itself is admin-owned and correctly skipped. Verified
// against Postgres: 1 media row before, 0 after.
//
// So carryOver is the only thing between a re-export and losing the record of
// an asset still sitting in the bucket. It is referenced by both main() and the
// test for exactly the reason `validate` is a field on the catalog.
var exercisePreserve = []string{"media"}

// exerciseEntryOf renders an exercise in exercises.json's shape.
//
// `media` is written as `[]` and then, on a re-export, replaced by whatever the
// file already had — see `preserve` in main and carryOver in mergeInto. The
// write path cannot author media and AdminAuthored does not read it, so this is
// the only honest value to emit for a new entry and the only safe rule for an
// existing one.
func exerciseEntryOf(e exercise.Exercise) entry {
	values := map[string]any{
		"id":                      e.ID,
		"name":                    e.Name,
		"sport":                   e.Sport,
		"movement_pattern":        e.MovementPattern,
		"movement_pattern_detail": e.MovementPatternDetail,
		"primary_muscles":         orEmpty(e.PrimaryMuscles),
		"secondary_muscles":       orEmpty(e.SecondaryMuscles),
		"equipment":               orEmpty(e.Equipment),
		"load_type":               string(e.LoadType),
		"is_unilateral":           e.IsUnilateral,
		"load_mode":               e.LoadMode,
		"implements":              e.Implements,
		"instructions":            e.Instructions,
		"note":                    e.Note,
		"media":                   []any{},
	}
	var out entry
	for _, k := range exerciseKeyOrder {
		v, ok := values[k]
		if !ok {
			// A key added to exerciseKeyOrder with no matching value would
			// otherwise emit `null` — and for the three TEXT[] NOT NULL columns
			// that is the "one entry takes the whole seed transaction down"
			// failure this file warns about elsewhere.
			panic(fmt.Sprintf("exportcontent: exerciseKeyOrder has %q with no value", k))
		}
		raw, err := rawJSON(v)
		if err != nil {
			// Only reachable if a string, bool or []string fails to marshal,
			// which encoding/json does not do.
			panic(fmt.Sprintf("exportcontent: marshal %q: %v", k, err))
		}
		out = append(out, pair{Key: k, Val: raw})
	}
	return out
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
// file is an empty list, not an error — a catalog can be exported before its
// seed file exists.
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
