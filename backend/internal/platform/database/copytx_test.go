package database

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The transaction dance, tested where it finally can be.
//
// **This is the reason the helper is worth having**, beyond the eleven lines.
// Neither `sequence` nor `workout` could test the rollback: their `CopyTo` is
// real code copying real rows, and no natural input makes its second INSERT
// fail, so both suites recorded "the transaction's actual guard is untested"
// as an open question. A `CopyFunc` is injectable, so a copy that writes and
// THEN fails is one closure away — and that is the case the whole transaction
// exists for.

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	pool, err := NewPool(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// A scratch table, so the helper is exercised against real transaction
// semantics without borrowing another module's schema.
func scratch(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	// Named per test, not a fixed `copytx_scratch`: `vola_test` is shared
	// across worktrees, so two sessions running this package at once would race
	// on the same DDL — one's DROP under the other's open transaction, which
	// presents as a spurious hang rather than a failure. Fixture ROWS tolerate
	// that; a table does not.
	name := "copytx_scratch_" + strings.ToLower(
		strings.NewReplacer("/", "_", " ", "_").Replace(t.Name()))
	if _, err := pool.Exec(ctx,
		`CREATE TABLE IF NOT EXISTS `+name+` (id text PRIMARY KEY)`); err != nil {
		t.Fatalf("create scratch: %v", err)
	}
	t.Cleanup(func() {
		// `lock_timeout`, so teardown CANNOT hang.
		//
		// A leaked transaction holds RowExclusive on this table and waits on
		// nothing, so Postgres's deadlock detector never fires and the DROP —
		// which needs AccessExclusive — queues behind it forever. That is not
		// theoretical: it is exactly what deleting the rollback produces, and
		// with no `-timeout` in `test:api` or CI it surfaces ten minutes later
		// as a panic in cleanup instead of as the failure it is. Three seconds
		// and a named error is the difference between "the guard fired" and
		// "the suite mysteriously stopped".
		_, err := pool.Exec(context.Background(),
			`SET lock_timeout = '3s'; DROP TABLE IF EXISTS `+name)
		if err != nil {
			t.Errorf("dropping %s: %v — a transaction is still holding it open", name, err)
		}
	})
	if _, err := pool.Exec(ctx, `TRUNCATE `+name); err != nil {
		t.Fatalf("truncate scratch: %v", err)
	}
	return name
}

func rows(t *testing.T, pool *pgxpool.Pool, table string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM `+table).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// noLeakedConnection is the assertion the row count CANNOT make.
//
// Counting rows through the pool proves "not committed" and nothing more: MVCC
// hides an uncommitted insert from another connection, so a transaction that
// was merely LEFT OPEN reads identically to one that was rolled back. Review
// caught that — the row count alone would have passed with the deferred
// rollback deleted, and the only thing catching the leak was the cleanup's DROP
// blocking on the held lock, surfacing ten minutes later as a panic in teardown
// (neither `test:api` nor CI passes `-timeout`).
//
// The pool knows. A closed transaction has returned its connection.
func noLeakedConnection(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if n := pool.Stat().AcquiredConns(); n != 0 {
		t.Errorf("%d connection(s) still acquired — the transaction was never closed", n)
	}
}

func TestCopySelfCommitsWhatTheCopyWrote(t *testing.T) {
	pool := testPool(t)
	table := scratch(t, pool)

	newID, ok, err := CopySelf(context.Background(), pool,
		func(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
			// The caller is BOTH sides of a self-copy — the property that makes
			// the visibility check run against the person asking.
			if sharerID != newOwnerID {
				t.Errorf("sharer %q and new owner %q must be the same caller", sharerID, newOwnerID)
			}
			_, err := tx.Exec(ctx, `INSERT INTO `+table+` (id) VALUES ('copied')`)
			return "copied", true, err
		},
		"src", "me")
	if err != nil || !ok || newID != "copied" {
		t.Fatalf("CopySelf = %q, %v, %v; want \"copied\", true, nil", newID, ok, err)
	}
	noLeakedConnection(t, pool)
	if n := rows(t, pool, table); n != 1 {
		t.Errorf("%d rows after a successful copy, want 1 — it did not commit", n)
	}
}

// The guard neither module's suite could reach.
func TestCopySelfRollsBackWhatAFailedCopyWrote(t *testing.T) {
	pool := testPool(t)
	table := scratch(t, pool)

	boom := errors.New("second statement failed")
	_, ok, err := CopySelf(context.Background(), pool,
		func(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
			// Half a copy: the row lands, then the operation fails — exactly
			// the shape a real CopyTo has when its items INSERT errors.
			if _, err := tx.Exec(ctx, `INSERT INTO `+table+` (id) VALUES ('half')`); err != nil {
				return "", false, err
			}
			return "", false, boom
		},
		"src", "me")
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the copy's own error", err)
	}
	if ok {
		t.Error("ok must be false when the copy failed")
	}
	noLeakedConnection(t, pool)
	if n := rows(t, pool, table); n != 0 {
		t.Errorf("%d rows after a failed copy, want 0 — the transaction did not roll back", n)
	}
}

// Not visible: no error, no rows, and nothing committed.
func TestCopySelfCommitsNothingWhenTheSourceIsNotVisible(t *testing.T) {
	pool := testPool(t)
	table := scratch(t, pool)

	newID, ok, err := CopySelf(context.Background(), pool,
		func(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
			// A real CopyTo decides this from its SELECT, before inserting —
			// but if one ever wrote first and refused after, the transaction is
			// what makes that safe. Written that way here on purpose.
			if _, err := tx.Exec(ctx, `INSERT INTO `+table+` (id) VALUES ('never')`); err != nil {
				return "", false, err
			}
			return "", false, nil
		},
		"src", "me")
	if err != nil {
		t.Fatalf("a not-visible source is not an error: %v", err)
	}
	if ok || newID != "" {
		t.Errorf("CopySelf = %q, %v; want \"\", false", newID, ok)
	}
	noLeakedConnection(t, pool)
	if n := rows(t, pool, table); n != 0 {
		t.Errorf("%d rows after a refused copy, want 0", n)
	}
}
