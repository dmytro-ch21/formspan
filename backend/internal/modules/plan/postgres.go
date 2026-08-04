package plan

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// maxRangeDays bounds a single List. Wide enough for a year view, which is the
// largest thing any client draws; without it a caller could ask for a decade
// and make the database sort a table scan for a screen that renders 31 cells.
const maxRangeDays = 400

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

// translatePgError turns constraint violations into domain errors, so bad
// input reaches the client as 400/409 rather than 500.
//
// Deliberately omits pgErr.Message — Postgres messages name constraints and
// sometimes the offending value, and this text goes to the client.
func translatePgError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23505": // unique_violation — only the primary key exists here.
		return ErrAlreadyExists
	case "23514": // check_violation
		if strings.Contains(pgErr.ConstraintName, "sport") {
			return fmt.Errorf("%w: unknown sport", ErrInvalidInput)
		}
		if strings.Contains(pgErr.ConstraintName, "notes") {
			return fmt.Errorf("%w: notes are too long", ErrInvalidInput)
		}
		return ErrInvalidInput
	case "23503": // foreign_key_violation — workout_id is the only FK.
		return fmt.Errorf("%w: unknown workout", ErrInvalidInput)
	case "22007", "22008": // invalid/out-of-range datetime
		return fmt.Errorf("%w: day must be a calendar date (YYYY-MM-DD)", ErrInvalidInput)
	}
	return err
}

// selectColumns is shared by every read so the row scan below cannot drift
// from the projection. `day` is cast to text in Postgres rather than scanned
// into a time.Time and reformatted in Go: pgx hands back a DATE as midnight in
// some zone, and every one of those conversions is a chance to move the plan
// onto the previous day. The database already knows the calendar date; asking
// for it as text is asking it not to help.
const selectColumns = `id, user_id, to_char(day, 'YYYY-MM-DD'), sport, workout_id, notes, created_at, updated_at`

func scanPlan(row pgx.Row) (*Plan, error) {
	var p Plan
	if err := row.Scan(
		&p.ID, &p.UserID, &p.Day, &p.Sport, &p.WorkoutID, &p.Notes, &p.CreatedAt, &p.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &p, nil
}

func (r *PostgresRepository) List(ctx context.Context, userID string, rng Range) ([]Plan, error) {
	from, err := time.Parse(DayLayout, rng.From)
	if err != nil {
		return nil, fmt.Errorf("%w: from must be a calendar date (YYYY-MM-DD)", ErrInvalidInput)
	}
	to, err := time.Parse(DayLayout, rng.To)
	if err != nil {
		return nil, fmt.Errorf("%w: to must be a calendar date (YYYY-MM-DD)", ErrInvalidInput)
	}
	if to.Before(from) {
		return nil, fmt.Errorf("%w: to must not be before from", ErrInvalidInput)
	}
	// Whole days, computed by date arithmetic rather than by dividing a
	// Duration: a range spanning a DST boundary is 23 or 25 hours on one of
	// its days, so hours/24 is off by one twice a year.
	if to.Sub(from).Hours()/24 > maxRangeDays {
		return nil, fmt.Errorf("%w: range must be %d days or fewer", ErrInvalidInput, maxRangeDays)
	}

	// Ordered by created_at within a day so a two-a-day keeps the order it was
	// planned in — the clients render the list top to bottom and would
	// otherwise shuffle the morning and evening sessions between reads.
	rows, err := r.pool.Query(ctx, `
		SELECT `+selectColumns+`
		  FROM plans
		 WHERE user_id = $1 AND day >= $2 AND day <= $3
		 ORDER BY day ASC, created_at ASC`,
		userID, from, to,
	)
	if err != nil {
		return nil, translatePgError(err)
	}
	defer rows.Close()

	// Non-nil so an empty week marshals as [] rather than null — a client
	// mapping over the result should not have to special-case "no plans".
	out := []Plan{}
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// Get is scoped by user_id, not just id.
//
// Ids are client-generated and therefore guessable, so an id-only lookup is a
// cross-user read — the IDOR this codebase has already closed twice in other
// modules. A plan belonging to someone else must be indistinguishable from one
// that does not exist, which is why this returns ErrNotFound rather than a
// forbidden error.
func (r *PostgresRepository) Get(ctx context.Context, userID, id string) (*Plan, error) {
	p, err := scanPlan(r.pool.QueryRow(ctx,
		`SELECT `+selectColumns+` FROM plans WHERE id = $1 AND user_id = $2`, id, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, translatePgError(err)
	}
	return p, nil
}

func (r *PostgresRepository) Create(ctx context.Context, userID string, in NewPlan) (*Plan, error) {
	day, err := time.Parse(DayLayout, in.Day)
	if err != nil {
		return nil, fmt.Errorf("%w: day must be a calendar date (YYYY-MM-DD)", ErrInvalidInput)
	}

	p, err := scanPlan(r.pool.QueryRow(ctx, `
		INSERT INTO plans (id, user_id, day, sport, workout_id, notes)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING `+selectColumns,
		in.ID, userID, day, in.Sport, in.WorkoutID, in.Notes,
	))
	if err != nil {
		return nil, translatePgError(err)
	}
	return p, nil
}

// Update applies only the fields the caller set.
//
// Built as a COALESCE over typed parameters rather than a string-concatenated
// SET list: the latter is where injection and "0 fields set" bugs live, and
// this way the statement is constant and the planner caches it.
//
// The WorkoutID triple-state is handled by a companion boolean — `$5` says
// whether to touch the column at all, so passing NULL genuinely clears it
// instead of meaning "leave alone", which is what a bare COALESCE would do.
func (r *PostgresRepository) Update(ctx context.Context, userID, id string, in PlanUpdate) (*Plan, error) {
	var day *time.Time
	if in.Day != nil {
		d, err := time.Parse(DayLayout, *in.Day)
		if err != nil {
			return nil, fmt.Errorf("%w: day must be a calendar date (YYYY-MM-DD)", ErrInvalidInput)
		}
		day = &d
	}

	setWorkout := in.WorkoutID != nil
	var workoutID *string
	if setWorkout {
		workoutID = *in.WorkoutID
	}

	p, err := scanPlan(r.pool.QueryRow(ctx, `
		UPDATE plans
		   SET day        = COALESCE($3, day),
		       sport      = COALESCE($4, sport),
		       workout_id = CASE WHEN $5 THEN $6 ELSE workout_id END,
		       notes      = COALESCE($7, notes),
		       updated_at = now()
		 WHERE id = $1 AND user_id = $2
		 RETURNING `+selectColumns,
		id, userID, day, in.Sport, setWorkout, workoutID, in.Notes,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, translatePgError(err)
	}
	return p, nil
}

// Delete removes one plan. Scoped by user_id for the same reason Get is.
//
// A hard delete, not a tombstone. A plan carries no history worth keeping —
// unlike a session, deleting it destroys nothing that was ever performed —
// and the mobile client's own plan table is local-only, so there is no
// tombstone protocol to honour here yet.
func (r *PostgresRepository) Delete(ctx context.Context, userID, id string) error {
	tag, err := r.pool.Exec(ctx, `DELETE FROM plans WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return translatePgError(err)
	}
	// Checked rather than assumed: without this, deleting someone else's plan
	// (or one that never existed) returns 204 and tells the caller it worked.
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
