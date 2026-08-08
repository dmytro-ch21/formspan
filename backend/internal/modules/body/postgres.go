package body

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct{ pool *pgxpool.Pool }

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

// translate turns a constraint violation into a domain error.
//
// The house rule, restated because it is the one that matters: **a raw SQL
// error must never escape a repository.** A constraint name in a 500 tells a
// client nothing it can act on and tells an attacker the schema.
func translate(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation
			// The only unique index here is the one-live-phase-per-athlete
			// partial index, so this is unambiguous — but it is matched on the
			// constraint NAME rather than assumed, so a second index added
			// later cannot silently inherit this message.
			if pgErr.ConstraintName == "body_phases_one_live_per_user" {
				return ErrPhaseActive
			}
			return fmt.Errorf("%w: that already exists", ErrInvalidInput)
		case "22P02": // invalid_text_representation — a malformed UUID
			return fmt.Errorf("%w: id must be a UUID", ErrInvalidInput)
		case "23514": // check_violation
			// Domain validation catches these first and says which field.
			// Reaching here means a path skipped Validate, so the message is
			// deliberately generic rather than leaking the constraint name.
			return fmt.Errorf("%w: a measurement is out of range", ErrInvalidInput)
		}
	}
	return err
}

const checkinCols = `
	user_id, measured_on::text, weight_kg,
	neck_cm, shoulders_cm, chest_cm, waist_cm, hips_cm,
	thigh_cm, calf_cm, upper_arm_cm, forearm_cm,
	measured_side, photo_key, notes, created_at, updated_at`

func scanCheckin(row pgx.Row) (Checkin, error) {
	var c Checkin
	err := row.Scan(
		&c.UserID, &c.MeasuredOn, &c.WeightKG,
		&c.NeckCM, &c.ShouldersCM, &c.ChestCM, &c.WaistCM, &c.HipsCM,
		&c.ThighCM, &c.CalfCM, &c.UpperArmCM, &c.ForearmCM,
		&c.MeasuredSide, &c.PhotoKey, &c.Notes, &c.CreatedAt, &c.UpdatedAt,
	)
	return c, err
}

// ListCheckins returns the caller's check-ins in [from, to], newest first.
//
// Both bounds are required by the handler. An unbounded list grows for the life
// of the account and every caller wants a window anyway — the same rule the
// themes module documents.
func (r *PostgresRepository) ListCheckins(ctx context.Context, userID, from, to string) ([]Checkin, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+checkinCols+`
		FROM body_checkins
		WHERE user_id = $1 AND measured_on BETWEEN $2::date AND $3::date
		ORDER BY measured_on DESC`, userID, from, to)
	if err != nil {
		return nil, translate(fmt.Errorf("body: list check-ins: %w", err))
	}
	defer rows.Close()

	// Non-nil, so an athlete with no history encodes as [] and not null — the
	// house convention at every parse boundary in the clients.
	out := make([]Checkin, 0)
	for rows.Next() {
		c, err := scanCheckin(rows)
		if err != nil {
			return nil, translate(fmt.Errorf("body: scan check-in: %w", err))
		}
		out = append(out, c)
	}
	return out, translate(rows.Err())
}

func (r *PostgresRepository) GetCheckin(ctx context.Context, userID, on string) (Checkin, error) {
	c, err := scanCheckin(r.pool.QueryRow(ctx, `
		SELECT `+checkinCols+`
		FROM body_checkins WHERE user_id = $1 AND measured_on = $2::date`, userID, on))
	if errors.Is(err, pgx.ErrNoRows) {
		return Checkin{}, ErrNotFound
	}
	if err != nil {
		return Checkin{}, translate(fmt.Errorf("body: get check-in: %w", err))
	}
	return c, nil
}

