package session

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
	// The history rollup resolves the caller's IANA zone. cmd/api imports this
	// too, but the dependency belongs to the package that calls LoadLocation —
	// a second binary, or these tests in a slim image, would break silently.
	_ "time/tzdata"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// defaultLimit bounds a listing that didn't ask for one. A training history
// grows without end, so an unbounded default would get slower every month
// for the one caller least likely to notice — the app's own home screen.
const defaultLimit = 50
const maxLimit = 200

// maxOneRMMultiplier is the largest factor EstimateOneRM can apply: Brzycki at
// the 12-effective-rep ceiling is 36/25. It's what lets the candidate search
// be bounded *exactly* rather than by a guessed row cap — see BestOneRMs.
const maxOneRMMultiplier = 36.0 / (37.0 - float64(maxEstimableReps))

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

// translatePgError turns constraint violations into domain errors, so bad
// input reaches the client as 400 rather than 500. Deliberately omits
// pgErr.Message: the handler surfaces ErrInvalidInput text, and Postgres
// messages name constraints and sometimes values.
func translatePgError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23514": // check_violation
		switch {
		case strings.Contains(pgErr.ConstraintName, "rpe"):
			return fmt.Errorf("%w: RPE must be between 1 and 10", ErrInvalidInput)
		case strings.Contains(pgErr.ConstraintName, "rir"):
			return fmt.Errorf("%w: RIR must be between 0 and 20", ErrInvalidInput)
		case strings.Contains(pgErr.ConstraintName, "set_type"):
			return fmt.Errorf("%w: unknown set type", ErrInvalidInput)
		case strings.Contains(pgErr.ConstraintName, "ends_after_start"):
			return fmt.Errorf("%w: a session can't end before it started", ErrInvalidInput)
		}
		return fmt.Errorf("%w: a value is out of range", ErrInvalidInput)
	case "22003":
		return fmt.Errorf("%w: a value is too large", ErrInvalidInput)
	case "23503": // foreign_key_violation
		if strings.Contains(pgErr.ConstraintName, "workout") {
			return fmt.Errorf("%w: unknown workout", ErrInvalidInput)
		}
		return fmt.Errorf("%w: unknown exercise", ErrInvalidInput)
	}
	return err
}

const sessionColumns = `
	id, user_id, workout_id, sport, name, started_at, ended_at, notes,
	created_at, updated_at`

type scannable interface{ Scan(dest ...any) error }

func scanSession(row scannable) (*Session, error) {
	var s Session
	err := row.Scan(&s.ID, &s.UserID, &s.WorkoutID, &s.Sport, &s.Name,
		&s.StartedAt, &s.EndedAt, &s.Notes, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		return nil, err
	}
	s.Sets = []Set{}
	return &s, nil
}

func (r *PostgresRepository) List(ctx context.Context, userID string, f Filter) (*SessionPage, error) {
	where := []string{"s.user_id = $1"}
	args := []any{userID}

	if f.Sport != "" {
		args = append(args, f.Sport)
		where = append(where, fmt.Sprintf("s.sport = $%d", len(args)))
	}
	if f.ExerciseID != "" {
		// EXISTS rather than a join: a session with eight sets of the same
		// exercise must appear once, not eight times.
		args = append(args, f.ExerciseID)
		where = append(where, fmt.Sprintf(
			"EXISTS (SELECT 1 FROM session_sets ss WHERE ss.session_id = s.id AND ss.exercise_id = $%d)",
			len(args)))
	}
	if !f.From.IsZero() {
		args = append(args, f.From)
		where = append(where, fmt.Sprintf("s.started_at >= $%d", len(args)))
	}
	if !f.To.IsZero() {
		args = append(args, f.To)
		where = append(where, fmt.Sprintf("s.started_at < $%d", len(args)))
	}
	if f.Query != "" {
		// Same shape as the exercise catalog's search, escape and all, so the
		// two search boxes behave identically. Without the ESCAPE a name
		// containing % or _ would silently match far more than it should.
		args = append(args, database.LikeTerm(f.Query))
		where = append(where, database.LikeClause("s.name", len(args)))
	}

	whereSQL := strings.Join(where, " AND ")

	// Counted with the identical predicate in the same request, so the total
	// and the rows describe the same filter. Not the same *snapshot* — these
	// are two statements, so a session synced between them can shift the
	// count by one. That drift is invisible in practice and far cheaper than
	// holding a repeatable-read transaction open across both.

	limit := f.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}
	args = append(args, limit)
	limitPlaceholder := len(args)
	args = append(args, offset)

	// `s.id` breaks ties on started_at. Without it two sessions logged in the
	// same second could swap places between pages, so one would appear twice
	// and another never — the classic unstable-sort paging bug.
	rows, err := r.pool.Query(ctx, `
		SELECT `+sessionColumns+` FROM sessions s
		WHERE `+whereSQL+`
		ORDER BY s.started_at DESC, s.id
		LIMIT $`+fmt.Sprint(limitPlaceholder)+` OFFSET $`+fmt.Sprint(len(args)), args...)
	if err != nil {
		return nil, fmt.Errorf("session: list: %w", err)
	}
	defer rows.Close()

	sessions := []Session{}
	ids := []string{}
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, fmt.Errorf("session: scan: %w", err)
		}
		sessions = append(sessions, *s)
		ids = append(ids, s.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: rows: %w", err)
	}
	if err := r.attachSets(ctx, sessions, ids); err != nil {
		return nil, err
	}

	// A first page that didn't fill *is* the total — no count needed. Worth
	// the branch because the COUNT is the expensive half under an
	// `exercise_id` filter: the paged SELECT walks the index and stops at
	// `limit`, while the count has to evaluate the EXISTS subquery against
	// every session the athlete has. This covers the common case for free.
	total := offset + len(sessions)
	if offset > 0 || len(sessions) == limit {
		if err := r.pool.QueryRow(ctx,
			`SELECT COUNT(*)::int FROM sessions s WHERE `+whereSQL, args[:len(args)-2]...).Scan(&total); err != nil {
			return nil, fmt.Errorf("session: count: %w", err)
		}
	}
	return &SessionPage{Sessions: sessions, Total: total, Limit: limit, Offset: offset}, nil
}

