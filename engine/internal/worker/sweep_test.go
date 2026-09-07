package worker

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func assertDatabaseExists(t *testing.T, adminURL, name string, want bool) {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var n int
	if err := conn.QueryRow(context.Background(),
		`SELECT count(*) FROM pg_database WHERE datname = $1`, name).Scan(&n); err != nil {
		t.Fatal(err)
	}
	got := n > 0
	if got != want {
		t.Fatalf("database %q exists = %v, want %v", name, got, want)
	}
}

func assertRoleExists(t *testing.T, adminURL, name string, want bool) {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var n int
	if err := conn.QueryRow(context.Background(),
		`SELECT count(*) FROM pg_roles WHERE rolname = $1`, name).Scan(&n); err != nil {
		t.Fatal(err)
	}
	got := n > 0
	if got != want {
		t.Fatalf("role %q exists = %v, want %v", name, got, want)
	}
}

// TestParseEphemeralNameRoundTripsAndRejectsNearMisses is the pure-logic
// half — no database needed — of the guard the live tests below depend on:
// Sweep must recognize exactly what Provision names, and nothing that only
// looks similar (a human's vola_test_<branch>, in particular, since that is
// the one name this whole mechanism must never touch — see CLAUDE.md's own
// per-branch-database convention).
func TestParseEphemeralNameRoundTripsAndRejectsNearMisses(t *testing.T) {
	created := time.Unix(1_700_000_000, 0).UTC()
	name := ephemeralResourceName("engine_run", 42, created, "ab12cd34")
	kind, id, ok := parseEphemeralName(name)
	if !ok {
		t.Fatalf("parseEphemeralName rejected its own output %q", name)
	}
	if kind != "engine_run" || id.runID != 42 || !id.createdAt.Equal(created) || id.suffix != "ab12cd34" {
		t.Fatalf("parseEphemeralName(%q) = %q, %+v, want engine_run, {42 %v ab12cd34}", name, kind, id, created)
	}
	if id.dbName() != name {
		t.Fatalf("dbName() = %q, want %q", id.dbName(), name)
	}
	wantRole := ephemeralResourceName("engine_role", 42, created, "ab12cd34")
	if id.roleName() != wantRole {
		t.Fatalf("roleName() = %q, want %q", id.roleName(), wantRole)
	}

	for _, near := range []string{
		"vola_test",
		"vola_test_n150",
		"engine_run_42_ab12cd34",       // missing the epoch segment entirely
		"engine_run_notanumber_1_ab12", // runID not numeric
		"engine_run_42_1_NOTHEX",       // suffix not hex
		"engine_runner_42_1_ab12",      // prefix near-miss
		"",
	} {
		if _, _, ok := parseEphemeralName(near); ok {
			t.Fatalf("parseEphemeralName(%q) matched — must only match its own exact convention", near)
		}
	}
}

// TestSweepRemovesResourcesCreatedAtOrBeforeCutoffAndLeavesLaterOnesAlone is
// the TTL boundary itself, made deterministic with Runner.Now rather than by
// waiting real wall-clock time for something to go stale: one workspace is
// stamped as if created two hours ago (Provision's own creation-time
// segment, not a separate side record — see sweep.go), a second is stamped
// with the real clock, and a single cutoff an hour back must catch exactly
// the first.
func TestSweepRemovesResourcesCreatedAtOrBeforeCutoffAndLeavesLaterOnesAlone(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	src, first, _ := makeSourceRepo(t)

	twoHoursAgo := time.Now().Add(-2 * time.Hour)
	rOld := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin,
		Now: func() time.Time { return twoHoursAgo }}
	old, err := rOld.Provision(ctx, 9101, 1, "stale", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	// Belt-and-braces only, per this package's established pattern: if the
	// sweep assertions below fail before removing it, this must not leave a
	// real database on the shared TEST_DATABASE_URL server. The `dropped`
	// latch (set by a successful Teardown) makes this a safe no-op once
	// Sweep has already removed it.
	t.Cleanup(func() { old.Teardown(context.Background()) })

	rFresh := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin}
	fresh, err := rFresh.Provision(ctx, 9102, 1, "fresh", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { fresh.Teardown(context.Background()) })

	assertDatabaseExists(t, admin, old.DBName, true)
	assertDatabaseExists(t, admin, fresh.DBName, true)

	// A cutoff before EITHER workspace's stamped creation time must remove
	// neither — proof the boundary is real, not "sweep drops everything on
	// the server that matches the prefix".
	res, err := Sweep(ctx, admin, twoHoursAgo.Add(-time.Minute), false)
	if err != nil {
		t.Fatal(err)
	}
	if contains(res.DroppedDatabases, old.DBName) || contains(res.DroppedDatabases, fresh.DBName) {
		t.Fatalf("sweep with a too-early cutoff removed a resource that is not stale yet: %+v", res)
	}
	assertDatabaseExists(t, admin, old.DBName, true)
	assertDatabaseExists(t, admin, fresh.DBName, true)

	// A cutoff an hour back — after `old`'s stamped time, before `fresh`'s
	// real one — is this test's actual claim: exactly the crashed worker's
	// leaked database and role are removed, and the still-legitimate one is
	// untouched.
	cutoff := time.Now().Add(-time.Hour)
	res, err = Sweep(ctx, admin, cutoff, false)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(res.DroppedDatabases, old.DBName) {
		t.Fatalf("sweep did not remove the stale database %s: %+v", old.DBName, res)
	}
	if !contains(res.DroppedRoles, old.DBRole) {
		t.Fatalf("sweep did not remove the stale role %s: %+v", old.DBRole, res)
	}
	if contains(res.DroppedDatabases, fresh.DBName) || contains(res.DroppedRoles, fresh.DBRole) {
		t.Fatalf("sweep removed the FRESH workspace's resources too: %+v", res)
	}
	if len(res.Errors) > 0 {
		t.Fatalf("sweep reported errors: %v", res.Errors)
	}

	assertDatabaseExists(t, admin, old.DBName, false)
	assertRoleExists(t, admin, old.DBRole, false)
	assertDatabaseExists(t, admin, fresh.DBName, true)
	assertRoleExists(t, admin, fresh.DBRole, true)
	old.dropped = true // Sweep already dropped the database; avoid a second best-effort DROP racing the (harmless, idempotent) cleanup below
}