/*
SaveCheckin upserts one day.

**An upsert, not a create**, and that is what makes an offline check-in safe to
re-send: the primary key is (user_id, measured_on), so a retry after a lost
response updates the same row instead of failing or duplicating the day. Same
contract the activity outbox and the session push already depend on.

`COALESCE(EXCLUDED.x, body_checkins.x)` on every measure is deliberate and is
the difference between two mental models. A weekly girth check-in sends girths
and no weight; without the coalesce it would erase the weight recorded that
morning. So **absent means "not measured", never "measured as nothing"** —
which is also why clearing a value is a DELETE of the day rather than a save
with nulls.
*/
func (r *PostgresRepository) SaveCheckin(ctx context.Context, c Checkin) (Checkin, error) {
	// NULL rather than a default, so the COALESCE below can tell "not stated"
	// from "stated as right".
	var side *Side
	if c.MeasuredSide != "" {
		side = &c.MeasuredSide
	}
	saved, err := scanCheckin(r.pool.QueryRow(ctx, `
		INSERT INTO body_checkins (
			user_id, measured_on, weight_kg,
			neck_cm, shoulders_cm, chest_cm, waist_cm, hips_cm,
			thigh_cm, calf_cm, upper_arm_cm, forearm_cm,
			measured_side, photo_key, notes)
		VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
			-- COALESCE, not the column DEFAULT: a default only applies when the
			-- column is OMITTED from the insert, and this statement always names
			-- it. Passing NULL through would violate NOT NULL.
			COALESCE($13, 'right'), $14, $15)
		ON CONFLICT (user_id, measured_on) DO UPDATE SET
			weight_kg     = COALESCE(EXCLUDED.weight_kg,     body_checkins.weight_kg),
			neck_cm       = COALESCE(EXCLUDED.neck_cm,       body_checkins.neck_cm),
			shoulders_cm  = COALESCE(EXCLUDED.shoulders_cm,  body_checkins.shoulders_cm),
			chest_cm      = COALESCE(EXCLUDED.chest_cm,      body_checkins.chest_cm),
			waist_cm      = COALESCE(EXCLUDED.waist_cm,      body_checkins.waist_cm),
			hips_cm       = COALESCE(EXCLUDED.hips_cm,       body_checkins.hips_cm),
			thigh_cm      = COALESCE(EXCLUDED.thigh_cm,      body_checkins.thigh_cm),
			calf_cm       = COALESCE(EXCLUDED.calf_cm,       body_checkins.calf_cm),
			upper_arm_cm  = COALESCE(EXCLUDED.upper_arm_cm,  body_checkins.upper_arm_cm),
			forearm_cm    = COALESCE(EXCLUDED.forearm_cm,    body_checkins.forearm_cm),
			-- Coalesced against the PARAMETER, not against EXCLUDED: EXCLUDED
			-- already carries the insert's COALESCE to 'right', so reading
			-- it here would see "right" for a caller who said nothing and
			-- relabel a left-side series anyway — the exact bug this is fixing.
			measured_side = COALESCE($13, body_checkins.measured_side),
			photo_key     = COALESCE(EXCLUDED.photo_key,     body_checkins.photo_key),
			-- Notes are replaced rather than coalesced: an empty note is a
			-- real edit ("delete what I wrote"), where an absent measurement
			-- is not.
			notes         = EXCLUDED.notes,
			updated_at    = now()
		RETURNING `+checkinCols,
		c.UserID, c.MeasuredOn, c.WeightKG,
		c.NeckCM, c.ShouldersCM, c.ChestCM, c.WaistCM, c.HipsCM,
		c.ThighCM, c.CalfCM, c.UpperArmCM, c.ForearmCM,
		side, c.PhotoKey, c.Notes))
	if err != nil {
		return Checkin{}, translate(fmt.Errorf("body: save check-in: %w", err))
	}
	return saved, nil
}

// AttachPhotoKey writes only the key — see the Repository doc for why this is
// not a SaveCheckin with one field set.
func (r *PostgresRepository) AttachPhotoKey(ctx context.Context, userID, on, key string) (Checkin, error) {
	c, err := scanCheckin(r.pool.QueryRow(ctx, `
		INSERT INTO body_checkins (user_id, measured_on, photo_key)
		VALUES ($1, $2::date, $3)
		ON CONFLICT (user_id, measured_on) DO UPDATE SET
			photo_key  = EXCLUDED.photo_key,
			updated_at = now()
		RETURNING `+checkinCols, userID, on, key))
	if err != nil {
		return Checkin{}, translate(fmt.Errorf("body: attach photo: %w", err))
	}
	return c, nil
}