// workingSet is Summarise's rule, expressed once for SQL.
//
// Duplicating a domain rule in SQL is normally exactly the drift this
// codebase has been bitten by. It's done here because the alternative is
// loading every set row of a training year to produce six numbers, and it's
// made safe the only way that actually works: TestHistoryAgreesWithSummarise
// runs both over the same data and fails if they ever disagree.
const workingSet = `ss.completed AND ss.set_type <> 'warmup'`

// History rolls a date range up per calendar day, plus totals for the period
// and for the window immediately before it.
func (r *PostgresRepository) History(ctx context.Context, userID string, f HistoryFilter) (*History, error) {
	loc, err := time.LoadLocation(f.TZ)
	if err != nil {
		return nil, fmt.Errorf("%w: unknown timezone", ErrInvalidInput)
	}

	days, err := r.historyDays(ctx, userID, f)
	if err != nil {
		return nil, err
	}
	totals, err := r.historyTotals(ctx, userID, f.Sport, f.TZ, f.From, f.To)
	if err != nil {
		return nil, err
	}
	// The same length, ending where this one starts. Comparing March against
	// a fixed "last 30 days" would move the goalposts every time the range
	// changed, and the delta would mean nothing.
	//
	// Counted in days and stepped with AddDate rather than subtracting a
	// Duration: March in New York is 743 hours, not 744, so `Add(-span)`
	// starts the comparison window at 01:00 and quietly drops anything logged
	// in that first hour — of the number the whole "up 12%" framing rests on.
	spanDays := int(math.Round(f.To.Sub(f.From).Hours() / 24))
	previous, err := r.historyTotals(ctx, userID, f.Sport, f.TZ, f.From.AddDate(0, 0, -spanDays), f.From)
	if err != nil {
		return nil, err
	}
	sports, err := r.historySports(ctx, userID, f)
	if err != nil {
		return nil, err
	}

	return &History{
		From: f.From.In(loc).Format("2006-01-02"),
		// To is exclusive internally; echo back the last day it includes,
		// which is the one the caller asked for.
		To:       f.To.In(loc).AddDate(0, 0, -1).Format("2006-01-02"),
		Totals:   *totals,
		Previous: *previous,
		Days:     days,
		Sports:   sports,
	}, nil
}

