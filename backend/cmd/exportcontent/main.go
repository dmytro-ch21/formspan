// Command exportcontent carries admin-authored catalog rows back into the seed
// JSON, so content created in a running environment can be reviewed, committed
// and promoted through the normal deploy.
//
// This is the half that makes admin authoring more than a local convenience.
// Without it, a technique added in staging exists only in staging's database:
// production never learns about it, and nothing reviews an id that becomes a
// permanent foreign key in athletes' training records.
//
// # WHICH FILE, AND WHY IT MATTERS
//
// It writes `techniques.additions.json`, NOT `techniques.json`. The latter is
// GENERATED — `scripts/import-exercise-catalog.py` builds it from a spreadsheet
// and merges the additions file in — so anything written there is destroyed by
// the next import. The additions file exists precisely for content authored by
// hand rather than by the sheet, which is exactly what this is.
//
// USAGE
//
//	go run ./cmd/exportcontent                # write the file, touch nothing else
//	go run ./cmd/exportcontent -adopt         # ...and hand the rows to the deploy
//
// The two steps are separate on purpose. Until the JSON is committed AND
// deployed, the database row is the only copy, so `-adopt` before that would
// leave content owned by a deploy that does not carry it yet. The intended
// order is: export, review the diff, merge, deploy, then adopt.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

func main() {
	logger := httplog.New()

	var (
		out   = flag.String("out", "internal/modules/technique/techniques.additions.json", "additions file to write")
		adopt = flag.Bool("adopt", false, "after writing, mark the exported rows source='seed' — only once the JSON is deployed")
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
		logger.Info("export: nothing authored in the console; file untouched", "out", *out)
		return
	}

	// The additions file is MERGED INTO the generated techniques.json by
	// `scripts/import-exercise-catalog.py`, which exits on "additions collide
	// with sheet ids". So an id present in both files breaks the importer —
	// far from here, and long after the export looked like it worked.
	//
	// A hard error rather than a skip: skipping would silently drop content
	// that has no other copy, which is the failure this whole command exists
	// to prevent.
	if err := refuseCollisions(authored); err != nil {
		logger.Error("export: refused", "err", err)
		os.Exit(1)
	}

	merged, added, updated, err := mergeInto(*out, authored)
	if err != nil {
		logger.Error("export: merge", "err", err)
		os.Exit(1)
	}
	if err := writeJSON(*out, merged); err != nil {
		logger.Error("export: write", "err", err)
		os.Exit(1)
	}
	logger.Info("export: wrote additions", "out", *out,
		"added", added, "updated", updated, "total", len(merged))

	if !*adopt {
		logger.Info("export: rows are still source='admin' — re-run with -adopt " +
			"once this file is committed and deployed, or the deploy will not own them")
		return
	}
	ids := make([]string, 0, len(authored))
	for _, t := range authored {
		ids = append(ids, t.ID)
	}
	if err := repo.AdoptAsSeeded(ctx, ids); err != nil {
		logger.Error("export: adopt", "err", err)
		os.Exit(1)
	}
	logger.Info("export: adopted; the deploy now owns these rows", "count", len(ids))
}

// refuseCollisions rejects any authored id the GENERATED catalog already
// holds.
//
// Unreachable through the API today — the write path 409s on a duplicate id,
// seeded or not — so this guards the case where a row was made `admin` by hand
// or by a future import that adopts an id already in use.
func refuseCollisions(authored []technique.Technique) error {
	generated, err := technique.SeedData()
	if err != nil {
		return fmt.Errorf("read the generated catalog: %w", err)
	}
	inSheet := make(map[string]bool, len(generated))
	for _, t := range generated {
		inSheet[t.ID] = true
	}
	var clashes []string
	for _, t := range authored {
		if inSheet[t.ID] {
			clashes = append(clashes, t.ID)
		}
	}
	if len(clashes) > 0 {
		sort.Strings(clashes)
		return fmt.Errorf(
			"these ids are already in the generated techniques.json, so exporting them "+
				"would break the importer (\"additions collide with sheet ids\"): %v — "+
				"they are marked source='admin' but the sheet owns them; fix the source "+
				"column or rename the technique", clashes)
	}
	return nil
}

