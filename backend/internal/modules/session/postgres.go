package session

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

// defaultLimit bounds a listing that didn't ask for one. A training history
// grows without end, so an unbounded default would get slower every month
// for the one caller least likely to notice — the app's own home screen.
const defaultLimit = 50
const maxLimit = 200

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

func (r *PostgresRepository) List(ctx context.Context, userID string, f Filter) ([]Session, error) {
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

	limit := f.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	args = append(args, limit)

	rows, err := r.pool.Query(ctx, `
		SELECT `+sessionColumns+` FROM sessions s
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY s.started_at DESC, s.id
		LIMIT $`+fmt.Sprint(len(args)), args...)
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
	return sessions, nil
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

// LastPerformances finds the top working set of the most recent session
// containing each requested exercise.
//
// One query for the whole list, not one per exercise — a session screen asks
// about every movement in the workout at once, and the N+1 here would be
// paid on the slowest screen in the app.
//
// DISTINCT ON does the work: ordered by exercise, then most recent session,
// then heaviest and most reps, so the first row per exercise is the top set
// of the latest session. Warm-ups are excluded — progressing off a warm-up
// would recommend a weight nobody worked at.
func (r *PostgresRepository) LastPerformances(
	ctx context.Context, userID string, exerciseIDs []string,
) (map[string]Performance, error) {
	out := map[string]Performance{}
	if len(exerciseIDs) == 0 {
		return out, nil
	}
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT ON (ss.exercise_id)
		       ss.exercise_id, s.started_at, ss.reps, ss.weight_kg, ss.rir, ss.rpe,
		       e.movement_pattern, e.load_type
		FROM session_sets ss
		JOIN sessions s ON s.id = ss.session_id
		JOIN exercises e ON e.id = ss.exercise_id
		WHERE s.user_id = $1
		  AND ss.exercise_id = ANY($2)
		  AND ss.set_type <> 'warmup'
		  AND ss.completed
		  -- A set with nothing recorded isn't a performance. Without this, an
		  -- exercise added to a session and then not actually done would be
		  -- the "most recent" one and would erase real history behind it.
		  AND (ss.reps IS NOT NULL OR ss.weight_kg IS NOT NULL
		       OR ss.seconds IS NOT NULL OR ss.distance_m IS NOT NULL)
		ORDER BY ss.exercise_id,
		         s.started_at DESC,
		         ss.weight_kg DESC NULLS LAST,
		         ss.reps DESC NULLS LAST`, userID, exerciseIDs)
	if err != nil {
		return nil, fmt.Errorf("session: last performances: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var p Performance
		if err := rows.Scan(&p.ExerciseID, &p.PerformedAt, &p.Reps, &p.WeightKg,
			&p.RIR, &p.RPE, &p.MovementPattern, &p.LoadType); err != nil {
			return nil, fmt.Errorf("session: scan performance: %w", err)
		}
		out[p.ExerciseID] = p
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: performance rows: %w", err)
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

func insertSets(ctx context.Context, tx pgx.Tx, sessionID string, sets []Set) error {
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
		batch.Queue(`
			INSERT INTO session_sets (
				session_id, exercise_id, position, set_type, reps, weight_kg,
				seconds, distance_m, rir, rpe, notes, completed
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			sessionID, s.ExerciseID, i, st, s.Reps, s.WeightKg,
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

	if err := insertSets(ctx, tx, in.ID, in.Sets); err != nil {
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
	if err := insertSets(ctx, tx, sessionID, sets); err != nil {
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