func (r *PostgresRepository) historyDays(ctx context.Context, userID string, f HistoryFilter) ([]HistoryDay, error) {
	args := []any{userID, f.From, f.To, f.TZ}
	sportClause := ""
	if f.Sport != "" {
		args = append(args, f.Sport)
		sportClause = fmt.Sprintf("AND s.sport = $%d", len(args))
	}

	// Aggregating sets per session first, then per day. Rolling straight to
	// the day would multiply the duration by the session's set count, because
	// the join repeats the session row once per set.
	rows, err := r.pool.Query(ctx, `
		WITH scoped AS (
			SELECT s.id, s.sport, s.started_at, s.ended_at,
			       (s.started_at AT TIME ZONE $4)::date AS day
			FROM sessions s
			WHERE s.user_id = $1 AND s.started_at >= $2 AND s.started_at < $3 `+sportClause+`
		),
		per_session AS (
			SELECT sc.id, sc.day, sc.sport,
			       COALESCE(EXTRACT(EPOCH FROM (sc.ended_at - sc.started_at)), 0)::bigint AS duration,
			       COUNT(*) FILTER (WHERE `+workingSet+`) AS working_sets,
			       COALESCE(SUM(ss.reps) FILTER (WHERE `+workingSet+`), 0) AS total_reps,
			       COALESCE(SUM(ss.reps * ss.weight_kg) FILTER (WHERE `+workingSet+`), 0) AS tonnage
			FROM scoped sc
			LEFT JOIN session_sets ss ON ss.session_id = sc.id
			GROUP BY sc.id, sc.day, sc.sport, sc.ended_at, sc.started_at
		)
		-- Explicit casts throughout: SUM() over bigint yields numeric, which
		-- won't scan into an int, and SUM() over numeric won't scan into a
		-- float64. Both are runtime failures, not compile-time ones.
		SELECT day, COUNT(*)::int, SUM(working_sets)::int, SUM(total_reps)::int,
		       SUM(tonnage)::float8, SUM(duration)::int,
		       array_agg(DISTINCT sport ORDER BY sport)
		FROM per_session
		GROUP BY day
		ORDER BY day`, args...)
	if err != nil {
		return nil, fmt.Errorf("session: history days: %w", err)
	}
	defer rows.Close()

	days := []HistoryDay{}
	for rows.Next() {
		var d HistoryDay
		var day time.Time
		if err := rows.Scan(&day, &d.Sessions, &d.WorkingSets, &d.TotalReps,
			&d.TonnageKg, &d.DurationSeconds, &d.Sports); err != nil {
			return nil, fmt.Errorf("session: history days scan: %w", err)
		}
		d.Date = day.Format("2006-01-02")
		days = append(days, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: history days rows: %w", err)
	}
	return days, nil
}

func (r *PostgresRepository) historyTotals(
	ctx context.Context, userID, sport, tz string, from, to time.Time,
) (*HistoryTotals, error) {
	args := []any{userID, from, to, tz}
	sportClause := ""
	if sport != "" {
		args = append(args, sport)
		sportClause = fmt.Sprintf("AND s.sport = $%d", len(args))
	}

	var t HistoryTotals
	// Exercises and active days can't be summed from the per-day rollup —
	// benching on Monday and Thursday is one exercise, and two sessions in a
	// day is one day. Both need their own DISTINCT over the whole period.
	// Active days uses the caller's timezone for the same reason the calendar
	// does, or the two would disagree about what a day is.
	err := r.pool.QueryRow(ctx, `
		WITH scoped AS (
			SELECT s.id, s.started_at, s.ended_at
			FROM sessions s
			WHERE s.user_id = $1 AND s.started_at >= $2 AND s.started_at < $3 `+sportClause+`
		)
		SELECT
			(SELECT COUNT(*) FROM scoped)::int,
			-- Rounded per session, matching historyDays, so summing the days
			-- equals this exactly. Rounding once here instead would leave the
			-- calendar and the headline a second or two apart.
			(SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at))::bigint), 0) FROM scoped)::int,
			(SELECT COUNT(DISTINCT (started_at AT TIME ZONE $4)::date) FROM scoped)::int,
			COUNT(*) FILTER (WHERE `+workingSet+`)::int,
			COALESCE(SUM(ss.reps) FILTER (WHERE `+workingSet+`), 0)::int,
			COALESCE(SUM(ss.reps * ss.weight_kg) FILTER (WHERE `+workingSet+`), 0)::float8,
			COUNT(DISTINCT ss.exercise_id)::int
		FROM session_sets ss
		WHERE ss.session_id IN (SELECT id FROM scoped)`, args...).
		Scan(&t.Sessions, &t.DurationSeconds, &t.ActiveDays, &t.WorkingSets,
			&t.TotalReps, &t.TonnageKg, &t.Exercises)
	if err != nil {
		return nil, fmt.Errorf("session: history totals: %w", err)
	}
	return &t, nil
}

func (r *PostgresRepository) historySports(ctx context.Context, userID string, f HistoryFilter) ([]SportCount, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT sport, COUNT(*) FROM sessions
		WHERE user_id = $1 AND started_at >= $2 AND started_at < $3
		GROUP BY sport ORDER BY COUNT(*) DESC, sport`, userID, f.From, f.To)
	if err != nil {
		return nil, fmt.Errorf("session: history sports: %w", err)
	}
	defer rows.Close()

	out := []SportCount{}
	for rows.Next() {
		var s SportCount
		if err := rows.Scan(&s.Sport, &s.Sessions); err != nil {
			return nil, fmt.Errorf("session: history sports scan: %w", err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: history sports rows: %w", err)
	}
	return out, nil
}

// attachSets loads every listed session's sets in one query. One round trip
// for the page rather than one per session — the N+1 here would grow with
// both history length and sets per session.
func (r *PostgresRepository) attachSets(ctx context.Context, sessions []Session, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.pool.Query(ctx, `
		SELECT session_id, exercise_id, position, set_type, reps, weight_kg,
		       seconds, distance_m, rir, rpe, notes, completed
		FROM session_sets
		WHERE session_id = ANY($1)
		ORDER BY session_id, position`, ids)
	if err != nil {
		return fmt.Errorf("session: list sets: %w", err)
	}
	defer rows.Close()

	bySession := make(map[string][]Set, len(ids))
	for rows.Next() {
		var (
			sessionID string
			st        Set
		)
		if err := rows.Scan(&sessionID, &st.ExerciseID, &st.Position, &st.SetType,
			&st.Reps, &st.WeightKg, &st.Seconds, &st.DistanceM,
			&st.RIR, &st.RPE, &st.Notes, &st.Completed); err != nil {
			return fmt.Errorf("session: scan set: %w", err)
		}
		bySession[sessionID] = append(bySession[sessionID], st)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("session: set rows: %w", err)
	}
	for i := range sessions {
		if sets := bySession[sessions[i].ID]; sets != nil {
			sessions[i].Sets = sets
		}
	}
	return nil
}

// RecentEfforts loads what the progression rule reads: for each requested
// exercise, its last `progressionWindow` sessions with every working set in
// them.
//
// Whole sessions rather than one top set per exercise, because the rule keys
// off the *weakest* working set (a session falling 10→6 is not a 10-rep
// session) and off whether a load has repeated across sessions (the stall
// check). Neither question can be answered from a single row.
//
// One query for the whole list, not one per exercise — a session screen asks
// about every movement in the workout at once, and the N+1 here would be paid
// on the slowest screen in the app.
//
// DENSE_RANK, not ROW_NUMBER: the rank has to number *sessions*, so every set
// belonging to one session must share a rank. ROW_NUMBER would number the set
// rows and the window would then cut a session in half, silently — the sets
// beyond the cut would vanish and the weakest-set gate would read the
// remainder as the whole session, which is the exact failure the gate exists
// to prevent.
func (r *PostgresRepository) RecentEfforts(
	ctx context.Context, userID string, exerciseIDs []string,
) (map[string]ProgressionInput, error) {
	out := map[string]ProgressionInput{}
	if len(exerciseIDs) == 0 {
		return out, nil
	}
	rows, err := r.pool.Query(ctx, `
		WITH ranked AS (
			SELECT ss.exercise_id, ss.session_id, s.started_at, ss.position,
			       ss.set_type, ss.reps, ss.weight_kg, ss.rir, ss.rpe,
			       DENSE_RANK() OVER (
			           PARTITION BY ss.exercise_id
			           ORDER BY s.started_at DESC, ss.session_id
			       ) AS session_rank
			FROM session_sets ss
			JOIN sessions s ON s.id = ss.session_id
			WHERE s.user_id = $1
			  -- Redundant against the join, and deliberately so: it lets the
			  -- planner seek session_sets_user_exercise_idx instead of walking
			  -- every session this athlete has. Provably equivalent, not just
			  -- correlated — migration 000014's composite FK makes a set row
			  -- naming a (session, owner) pair that isn't real impossible.
			  AND ss.user_id = $1
			  AND ss.exercise_id = ANY($2)
			  AND `+workingSet+`
			  -- A set with nothing recorded isn't a performance. Without this,
			  -- an exercise added to a session and never actually done would
			  -- rank as the most recent and hide real history behind it.
			  AND (ss.reps IS NOT NULL OR ss.weight_kg IS NOT NULL
			       OR ss.seconds IS NOT NULL OR ss.distance_m IS NOT NULL)
		)
		-- Driven from the *requested* ids rather than from history, which is
		-- what makes "never logged" distinguishable from "not a weighted
		-- lift". Reading the catalog off the set rows meant an exercise with
		-- no history came back with an empty load_type, and the rule then
		-- told a first-time squatter their barbell squat wasn't measured in
		-- weight. LEFT JOIN, so every requested id gets at least one row.
		--
		-- The catalog join also belongs out here rather than inside the CTE:
		-- movement_pattern and load_type are constant per exercise, and
		-- joining per set row made that lookup ~95% of the query's buffer
		-- traffic for values that never vary.
		SELECT ex.id, e.movement_pattern, e.load_type,
		       r.session_id, r.started_at, r.position, r.set_type,
		       r.reps, r.weight_kg, r.rir, r.rpe
		FROM unnest($2::text[]) AS ex(id)
		JOIN exercises e ON e.id = ex.id
		LEFT JOIN ranked r ON r.exercise_id = ex.id AND r.session_rank <= $3
		ORDER BY ex.id, r.started_at DESC NULLS LAST, r.session_id, r.position`,
		userID, exerciseIDs, progressionWindow)
	if err != nil {
		return nil, fmt.Errorf("session: recent efforts: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			exerciseID        string
			pattern, loadType string
			// Null for a requested exercise with no history — the row the
			// LEFT JOIN produces so the catalog fields still arrive.
			sessionID *string
			startedAt *time.Time
			position  *int
			setType   *SetType
			s         Set
		)
		if err := rows.Scan(&exerciseID, &pattern, &loadType,
			&sessionID, &startedAt, &position, &setType,
			&s.Reps, &s.WeightKg, &s.RIR, &s.RPE); err != nil {
			return nil, fmt.Errorf("session: scan recent effort: %w", err)
		}

		in := out[exerciseID]
		in.ExerciseID = exerciseID
		in.MovementPattern, in.LoadType = pattern, loadType
		if sessionID == nil {
			// Catalog-only row: the exercise exists, the history doesn't.
			// Recent stays empty, which is exactly what "no history" means to
			// the rule.
			out[exerciseID] = in
			continue
		}

		// Every set row here already passed the workingSet filter, and
		// Progress re-checks Completed on the domain side. Setting it keeps
		// the two consistent rather than relying on Go's zero value.
		s.Completed = true
		s.ExerciseID = exerciseID
		s.Position, s.SetType = *position, *setType

		// Rows arrive grouped and newest-first, so a new session ID is always
		// a new bucket appended in the order the rule expects.
		if n := len(in.Recent); n > 0 && in.Recent[n-1].SessionID == *sessionID {
			in.Recent[n-1].Sets = append(in.Recent[n-1].Sets, s)
		} else {
			in.Recent = append(in.Recent, SessionEffort{
				SessionID:   *sessionID,
				PerformedAt: *startedAt,
				Sets:        []Set{s},
			})
		}
		out[exerciseID] = in
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: recent effort rows: %w", err)
	}
	return out, nil
}

func (r *PostgresRepository) Get(ctx context.Context, userID, id string) (*Session, error) {
	row := r.pool.QueryRow(ctx,
		`SELECT `+sessionColumns+` FROM sessions s WHERE s.id = $1 AND s.user_id = $2`, id, userID)
	s, err := scanSession(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Same answer whether it doesn't exist or isn't yours.
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("session: get: %w", err)
	}
	one := []Session{*s}
	if err := r.attachSets(ctx, one, []string{s.ID}); err != nil {
		return nil, err
	}
	return &one[0], nil
}

// assertSportsMatch rejects sets whose exercise belongs to another
// discipline. Checked here rather than trusted, for the same reason the
// workout module does: it's a data guarantee, not a UI convention.
func assertSportsMatch(ctx context.Context, tx pgx.Tx, sport string, sets []Set) error {
	if len(sets) == 0 {
		return nil
	}
	ids := make([]string, 0, len(sets))
	for _, s := range sets {
		ids = append(ids, s.ExerciseID)
	}
	rows, err := tx.Query(ctx, `SELECT id, sport FROM exercises WHERE id = ANY($1)`, ids)
	if err != nil {
		return fmt.Errorf("session: check exercise sports: %w", err)
	}
	defer rows.Close()

	found := map[string]string{}
	for rows.Next() {
		var id, sp string
		if err := rows.Scan(&id, &sp); err != nil {
			return fmt.Errorf("session: scan exercise sport: %w", err)
		}
		found[id] = sp
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("session: exercise sport rows: %w", err)
	}
	for _, s := range sets {
		sp, ok := found[s.ExerciseID]
		if !ok {
			return fmt.Errorf("%w: unknown exercise %q", ErrInvalidInput, s.ExerciseID)
		}
		if sp != sport {
			return fmt.Errorf("%w: %q is %s, session is %s", ErrSportMismatch, s.ExerciseID, sp, sport)
		}
	}
	return nil
}

// assertWorkoutUsable resolves a session's workout_id under the same
// visibility rule the workout module reads by, and checks the disciplines
// agree.
//
// Not optional, and not merely tidiness: without it a caller could POST a
// session naming any workout ID and read the outcome as an oracle — a
// visible ID inserts and returns 200, a nonexistent one trips the foreign
// key and returns 400. Workout IDs are client-generated and therefore often
// guessable ("push-day-a"), which makes that a practical way to enumerate
// other people's private templates. Exactly the bug already closed on the
// workout write paths; it came back through a different door.
//
// Hence one indistinguishable error for "no such workout" and "not yours".
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
		return fmt.Errorf("session: check workout: %w", err)
	}
	// sessions.sport is denormalised from the workout; nothing in the schema
	// keeps them honest, so it's checked here.
	if wSport != sport {
		return fmt.Errorf("%w: that workout is %s, session is %s", ErrSportMismatch, wSport, sport)
	}
	return nil
}

func insertSets(ctx context.Context, tx pgx.Tx, sessionID, userID string, sets []Set) error {
	if len(sets) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for i, s := range sets {
		st := s.SetType
		if st == "" {
			st = SetTypeWorking
		}
		// Position from array order, never trusted from the client — so a
		// caller can't create gaps or an order differing from what it sent.
		// user_id is passed, not sub-queried: the composite foreign key on
		// (session_id, user_id) verifies it against `sessions`, so a wrong
		// value is rejected by the database rather than needing a correlated
		// lookup on every row of the batch.
		batch.Queue(`
			INSERT INTO session_sets (
				session_id, user_id, exercise_id, position, set_type, reps, weight_kg,
				seconds, distance_m, rir, rpe, notes, completed
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			sessionID, userID, s.ExerciseID, i, st, s.Reps, s.WeightKg,
			s.Seconds, s.DistanceM, s.RIR, s.RPE, s.Notes, s.Completed)
	}
	results := tx.SendBatch(ctx, batch)
	for i := range sets {
		if _, err := results.Exec(); err != nil {
			results.Close() //nolint:errcheck // returning the more useful error
			if t := translatePgError(err); !errors.Is(t, err) {
				return t
			}
			return fmt.Errorf("session: insert set %d: %w", i, err)
		}
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("session: set batch: %w", err)
	}
	return nil
}

