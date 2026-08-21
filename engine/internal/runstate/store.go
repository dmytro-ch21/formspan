package runstate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrAlreadyLeased marks a claim on an issue whose active run belongs to
// someone (possibly a live copy of this same engine). The database's partial
// unique index decides — application state never does.
var ErrAlreadyLeased = errors.New("issue already has an active run")

// ErrDuplicateDelivery marks a run creation whose webhook delivery id was
// already consumed — the dedupe the webhook gateway (N146) rides on.
var ErrDuplicateDelivery = errors.New("delivery id already consumed")

// ErrLeaseLost marks a heartbeat or transition by an owner whose lease has
// been taken over or expired out from under it.
var ErrLeaseLost = errors.New("lease no longer held")

// ErrNotStale guards takeover: a lease that has not expired cannot be taken.
var ErrNotStale = errors.New("lease has not expired")

// ErrIllegalTransition marks a refused state-machine edge — a sentinel so
// callers distinguish "refused by the machine" from infrastructure errors
// without pattern-matching messages (which this repo's conventions forbid).
var ErrIllegalTransition = errors.New("illegal transition")

type Store struct {
	pool *pgxpool.Pool
	// LeaseTTL bounds how long a silent engine keeps a claim. Heartbeats
	// extend it; a crashed engine simply stops heartbeating and the lease
	// becomes recoverable at expiry — no cleanup process required.
	LeaseTTL time.Duration
}

func NewStore(pool *pgxpool.Pool, ttl time.Duration) *Store {
	return &Store{pool: pool, LeaseTTL: ttl}
}

type Run struct {
	ID          int64
	IssueNumber int
	State       State
	Risk        string
	LeaseOwner  string
	LeaseExpiry time.Time
	Attempt     int
}

// Claim creates the run and takes the lease in ONE insert: either the row
// lands (you own it, state QUEUED) or the partial unique index refuses
// because an active run exists. deliveryID may be empty (polling has none);
// a duplicate non-empty one returns ErrDuplicateDelivery.
func (s *Store) Claim(ctx context.Context, issue int, owner, deliveryID string) (*Run, error) {
	var delivery any
	if deliveryID != "" {
		delivery = deliveryID
	}
	row := s.pool.QueryRow(ctx, `
		INSERT INTO agent_runs (issue_number, state, trigger_delivery_id, lease_owner, lease_expires_at)
		VALUES ($1, 'QUEUED', $2, $3, now() + $4)
		RETURNING id, issue_number, state, risk, lease_owner, lease_expires_at, attempt`,
		issue, delivery, owner, s.LeaseTTL)
	run, err := scanRun(row)
	if err == nil {
		return run, nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		switch pgErr.ConstraintName {
		case "agent_runs_one_active_per_issue":
			return nil, ErrAlreadyLeased
		case "agent_runs_trigger_delivery_id_key":
			return nil, ErrDuplicateDelivery
		}
	}
	return nil, fmt.Errorf("claim issue %d: %w", issue, err)
}

