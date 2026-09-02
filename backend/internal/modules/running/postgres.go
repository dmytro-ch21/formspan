package running

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

const detailColumns = `
	session_id, route_points, splits, elevation_gain_m, avg_pace_sec_per_km,
	distance_m, duration_seconds, source, created_at, updated_at`

// translatePgError turns constraint violations into domain errors.
//
// Mirrors bjj.translateSessionPgError. The interesting one is the owner
// foreign key: `running_session_detail` references `sessions (id, user_id)`
// as a pair, so a write naming a session that does not exist — or belongs to
// somebody else — is refused by the database itself, as a backstop behind
// the explicit ownership check in PutDetail (which covers what the FK
// cannot: sport, and the upsert's DO UPDATE path — see the WHERE clause
// there).
func translatePgError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23503": // foreign_key_violation
		return ErrNotFound
	case "23514": // check_violation
		return fmt.Errorf("%w: a value is out of range", ErrInvalidInput)
	case "22003": // numeric_value_out_of_range
		return fmt.Errorf("%w: a value is too large", ErrInvalidInput)
	}
	return err
}

// PutDetail upserts the running detail for a session, replacing the route
// and splits wholesale.
//
// One statement rather than bjj's transaction-plus-batch: the route and
// splits live in this same row as JSONB rather than in child tables, so
// there is no second write to keep in step with the first. Chosen over a
// per-point table because nothing here ever queries across sessions by
// point or by split — no funnel, no heatmap, the way bjj's tags need one —
// so the relational cost of a child table buys nothing, while a run's track
// can be thousands of points that would otherwise be thousands of round
// trips inside one transaction on every save.
func (r *PostgresRepository) PutDetail(
	ctx context.Context, userID string, d SessionDetail,
) (SessionDetail, error) {
	points, err := json.Marshal(routePointsOrEmpty(d.RoutePoints))
	if err != nil {
		return SessionDetail{}, fmt.Errorf("running: marshal route_points: %w", err)
	}
	splits, err := json.Marshal(splitsOrEmpty(d.Splits))
	if err != nil {
		return SessionDetail{}, fmt.Errorf("running: marshal splits: %w", err)
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return SessionDetail{}, fmt.Errorf("running: begin: %w", err)
	}
	// No-op once committed — the pgx idiom for "roll back unless we reached
	// the end".
	defer func() { _ = tx.Rollback(ctx) }()

	// Ownership AND sport, read explicitly inside the transaction — the
	// composite owner FK alone cannot do this job. See bjj.PutDetail's note
	// on the same check: it says nothing about sport, and it does not fire
	// at all on the upsert's DO UPDATE path below.
	var sport string
	err = tx.QueryRow(ctx,
		`SELECT sport FROM sessions WHERE id = $1 AND user_id = $2`,
		d.SessionID, userID).Scan(&sport)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionDetail{}, ErrNotFound
	}
	if err != nil {
		return SessionDetail{}, fmt.Errorf("running: check session: %w", err)
	}
	// A session of another sport answers exactly as a missing one does —
	// telling the two apart would confirm the id belongs to somebody's
	// account. Same stance as bjj.
	if sport != sportKey {
		return SessionDetail{}, ErrNotFound
	}

	row := tx.QueryRow(ctx, `
		INSERT INTO running_session_detail
			(session_id, user_id, route_points, splits, elevation_gain_m,
			 avg_pace_sec_per_km, distance_m, duration_seconds, source)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (session_id) DO UPDATE SET
			route_points        = excluded.route_points,
			splits              = excluded.splits,
			elevation_gain_m    = excluded.elevation_gain_m,
			avg_pace_sec_per_km = excluded.avg_pace_sec_per_km,
			distance_m          = excluded.distance_m,
			duration_seconds    = excluded.duration_seconds,
			source              = excluded.source,
			updated_at          = now()
		-- Load-bearing, exactly as in bjj.PutDetail: on the INSERT path the
		-- composite owner FK rejects a session that is not this caller's,
		-- but Postgres skips that referential-integrity check on DO UPDATE
		-- when no referencing column changes — and this update rewrites only
		-- payload columns, never session_id or user_id. So for an existing
		-- row this predicate is the only thing standing between one
		-- athlete and another's run. See
		-- TestUpsertPredicateRefusesACrossUserUpdateAtTheSQLLevel, which
		-- exercises this statement directly rather than through the
		-- repository, because no repository call can reach a deleted
		-- version of this line: the ownership SELECT above answers first.
		WHERE running_session_detail.user_id = $2
		RETURNING `+detailColumns,
		d.SessionID, userID, points, splits, d.ElevationGainM,
		d.AvgPaceSecPerKm, d.DistanceM, d.DurationSeconds, string(d.Source))

	out, err := scanDetail(row)
	if errors.Is(err, pgx.ErrNoRows) {
		// The row exists but the WHERE above excluded it — someone else
		// owns this session id. Same non-disclosure answer as "no such
		// session".
		return SessionDetail{}, ErrNotFound
	}
	if err != nil {
		return SessionDetail{}, translatePgError(err)
	}

	if err := tx.Commit(ctx); err != nil {
		return SessionDetail{}, fmt.Errorf("running: commit: %w", err)
	}
	return out, nil
}

func (r *PostgresRepository) GetDetail(
	ctx context.Context, userID, sessionID string,
) (SessionDetail, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT `+detailColumns+`
		FROM running_session_detail
		WHERE session_id = $1 AND user_id = $2`, sessionID, userID)

	d, err := scanDetail(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionDetail{}, ErrNotFound
	}
	if err != nil {
		return SessionDetail{}, fmt.Errorf("running: get: %w", err)
	}
	return d, nil
}

// scanner is the slice of pgx.Row/pgx.Rows this package's scan functions
// need, matching bjj's own.
type scanner interface {
	Scan(dest ...any) error
}

func scanDetail(s scanner) (SessionDetail, error) {
	var (
		d         SessionDetail
		points    []byte
		splits    []byte
		source    string
		createdAt time.Time
		updatedAt time.Time
	)
	err := s.Scan(&d.SessionID, &points, &splits, &d.ElevationGainM,
		&d.AvgPaceSecPerKm, &d.DistanceM, &d.DurationSeconds, &source,
		&createdAt, &updatedAt)
	if err != nil {
		return SessionDetail{}, err
	}
	d.Source = Source(source)
	d.CreatedAt = createdAt
	d.UpdatedAt = updatedAt

	if err := json.Unmarshal(points, &d.RoutePoints); err != nil {
		return SessionDetail{}, fmt.Errorf("running: unmarshal route_points: %w", err)
	}
	if err := json.Unmarshal(splits, &d.Splits); err != nil {
		return SessionDetail{}, fmt.Errorf("running: unmarshal splits: %w", err)
	}
	// Non-nil empty slices: this marshals to [] rather than null, same
	// convention as bjj.listTags, so a client can iterate without a null
	// check.
	if d.RoutePoints == nil {
		d.RoutePoints = []RoutePoint{}
	}
	if d.Splits == nil {
		d.Splits = []Split{}
	}
	return d, nil
}

func routePointsOrEmpty(p []RoutePoint) []RoutePoint {
	if p == nil {
		return []RoutePoint{}
	}
	return p
}

func splitsOrEmpty(s []Split) []Split {
	if s == nil {
		return []Split{}
	}
	return s
}
