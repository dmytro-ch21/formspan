package runstate

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrations is the engine's own ordered migration list, embedded so the
// binary always carries the schema it expects. Deliberately NOT
// backend/migrations/ and NOT golang-migrate: the engine database is a
// different database with a different owner, and sharing the product's
// migration sequence would put engine schema one typo away from a product
// deploy. Same append-only discipline though — never edit an entry, add one.
var migrations = []string{
	// 1 — the four tables and the lease constraint.
	`
CREATE TABLE agent_runs (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_number        INT         NOT NULL,
    state               TEXT        NOT NULL DEFAULT 'QUEUED',
    risk                TEXT        NOT NULL DEFAULT 'low',
    base_sha            TEXT        NOT NULL DEFAULT '',
    branch              TEXT        NOT NULL DEFAULT '',
    trigger_delivery_id TEXT        UNIQUE,
    lease_owner         TEXT        NOT NULL,
    lease_expires_at    TIMESTAMPTZ NOT NULL,
    attempt             INT         NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ONE ACTIVE LEASE PER ISSUE, enforced by the database rather than by
-- application logic: a second INSERT for an issue whose run is not in a
-- terminal state violates this index, whatever the application believed.
-- The state list here must equal runstate.Terminal's — a test pins them.
CREATE UNIQUE INDEX agent_runs_one_active_per_issue
    ON agent_runs (issue_number)
    WHERE state NOT IN ('DONE', 'BLOCKED', 'FAILED', 'CANCELLED');

CREATE TABLE agent_steps (
    run_id      BIGINT      NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    seq         INT         NOT NULL,
    step_type   TEXT        NOT NULL,
    state       TEXT        NOT NULL,
    command     TEXT        NOT NULL DEFAULT '',
    exit_code   INT,
    summary     TEXT        NOT NULL DEFAULT '',
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    PRIMARY KEY (run_id, seq)
);

-- Immutable event log: every transition (and every REFUSED transition) is a
-- row, so "what happened to this run" is answerable without trusting memory.
CREATE TABLE agent_events (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id     BIGINT      NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    event_type TEXT        NOT NULL,
    payload    JSONB       NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_artifacts (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id     BIGINT      NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    kind       TEXT        NOT NULL,
    ref        TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Events() and the ON DELETE CASCADE both read by run_id, and the table only
-- grows — one row per transition across every run forever.
CREATE INDEX agent_events_run_id ON agent_events (run_id);
`,
}

// terminalStatesInSchema is the state list the partial index above names,
// exported to the test that pins it against runstate.Terminal — the two are
// one invariant written in two languages, and only a test can hold them
// together.
var terminalStatesInSchema = []State{Done, Blocked, Failed, Cancelled}

// migrateLockKey serialises concurrent Migrate calls per database — two
// engine replicas starting at once must not race the version table.
const migrateLockKey = 0x564f4c41454e47 // "VOLAENG"

// Migrate applies every migration above the recorded version in ONE
// transaction, under an advisory xact lock. One tx (Postgres DDL is
// transactional) means half-applied state is impossible; the lock means a
// second replica waits and then reads the finished version rather than racing
// `CREATE TABLE IF NOT EXISTS` into a catalog error. A tiny versioned
// migrator rather than IF NOT EXISTS soup: idempotent-looking DDL hides
// drift, a version number refuses it.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, migrateLockKey); err != nil {
		return fmt.Errorf("engine migrate: lock: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`CREATE TABLE IF NOT EXISTS engine_schema_version (version INT NOT NULL UNIQUE)`); err != nil {
		return fmt.Errorf("engine migrate: %w", err)
	}
	var version int
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(max(version), 0) FROM engine_schema_version`).Scan(&version); err != nil {
		return fmt.Errorf("engine migrate: read version: %w", err)
	}
	for i := version; i < len(migrations); i++ {
		if _, err := tx.Exec(ctx, migrations[i]); err != nil {
			return fmt.Errorf("engine migrate: apply %d: %w", i+1, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO engine_schema_version (version) VALUES ($1)`, i+1); err != nil {
			return fmt.Errorf("engine migrate: record %d: %w", i+1, err)
		}
	}
	return tx.Commit(ctx)
}
