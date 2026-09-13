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

// stuckRowReport is the SQL predicate for N565's (#1108) daily stuck-row
// reports. They reuse the `sync_blocked` kind with `details.reason` set, so a
// query that counts give-ups has to tell the two apart. One constant, so the
// count and the stuck-rows figure cannot disagree about what a report is.
const stuckRowReport = `kind = 'sync_blocked' AND details->>'reason' IN ('stuck_blocked', 'stuck_refused')`

// stuckReportPass is how long before an athlete's newest stuck-row report
// another of their reports still counts as part of the same pass.
//
// One pass does not always arrive as one insert. The device captures one event
// per group, and its telemetry buffer flushes by itself once it holds ten
// (`flushAtCount` in `apps/mobile/lib/telemetry.ts`). A pass with more groups
// therefore lands as several requests, milliseconds apart, each with its own
// `now()`, and matching on the newest timestamp alone would keep only the last
// request's groups. Two passes are at least 15 minutes apart on the device
// (`MIN_CHANGE_INTERVAL_MS` in `apps/mobile/lib/stuckRows.ts`), so five minutes
// takes in a split pass without reaching back into the one before.
const stuckReportPass = 5 * time.Minute

// maxStuckRowGroups bounds the stuck-rows figure. The groups come from details
// a client wrote, so how many there are is not the server's to promise.
const maxStuckRowGroups = 20

func (r *PostgresRepository) Summarise(ctx context.Context, since time.Time) (Summary, error) {
	s := Summary{
		Since:          since,
		ByKind:         map[string]int{},
		SlowestPathsMS: map[string]int{},
		StuckRows:      []StuckRowGroup{},
	}

	// Stuck-row reports count toward Total but not toward their kind (F66,
	// #1200). "Sync blocked" means a device gave up pushing, and one athlete
	// with one stuck row sends a report a day for as long as it stays stuck,
	// so counting reports there would turn one refused entry into thirty
	// give-ups a month.
	rows, err := r.pool.Query(ctx, `
		SELECT kind, COUNT(*), COUNT(*) FILTER (WHERE `+stuckRowReport+`)
		FROM health_events
		WHERE occurred_at >= $1 GROUP BY kind`, since)
	if err != nil {
		return s, fmt.Errorf("health: summarise kinds: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var kind string
		var n, reports int
		if err := rows.Scan(&kind, &n, &reports); err != nil {
			return s, fmt.Errorf("health: scan kind: %w", err)
		}
		s.ByKind[kind] = n - reports
		s.StuckRowReports += reports
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

	if err := r.summariseStuckRows(ctx, since, &s); err != nil {
		return s, err
	}
	return s, nil
}

// summariseStuckRows fills in who has stuck rows, from each athlete's latest
// report (F66, #1200).
//
// The latest report rather than every report in the window. A group whose rows
// got unstuck is missing from the next report, and summing a day of reports
// would count one stuck row once per report. A device with nothing stuck sends
// nothing at all, so an athlete whose rows all cleared stays listed until their
// last report leaves the window.
//
// The details were written by a client, so nothing about their shape is
// trusted: a group needs a string entity and code to be listed, and a row count
// that is not a number in range counts as zero rather than failing the cast and
// taking the whole health screen down with it.
func (r *PostgresRepository) summariseStuckRows(ctx context.Context, since time.Time, s *Summary) error {
	if err := r.pool.QueryRow(ctx, `
		SELECT COUNT(DISTINCT user_id) FROM health_events
		WHERE occurred_at >= $1 AND user_id IS NOT NULL AND `+stuckRowReport, since,
	).Scan(&s.StuckRowAthletes); err != nil {
		return fmt.Errorf("health: summarise stuck athletes: %w", err)
	}

	// DISTINCT ON keeps one event per athlete and group, so a group reported
	// twice inside one pass (a phone clock moved backwards re-reports at once)
	// is not counted twice.
	rows, err := r.pool.Query(ctx, `
		WITH reports AS (
			SELECT user_id, occurred_at, details FROM health_events
			WHERE occurred_at >= $1 AND user_id IS NOT NULL AND `+stuckRowReport+`
		), newest AS (
			SELECT user_id, MAX(occurred_at) AS at FROM reports GROUP BY user_id
		), latest AS (
			SELECT DISTINCT ON (r.user_id, r.details->>'entity', r.details->>'reason', r.details->>'code')
			       r.details
			FROM reports r
			JOIN newest n ON n.user_id = r.user_id
			WHERE r.occurred_at >= n.at - make_interval(secs => $2)
			  AND jsonb_typeof(r.details->'entity') = 'string'
			  AND jsonb_typeof(r.details->'code') = 'string'
			ORDER BY r.user_id, r.details->>'entity', r.details->>'reason', r.details->>'code', r.occurred_at DESC
		)
		SELECT details->>'entity', details->>'reason', details->>'code', COUNT(*),
		       SUM(CASE
		             WHEN jsonb_typeof(details->'rows') <> 'number' THEN 0
		             WHEN (details->'rows')::numeric BETWEEN 0 AND 1000000 THEN floor((details->'rows')::numeric)
		             ELSE 0
		           END)::bigint
		FROM latest
		GROUP BY 1, 2, 3
		ORDER BY 4 DESC, 5 DESC, 1, 2, 3
		LIMIT $3`, since, stuckReportPass.Seconds(), maxStuckRowGroups)
	if err != nil {
		return fmt.Errorf("health: summarise stuck rows: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var g StuckRowGroup
		var reason string
		if err := rows.Scan(&g.Entity, &reason, &g.Code, &g.Athletes, &g.Rows); err != nil {
			return fmt.Errorf("health: scan stuck rows: %w", err)
		}
		g.State = strings.TrimPrefix(reason, "stuck_")
		s.StuckRows = append(s.StuckRows, g)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("health: summarise stuck rows: %w", err)
	}
	return nil
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
