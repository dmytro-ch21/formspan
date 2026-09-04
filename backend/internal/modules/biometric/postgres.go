package biometric

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

const sampleColumns = `
	id, metric_type, source, source_platform, value, unit, measured_at, period_end, created_at`

// translatePgError turns constraint violations into domain errors. Mirrors
// running.translatePgError.
func translatePgError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23503": // foreign_key_violation
		return ErrNotFound
	case "23505": // unique_violation
		return fmt.Errorf("%w: a value conflicts with an existing row", ErrInvalidInput)
	case "23514": // check_violation
		return fmt.Errorf("%w: a value is out of range", ErrInvalidInput)
	case "22003": // numeric_value_out_of_range
		return fmt.Errorf("%w: a value is too large", ErrInvalidInput)
	}
	return err
}

// PutSamples stores a batch of raw readings idempotently.
//
// ONE round trip via pgx.Batch — N single-row INSERT ... ON CONFLICT DO
// NOTHING statements pipelined together, rather than N sequential Query
// calls, matching the two-query-in-one-batch shape activity.GetUser already
// uses for the same reason: this endpoint exists specifically to receive a
// sync batch, so N round trips would be the ordinary case, not an edge one.
//
// A conflicting id (one already stored) falls into one of two buckets,
// mirroring activity.Create's ID-collision handling exactly and for the
// identical IDOR reason: ids are client-generated, so without checking
// ownership on the conflict path, a guessed/replayed id belonging to another
// user would either hand back their row or silently swallow the caller's own
// submission under someone else's id.
//
//   - Same user: an ordinary idempotent retry. The existing row is returned
//     as if it had just been inserted.
//   - Different user: ErrAlreadyExists, without disclosing whose row it
//     actually is — ownership is confirmed, never denied by telling the
//     caller who won.
func (r *PostgresRepository) PutSamples(
	ctx context.Context, userID string, samples []Sample,
) ([]Sample, error) {
	if len(samples) == 0 {
		return []Sample{}, nil
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("biometric: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	batch := &pgx.Batch{}
	for _, s := range samples {
		batch.Queue(`
			INSERT INTO biometric_samples
				(id, user_id, metric_type, source, source_platform, value, unit, measured_at, period_end)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (id) DO NOTHING
			RETURNING `+sampleColumns,
			s.ID, userID, string(s.MetricType), string(s.Source), string(s.SourcePlatform),
			s.Value, s.Unit, s.MeasuredAt, s.PeriodEnd)
	}

	br := tx.SendBatch(ctx, batch)
	out := make([]Sample, 0, len(samples))
	var conflictIDs []string
	for range samples {
		row := br.QueryRow()
		saved, err := scanSample(row)
		if errors.Is(err, pgx.ErrNoRows) {
			// Handled after the batch closes below.
			continue
		}
		if err != nil {
			_ = br.Close()
			return nil, translatePgError(err)
		}
		out = append(out, saved)
	}
	// Re-walk to collect the ids that conflicted — QueryRow above doesn't
	// tell us WHICH input produced ErrNoRows without keeping index in
	// lockstep, so track it directly instead of inferring it from `out`.
	if len(out) != len(samples) {
		conflictIDs = missingIDs(samples, out)
	}
	if err := br.Close(); err != nil {
		return nil, translatePgError(err)
	}

	if len(conflictIDs) > 0 {
		existing, err := r.getOwnedByIDs(ctx, tx, conflictIDs, userID)
		if err != nil {
			return nil, err
		}
		if len(existing) != len(conflictIDs) {
			// At least one conflicting id belongs to someone else. Refuse
			// the whole batch rather than partially applying it — a client
			// retrying a partially-applied batch cannot tell which half
			// still needs sending.
			return nil, ErrAlreadyExists
		}
		out = append(out, existing...)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("biometric: commit: %w", err)
	}
	return out, nil
}

// missingIDs returns the DISTINCT ids present in `samples` but not in `out`
// — the ones the batch's ON CONFLICT DO NOTHING swallowed.
//
// Deduplicated on purpose: `getOwnedByIDs` below queries `id = ANY($1)`,
// which naturally collapses to one row per distinct id, so comparing ITS
// result's length against a non-deduplicated missing-id list undercounts the
// moment a batch names the same id twice. That is not a hypothetical input —
// it is exactly what a naive retry of a batch already containing a
// duplicate produces — and the undercount used to read as "an id belongs to
// someone else" (ErrAlreadyExists) for a batch that was actually a
// legitimate, fully-owned retry. A duplicate id within one batch collapses
// to a single conflict here rather than being treated as two.
func missingIDs(samples []Sample, out []Sample) []string {
	got := make(map[string]bool, len(out))
	for _, s := range out {
		got[s.ID] = true
	}
	seen := make(map[string]bool, len(samples))
	var missing []string
	for _, s := range samples {
		if got[s.ID] || seen[s.ID] {
			continue
		}
		seen[s.ID] = true
		missing = append(missing, s.ID)
	}
	return missing
}

func (r *PostgresRepository) getOwnedByIDs(
	ctx context.Context, tx pgx.Tx, ids []string, userID string,
) ([]Sample, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+sampleColumns+`
		FROM biometric_samples
		WHERE id = ANY($1) AND user_id = $2`, ids, userID)
	if err != nil {
		return nil, fmt.Errorf("biometric: get owned by ids: %w", err)
	}
	defer rows.Close()

	var out []Sample
	for rows.Next() {
		s, err := scanSample(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("biometric: get owned by ids rows: %w", err)
	}
	return out, nil
}

// ListSamples returns the caller's own samples of one metric type within
// [from, to], ascending by measured_at, capped at MaxSamplesPerListQuery —
// see that constant's doc comment for why a time-window bound alone isn't
// enough here. `id` breaks ties on an equal measured_at so the cap lands on
// a deterministic row rather than whichever the planner happens to emit
// first, matching activity.ListByUser's own reasoning for the identical
// tiebreak.
func (r *PostgresRepository) ListSamples(
	ctx context.Context, userID string, metricType MetricType, from, to time.Time,
) ([]Sample, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+sampleColumns+`
		FROM biometric_samples
		WHERE user_id = $1 AND metric_type = $2 AND measured_at >= $3 AND measured_at <= $4
		ORDER BY measured_at, id
		LIMIT $5`,
		userID, string(metricType), from, to, MaxSamplesPerListQuery)
	if err != nil {
		return nil, fmt.Errorf("biometric: list samples: %w", err)
	}
	defer rows.Close()

	out := []Sample{}
	for rows.Next() {
		s, err := scanSample(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("biometric: list samples rows: %w", err)
	}
	return out, nil
}

// ComputeSessionMetrics derives and stores session_metrics for a session the
// caller owns, from whatever heart_rate samples fall in that session's
// started_at/ended_at window (design doc §2).
func (r *PostgresRepository) ComputeSessionMetrics(
	ctx context.Context, userID, sessionID string,
	hrMaxBPM float64, hrMaxSource HRMaxSource, hrSourceHint HRSource,
) (SessionMetrics, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return SessionMetrics{}, fmt.Errorf("biometric: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Ownership read, explicit inside the transaction — matches
	// running.PutDetail's stance: the composite owner FK below is a
	// backstop against a race, not the authorization check itself, and it
	// says nothing about ended_at.
	var startedAt time.Time
	var endedAt *time.Time
	err = tx.QueryRow(ctx,
		`SELECT started_at, ended_at FROM sessions WHERE id = $1 AND user_id = $2`,
		sessionID, userID).Scan(&startedAt, &endedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionMetrics{}, ErrNotFound
	}
	if err != nil {
		return SessionMetrics{}, fmt.Errorf("biometric: check session: %w", err)
	}
	if endedAt == nil {
		// A load number needs a finished window — an in-progress session's
		// eventual duration isn't known yet, so there is nothing honest to
		// compute against.
		return SessionMetrics{}, fmt.Errorf("%w: session has not ended yet", ErrInvalidInput)
	}

	hrRows, err := tx.Query(ctx, `
		SELECT measured_at, value FROM biometric_samples
		WHERE user_id = $1 AND metric_type = $2 AND measured_at >= $3 AND measured_at <= $4
		ORDER BY measured_at`,
		userID, string(MetricHeartRate), startedAt, *endedAt)
	if err != nil {
		return SessionMetrics{}, fmt.Errorf("biometric: query hr samples: %w", err)
	}
	var hrSamples []HRSample
	for hrRows.Next() {
		var s HRSample
		if err := hrRows.Scan(&s.MeasuredAt, &s.BPM); err != nil {
			hrRows.Close()
			return SessionMetrics{}, fmt.Errorf("biometric: scan hr sample: %w", err)
		}
		hrSamples = append(hrSamples, s)
	}
	if err := hrRows.Err(); err != nil {
		hrRows.Close()
		return SessionMetrics{}, fmt.Errorf("biometric: hr sample rows: %w", err)
	}
	hrRows.Close()

	var activeKcal *int
	var kcalSum float64
	var kcalCount int
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(value), 0), COUNT(*) FROM biometric_samples
		WHERE user_id = $1 AND metric_type = $2 AND measured_at >= $3 AND measured_at <= $4`,
		userID, string(MetricActiveEnergy), startedAt, *endedAt).Scan(&kcalSum, &kcalCount)
	if err != nil {
		return SessionMetrics{}, fmt.Errorf("biometric: query active energy: %w", err)
	}
	if kcalCount > 0 {
		// Absent (nil), not zero, when nothing was found — same "measured
		// vs. couldn't be measured" distinction TRIMP/TimeInZones take in
		// Compute.
		k := int(kcalSum + 0.5)
		activeKcal = &k
	}

	m := Compute(hrSamples, hrMaxBPM, hrMaxSource, hrSourceHint)
	m.SessionID = sessionID
	m.ActiveKcal = activeKcal
	m.ComputedAt = time.Now().UTC()
	m.RuleVersion = RuleVersion

	zonesJSON, err := json.Marshal(m.TimeInZones)
	if err != nil {
		return SessionMetrics{}, fmt.Errorf("biometric: marshal time_in_zones: %w", err)
	}

	// hr_max_source is stored as *string, not string(m.HRMaxSource) directly
	// — m.HRMaxSource is nil whenever Compute didn't actually classify
	// anything against it (see Compute's doc comment), and that has to reach
	// Postgres as a real NULL, not the empty string HRMaxSource("") would
	// otherwise write past the column's own CHECK constraint.
	var hrMaxSourceParam *string
	if m.HRMaxSource != nil {
		s := string(*m.HRMaxSource)
		hrMaxSourceParam = &s
	}

	row := tx.QueryRow(ctx, `
		INSERT INTO session_metrics
			(session_id, user_id, avg_hr_bpm, max_hr_bpm, active_kcal, trimp,
			 time_in_zones, hr_source, sample_count, computed_at, rule_version,
			 hr_max_bpm, hr_max_source)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (session_id) DO UPDATE SET
			avg_hr_bpm    = excluded.avg_hr_bpm,
			max_hr_bpm    = excluded.max_hr_bpm,
			active_kcal   = excluded.active_kcal,
			trimp         = excluded.trimp,
			time_in_zones = excluded.time_in_zones,
			hr_source     = excluded.hr_source,
			sample_count  = excluded.sample_count,
			computed_at   = excluded.computed_at,
			rule_version  = excluded.rule_version,
			hr_max_bpm    = excluded.hr_max_bpm,
			hr_max_source = excluded.hr_max_source
		-- Load-bearing exactly as in running.PutDetail: Postgres skips the
		-- referencing FK check on DO UPDATE when session_id/user_id don't
		-- change, so this predicate is what stops one athlete's recompute
		-- from overwriting another's row if a bug ever let a call reach
		-- this far with the wrong user_id.
		WHERE session_metrics.user_id = $2
		RETURNING session_id, avg_hr_bpm, max_hr_bpm, active_kcal, trimp,
			time_in_zones, hr_source, sample_count, computed_at, rule_version,
			hr_max_bpm, hr_max_source`,
		sessionID, userID, m.AvgHRBPM, m.MaxHRBPM, m.ActiveKcal, m.TRIMP,
		zonesJSON, string(m.HRSource), m.SampleCount, m.ComputedAt, m.RuleVersion,
		m.HRMaxBPM, hrMaxSourceParam)

	out, err := scanSessionMetrics(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionMetrics{}, ErrNotFound
	}
	if err != nil {
		return SessionMetrics{}, translatePgError(err)
	}

	if err := tx.Commit(ctx); err != nil {
		return SessionMetrics{}, fmt.Errorf("biometric: commit: %w", err)
	}
	return out, nil
}

// GetSessionMetrics reads back a previously computed row.
func (r *PostgresRepository) GetSessionMetrics(
	ctx context.Context, userID, sessionID string,
) (SessionMetrics, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT session_id, avg_hr_bpm, max_hr_bpm, active_kcal, trimp,
			time_in_zones, hr_source, sample_count, computed_at, rule_version,
			hr_max_bpm, hr_max_source
		FROM session_metrics
		WHERE session_id = $1 AND user_id = $2`, sessionID, userID)

	m, err := scanSessionMetrics(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionMetrics{}, ErrNotFound
	}
	if err != nil {
		return SessionMetrics{}, fmt.Errorf("biometric: get session metrics: %w", err)
	}
	return m, nil
}

// ListSessionLoad returns the caller's own sessions with a computed TRIMP in
// [from, to], ascending by started_at — see the Repository interface's doc
// comment for why this is one JOIN rather than N calls to
// GetSessionMetrics.
//
// `trimp IS NOT NULL` is the whole of the "exclude hr_source='none' /
// never-enriched sessions honestly" rule: Compute (trimp.go) only ever
// writes a non-nil trimp when real samples were classified against a real
// HRmax, so this single predicate already encodes the same gate
// SessionMetrics.TRIMP's own doc comment describes — a second, redundant
// hr_source check would just be re-deriving what trimp's nullness already
// says.
func (r *PostgresRepository) ListSessionLoad(
	ctx context.Context, userID string, from, to time.Time,
) ([]SessionLoad, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT s.id, s.sport, s.started_at, m.trimp
		FROM sessions s
		JOIN session_metrics m ON m.session_id = s.id
		WHERE s.user_id = $1 AND m.user_id = $1
			AND m.trimp IS NOT NULL
			AND s.started_at >= $2 AND s.started_at <= $3
		ORDER BY s.started_at, s.id`,
		userID, from, to)
	if err != nil {
		return nil, fmt.Errorf("biometric: list session load: %w", err)
	}
	defer rows.Close()

	out := []SessionLoad{}
	for rows.Next() {
		var l SessionLoad
		if err := rows.Scan(&l.SessionID, &l.Sport, &l.StartedAt, &l.TRIMP); err != nil {
			return nil, fmt.Errorf("biometric: scan session load: %w", err)
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("biometric: list session load rows: %w", err)
	}
	return out, nil
}

// scanner is the slice of pgx.Row/pgx.Rows this file's scan functions need,
// matching running's own.
type scanner interface {
	Scan(dest ...any) error
}

func scanSample(s scanner) (Sample, error) {
	var (
		out        Sample
		metricType string
		source     string
		platform   string
	)
	err := s.Scan(&out.ID, &metricType, &source, &platform, &out.Value, &out.Unit,
		&out.MeasuredAt, &out.PeriodEnd, &out.CreatedAt)
	if err != nil {
		return Sample{}, err
	}
	out.MetricType = MetricType(metricType)
	out.Source = Source(source)
	out.SourcePlatform = SourcePlatform(platform)
	return out, nil
}

func scanSessionMetrics(s scanner) (SessionMetrics, error) {
	var (
		out         SessionMetrics
		zonesJSON   []byte
		hrSource    string
		hrMaxSource *string
	)
	err := s.Scan(&out.SessionID, &out.AvgHRBPM, &out.MaxHRBPM, &out.ActiveKcal, &out.TRIMP,
		&zonesJSON, &hrSource, &out.SampleCount, &out.ComputedAt, &out.RuleVersion,
		&out.HRMaxBPM, &hrMaxSource)
	if err != nil {
		return SessionMetrics{}, err
	}
	out.HRSource = HRSource(hrSource)
	if hrMaxSource != nil {
		v := HRMaxSource(*hrMaxSource)
		out.HRMaxSource = &v
	}
	if err := json.Unmarshal(zonesJSON, &out.TimeInZones); err != nil {
		return SessionMetrics{}, fmt.Errorf("biometric: unmarshal time_in_zones: %w", err)
	}
	if out.TimeInZones == nil {
		out.TimeInZones = map[string]float64{}
	}
	return out, nil
}