// TestSweepIsTheRealCrashRecoveryPath is steps-to-test #2 itself: provision
// a workspace and then simulate the worker process being killed — which, in
// this codebase, means exactly one thing: Teardown is never called, because
// nothing can trap SIGKILL to run cleanup on the way out. Nothing but Sweep
// will ever reclaim what is left.
func TestSweepIsTheRealCrashRecoveryPath(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	src, first, _ := makeSourceRepo(t)

	killedAt := time.Now().Add(-3 * time.Hour)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin,
		Now: func() time.Time { return killedAt }}
	ws, err := r.Provision(ctx, 9103, 1, "killed", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately no defer/t.Cleanup(ws.Teardown) here — that is the whole
	// point of this test. A leaked real database on the shared
	// TEST_DATABASE_URL server would be exactly the residue this feature
	// exists to prevent, so clean up ANY survivor directly rather than via
	// the mechanism under test.
	t.Cleanup(func() {
		conn, err := pgx.Connect(context.Background(), admin)
		if err != nil {
			return
		}
		defer conn.Close(context.Background())
		conn.Exec(context.Background(), fmt.Sprintf(`DROP DATABASE IF EXISTS %q WITH (FORCE)`, ws.DBName))
		conn.Exec(context.Background(),
			`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, ws.DBRole)
		conn.Exec(context.Background(), fmt.Sprintf(`DROP ROLE IF EXISTS %q`, ws.DBRole))
		os.RemoveAll(ws.Dir)
	})

	assertDatabaseExists(t, admin, ws.DBName, true)
	assertRoleExists(t, admin, ws.DBRole, true)

	if _, err := Sweep(ctx, admin, time.Now().Add(-time.Hour), false); err != nil {
		t.Fatal(err)
	}

	assertDatabaseExists(t, admin, ws.DBName, false)
	assertRoleExists(t, admin, ws.DBRole, false)
}

// TestSweepRemovesAnOrphanRoleWithNoMatchingDatabase covers the OTHER
// partial-failure shape: CREATE ROLE succeeded but the process died before
// CREATE DATABASE ever ran (or after the database was independently
// removed). Provision's own dropRole already guards the same-process
// version of this; this is Sweep's cross-process equivalent.
func TestSweepRemovesAnOrphanRoleWithNoMatchingDatabase(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	old := time.Now().Add(-2 * time.Hour)
	suffix, err := randomHex(4)
	if err != nil {
		t.Fatal(err)
	}
	role := ephemeralResourceName("engine_role", 9104, old, suffix)
	if _, err := conn.Exec(ctx, fmt.Sprintf(`CREATE ROLE %q LOGIN PASSWORD 'x'`, role)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		conn.Exec(context.Background(), fmt.Sprintf(`DROP ROLE IF EXISTS %q`, role))
	})

	res, err := Sweep(ctx, admin, time.Now().Add(-time.Hour), false)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(res.DroppedRoles, role) {
		t.Fatalf("sweep did not remove the orphan role %s: %+v", role, res)
	}
	assertRoleExists(t, admin, role, false)
}

// TestSweepDryRunReportsWithoutRemoving is the CLI's --dry-run contract:
// candidates are named, nothing is actually dropped.
func TestSweepDryRunReportsWithoutRemoving(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	src, first, _ := makeSourceRepo(t)

	old := time.Now().Add(-2 * time.Hour)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin,
		Now: func() time.Time { return old }}
	ws, err := r.Provision(ctx, 9105, 1, "dryrun", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.Teardown(context.Background()) })

	res, err := Sweep(ctx, admin, time.Now().Add(-time.Hour), true)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(res.DroppedDatabases, ws.DBName) || !contains(res.DroppedRoles, ws.DBRole) {
		t.Fatalf("dry run did not report the stale resources: %+v", res)
	}
	assertDatabaseExists(t, admin, ws.DBName, true)
	assertRoleExists(t, admin, ws.DBRole, true)
}

// TestSweepNeverTouchesAnythingOutsideItsOwnNamingConvention is the safety
// property this whole mechanism depends on, checked live rather than only
// argued in a comment: on the SHARED local Postgres this project's own
// worktree convention has every concurrent session connect to, vola_test
// and every human's vola_test_<branch> sit on the exact same server Sweep
// queries. A wide-open cutoff (24h in the future — everything real is
// "before" it) in DRY RUN ONLY must never name vola_test as a candidate.
func TestSweepNeverTouchesAnythingOutsideItsOwnNamingConvention(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	res, err := Sweep(context.Background(), admin, time.Now().Add(24*time.Hour), true)
	if err != nil {
		t.Fatal(err)
	}
	if contains(res.DroppedDatabases, "vola_test") {
		t.Fatal("sweep considered dropping vola_test — it must be structurally invisible to the naming-convention filter, not merely excluded by policy")
	}
	for _, db := range res.DroppedDatabases {
		if kind, _, ok := parseEphemeralName(db); !ok || kind != "engine_run" {
			t.Fatalf("sweep listed %q as a candidate, which does not match its own naming convention", db)
		}
	}
}