func (r *PostgresRepository) DeleteCheckin(ctx context.Context, userID, on string) error {
	tag, err := r.pool.Exec(ctx,
		`DELETE FROM body_checkins WHERE user_id = $1 AND measured_on = $2::date`, userID, on)
	if err != nil {
		return translate(fmt.Errorf("body: delete check-in: %w", err))
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

const phaseCols = `
	id::text, user_id, kind, started_on::text, target_on::text,
	target_weight_kg, ended_on::text, notes, created_at, updated_at`

func scanPhase(row pgx.Row) (Phase, error) {
	var p Phase
	err := row.Scan(&p.ID, &p.UserID, &p.Kind, &p.StartedOn, &p.TargetOn,
		&p.TargetWeightKG, &p.EndedOn, &p.Notes, &p.CreatedAt, &p.UpdatedAt)
	return p, err
}

// ListPhases returns every phase, newest first — the live one, then history.
func (r *PostgresRepository) ListPhases(ctx context.Context, userID string) ([]Phase, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT `+phaseCols+` FROM body_phases WHERE user_id = $1 ORDER BY started_on DESC, created_at DESC`,
		userID)
	if err != nil {
		return nil, translate(fmt.Errorf("body: list phases: %w", err))
	}
	defer rows.Close()

	out := make([]Phase, 0)
	for rows.Next() {
		p, err := scanPhase(rows)
		if err != nil {
			return nil, translate(fmt.Errorf("body: scan phase: %w", err))
		}
		out = append(out, p)
	}
	return out, translate(rows.Err())
}

// ActivePhase returns the one phase with no end date, or ErrNotFound.
//
// The partial unique index guarantees there is at most one, so this needs no
// ordering and no tiebreak — the constraint is what makes the query honest
// rather than a LIMIT 1 over an ambiguous set.
func (r *PostgresRepository) ActivePhase(ctx context.Context, userID string) (Phase, error) {
	p, err := scanPhase(r.pool.QueryRow(ctx,
		`SELECT `+phaseCols+` FROM body_phases WHERE user_id = $1 AND ended_on IS NULL`, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Phase{}, ErrNotFound
	}
	if err != nil {
		return Phase{}, translate(fmt.Errorf("body: active phase: %w", err))
	}
	return p, nil
}

// CreatePhase starts one. A second live phase is refused by the index, which
// `translate` turns into ErrPhaseActive — a 409, because the caller's fix is to
// end the running one rather than to correct their input.
func (r *PostgresRepository) CreatePhase(ctx context.Context, p Phase) (Phase, error) {
	/*
		`ON CONFLICT (id) DO NOTHING` then re-fetch — the shape `activity` uses,
		and for the same reason. A plain INSERT made the client-generated id
		pointless: a retried create hit the primary key and came back 400
		"that already exists", which is both the wrong status for a conflict and
		a lie about the caller's input. Raised in review.

		The re-fetch is scoped to (id, user_id). Unscoped it would return
		somebody else's phase to whoever guessed a UUID — the exact disclosure
		the activity module's comment documents.

		The one-live-phase partial index still raises through this clause, so
		ErrPhaseActive keeps working: the conflict target names `id` only.
	*/
	created, err := scanPhase(r.pool.QueryRow(ctx, `
		WITH inserted AS (
			INSERT INTO body_phases (id, user_id, kind, started_on, target_on, target_weight_kg, notes)
			VALUES ($1, $2, $3, $4::date, $5::date, $6, $7)
			ON CONFLICT (id) DO NOTHING
			RETURNING `+phaseCols+`
		)
		SELECT * FROM inserted
		UNION ALL
		SELECT `+phaseCols+` FROM body_phases
		WHERE id = $1 AND user_id = $2 AND NOT EXISTS (SELECT 1 FROM inserted)`,
		p.ID, p.UserID, p.Kind, p.StartedOn, p.TargetOn, p.TargetWeightKG, p.Notes))
	if errors.Is(err, pgx.ErrNoRows) {
		// The id exists and belongs to somebody else. A 404-shaped answer
		// rather than a "that exists" oracle.
		return Phase{}, ErrNotFound
	}
	if err != nil {
		return Phase{}, translate(fmt.Errorf("body: create phase: %w", err))
	}
	return created, nil
}

// EndPhase closes one.
//
// Scoped by user_id as well as id — the rule every read and write in this
// codebase follows, and the one whose absence has been the source of the
// cross-user enumeration bugs review has caught twice. An id belonging to
// somebody else is a 404 here, not a 403: confirming the id exists is itself
// the leak.
//
// `ended_on IS NULL` in the predicate makes it idempotent: ending an
// already-ended phase is a 404 rather than a silent second write that would
// move the recorded end date.
func (r *PostgresRepository) EndPhase(ctx context.Context, userID, id, on string) (Phase, error) {
	p, err := scanPhase(r.pool.QueryRow(ctx, `
		UPDATE body_phases SET ended_on = $3::date, updated_at = now()
		WHERE user_id = $1 AND id = $2 AND ended_on IS NULL
		RETURNING `+phaseCols, userID, id, on))
	if errors.Is(err, pgx.ErrNoRows) {
		return Phase{}, ErrNotFound
	}
	if err != nil {
		return Phase{}, translate(fmt.Errorf("body: end phase: %w", err))
	}
	return p, nil
}
