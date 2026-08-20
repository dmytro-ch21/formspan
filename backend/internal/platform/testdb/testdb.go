// Package testdb holds the one piece of apparatus every Postgres-backed test
// package in this repo shares: the lock that makes a test binary the sole
// writer of its test database for as long as it runs.
//
// # Why this exists
//
// The Postgres tests here seed shared rows with FIXED ids — `wk_fx_bench_press`,
// `test-content-live`, the whole 762-row exercise catalog — and delete them
// again on the way out. Sequentially that is merely wasteful, which is why every
// package has always passed on its own. It stops working the moment a SECOND
// copy of a test binary runs against the same database, and that is the ordinary
// state of this repo rather than an exotic one: CLAUDE.md names `vola_test` as
// the default target and a dozen worktrees share it. The neighbour's cleanup
// then deletes the rows this process's in-flight test is using, and the test
// reports `unknown exercise "wk_fx_bench_press"` for a row it seeded itself
// milliseconds earlier — which reads as a bug in whatever PR happened to be
// running. That misattribution is what cost the time in #426, and #454 measured
// it in twelve more packages, `workout` failing 21 of 24 runs.
//
// # Why one key and not one per package
//
// #426 fixed `session` with a lock keyed to that package. That is enough for
// `session`, whose fixture ids are namespaced `ses_fx_*` and touched by nothing
// else, but it does not generalise, because the interference here is not only
// within a package:
//
//   - `exercise` seeds and then deletes the whole shipped catalog by the ids
//     `SeedData()` names; `workout`'s seeder tests insert 45 of those same real
//     ids. A per-package key lets those two run at once.
//   - `technique` asserts unscoped counts (`count(*) FROM techniques WHERE
//     to_position IS NOT NULL`), while `sequence`, `share`, `feed`, `curriculum`,
//     `contest`, `accomplishment` and `bjj` all insert technique rows. That is a
//     second, independent failure mechanism and no per-package key can see it.
//
// One key per DATABASE turns "which packages can safely overlap?" — a question
// whose answer changes every time someone adds a fixture — into "one test binary
// at a time", which needs no maintenance and covers both mechanisms. It is the
// same rule `-p 1` already applies inside one `go test` invocation, extended to
// the several invocations a multi-agent fleet runs at once.
//
// # What it costs
//
// Concurrent suites against ONE database serialise instead of interleaving, and
// that is a real cost rather than a free lunch. Measured 2026-08-20, four
// concurrent suites, 24 runs, `-count=1`:
//
//	                       before        after
//	failures               9 packages    none
//	24 runs, wall clock    386s          452s   (+17%)
//	per run, median        57s           72s
//	per run, spread        39–105s       63–93s
//
// +17% of throughput, for nine packages' worth of spurious red. It is cheaper
// than it sounds because the suite is not all database work — the pure-logic
// packages still overlap freely — and the *spread* narrows, which is worth as
// much as the median: before, a run's duration depended on who else was running.
//
// The cost is zero in every case that is not two agents sharing one database:
// CI runs one binary against a throwaway database, and a per-branch
// `vola_test_<branch>` has no contender. `createdb -U vola vola_test_<branch>`
// remains the right first move, exactly as CLAUDE.md says; this is the net for
// when nobody does it.
//
// # What it does NOT change
//
// Nothing about how a package seeds its own rows. Once a binary is the sole
// writer, per-test seed/delete churn is harmless again, so the twelve packages
// #454 covers keep their fixtures exactly where they were — no ids renamed, no
// `t.Cleanup` moved. (`session` keeps the per-process seeding #426 gave it,
// because that was a separate, worthwhile churn fix.)
package testdb

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// LockKey identifies "the shared test fixtures in this database". Arbitrary but
// fixed; it is the issue number.
const LockKey = 454

// LockScopeSQL is the lock's SECOND key: a hash of the database name.
//
// Advisory lock keys are CLUSTER-wide, not per-database. Without this, two
// binaries running against their own `vola_test_<branch>` databases on the one
// local Postgres would serialise on each other for no reason — and per-branch
// databases are exactly what CLAUDE.md tells you to use. Scoped, a branch with
// its own database never queues at all, and neither does CI, which gets a
// throwaway database per run.
//
// Exported because a test that PROBES the lock has to use the same scope; see
// AssertHeld.
const LockScopeSQL = `('x' || substr(md5(current_database()), 1, 8))::bit(32)::int`