func (r *PostgresRepository) Create(ctx context.Context, in NewSession) (*Session, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("session: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	if err := assertWorkoutUsable(ctx, tx, in.WorkoutID, in.UserID, in.Sport); err != nil {
		return nil, err
	}
	if err := assertSportsMatch(ctx, tx, in.Sport, in.Sets); err != nil {
		return nil, err
	}

	var created bool
	err = tx.QueryRow(ctx, `
		INSERT INTO sessions (id, user_id, workout_id, sport, name, started_at, ended_at, notes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (id) DO NOTHING
		RETURNING true`,
		in.ID, in.UserID, in.WorkoutID, in.Sport, in.Name,
		in.StartedAt, in.EndedAt, in.Notes).Scan(&created)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, translatePgError(fmt.Errorf("session: create: %w", err))
	}

	if errors.Is(err, pgx.ErrNoRows) {
		// The ID exists. IDs are client-generated, so this lookup MUST be
		// user-scoped: without it, replaying someone else's ID would return
		// their training log. Same IDOR the activity and workout modules
		// each had to close.
		var owner string
		if err := tx.QueryRow(ctx,
			`SELECT user_id FROM sessions WHERE id = $1`, in.ID).Scan(&owner); err != nil {
			return nil, fmt.Errorf("session: create conflict: %w", err)
		}
		if owner != in.UserID {
			return nil, ErrAlreadyExists
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("session: commit: %w", err)
		}
		return r.Get(ctx, in.UserID, in.ID)
	}

	if err := insertSets(ctx, tx, in.ID, in.UserID, in.Sets); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("session: commit: %w", err)
	}
	return r.Get(ctx, in.UserID, in.ID)
}

