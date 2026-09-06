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

// maxPlans bounds a single List independently of the day window.
//
// The window caps how much CALENDAR a caller can ask for; it says nothing
// about how many plans live in it. Two-a-days are supported and there is no
// unique constraint per day, so a single day can hold arbitrarily many rows —
// which makes the day cap alone an unbounded response. Far above any real
// year of training, so it never truncates a genuine calendar; the response is
// already wrapped in an object rather than a bare array so paging can be added
// without breaking clients.
const maxPlans = 2000

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
		if strings.Contains(pgErr.ConstraintName, "one_template_kind") {
			return fmt.Errorf("%w: a plan may reference a workout or a class plan, not both", ErrInvalidInput)
		}
		if strings.Contains(pgErr.ConstraintName, "time_of_day_minutes") {
			return fmt.Errorf("%w: time_of_day_minutes must be between 0 and %d, or null",
				ErrInvalidInput, MaxTimeOfDayMinutes)
		}
		return ErrInvalidInput
	case "23503": // foreign_key_violation — workout_id and class_plan_id are the two FKs.
		if strings.Contains(pgErr.ConstraintName, "class_plan") {
			return fmt.Errorf("%w: unknown class plan", ErrInvalidInput)
		}
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
const selectColumns = `id, user_id, to_char(day, 'YYYY-MM-DD'), sport, workout_id, class_plan_id, time_of_day_minutes, notes, created_at, updated_at`