// lockWait bounds the wait rather than blocking forever, so a genuinely wedged
// neighbour names its own cause instead of arriving as an unexplained hang.
//
// The number is NOT #426's 120s, and the difference is the whole point of #454.
// There the lock was per package and contested by at most the same package in
// another lane; here every Postgres package queues on one key, so the budget has
// to cover a queue, not a single holder. Two things set it:
//
//   - Depth. The lock is released when a package's binary exits, so a waiter is
//     behind at most one package per competing lane — not one whole suite.
//     Measured on this repo: the slowest package is single-digit seconds, so
//     twelve lanes queue for well under a minute.
//   - Amplification. A neighbour invoked with `-count=N` lives N times as long
//     and holds the lock for all of it. `-count=10` on the slowest package is
//     the realistic worst case, and #426 shipped a flake by not budgeting for
//     it: at 60s the WAITER failed 2 of 10 lane-runs, a new flake wearing the
//     old one's clothes.
//
// Five minutes clears both with room to spare. It can afford to be generous
// because the wait is FAIR (see Lock) — a waiter cannot be starved by luckier
// neighbours, so the budget only has to cover a queue that is actually moving,
// and a heartbeat makes a stalled one visible long before the deadline.
//
// A var rather than a const so this package's own test can shorten it and watch
// the deadline fire. Deliberately NOT an env var: a knob that lets somebody set
// this to a second would quietly reintroduce the flake it exists to prevent.
var lockWait = 5 * time.Minute

// heartbeat is how often a waiting binary says so. A silent wait is
// indistinguishable from a hung test binary, and the person watching has no
// reason to suspect a second copy of themselves.
const heartbeat = 30 * time.Second