// requireOwner resolves a session for writing. FOR UPDATE serialises
// concurrent writes to the same session, which the offline sync model makes
// a realistic case rather than a theoretical one.
func requireOwner(ctx context.Context, tx pgx.Tx, userID, id string) (string, error) {
	var owner, sport string
	err := tx.QueryRow(ctx,
		`SELECT user_id, sport FROM sessions WHERE id = $1 FOR UPDATE`, id).Scan(&owner, &sport)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("session: load for write: %w", err)
	}
	if owner != userID {
		// Sessions are never shared, so there's no "visible but not yours"
		// case — not-found is the only correct answer, and it keeps IDs
		// unenumerable.
		return "", ErrNotFound
	}
	return sport, nil
}

func (r *PostgresRepository) ReplaceSets(ctx context.Context, userID, sessionID string, sets []Set) (*Session, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("session: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	sport, err := requireOwner(ctx, tx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	if err := assertSportsMatch(ctx, tx, sport, sets); err != nil {
		return nil, err
	}

	// Replace wholesale rather than diffing: re-ordering and correcting are
	// both common, and a diff would have to dance around the
	// (session_id, position) unique constraint for no benefit at this size.
	if _, err := tx.Exec(ctx, `DELETE FROM session_sets WHERE session_id = $1`, sessionID); err != nil {
		return nil, fmt.Errorf("session: clear sets: %w", err)
	}
	// `userID` here is the caller's, already verified against the session by
	// requireOwner above — so the composite FK is a second line of defence,
	// not the only one.
	if err := insertSets(ctx, tx, sessionID, userID, sets); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE sessions SET updated_at = now() WHERE id = $1`, sessionID); err != nil {
		return nil, fmt.Errorf("session: touch: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("session: commit: %w", err)
	}
	return r.Get(ctx, userID, sessionID)
}

// Rename changes only the session's name.
//
// Its own method rather than a general Update, because name is the only field
// a client may change after the fact: sport decides which screen renders it,
// started_at/ended_at are what history counts, and sets have their own
// replace endpoint. A general PATCH would make all of those editable by
// accident.
//
// The name defaults to the workout or the BJJ kind ("Class"), which is right
// until the session was a seminar, a comp class or an open mat — and until
// this existed the phone could rename locally, mark the row clean, and drop
// the change on the floor without anything noticing.
func (r *PostgresRepository) Rename(ctx context.Context, userID, sessionID, name string) (*Session, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("session: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	// Same ownership gate as Finish. Without it a client-generated id from
	// another account is renameable, which is the IDOR this module has
	// already had to close once.
	if _, err := requireOwner(ctx, tx, userID, sessionID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE sessions SET name = $2, updated_at = now() WHERE id = $1`,
		sessionID, name); err != nil {
		return nil, translatePgError(fmt.Errorf("session: rename: %w", err))
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("session: commit: %w", err)
	}
	return r.Get(ctx, userID, sessionID)
}

