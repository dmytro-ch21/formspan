package testdb

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Deliberately NO TestMain here. This package is the apparatus, not a consumer:
// it holds no fixture rows, so it has nothing to protect, and taking the lock
// for the lifetime of this binary would make the test below — which needs the
// lock held by a connection it controls — impossible to write.

func connect(t *testing.T) *pgx.Conn {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	conn, err := pgx.Connect(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

// The deadline is the one behaviour here that no other test can reach: every
// package's TestMain takes the lock on the happy path, so the WAIT is exercised
// constantly and the give-up is exercised never. Left untested it would be the
// classic surviving mutation — delete it, everything stays green, and a wedged
// neighbour turns back into a hang nobody can explain.
//
// It also pins the two things the message has to carry, because that message is
// the entire value of failing rather than blocking: what went wrong, and the one
// command that fixes it.
func TestLockGivesUpWithAnActionableMessageRatherThanHanging(t *testing.T) {
	ctx := context.Background()
	holder := connect(t) // skips without TEST_DATABASE_URL

	// Take it properly rather than assuming it is free: another binary may
	// legitimately hold it, and Lock is what queues for it.
	if err := Lock(ctx, holder); err != nil {
		t.Fatalf("take the lock on the holding connection: %v", err)
	}
	defer func() { _ = Unlock(ctx, holder) }()

	// Confirm the apparatus is armed before believing what it proves: if the
	// holder did not really have the lock, the waiter below would simply take
	// it and the test would fail for the wrong reason.
	probe := connect(t)
	if got, err := TryLock(ctx, probe); err != nil {
		t.Fatalf("probe: %v", err)
	} else if got {
		_ = Unlock(ctx, probe)
		t.Fatal("the holding connection does not actually hold the lock, so this " +
			"test cannot measure the wait it exists to measure")
	}

	restore := lockWait
	lockWait = 300 * time.Millisecond
	defer func() { lockWait = restore }()

	waiter := connect(t)
	started := time.Now()
	err := Lock(ctx, waiter)
	waited := time.Since(started)

	if err == nil {
		_ = Unlock(ctx, waiter)
		t.Fatal("a second connection took a lock that was already held")
	}
	// Generous, because this is asserting that it RETURNED rather than blocked
	// to the test timeout — not that Postgres is punctual.
	if waited > 30*time.Second {
		t.Errorf("waited %s for a %s budget — the deadline is not being honoured", waited, lockWait)
	}
	for _, want := range []string{
		"fixture lock",
		"cannot share a database with a second copy of themselves",
		"createdb -U vola vola_test_",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the give-up message does not mention %q, so it does not tell the "+
				"reader what happened or how to fix it:\n%v", want, err)
		}
	}
}

// The lock_timeout the wait installs must not outlive the wait. It is set on the
// connection TestMain then hands to the fixture hooks, so a lingering one would
// cancel an unrelated seed statement that happened to touch a busy row — a
// failure with no visible connection to locking at all.
func TestTheWaitDoesNotLeaveALockTimeoutOnTheConnection(t *testing.T) {
	ctx := context.Background()
	holder := connect(t)
	if err := Lock(ctx, holder); err != nil {
		t.Fatalf("take the lock on the holding connection: %v", err)
	}
	defer func() { _ = Unlock(ctx, holder) }()

	restore := lockWait
	lockWait = 300 * time.Millisecond
	defer func() { lockWait = restore }()

	waiter := connect(t)
	if err := Lock(ctx, waiter); err == nil {
		_ = Unlock(ctx, waiter)
		t.Fatal("a second connection took a lock that was already held")
	}

	var setting string
	if err := waiter.QueryRow(ctx, `SHOW lock_timeout`).Scan(&setting); err != nil {
		t.Fatalf("read lock_timeout back: %v", err)
	}
	if setting != "0" {
		t.Errorf("lock_timeout is still %q after the wait; it must be reset to 0 or it "+
			"will cancel later statements on this connection", setting)
	}
}

// Scoping is the difference between "a branch with its own database never
// queues" and "every per-branch database on this Postgres serialises against
// every other" — and CLAUDE.md tells everyone to use their own database, so
// getting it wrong penalises exactly the people doing the right thing. Advisory
// keys are cluster-wide, so nothing but this expression makes the key local.
// It evaluates the real expression on TWO REAL DATABASES and requires the
// answers to differ. An earlier version of this test compared it against the
// hash of an invented name instead, and a mutation replacing
// `current_database()` with a constant sailed straight through it — the test was
// asserting that two different strings hash differently, which is true of any
// constant. Only a second connection to a second database can tell the two
// apart.
func TestTheLockKeyIsScopedToTheDatabase(t *testing.T) {
	ctx := context.Background()
	here := connect(t) // skips without TEST_DATABASE_URL

	cfg, err := pgx.ParseConfig(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("parse TEST_DATABASE_URL: %v", err)
	}
	mine := cfg.Database
	if mine == "postgres" {
		t.Skip("TEST_DATABASE_URL already points at `postgres`; this test needs a second database")
	}
	cfg.Database = "postgres" // always present, and never the test database
	elsewhereConn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect to the `postgres` database for comparison: %v", err)
	}
	defer func() { _ = elsewhereConn.Close(ctx) }()

	var scoped, elsewhere int32
	if err := here.QueryRow(ctx, `SELECT `+LockScopeSQL).Scan(&scoped); err != nil {
		t.Fatalf("evaluate the scope expression here: %v", err)
	}
	if err := elsewhereConn.QueryRow(ctx, `SELECT `+LockScopeSQL).Scan(&elsewhere); err != nil {
		t.Fatalf("evaluate the scope expression elsewhere: %v", err)
	}
	if scoped == elsewhere {
		t.Fatalf("the lock scope is %d in both %q and `postgres`, so it does not depend on "+
			"the database: every vola_test_<branch> on this Postgres would serialise "+
			"against every other one, and against CI", scoped, mine)
	}
}