// Conn is the subset of pgx's connection types this package needs. It is
// satisfied by *pgx.Conn, *pgxpool.Conn, *pgxpool.Pool and pgx.Tx, so a probe
// can be written against whatever a test already has.
type Conn interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// TryLock attempts the lock without waiting. Reports whether it was taken.
//
// The lock is session-level: it is held by the CONNECTION that took it and
// released when that connection closes, including when the binary dies, so a
// crashed run cannot wedge the next one. Never take it on a pooled connection
// you hand back.
func TryLock(ctx context.Context, conn Conn) (bool, error) {
	var got bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock($1::int, `+LockScopeSQL+`)`, LockKey).Scan(&got); err != nil {
		return false, fmt.Errorf("try the shared fixture lock: %w", err)
	}
	return got, nil
}

// Unlock releases it. Only meaningful on the connection that took it.
func Unlock(ctx context.Context, conn Conn) error {
	_, err := conn.Exec(ctx, `SELECT pg_advisory_unlock($1::int, `+LockScopeSQL+`)`, LockKey)
	return err
}

// Lock takes the shared fixture lock, waiting up to lockWait.
//
// It tries once without blocking — the overwhelmingly common case, including
// every CI run and every per-branch database — and only then announces itself
// and waits.
//
// The wait is Postgres's own, bounded by `lock_timeout`, rather than #426's
// poll-and-sleep. That is deliberate and it is what makes a single shared key
// safe: Postgres queues lock waiters, so twelve binaries queueing behind one
// holder are served in order. A 100ms poll re-races every waiter on every
// release, which is fine for the two contenders a per-package key can have and
// is not fine for twelve — the unlucky one can lose repeatedly, and the failure
// it eventually produces looks exactly like the bug this package exists to
// remove.
func Lock(ctx context.Context, conn *pgx.Conn) error {
	got, err := TryLock(ctx, conn)
	if err != nil {
		return err
	}
	if got {
		return nil
	}

	fmt.Fprintf(os.Stderr,
		"testdb: another test binary holds this database's fixture lock; waiting up to %s.\n"+
			"        (These tests seed rows with fixed ids and cannot share a database with a "+
			"second copy of themselves.)\n", lockWait)

	started := time.Now()
	done := make(chan struct{})
	defer close(done)
	go func() {
		t := time.NewTicker(heartbeat)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				fmt.Fprintf(os.Stderr, "testdb: still waiting for the fixture lock (%s elapsed)…\n",
					time.Since(started).Truncate(time.Second))
			}
		}
	}()

	// lock_timeout applies to advisory locks (verified against Postgres 16:
	// the wait ends at the budget with SQLSTATE 55P03, rather than blocking to
	// the test timeout).
	if _, err := conn.Exec(ctx, fmt.Sprintf(`SET lock_timeout = '%dms'`, lockWait.Milliseconds())); err != nil {
		return fmt.Errorf("set the fixture lock timeout: %w", err)
	}
	_, err = conn.Exec(ctx, `SELECT pg_advisory_lock($1::int, `+LockScopeSQL+`)`, LockKey)
	// Restore the default whatever happened: this connection outlives the
	// acquire and a lingering lock_timeout would silently cancel unrelated
	// statements a fixture hook runs on it.
	if _, resetErr := conn.Exec(ctx, `SET lock_timeout = 0`); resetErr != nil && err == nil {
		return fmt.Errorf("reset the fixture lock timeout: %w", resetErr)
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
			return fmt.Errorf(
				"another test binary has held this database's fixture lock for %s.\n"+
					"These tests seed rows with FIXED ids and assert unscoped counts, so they "+
					"cannot share a database with a second copy of themselves — whichever "+
					"finishes first deletes the other's rows mid-test.\n"+
					"Give this branch its own database, as CLAUDE.md's \"use your own database\" "+
					"section describes:\n"+
					"  createdb -U vola vola_test_<branch> && TEST_DATABASE_URL=…vola_test_<branch>",
				lockWait)
		}
		return fmt.Errorf("take the shared fixture lock: %w", err)
	}
	return nil
}

// Fixtures is the optional seed/remove pair a package can run inside the lock.
type Fixtures struct {
	// Seed runs once, after the lock is taken and before any test.
	Seed func(context.Context, Conn) error
	// Remove runs once, after every test, while the lock is still held.
	Remove func(context.Context, Conn) error
}

// Main runs m holding the shared fixture lock, and returns the exit code the
// caller should pass to os.Exit:
//
//	func TestMain(m *testing.M) { os.Exit(testdb.Main(m)) }
//
// With TEST_DATABASE_URL unset every Postgres test skips, so there are no rows
// to own and nothing to lock; m runs untouched and the package's pure-logic
// tests are unaffected.
func Main(m *testing.M) int { return MainWithFixtures(m, Fixtures{}) }

// MainWithFixtures is Main plus a seed/remove pair that belongs to the process
// rather than to each test. Both run on the lock-holding connection.
func MainWithFixtures(m *testing.M, fx Fixtures) int {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		return m.Run()
	}
	ctx := context.Background()
	// A dedicated connection rather than one borrowed from a pool: the advisory
	// lock lives on the SESSION that took it, and a pooled connection would be
	// handed back and could unlock or outlive the lock by accident.
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		fmt.Fprintf(os.Stderr, "testdb: connect to TEST_DATABASE_URL: %v\n", err)
		return 1
	}
	if err := Lock(ctx, conn); err != nil {
		fmt.Fprintf(os.Stderr, "testdb: %v\n", err)
		_ = conn.Close(ctx)
		return 1
	}
	if fx.Seed != nil {
		if err := fx.Seed(ctx, conn); err != nil {
			fmt.Fprintf(os.Stderr, "testdb: seed fixtures: %v\n", err)
			_ = conn.Close(ctx)
			return 1
		}
	}

	code := m.Run()

	if fx.Remove != nil {
		if err := fx.Remove(ctx, conn); err != nil {
			fmt.Fprintf(os.Stderr, "testdb: remove fixtures: %v\n", err)
			if code == 0 {
				code = 1
			}
		}
	}
	// Explicit, because the caller's os.Exit runs no deferred function. Closing
	// releases the advisory lock.
	_ = conn.Close(ctx)
	return code
}

// AssertHeld fails unless this binary already holds its database's fixture
// lock. Skips when TEST_DATABASE_URL is unset, like every other Postgres test.
//
// The lock IS the fix, so every package it protects asserts it rather than
// describing it in a comment: delete the TestMain and this is what goes red.
// Without it the removal is silent and the package goes back to passing alone
// and failing in a fleet, which is the exact shape of #426 and #454.
//
// It opens its OWN connection, which is what makes it a real probe: advisory
// locks are held per session, so a probe run on TestMain's connection would
// simply re-enter the lock and report success. A pooled connection would not do
// either — pool.QueryRow hands its connection straight back, so the unlock
// below could land on a different session and do nothing.
func AssertHeld(t *testing.T) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect a probe connection: %v", err)
	}
	defer func() { _ = conn.Close(ctx) }()

	got, err := TryLock(ctx, conn)
	if err != nil {
		t.Fatalf("probe the fixture lock: %v", err)
	}
	if got {
		if err := Unlock(ctx, conn); err != nil {
			t.Logf("release the probe lock: %v", err)
		}
		t.Fatal("a second connection was able to take this database's fixture lock, so " +
			"nothing stops a second test binary deleting these fixtures out from under " +
			"an in-flight test. TestMain must hold it for the lifetime of the process — " +
			"see #454.")
	}
}