func scanPlan(row pgx.Row) (*Plan, error) {
	var p Plan
	if err := row.Scan(
		&p.ID, &p.UserID, &p.Day, &p.Sport, &p.WorkoutID, &p.ClassPlanID, &p.TimeOfDayMinutes,
		&p.Notes, &p.CreatedAt, &p.UpdatedAt,
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
	// Counted INCLUSIVELY, matching the range itself and the spec: 1 Jan to
	// 5 Feb the following year is a 400-day difference but 401 days of
	// calendar, and the documented limit is "wider than 400 days is a 400".
	//
	// Dividing a Duration is safe here only because `time.Parse` with
	// `DayLayout` always yields UTC, where every day is exactly 24 hours. An
	// earlier comment claimed this was date arithmetic chosen to survive DST;
	// it was not, and stating a safety property the code does not implement is
	// how the next person introduces the bug it warns about.
	if int(to.Sub(from).Hours()/24)+1 > maxRangeDays {
		return nil, fmt.Errorf("%w: range must be %d days or fewer", ErrInvalidInput, maxRangeDays)
	}

	// Ordered by time_of_day_minutes within a day (N126/#520) — a two-a-day
	// with times set now reads in the order the athlete will actually meet
	// them, which `created_at` (the order they were PLANNED in) cannot
	// promise. `NULLS LAST` is Postgres's own default for ASC (kept explicit
	// here for readability, not because leaving it off would change the
	// result — found in review, backend-reviewer, correcting an earlier
	// version of this comment that claimed otherwise): an untimed plan
	// carries no claim about when in the day it falls, so it renders after
	// every plan that does.
	//
	// created_at is the tiebreak for two plans that share a time (or share
	// having none) — preserving the original "insertion order within a day"
	// behavior for everything this column cannot distinguish. `id` remains
	// the final tiebreak beneath that, for the reason already given: two
	// plans pushed in one sync batch can share created_at exactly, since it
	// is TRANSACTION time. `api-conventions.md` requires a tiebreak on every
	// ordered list for this reason — never a timestamp alone.
	rows, err := r.pool.Query(ctx, `
		SELECT `+selectColumns+`
		  FROM plans
		 WHERE user_id = $1 AND day >= $2 AND day <= $3
		 ORDER BY day ASC, time_of_day_minutes ASC NULLS LAST, created_at ASC, id ASC
		 LIMIT $4`,
		userID, from, to, maxPlans,
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

// assertWorkoutUsable resolves a plan's workout_id under the same visibility
// rule the workout module reads by, and checks the disciplines agree.
//
// **Not optional.** Without it a caller could POST a plan naming any workout
// id and read the outcome as an oracle: a visible id inserts and returns 201,
// a nonexistent one trips the foreign key and returns 400. Workout ids are
// client-generated and therefore often guessable ("push-day-a"), which makes
// that a practical way to enumerate other people's private templates — and
// the plan row then persists a pointer into another user's data.
//
// This is a verbatim port of `session.assertWorkoutUsable`, and the third time
// this bug class has had to be closed in this codebase: the workout write
// paths first, then sessions, now plans. The comment there says it "came back
// through a different door"; this was a third door.
//
// Hence ONE indistinguishable error for "no such workout" and "not yours" —
// the two must not be tellable apart.
func assertWorkoutUsable(ctx context.Context, tx pgx.Tx, workoutID *string, userID, sport string) error {
	if workoutID == nil {
		return nil
	}
	var wSport string
	err := tx.QueryRow(ctx, `
		SELECT sport FROM workouts
		WHERE id = $1 AND (owner_user_id = $2 OR owner_user_id IS NULL OR visibility = 'public')`,
		*workoutID, userID).Scan(&wSport)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: unknown workout", ErrInvalidInput)
	}
	if err != nil {
		return fmt.Errorf("plan: check workout: %w", err)
	}
	// `plans.sport` is chosen by the client, not derived from the workout, so
	// nothing in the schema keeps the two honest. Unchecked, a BJJ day could
	// point at a strength template and render as "BJJ — Push Day".
	if wSport != sport {
		return fmt.Errorf("%w: that workout is %s, plan is %s", ErrInvalidInput, wSport, sport)
	}
	return nil
}

// assertClassPlanUsable resolves a plan's class_plan_id under class plan's
// own visibility rule: every class plan a caller can see, they own — see
// classplan.go's package comment on the deliberately absent ErrForbidden,
// which explains why "not yours" and "does not exist" are the identical case
// for that domain on every path it has.
//
// Simpler than assertWorkoutUsable in exactly that respect: there is no
// public/VOLA-authored class plan to admit, and a class plan carries no sport
// column at all (see classplan.go), so there is nothing to cross-check a
// plan's sport against — this collapses to a plain ownership check.
//
// **A deliberate gap, not an oversight: nothing here stops `{"sport":
// "strength", "class_plan_id": "..."}`**, which would render as a strength
// day naming a BJJ class. Two things keep this from being reachable through
// the product rather than through raw API access: the web calendar's class-
// plan picker only appears when the chosen discipline's catalog is
// techniques (see calendar/page.tsx's `isTechniquesCatalog`), and mobile
// never writes class_plan_id at all (see apps/mobile/lib/plan.ts). Adding a
// hard `sport == "bjj"` check here was considered and rejected: classplan.go
// deliberately carries no sport field because a class plan is not itself
// sport-typed data, and hardcoding one discipline into this guard would be
// the same migration-per-discipline cost 000021 removed from `sport`'s own
// CHECK constraint, reintroduced one module up. If a caller ever reaches
// this through something other than the two UIs above, that is the moment
// to revisit — not preemptively here.
//
// **Not optional, for the identical reason assertWorkoutUsable is not.**
// Without it a caller could POST a plan naming any class_plan id and read the
// outcome as an oracle: a visible id inserts and returns 201, a nonexistent
// one trips the foreign key and returns 400 — a practical way to enumerate
// other coaches' guessable plan ids and confirm a private plan's existence.
// Hence ONE indistinguishable error for "no such class plan" and "not yours".
func assertClassPlanUsable(ctx context.Context, tx pgx.Tx, classPlanID *string, userID string) error {
	if classPlanID == nil {
		return nil
	}
	var exists bool
	err := tx.QueryRow(ctx, `
		SELECT true FROM class_plans WHERE id = $1 AND owner_user_id = $2`,
		*classPlanID, userID).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: unknown class plan", ErrInvalidInput)
	}
	if err != nil {
		return fmt.Errorf("plan: check class plan: %w", err)
	}
	return nil
}

// bothTemplateKindsSet reports whether a workout and a class plan would both
// be set on a plan, which nothing anywhere knows how to render — a calendar
// row is one schedule, not two. Shared by Create (where both sides are known
// outright) and Update (where the caller may touch only one side, and the
// other's current value on the row decides the conflict — see the call in
// Update for that fetch).
func bothTemplateKindsSet(workoutID, classPlanID *string) bool {
	return workoutID != nil && classPlanID != nil
}

func (r *PostgresRepository) Create(ctx context.Context, userID string, in NewPlan) (*Plan, error) {
	day, err := time.Parse(DayLayout, in.Day)
	if err != nil {
		return nil, fmt.Errorf("%w: day must be a calendar date (YYYY-MM-DD)", ErrInvalidInput)
	}

	// Checked before opening a transaction: a plan naming both a workout and
	// a class plan is invalid regardless of whether either one turns out to
	// exist, so there is nothing to gain from a round trip first. The
	// database's own `plans_one_template_kind` CHECK is defence in depth for
	// this — see the migration — but a caller should get a message naming
	// the conflict rather than a constraint name.
	if bothTemplateKindsSet(in.WorkoutID, in.ClassPlanID) {
		return nil, fmt.Errorf("%w: a plan may reference a workout or a class plan, not both", ErrInvalidInput)
	}

	// In a transaction so the visibility check and the insert cannot be split
	// by a concurrent delete — the same shape `session.Create` uses.
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	if err := assertWorkoutUsable(ctx, tx, in.WorkoutID, userID, in.Sport); err != nil {
		return nil, err
	}
	if err := assertClassPlanUsable(ctx, tx, in.ClassPlanID, userID); err != nil {
		return nil, err
	}

	p, err := scanPlan(tx.QueryRow(ctx, `
		INSERT INTO plans (id, user_id, day, sport, workout_id, class_plan_id, time_of_day_minutes, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING `+selectColumns,
		in.ID, userID, day, in.Sport, in.WorkoutID, in.ClassPlanID, in.TimeOfDayMinutes, in.Notes,
	))
	if err != nil {
		return nil, translatePgError(err)
	}
	if err := tx.Commit(ctx); err != nil {
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

	setWorkout := in.WorkoutID.Present
	workoutID := in.WorkoutID.Value
	setClassPlan := in.ClassPlanID.Present
	classPlanID := in.ClassPlanID.Value
	setTimeOfDay := in.TimeOfDayMinutes.Present
	timeOfDayMinutes := in.TimeOfDayMinutes.Value

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	// Mutual exclusivity, checked against the row's state AFTER this update —
	// not merely against what this one PATCH sets. A caller may touch only
	// one side (set a class_plan_id and say nothing about workout_id), and
	// whether that conflicts depends on what the OTHER column already holds
	// on the row, exactly as the sport re-check just below has to fetch the
	// row's current sport when the caller didn't send one. Only fetched when
	// there is something to conflict with: setting neither, or clearing
	// either side, can never produce the forbidden pair.
	if (setWorkout && workoutID != nil) || (setClassPlan && classPlanID != nil) {
		finalWorkout, finalClassPlan := workoutID, classPlanID
		if !setWorkout || !setClassPlan {
			var curWorkout, curClassPlan *string
			err := tx.QueryRow(ctx,
				`SELECT workout_id, class_plan_id FROM plans WHERE id = $1 AND user_id = $2`,
				id, userID,
			).Scan(&curWorkout, &curClassPlan)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrNotFound
			}
			if err != nil {
				return nil, translatePgError(err)
			}
			if !setWorkout {
				finalWorkout = curWorkout
			}
			if !setClassPlan {
				finalClassPlan = curClassPlan
			}
		}
		if bothTemplateKindsSet(finalWorkout, finalClassPlan) {
			return nil, fmt.Errorf("%w: a plan may reference a workout or a class plan, not both", ErrInvalidInput)
		}
	}

	// The same visibility check `Create` does — an update is just as good an
	// oracle as an insert, and re-pointing a plan at someone else's private
	// template is the same leak by a different verb.
	//
	// The sport it is checked against is the one the row will HAVE after this
	// update, not the one it has now: a PATCH may change both at once, and
	// checking the stale sport would reject a legitimate pair and accept a
	// mismatched one.
	if setWorkout && workoutID != nil {
		sport := ""
		if in.Sport != nil {
			sport = *in.Sport
		} else {
			if err := tx.QueryRow(ctx,
				`SELECT sport FROM plans WHERE id = $1 AND user_id = $2`, id, userID,
			).Scan(&sport); errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrNotFound
			} else if err != nil {
				return nil, translatePgError(err)
			}
		}
		if err := assertWorkoutUsable(ctx, tx, workoutID, userID, sport); err != nil {
			return nil, err
		}
	}
	// class_plan_id has no sport to cross-check — see assertClassPlanUsable.
	if setClassPlan && classPlanID != nil {
		if err := assertClassPlanUsable(ctx, tx, classPlanID, userID); err != nil {
			return nil, err
		}
	}

	p, err := scanPlan(tx.QueryRow(ctx, `
		UPDATE plans
		   SET day                  = COALESCE($3, day),
		       sport                = COALESCE($4, sport),
		       workout_id           = CASE WHEN $5 THEN $6 ELSE workout_id END,
		       class_plan_id        = CASE WHEN $7 THEN $8 ELSE class_plan_id END,
		       time_of_day_minutes  = CASE WHEN $9 THEN $10 ELSE time_of_day_minutes END,
		       notes                = COALESCE($11, notes),
		       updated_at           = now()
		 WHERE id = $1 AND user_id = $2
		 RETURNING `+selectColumns,
		id, userID, day, in.Sport, setWorkout, workoutID, setClassPlan, classPlanID,
		setTimeOfDay, timeOfDayMinutes, in.Notes,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, translatePgError(err)
	}
	if err := tx.Commit(ctx); err != nil {
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