func (r *PostgresRepository) Finish(ctx context.Context, userID, sessionID string, endedAt time.Time) (*Session, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("session: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	if _, err := requireOwner(ctx, tx, userID, sessionID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE sessions SET ended_at = $2, updated_at = now() WHERE id = $1`,
		sessionID, endedAt); err != nil {
		return nil, translatePgError(fmt.Errorf("session: finish: %w", err))
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("session: commit: %w", err)
	}
	return r.Get(ctx, userID, sessionID)
}

func (r *PostgresRepository) Delete(ctx context.Context, userID, id string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("session: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	if _, err := requireOwner(ctx, tx, userID, id); err != nil {
		return err
	}
	// session_sets cascade.
	if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id); err != nil {
		return fmt.Errorf("session: delete: %w", err)
	}
	return tx.Commit(ctx)
}

// BestOneRMs finds the best estimated one-rep max per exercise, across
// everything the caller has logged.
//
// The candidate sets are fetched and evaluated in Go rather than ranked in
// SQL, for two reasons. The estimate folds in RIR and RPE, so it isn't
// monotonic in weight — 5×100 at 3 RIR beats a 110 single — and there is no
// "just take the heaviest" shortcut. And expressing the rep-max curve in SQL
// would put a second copy of it a schema migration away from the first.
//
// Bounded by `maxOneRMScan`: only sets that could possibly qualify come back
// (completed, non-warm-up, weighted, at or under the rep ceiling), which for
// a real training history is a few hundred rows per exercise.
func (r *PostgresRepository) BestOneRMs(
	ctx context.Context, userID string, exerciseIDs []string,
) (map[string]float64, error) {
	out := map[string]float64{}
	if len(exerciseIDs) == 0 {
		return out, nil
	}

	// Bounded by arithmetic rather than by a row cap.
	//
	// The estimate is between 1.00x and 1.44x the weight lifted, so a set can
	// only be the best if 1.44 x its weight reaches the heaviest *estimable*
	// set recorded for that same exercise. Everything below that line is
	// provably beatable and never has to be fetched.
	//
	// "Estimable" is load-bearing in that sentence — see the filter below.
	// The bound is only sound when `heaviest` comes from a row that actually
	// produces an estimate, because it is the estimate that a candidate has
	// to beat, not the weight.
	//
	// A plain `LIMIT n ORDER BY weight DESC` looks equivalent and isn't: the
	// order is global across every requested exercise, so a squat history
	// eats the budget and the lateral raises fall off the end entirely. And
	// even per-exercise a cap can cut the winner, because 12x100 (144) beats
	// 1x140 (140). This filter cannot.
	rows, err := r.pool.Query(ctx, `
		WITH candidate AS (
			SELECT ss.exercise_id, ss.reps, ss.weight_kg, ss.rir, ss.rpe,
			       MAX(ss.weight_kg) OVER (PARTITION BY ss.exercise_id) AS heaviest
			-- No join: the owner is on the row, so this seeks straight into
			-- session_sets_user_exercise_idx instead of scanning either every
			-- user's sets of this exercise or this user's whole history.
			FROM session_sets ss
			WHERE ss.user_id = $1
			  AND ss.exercise_id = ANY($2)
			  AND `+workingSet+`
			  AND ss.reps IS NOT NULL AND ss.weight_kg IS NOT NULL
			  -- Effective reps, mirroring EstimateOneRM exactly: RIR is the
			  -- observed quantity and wins where both are present, RPE
			  -- converts as 10 minus itself, and a set reporting neither is
			  -- taken at face value.
			  --
			  -- This used to test reps alone, which is a correct exclusion
			  -- and the wrong *pool*. A set of 10 at 3 RIR is 13 effective:
			  -- Go refuses to estimate it, but it passed that filter and so
			  -- became a candidate — and heaviest, above, is a MAX over the
			  -- candidates. It set the bar at its own weight,
			  -- contributed no estimate, and every lighter set was pruned in
			  -- favour of a row that could never score. The athlete's record
			  -- silently stopped existing.
			  --
			  -- Found by review, reproduced against Postgres:
			  -- 100kg x 10 @ 3 RIR alongside 60kg x 12 @ 0 RIR returned no
			  -- record at all, where the real best is 86.4kg. Ordinary
			  -- hypertrophy data, not an edge case.
			  --
			  -- The trailing 0 arm is deliberately kept although it is
			  -- unreachable here: GREATEST/LEAST *ignore* NULLs in Postgres,
			  -- so with no RPE the second arm already evaluates to 0 rather
			  -- than to NULL. It stays because the expression is then correct
			  -- under ordinary NULL propagation too — don't "simplify" this
			  -- into a CASE without re-checking the no-effort row.
			  AND ss.reps + COALESCE(
			        ss.rir::numeric,
			        GREATEST(0, 10 - LEAST(ss.rpe, 10)),
			        0
			      ) <= $3
		)
		SELECT exercise_id, reps, weight_kg, rir, rpe
		FROM candidate
		WHERE weight_kg * $4 >= heaviest`,
		userID, exerciseIDs, maxEstimableReps, maxOneRMMultiplier)
	if err != nil {
		return nil, fmt.Errorf("session: best 1rm: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var id string
		var set Set
		if err := rows.Scan(&id, &set.Reps, &set.WeightKg, &set.RIR, &set.RPE); err != nil {
			return nil, fmt.Errorf("session: best 1rm scan: %w", err)
		}
		if set.Reps == nil || set.WeightKg == nil {
			// The predicate above excludes these, but one edit to it would
			// turn a filter change into a panic.
			continue
		}
		est, ok := EstimateOneRM(*set.Reps, *set.WeightKg, set.RIR, set.RPE)
		if ok && est > out[id] {
			out[id] = est
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: best 1rm rows: %w", err)
	}
	return out, nil
}

// Records finds every personal record the caller holds for the named
// exercises.
//
// Computed from the log on every read rather than kept in a table, and that's
// the load-bearing decision. A materialised record has to be *retracted* when
// the set behind it is corrected or its session deleted — and getting that
// wrong leaves someone staring at a lift they never did, which is the one
// failure a records feature cannot afford. Derived, a record is by
// construction exactly what the log says.
//
// The simple maxima are exact by construction too: weight, reps, seconds and
// distance are each monotonic, so the largest row *is* the record and a window
// function finds it in one pass. Only the estimated 1RM isn't monotonic in
// weight — effort folds in — which is why it comes from BestOneRMs and its
// own arithmetic bound instead.
func (r *PostgresRepository) Records(
	ctx context.Context, userID string, ids []string,
) ([]ExerciseRecords, error) {
	out := []ExerciseRecords{}
	if len(ids) == 0 {
		return out, nil
	}
	// A *copy* is sorted for the query; the output below iterates the caller's
	// original order. Sorting `ids` in place returned every exercise
	// alphabetically, which silently threw away both orderings the feature
	// runs on — the pinned `position` the athlete chose, and most-trained-first
	// for `scope=all` — and made the reorder UI inert while looking like it
	// worked.
	queryIDs := append([]string(nil), ids...)
	sort.Strings(queryIDs)

	// Which records an exercise can hold comes from the catalog, not the
	// caller — same as RecentEfforts reads load_type for the progression
	// rule. A client that guessed would be one catalog change from being
	// wrong.
	loadTypes := map[string]string{}
	ltRows, err := r.pool.Query(ctx,
		`SELECT id, load_type FROM exercises WHERE id = ANY($1)`, queryIDs)
	if err != nil {
		return nil, fmt.Errorf("session: records load types: %w", err)
	}
	for ltRows.Next() {
		var id, lt string
		if err := ltRows.Scan(&id, &lt); err != nil {
			ltRows.Close()
			return nil, fmt.Errorf("session: records load type scan: %w", err)
		}
		loadTypes[id] = lt
	}
	ltRows.Close()
	if err := ltRows.Err(); err != nil {
		return nil, fmt.Errorf("session: records load type rows: %w", err)
	}

	// One row per (exercise, metric) maximum. `id` breaks ties so the record
	// is deterministic when two identical bests exist — otherwise the "when"
	// would flip between requests.
	rows, err := r.pool.Query(ctx, `
		WITH scoped AS (
			SELECT ss.id, ss.exercise_id, ss.reps, ss.weight_kg, ss.seconds,
			       ss.distance_m, ss.rir, ss.rpe, ss.session_id, s.started_at
			FROM session_sets ss
			JOIN sessions s ON s.id = ss.session_id
			WHERE ss.user_id = $1 AND ss.exercise_id = ANY($2) AND `+workingSet+`
		),
		-- Ties break on when it happened, then on id for a total order.
		-- Breaking on id alone was unstable: ReplaceSets deletes and
		-- reinserts, so editing an old session regenerates its row ids and a
		-- tied record would silently move its date to the later session.
		ranked AS (
			SELECT *,
			  ROW_NUMBER() OVER (PARTITION BY exercise_id ORDER BY (CASE WHEN reps IS NULL THEN NULL ELSE weight_kg END)
			                    DESC NULLS LAST, started_at, id) AS rn_weight,
			  ROW_NUMBER() OVER (PARTITION BY exercise_id ORDER BY reps       DESC NULLS LAST, started_at, id) AS rn_reps,
			  ROW_NUMBER() OVER (PARTITION BY exercise_id ORDER BY seconds    DESC NULLS LAST, started_at, id) AS rn_seconds,
			  ROW_NUMBER() OVER (PARTITION BY exercise_id ORDER BY distance_m DESC NULLS LAST, started_at, id) AS rn_distance
			FROM scoped
		)
		SELECT exercise_id, reps, weight_kg, seconds, distance_m, rir, rpe,
		       session_id, started_at,
		       rn_weight = 1, rn_reps = 1, rn_seconds = 1, rn_distance = 1
		FROM ranked
		WHERE rn_weight = 1 OR rn_reps = 1 OR rn_seconds = 1 OR rn_distance = 1`,
		userID, queryIDs)
	if err != nil {
		return nil, fmt.Errorf("session: records: %w", err)
	}
	defer rows.Close()

	type candidate struct {
		rec                        Record
		bestW, bestR, bestS, bestD bool
	}
	byExercise := map[string][]candidate{}
	for rows.Next() {
		var id string
		var c candidate
		if err := rows.Scan(&id, &c.rec.Reps, &c.rec.WeightKg, &c.rec.Seconds,
			&c.rec.DistanceM, &c.rec.RIR, &c.rec.RPE, &c.rec.SessionID,
			&c.rec.AchievedAt, &c.bestW, &c.bestR, &c.bestS, &c.bestD); err != nil {
			return nil, fmt.Errorf("session: records scan: %w", err)
		}
		byExercise[id] = append(byExercise[id], c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: records rows: %w", err)
	}

	best1RM, err := r.BestOneRMs(ctx, userID, queryIDs)
	if err != nil {
		return nil, err
	}
	oneRMSet, err := r.bestOneRMSets(ctx, userID, queryIDs, best1RM)
	if err != nil {
		return nil, err
	}

	cutoff := time.Now().Add(-recentWindow)
	for _, id := range ids {
		kinds := RecordKindsFor(loadTypes[id])
		if len(kinds) == 0 {
			continue
		}
		recs := []Record{}
		for _, kind := range kinds {
			var rec *Record
			switch kind {
			case RecordOneRM:
				if v, ok := best1RM[id]; ok {
					if base, ok := oneRMSet[id]; ok {
						c := base
						c.Kind, c.Value = RecordOneRM, v
						rec = &c
					}
				}
			default:
				for _, c := range byExercise[id] {
					if !matchesKind(kind, c.bestW, c.bestR, c.bestS, c.bestD) {
						continue
					}
					v, ok := recordValue(kind, c.rec)
					if !ok {
						continue
					}
					cp := c.rec
					cp.Kind, cp.Value = kind, v
					rec = &cp
					break
				}
			}
			if rec == nil {
				continue
			}
			rec.IsRecent = rec.AchievedAt.After(cutoff)
			recs = append(recs, *rec)
		}
		if len(recs) > 0 {
			out = append(out, ExerciseRecords{ExerciseID: id, Records: recs})
		}
	}
	return out, nil
}

func matchesKind(k RecordKind, w, r, s, d bool) bool {
	switch k {
	case RecordHeaviest:
		return w
	case RecordMostReps:
		return r
	case RecordLongest:
		return s
	case RecordFurthest:
		return d
	}
	return false
}

// recordValue reads the measure a kind is about, reporting false when the
// winning row didn't record it — a "heaviest" row with no weight is not a
// weight record, it's just the row that sorted first among nulls.
func recordValue(k RecordKind, rec Record) (float64, bool) {
	switch k {
	case RecordHeaviest:
		if rec.WeightKg != nil && *rec.WeightKg > 0 {
			return *rec.WeightKg, true
		}
	case RecordMostReps:
		if rec.Reps != nil && *rec.Reps > 0 {
			return float64(*rec.Reps), true
		}
	case RecordLongest:
		if rec.Seconds != nil && *rec.Seconds > 0 {
			return float64(*rec.Seconds), true
		}
	case RecordFurthest:
		if rec.DistanceM != nil && *rec.DistanceM > 0 {
			return float64(*rec.DistanceM), true
		}
	}
	return 0, false
}

// bestOneRMSets finds which set produced each exercise's best estimate, so the
// record can carry its own evidence like every other one.
func (r *PostgresRepository) bestOneRMSets(
	ctx context.Context, userID string, ids []string, best map[string]float64,
) (map[string]Record, error) {
	out := map[string]Record{}
	if len(best) == 0 {
		return out, nil
	}
	rows, err := r.pool.Query(ctx, `
		SELECT ss.exercise_id, ss.reps, ss.weight_kg, ss.rir, ss.rpe,
		       ss.session_id, s.started_at
		FROM session_sets ss
		JOIN sessions s ON s.id = ss.session_id
		WHERE ss.user_id = $1 AND ss.exercise_id = ANY($2) AND `+workingSet+`
		  AND ss.reps IS NOT NULL AND ss.weight_kg IS NOT NULL
		  AND ss.reps <= $3`, userID, ids, maxEstimableReps)
	if err != nil {
		return nil, fmt.Errorf("session: 1rm evidence: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var rec Record
		if err := rows.Scan(&id, &rec.Reps, &rec.WeightKg, &rec.RIR, &rec.RPE,
			&rec.SessionID, &rec.AchievedAt); err != nil {
			return nil, fmt.Errorf("session: 1rm evidence scan: %w", err)
		}
		est, ok := EstimateOneRM(*rec.Reps, *rec.WeightKg, rec.RIR, rec.RPE)
		// Float equality is safe here: both sides come from the identical
		// function over the identical row, so this is identity rather than
		// approximation.
		if !ok || est != best[id] {
			continue
		}
		if prev, seen := out[id]; !seen || rec.AchievedAt.Before(prev.AchievedAt) {
			// The earliest set to reach the mark is when it was first set.
			out[id] = rec
		}
	}
	return out, rows.Err()
}

// maxPinned bounds the profile shortlist. Beyond about a dozen it stops being
// a shortlist and the screen stops being scannable, which is the whole point.
const maxPinned = 12

func (r *PostgresRepository) PinnedExercises(ctx context.Context, userID string) ([]string, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT exercise_id FROM pinned_exercises WHERE user_id = $1 ORDER BY position, exercise_id`,
		userID)
	if err != nil {
		return nil, fmt.Errorf("session: pinned: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("session: pinned scan: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// SetPinnedExercises replaces the whole list.
//
// Replace rather than add/remove for the same reason sets are replaced
// wholesale: the client edits an ordered list as one thing, and a diffing API
// would need to express reordering, which is most of the editing people
// actually do here.
func (r *PostgresRepository) SetPinnedExercises(ctx context.Context, userID string, ids []string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("session: pin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after commit is a no-op

	if _, err := tx.Exec(ctx, `DELETE FROM pinned_exercises WHERE user_id = $1`, userID); err != nil {
		return fmt.Errorf("session: clear pins: %w", err)
	}
	for i, id := range ids {
		if _, err := tx.Exec(ctx,
			// ON CONFLICT rather than a bare insert: two devices saving at once
			// each delete under their own snapshot, see nothing, and then
			// collide on the primary key — a 500 for what should be
			// last-write-wins. Same shape profile.SetExerciseUnit uses.
			`INSERT INTO pinned_exercises (user_id, exercise_id, position)
			 VALUES ($1,$2,$3)
			 ON CONFLICT (user_id, exercise_id) DO UPDATE SET position = EXCLUDED.position`,
			userID, id, i); err != nil {
			// An unknown exercise is the caller's mistake, not ours.
			if t := translatePgError(err); !errors.Is(t, err) {
				return t
			}
			return fmt.Errorf("session: pin %s: %w", id, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("session: pin commit: %w", err)
	}
	return nil
}

// MostTrainedExercises is the fallback shortlist: what you do most, which is
// a better first guess at what you care about than an empty screen asking you
// to configure something.
func (r *PostgresRepository) MostTrainedExercises(ctx context.Context, userID string, limit int) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT ss.exercise_id
		FROM session_sets ss
		WHERE ss.user_id = $1 AND `+workingSet+`
		GROUP BY ss.exercise_id
		ORDER BY COUNT(*) DESC, ss.exercise_id
		LIMIT $2`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("session: most trained: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("session: most trained scan: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
