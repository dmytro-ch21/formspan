package migrateguard

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Migration is one versioned "up" file on disk.
type Migration struct {
	Version uint64
	Name    string // 000070_profile_activity_level
	File    string // 000070_profile_activity_level.up.sql
}

// State is what the database says about itself. Read with a plain SELECT.
type State struct {
	// Applied is false when schema_migrations does not exist yet — a database
	// that has never been migrated.
	Applied bool
	Version uint64
	Dirty   bool
}

// ReadMigrations lists the up-migrations in dir, lowest version first.
func ReadMigrations(dir string) ([]Migration, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var migs []Migration
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".up.sql") {
			continue
		}
		stem := strings.TrimSuffix(name, ".up.sql")
		digits, _, ok := strings.Cut(stem, "_")
		if !ok {
			continue
		}
		v, err := strconv.ParseUint(digits, 10, 64)
		if err != nil {
			continue
		}
		migs = append(migs, Migration{Version: v, Name: stem, File: name})
	}
	sort.Slice(migs, func(i, j int) bool { return migs[i].Version < migs[j].Version })
	return migs, nil
}

// Pending returns the migrations `up` would actually apply: golang-migrate
// applies only versions STRICTLY above the recorded one.
func Pending(migs []Migration, state State) []Migration {
	var out []Migration
	for _, m := range migs {
		if !state.Applied || m.Version > state.Version {
			out = append(out, m)
		}
	}
	return out
}

// pendingListLimit is where naming every migration stops helping. A deploy
// applies one or two and wants them named; a fresh environment applies all of
// them and wants a count and a range.
const pendingListLimit = 10

// FormatPending renders the pending list for the preamble.
func FormatPending(pending []Migration) string {
	switch {
	case len(pending) == 0:
		return "none"
	case len(pending) <= pendingListLimit:
		names := make([]string, 0, len(pending))
		for _, m := range pending {
			names = append(names, m.Name)
		}
		return strings.Join(names, ", ")
	default:
		return fmt.Sprintf("%d migrations, %s … %s", len(pending), pending[0].Name, pending[len(pending)-1].Name)
	}
}

// Highest returns the largest version on disk, and false when there are none.
func Highest(migs []Migration) (Migration, bool) {
	if len(migs) == 0 {
		return Migration{}, false
	}
	return migs[len(migs)-1], true
}

// Disagreement is a way in which the database and this checkout contradict
// each other. Both kinds are fatal, and both name the fix.
type Disagreement struct {
	Headline string
	Detail   string
}

func (d Disagreement) Error() string { return d.Headline + "\n\n" + d.Detail }

// CheckAgreement compares the database against the migration files.
//
// It runs for EVERY target, local included. The silently-skipped case below is
// the one that costs days rather than minutes, and the place it actually bites
// is a per-branch local database.
func CheckAgreement(state State, migs []Migration, prov Provenance) []Disagreement {
	var out []Disagreement
	if !state.Applied {
		return nil
	}

	if state.Dirty {
		out = append(out, Disagreement{
			Headline: fmt.Sprintf("the database is marked DIRTY at version %d.", state.Version),
			Detail: "" +
				"A previous migration failed part-way and golang-migrate refuses to continue\n" +
				"until somebody says what the schema actually looks like.\n\n" +
				"Fix: inspect the schema, finish or undo version " + strconv.FormatUint(state.Version, 10) + " by hand in one\n" +
				"transaction, then `UPDATE schema_migrations SET dirty = false`.",
		})
	}

	if highest, ok := Highest(migs); ok && state.Version > highest.Version {
		out = append(out, Disagreement{
			Headline: fmt.Sprintf("the database is AHEAD of this checkout: it records version %d, and the highest migration here is %d (%s).", state.Version, highest.Version, highest.Name),
			Detail: "" +
				"Version " + strconv.FormatUint(state.Version, 10) + " does not exist here, so golang-migrate cannot read its down file and\n" +
				"`up` cannot run at all. This state is produced by applying an UNMERGED branch's\n" +
				"migration to a database: the branch's numbers went in, the branch never landed,\n" +
				"and those numbers are now unreachable for everyone else. Every migration on main\n" +
				"numbered at or below " + strconv.FormatUint(state.Version, 10) + " is also permanently skipped here.\n\n" +
				"Fix, in order of preference:\n" +
				"  - a scratch database you own: drop and recreate it, then migrate up.\n" +
				"  - a shared or deployed database: do NOT roll it back casually. Find the branch\n" +
				"    that applied it, roll back exactly that migration's .down.sql inside one\n" +
				"    transaction and set schema_migrations.version back. CLAUDE.md, \"To undo one\n" +
				"    migration\", has the recipe — `migrate down` is NOT it; it unwinds everything.",
		})
	}

	if prov.GitRan {
		var skipped []string
		for _, m := range migs {
			if m.Version <= state.Version && prov.NotOnMain[m.File] {
				skipped = append(skipped, fmt.Sprintf("%s (version %d)", m.File, m.Version))
			}
		}
		if len(skipped) > 0 {
			out = append(out, Disagreement{
				Headline: fmt.Sprintf("%d migration(s) would be SILENTLY SKIPPED against this database (version %d).", len(skipped), state.Version),
				Detail: "" +
					"  " + strings.Join(skipped, "\n  ") + "\n\n" +
					"golang-migrate applies only versions strictly ABOVE the recorded one. It would\n" +
					"print \"done\", exit 0, and never run these files. The failure surfaces days later\n" +
					"and somewhere else, as `column \"...\" does not exist`, and reads as a code bug.\n\n" +
					"These files are not on origin/main, so they are new here and cannot already have\n" +
					"run. Fix: renumber them STRICTLY ABOVE the highest number on origin/main — never\n" +
					"fill a gap below it, since a gap is a number only a database that has not reached\n" +
					"it can ever apply — or drop and recreate this database if it is a scratch one.",
			})
		}
	}

	return out
}

// DirFromPath turns golang-migrate's source URL into a filesystem path.
// Returns false for any source this package cannot inspect.
func DirFromPath(migrationsPath string) (string, bool) {
	if !strings.HasPrefix(migrationsPath, "file://") {
		return "", false
	}
	p := strings.TrimPrefix(migrationsPath, "file://")
	if p == "" {
		return "", false
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return p, true
	}
	return abs, true
}
