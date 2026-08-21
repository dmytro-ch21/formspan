package migrateguard

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func migrationsFixture(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, n := range names {
		write(t, filepath.Join(dir, n), "SELECT 1;\n")
	}
	return dir
}

func TestReadMigrations(t *testing.T) {
	dir := migrationsFixture(t,
		"000070_profile_activity_level.up.sql",
		"000070_profile_activity_level.down.sql",
		"000002_second.up.sql",
		"000002_second.down.sql",
		"README.md",
		"notanumber_thing.up.sql",
	)
	if err := os.Mkdir(filepath.Join(dir, "000099_a_directory.up.sql"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := ReadMigrations(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d migrations, want 2: %+v", len(got), got)
	}
	// Sorted by version, not by filename, and .down.sql is not a migration.
	if got[0].Version != 2 || got[1].Version != 70 {
		t.Fatalf("versions = %d, %d; want 2, 70", got[0].Version, got[1].Version)
	}
	if got[1].Name != "000070_profile_activity_level" {
		t.Errorf("Name = %q", got[1].Name)
	}
	if got[1].File != "000070_profile_activity_level.up.sql" {
		t.Errorf("File = %q", got[1].File)
	}
}

func TestPending(t *testing.T) {
	migs := []Migration{{Version: 1}, {Version: 2}, {Version: 3}}

	if got := Pending(migs, State{}); len(got) != 3 {
		t.Errorf("never-migrated database: got %d pending, want 3", len(got))
	}
	// Strictly above, which is the whole trap: version 2 is NOT re-applied.
	if got := Pending(migs, State{Applied: true, Version: 2}); len(got) != 1 || got[0].Version != 3 {
		t.Errorf("got %+v, want only version 3", got)
	}
	if got := Pending(migs, State{Applied: true, Version: 3}); len(got) != 0 {
		t.Errorf("got %+v, want nothing pending", got)
	}
}

// The state staging was left in by #461.
func TestCheckAgreement_DatabaseAheadOfCheckout(t *testing.T) {
	migs := []Migration{{Version: 69, Name: "000069_bjj_focus_provenance"}, {Version: 70, Name: "000070_profile_activity_level"}}
	state := State{Applied: true, Version: 71}

	got := CheckAgreement(state, migs, Provenance{})
	if len(got) != 1 {
		t.Fatalf("got %d disagreements, want 1: %+v", len(got), got)
	}
	text := got[0].Error()
	for _, want := range []string{"AHEAD", "71", "000070_profile_activity_level", "UNMERGED", "drop and recreate"} {
		if !strings.Contains(text, want) {
			t.Errorf("the message does not mention %q — it must name the situation AND the fix:\n%s", want, text)
		}
	}
}

func TestCheckAgreement_AtTheHighestVersionIsFine(t *testing.T) {
	migs := []Migration{{Version: 69}, {Version: 70, Name: "seventy"}}
	if got := CheckAgreement(State{Applied: true, Version: 70}, migs, Provenance{}); len(got) != 0 {
		t.Fatalf("a fully migrated database was flagged: %+v", got)
	}
}

// The quiet failure mode, and the one that costs days: a new migration
// numbered at or below the recorded version is never applied, and
// golang-migrate prints "done" and exits 0.
func TestCheckAgreement_MigrationWouldBeSilentlySkipped(t *testing.T) {
	migs := []Migration{
		{Version: 65, Name: "000065_branch_only", File: "000065_branch_only.up.sql"},
		{Version: 70, Name: "000070_profile_activity_level", File: "000070_profile_activity_level.up.sql"},
	}
	prov := Provenance{GitRan: true, NotOnMain: map[string]bool{"000065_branch_only.up.sql": true}}

	got := CheckAgreement(State{Applied: true, Version: 70}, migs, prov)
	if len(got) != 1 {
		t.Fatalf("got %d disagreements, want 1: %+v", len(got), got)
	}
	text := got[0].Error()
	for _, want := range []string{"SILENTLY SKIPPED", "000065_branch_only.up.sql", "exit 0", "renumber", "STRICTLY ABOVE"} {
		if !strings.Contains(text, want) {
			t.Errorf("the message does not mention %q:\n%s", want, text)
		}
	}
}

// The boundary, and it is the whole reason the comparison is <= rather than <:
// golang-migrate applies versions STRICTLY above the recorded one, so a file
// numbered EXACTLY at the recorded version is skipped too. Without this vector
// a < survives, which was measured: mutation M7 passed the suite.
func TestCheckAgreement_SkipCheckIncludesTheRecordedVersionItself(t *testing.T) {
	migs := []Migration{{Version: 70, Name: "000070_branch_only", File: "000070_branch_only.up.sql"}}
	prov := Provenance{GitRan: true, NotOnMain: map[string]bool{"000070_branch_only.up.sql": true}}

	got := CheckAgreement(State{Applied: true, Version: 70}, migs, prov)
	if len(got) != 1 {
		t.Fatalf("a migration numbered exactly at the recorded version was not flagged: %+v", got)
	}
	if !strings.Contains(got[0].Error(), "000070_branch_only.up.sql") {
		t.Errorf("message does not name the file:\n%s", got[0].Error())
	}
}

// Ordinary branch development: a new migration numbered above the recorded
// version will apply normally and must not be flagged. This is the case that
// would make the guard painful if it were wrong.
func TestCheckAgreement_NewMigrationAboveTheVersionIsOrdinaryWork(t *testing.T) {
	migs := []Migration{
		{Version: 70, File: "000070_profile_activity_level.up.sql"},
		{Version: 71, File: "000071_branch_only.up.sql"},
	}
	prov := Provenance{GitRan: true, NotOnMain: map[string]bool{"000071_branch_only.up.sql": true}}

	if got := CheckAgreement(State{Applied: true, Version: 70}, migs, prov); len(got) != 0 {
		t.Fatalf("ordinary branch work was flagged: %+v", got)
	}
}

// Without a comparison against origin/main there is no way to know a file is
// new, so the skip check must stay silent rather than guess.
func TestCheckAgreement_SkipCheckNeedsTheGitComparison(t *testing.T) {
	migs := []Migration{{Version: 65, File: "000065_branch_only.up.sql"}, {Version: 70, File: "x.up.sql"}}
	prov := Provenance{GitRan: false, NotOnMain: map[string]bool{"000065_branch_only.up.sql": true}}

	if got := CheckAgreement(State{Applied: true, Version: 70}, migs, prov); len(got) != 0 {
		t.Fatalf("the skip check fired without having compared anything: %+v", got)
	}
}

func TestCheckAgreement_DirtyDatabase(t *testing.T) {
	migs := []Migration{{Version: 70, Name: "seventy"}}
	got := CheckAgreement(State{Applied: true, Version: 70, Dirty: true}, migs, Provenance{})
	if len(got) != 1 {
		t.Fatalf("a dirty database was not flagged: %+v", got)
	}
	if !strings.Contains(got[0].Error(), "DIRTY") {
		t.Errorf("message does not say the database is dirty:\n%s", got[0].Error())
	}
}

func TestCheckAgreement_NeverMigratedDatabaseIsNeverFlagged(t *testing.T) {
	migs := []Migration{{Version: 70, File: "x.up.sql"}}
	prov := Provenance{GitRan: true, NotOnMain: map[string]bool{"x.up.sql": true}}
	if got := CheckAgreement(State{}, migs, prov); len(got) != 0 {
		t.Fatalf("a fresh database was flagged: %+v", got)
	}
}

func TestDirFromPath(t *testing.T) {
	if got, ok := DirFromPath("file:///app/migrations"); !ok || got != "/app/migrations" {
		t.Errorf("DirFromPath(file:///app/migrations) = %q, %v", got, ok)
	}
	if got, ok := DirFromPath("file://migrations"); !ok || !filepath.IsAbs(got) || filepath.Base(got) != "migrations" {
		t.Errorf("DirFromPath(file://migrations) = %q, %v", got, ok)
	}
	for _, bad := range []string{"", "migrations", "s3://bucket/migrations", "github://owner/repo"} {
		if _, ok := DirFromPath(bad); ok {
			t.Errorf("DirFromPath(%q) claimed to be inspectable", bad)
		}
	}
}

func TestFormatPending(t *testing.T) {
	if got := FormatPending(nil); got != "none" {
		t.Errorf("empty: got %q", got)
	}

	short := []Migration{{Name: "000069_a"}, {Name: "000070_b"}}
	if got := FormatPending(short); got != "000069_a, 000070_b" {
		t.Errorf("short list must be named in full: got %q", got)
	}

	// A fresh environment applies everything; a count and a range beat 68 names.
	var long []Migration
	for i := 1; i <= 68; i++ {
		long = append(long, Migration{Version: uint64(i), Name: fmt.Sprintf("%06d_m", i)})
	}
	got := FormatPending(long)
	if !strings.Contains(got, "68 migrations") || !strings.Contains(got, "000001_m") || !strings.Contains(got, "000068_m") {
		t.Errorf("long list must give a count and both ends: got %q", got)
	}
	if strings.Contains(got, "000034_m") {
		t.Errorf("long list should not name every migration: got %q", got)
	}
}
