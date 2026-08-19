package database

import (
	"context"
	"errors"
	"os"
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
	name := "copytx_scratch"
	if _, err := pool.Exec(ctx,
		`CREATE TABLE IF NOT EXISTS copytx_scratch (id text PRIMARY KEY)`); err != nil {
		t.Fatalf("create scratch: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS copytx_scratch`) })
	if _, err := pool.Exec(ctx, `TRUNCATE copytx_scratch`); err != nil {
		t.Fatalf("truncate scratch: %v", err)
	}
	return name
}

func rows(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM copytx_scratch`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func TestCopySelfCommitsWhatTheCopyWrote(t *testing.T) {
	pool := testPool(t)
	scratch(t, pool)

	newID, ok, err := CopySelf(context.Background(), pool,
		func(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
			// The caller is BOTH sides of a self-copy — the property that makes
			// the visibility check run against the person asking.
			if sharerID != newOwnerID {
				t.Errorf("sharer %q and new owner %q must be the same caller", sharerID, newOwnerID)
			}
			_, err := tx.Exec(ctx, `INSERT INTO copytx_scratch (id) VALUES ('copied')`)
			return "copied", true, err
		},
		"src", "me")
	if err != nil || !ok || newID != "copied" {
		t.Fatalf("CopySelf = %q, %v, %v; want \"copied\", true, nil", newID, ok, err)
	}
	if n := rows(t, pool); n != 1 {
		t.Errorf("%d rows after a successful copy, want 1 — it did not commit", n)
	}
}

// The guard neither module's suite could reach.
func TestCopySelfRollsBackWhatAFailedCopyWrote(t *testing.T) {
	pool := testPool(t)
	scratch(t, pool)

	boom := errors.New("second statement failed")
	_, ok, err := CopySelf(context.Background(), pool,
		func(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
			// Half a copy: the row lands, then the operation fails — exactly
			// the shape a real CopyTo has when its items INSERT errors.
			if _, err := tx.Exec(ctx, `INSERT INTO copytx_scratch (id) VALUES ('half')`); err != nil {
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
	if n := rows(t, pool); n != 0 {
		t.Errorf("%d rows after a failed copy, want 0 — the transaction did not roll back", n)
	}
}

// Not visible: no error, no rows, and nothing committed.
func TestCopySelfCommitsNothingWhenTheSourceIsNotVisible(t *testing.T) {
	pool := testPool(t)
	scratch(t, pool)

	newID, ok, err := CopySelf(context.Background(), pool,
		func(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
			// A real CopyTo decides this from its SELECT, before inserting —
			// but if one ever wrote first and refused after, the transaction is
			// what makes that safe. Written that way here on purpose.
			if _, err := tx.Exec(ctx, `INSERT INTO copytx_scratch (id) VALUES ('never')`); err != nil {
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
	if n := rows(t, pool); n != 0 {
		t.Errorf("%d rows after a refused copy, want 0", n)
	}
}
