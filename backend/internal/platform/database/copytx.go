package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CopyFunc duplicates a resource into newOwnerID's ownership inside the
// transaction it is handed, returning the new row's id.
//
// The same signature `share.Copier.CopyTo` declares — deliberately as a
// FUNCTION rather than that interface, because the domain modules must not
// import `share`. That dependency runs the other way on purpose (the modules
// satisfy an interface declared over there and `cmd/api` pairs them up), and
// taking a func value here keeps it that way while still describing the same
// contract.
//
// `ok` is false when the resource is not visible to sharerID — which includes
// "does not exist", deliberately conflated so a caller cannot use this to
// discover whether an id belongs to somebody.
type CopyFunc func(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (newID string, ok bool, err error)

// CopySelf runs the copy-into-your-own-library transaction: begin, copy,
// commit — with the caller as both the sharer and the new owner, which is what
// makes it a self-copy and what makes the visibility check run against the
// person asking.
//
// **Why this is shared and share-accept is not.** `sequence.Copy` and
// `workout.Copy` were the same seventeen lines twice (#294, #298), and the
// duplicated part is precisely where the subtle mistakes live: the deferred
// rollback, committing BEFORE the read-back so a 201 can never describe a row
// whose commit failed, and not holding a connection across both. Share-accept
// looks similar and is NOT the same operation — it opens its transaction so the
// share's status flip commits with the copy, and on a missing source it DELETES
// the dead share and commits rather than refusing. Folding that in would trade
// a real behaviour for a shape.
//
// What stays with the caller: the read-back, its own `ErrNotFound`, and its own
// error wrapping. Those are the module's vocabulary, and a helper that returned
// somebody else's error type would leak this package into every handler's
// error mapping.
func CopySelf(
	ctx context.Context,
	pool *pgxpool.Pool,
	copy CopyFunc,
	resourceID, userID string,
) (newID string, ok bool, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", false, fmt.Errorf("database: copy begin: %w", err)
	}
	// Runs on every path including the successful one, where it is a no-op
	// against an already-committed transaction. That is what makes every early
	// return below safe to write as a bare return.
	defer func() { _ = tx.Rollback(ctx) }()

	newID, ok, err = copy(ctx, tx, resourceID, userID, userID)
	if err != nil {
		return "", false, err
	}
	if !ok {
		// Nothing is committed, so whatever the copy managed before deciding it
		// could not finish is discarded.
		return "", false, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, fmt.Errorf("database: copy commit: %w", err)
	}
	// Committed BEFORE the caller reads back, and the ordering is deliberate:
	// reading inside the transaction would mean answering 201 with a row whose
	// commit could still fail. The cost is the other way round — a read that
	// fails after a successful commit gives a 500 over a copy that exists, and
	// a retry makes a second one. Copying is documented non-idempotent, so a
	// duplicate is a known shape; a response describing a row that never
	// existed is not.
	return newID, true, nil
}