// mergeInto folds the exported techniques into the existing additions file.
//
// MERGE, not replace. The additions file is also hand-edited — it predates this
// command by months and holds 16 entries the console never wrote — so
// overwriting it would silently delete authored content that has no other copy.
// Existing entries are matched by id and replaced; everything else is kept.
//
// The result is sorted by id so a re-export with no changes produces a
// byte-identical file. That reproducibility is a property this repo has paid
// for before: without it every export is a noisy diff and nobody reads them.
func mergeInto(path string, authored []technique.Technique) (
	merged []map[string]any, added, updated int, err error,
) {
	existing := []map[string]any{}
	raw, readErr := os.ReadFile(path)
	switch {
	case readErr == nil:
		if err := json.Unmarshal(raw, &existing); err != nil {
			return nil, 0, 0, fmt.Errorf("parse %s: %w", path, err)
		}
	case !os.IsNotExist(readErr):
		return nil, 0, 0, fmt.Errorf("read %s: %w", path, readErr)
	}

	byID := make(map[string]map[string]any, len(existing)+len(authored))
	order := make([]string, 0, len(existing)+len(authored))
	for _, e := range existing {
		id, _ := e["id"].(string)
		if id == "" {
			return nil, 0, 0, fmt.Errorf("%s holds an entry with no id", path)
		}
		if _, dup := byID[id]; !dup {
			order = append(order, id)
		}
		byID[id] = e
	}
	for _, t := range authored {
		if _, exists := byID[t.ID]; exists {
			updated++
		} else {
			added++
			order = append(order, t.ID)
		}
		byID[t.ID] = entryOf(t)
	}

	sort.Strings(order)
	merged = make([]map[string]any, 0, len(order))
	for _, id := range order {
		merged = append(merged, byID[id])
	}
	return merged, added, updated, nil
}

// entryOf renders a technique in the additions file's shape.
//
// Empty strings and empty lists are OMITTED, matching how the hand-authored
// entries are written — carrying `"to_position": ""` would be a lie, because
// migration 000029 is explicit that absent means "not recorded" and is a
// different fact from any value.
func entryOf(t technique.Technique) map[string]any {
	e := map[string]any{"id": t.ID, "name": t.Name}
	str := func(k, v string) {
		if v != "" {
			e[k] = v
		}
	}
	list := func(k string, v []string) {
		if len(v) > 0 {
			e[k] = v
		}
	}
	list("aliases", t.Aliases)
	str("category", t.Category)
	str("position", t.Position)
	str("position_detail", t.PositionDetail)
	str("gi_no_gi", t.GiNoGi)
	str("typical_belt", t.TypicalBelt)
	str("description", t.Description)
	str("when_to_use", t.WhenToUse)
	list("setup_from", t.SetupFrom)
	list("common_next_moves", t.CommonNextMoves)
	list("common_counters", t.CommonCounters)
	str("video_reference", t.VideoReference)
	str("source_notes", t.SourceNotes)
	str("ibjjf_ruleset_id", t.IBJJFRulesetID)
	str("function", t.Function)
	str("to_position", t.ToPosition)
	return e
}

// writeJSON matches the file's existing formatting: two-space indent, a
// trailing newline, and NO HTML escaping — Go's encoder turns `&` into
// `&` by default, which would rewrite unrelated entries on the first
// export and bury the real change in the diff.
func writeJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	var buf []byte
	{
		f, err := os.CreateTemp(filepath.Dir(path), ".export-*.json")
		if err != nil {
			return err
		}
		defer os.Remove(f.Name())
		enc := json.NewEncoder(f)
		enc.SetIndent("", "  ")
		enc.SetEscapeHTML(false)
		if err := enc.Encode(v); err != nil {
			f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		buf, err = os.ReadFile(f.Name())
		if err != nil {
			return err
		}
	}
	return os.WriteFile(path, buf, 0o644)
}
