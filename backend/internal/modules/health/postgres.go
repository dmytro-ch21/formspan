package health

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

func (r *PostgresRepository) Record(ctx context.Context, e Event) error {
	details := marshalDetails(e.Details)
	_, err := r.pool.Exec(ctx, `
		INSERT INTO health_events (
			source, kind, user_id, method, path, status, duration_ms,
			error_code, message, request_id, trace_id, details
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		e.Source, e.Kind, e.UserID, e.Method, e.Path, e.Status, e.DurationMS,
		e.ErrorCode, e.Message, e.RequestID, e.TraceID, details)
	if err != nil {
		return fmt.Errorf("health: record: %w", err)
	}
	return nil
}

// RecordBatch inserts every event in ONE statement.
//
// A multi-row VALUES list rather than a loop: it is one round trip instead of
// fifty, and it is atomic without needing an explicit transaction, so a failure
// stores nothing rather than storing a prefix. See the interface for why that
// matters more here than the round trips do.
func (r *PostgresRepository) RecordBatch(ctx context.Context, events []Event) error {
	if len(events) == 0 {
		return nil
	}
	const cols = 12
	values := make([]string, 0, len(events))
	args := make([]any, 0, len(events)*cols)
	for i, e := range events {
		base := i * cols
		ph := make([]string, cols)
		for j := range ph {
			ph[j] = "$" + strconv.Itoa(base+j+1)
		}
		values = append(values, "("+strings.Join(ph, ", ")+")")
		args = append(args,
			e.Source, e.Kind, e.UserID, e.Method, e.Path, e.Status, e.DurationMS,
			e.ErrorCode, e.Message, e.RequestID, e.TraceID, marshalDetails(e.Details))
	}
	_, err := r.pool.Exec(ctx, `
		INSERT INTO health_events (
			source, kind, user_id, method, path, status, duration_ms,
			error_code, message, request_id, trace_id, details
		) VALUES `+strings.Join(values, ", "), args...)
	if err != nil {
		return fmt.Errorf("health: record batch: %w", err)
	}
	return nil
}

// marshalDetails is shared by both writers so they cannot disagree about what
// an unserialisable details map means — dropping the context, never the event.
func marshalDetails(d map[string]any) []byte {
	if len(d) == 0 {
		return nil
	}
	b, err := json.Marshal(d)
	if err != nil {
		// Don't fail the write over unserialisable context — the event itself
		// is the thing worth keeping.
		return nil
	}
	return b
}

func (r *PostgresRepository) List(ctx context.Context, f Filter) ([]Event, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	if limit > MaxLimit {
		limit = MaxLimit
	}

	// Every filter is optional, expressed as "this parameter is empty OR it
	// matches" so one query serves every combination. Cleaner than assembling
	// SQL by string concatenation, and it keeps the parameters bound.
	rows, err := r.pool.Query(ctx, `
		SELECT id, occurred_at, source, kind, user_id, method, path, status,
		       duration_ms, error_code, message, request_id, trace_id, details
		FROM health_events
		WHERE ($1 = '' OR kind = $1)
		  AND ($2 = '' OR user_id = $2)
		  AND ($3::timestamptz IS NULL OR occurred_at >= $3)
		ORDER BY occurred_at DESC, id DESC
		LIMIT $4`,
		string(f.Kind), f.UserID, nullTime(f.Since), limit)
	if err != nil {
		return nil, fmt.Errorf("health: list: %w", err)
	}
	defer rows.Close()

	// Non-nil so the JSON is `[]` and not `null` — a client shouldn't have to
	// handle both for "nothing wrong".
	events := []Event{}
	for rows.Next() {
		var (
			e       Event
			details []byte
		)
		if err := rows.Scan(&e.ID, &e.OccurredAt, &e.Source, &e.Kind, &e.UserID,
			&e.Method, &e.Path, &e.Status, &e.DurationMS, &e.ErrorCode,
			&e.Message, &e.RequestID, &e.TraceID, &details); err != nil {
			return nil, fmt.Errorf("health: scan: %w", err)
		}
		if len(details) > 0 {
			_ = json.Unmarshal(details, &e.Details)
		}
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("health: list rows: %w", err)
	}
	return events, nil
}

func (r *PostgresRepository) Summarise(ctx context.Context, since time.Time) (Summary, error) {
	s := Summary{
		Since:          since,
		ByKind:         map[string]int{},
		SlowestPathsMS: map[string]int{},
	}

	rows, err := r.pool.Query(ctx, `
		SELECT kind, COUNT(*) FROM health_events
		WHERE occurred_at >= $1 GROUP BY kind`, since)
	if err != nil {
		return s, fmt.Errorf("health: summarise kinds: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var kind string
		var n int
		if err := rows.Scan(&kind, &n); err != nil {
			return s, fmt.Errorf("health: scan kind: %w", err)
		}
		s.ByKind[kind] = n
		s.Total += n
	}
	if err := rows.Err(); err != nil {
		return s, fmt.Errorf("health: summarise rows: %w", err)
	}

	// How many *people* are affected, not how many events — twenty rows from
	// one athlete on a bad connection is a very different morning from twenty
	// athletes hitting the same broken endpoint, and the raw total cannot tell
	// them apart.
	if err := r.pool.QueryRow(ctx, `
		SELECT COUNT(DISTINCT user_id) FROM health_events
		WHERE occurred_at >= $1 AND user_id IS NOT NULL`, since,
	).Scan(&s.AffectedUsers); err != nil {
		return s, fmt.Errorf("health: summarise users: %w", err)
	}

	// Worst observed latency per route, so a slow endpoint is named rather
	// than merely counted.
	slow, err := r.pool.Query(ctx, `
		SELECT path, MAX(duration_ms) FROM health_events
		WHERE occurred_at >= $1 AND kind = 'slow_request' AND path IS NOT NULL
		GROUP BY path ORDER BY MAX(duration_ms) DESC LIMIT 10`, since)
	if err != nil {
		return s, fmt.Errorf("health: summarise slow: %w", err)
	}
	defer slow.Close()
	for slow.Next() {
		var path string
		var ms int
		if err := slow.Scan(&path, &ms); err != nil {
			return s, fmt.Errorf("health: scan slow: %w", err)
		}
		s.SlowestPathsMS[path] = ms
	}
	if err := slow.Err(); err != nil {
		return s, fmt.Errorf("health: summarise slow rows: %w", err)
	}
	return s, nil
}

// nullTime lets one query serve both "since X" and "no lower bound" without a
// second statement — the zero Time becomes SQL NULL, which the WHERE clause
// treats as "unfiltered".
func nullTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// retention is how far back health_events is kept.
//
// Matched to the read path's own limit: the handler clamps `?hours=` to a
// 30-day window, so anything older is already unreachable through the API.
// 90 days leaves generous headroom for widening that window later without
// another migration.
const retention = 90 * 24 * time.Hour

// Prune drops health events past the retention window.
//
// Called from cmd/seed, which runs on every deploy — the only scheduled thing
// this project has. A pg_cron job would be tidier; it is not worth adding an
// extension for one DELETE.
//
// Returns the number of rows removed so the deploy log says what happened
// rather than being silent about deleting data.
func (r *PostgresRepository) Prune(ctx context.Context) (int64, error) {
	tag, err := r.pool.Exec(ctx,
		`DELETE FROM health_events WHERE occurred_at < $1`, time.Now().Add(-retention))
	if err != nil {
		return 0, fmt.Errorf("health: prune: %w", err)
	}
	return tag.RowsAffected(), nil
}