// Heartbeat extends the lease iff the caller still holds it AND it has not
// already expired — a lease that lapsed may have been taken over, and a late
// heartbeat must not resurrect it.
func (s *Store) Heartbeat(ctx context.Context, runID int64, owner string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE agent_runs
		SET lease_expires_at = now() + $3, updated_at = now()
		WHERE id = $1 AND lease_owner = $2 AND lease_expires_at > now()`,
		runID, owner, s.LeaseTTL)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// TakeOver recovers a stale lease: it succeeds only when the current lease
// has expired, so a live owner can never be dispossessed — and only on a
// non-terminal run, so a finished run's inevitably-past timestamp cannot be
// "recovered" into a phantom lease beside a newer active run. The lease
// update and its audit event commit atomically: a takeover that succeeded
// but errored on the event would leave the caller holding a lease its retry
// (ErrNotStale against its own fresh lease) could not explain.
func (s *Store) TakeOver(ctx context.Context, runID int64, newOwner string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx, `
		UPDATE agent_runs
		SET lease_owner = $2, lease_expires_at = now() + $3, updated_at = now()
		WHERE id = $1 AND lease_expires_at <= now() AND state NOT IN (`+terminalSQL()+`)`,
		runID, newOwner, s.LeaseTTL)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotStale
	}
	if err := appendEventTx(ctx, tx, runID, "lease_taken_over",
		map[string]any{"new_owner": newOwner}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Transition moves a run to a new state, validating the edge and requiring a
// live lease. An ILLEGAL transition is refused AND recorded as an event —
// per the ticket, a refusal that leaves no trace is a refusal nobody debugs.
func (s *Store) Transition(ctx context.Context, runID int64, owner string, to State) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var current State
	err = tx.QueryRow(ctx, `
		SELECT state FROM agent_runs
		WHERE id = $1 AND lease_owner = $2 AND lease_expires_at > now()
		FOR UPDATE`, runID, owner).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrLeaseLost
	}
	if err != nil {
		return err
	}
	if verr := ValidateTransition(current, to); verr != nil {
		if err := appendEventTx(ctx, tx, runID, "transition_refused",
			map[string]any{"from": current, "to": to, "error": verr.Error()}); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return fmt.Errorf("%w: %v", ErrIllegalTransition, verr)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE agent_runs SET state = $2, updated_at = now() WHERE id = $1`,
		runID, string(to)); err != nil {
		return err
	}
	if err := appendEventTx(ctx, tx, runID, "transition",
		map[string]any{"from": current, "to": to}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Get returns the run — diagnostics and tests.
func (s *Store) Get(ctx context.Context, runID int64) (*Run, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id, issue_number, state, risk, lease_owner, lease_expires_at, attempt
		FROM agent_runs WHERE id = $1`, runID)
	return scanRun(row)
}

// AppendStep records one executed step under the run. It requires a live
// lease held by the caller — steps are the one write path that could
// otherwise land from a dispossessed engine — and that lease is also what
// makes the max(seq)+1 safe: one run has one live owner, so step writes are
// serial by construction rather than by luck.
func (s *Store) AppendStep(ctx context.Context, runID int64, owner, stepType, command, summary string, exitCode *int) error {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO agent_steps (run_id, seq, step_type, state, command, exit_code, summary, finished_at)
		SELECT r.id, COALESCE((SELECT max(seq) FROM agent_steps WHERE run_id = r.id), 0) + 1,
		       $3, r.state, $4, $5, $6, now()
		FROM agent_runs r
		WHERE r.id = $1 AND r.lease_owner = $2 AND r.lease_expires_at > now()`,
		runID, owner, stepType, command, exitCode, summary)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// Events lists a run's event types in order — the audit read.
func (s *Store) Events(ctx context.Context, runID int64) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT event_type FROM agent_events WHERE run_id = $1 ORDER BY id`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// terminalSQL renders the terminal-state list as SQL literals, from the same
// variable the schema-pin test checks — so the store's NOT IN and the index
// predicate cannot disagree without that test noticing.
func terminalSQL() string {
	parts := make([]string, len(terminalStatesInSchema))
	for i, s := range terminalStatesInSchema {
		parts[i] = "'" + string(s) + "'"
	}
	return strings.Join(parts, ", ")
}

func appendEventTx(ctx context.Context, tx pgx.Tx, runID int64, eventType string, payload map[string]any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO agent_events (run_id, event_type, payload) VALUES ($1, $2, $3)`,
		runID, eventType, b)
	return err
}

func scanRun(row pgx.Row) (*Run, error) {
	var r Run
	var state string
	if err := row.Scan(&r.ID, &r.IssueNumber, &state, &r.Risk, &r.LeaseOwner, &r.LeaseExpiry, &r.Attempt); err != nil {
		return nil, err
	}
	r.State = State(state)
	return &r, nil
}
