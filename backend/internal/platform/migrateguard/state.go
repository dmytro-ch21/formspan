package migrateguard

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// undefinedTable is Postgres' error code for "relation does not exist".
const undefinedTable = "42P01"

// ReadState reads schema_migrations with a plain SELECT and nothing else.
//
// Read-only on purpose: `migrate status` has to be the command somebody points
// at a deployed database during an incident, so it must not be able to create
// a table, take a lock, or leave a trace.
func ReadState(ctx context.Context, dsn string) (State, error) {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return State{}, err
	}
	defer func() { _ = conn.Close(ctx) }()

	var version uint64
	var dirty bool
	err = conn.QueryRow(ctx, "SELECT version, dirty FROM schema_migrations").Scan(&version, &dirty)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// The table exists but is empty — golang-migrate's state after a full
		// `down`. Indistinguishable from never-migrated, and treated the same.
		return State{}, nil
	case err != nil:
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == undefinedTable {
			return State{}, nil
		}
		return State{}, err
	}
	return State{Applied: true, Version: version, Dirty: dirty}, nil
}
