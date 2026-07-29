package workout

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// translatePgError converts constraint violations into domain errors, so a
// bad request reaches the client as 400 rather than 500. Without it a
// target_sets of 0 trips the CHECK and surfaces as an internal error, which
// is both a lie and a contract violation.
//
// Deliberately does NOT include pgErr.Message in the returned error: the
// handler surfaces ErrInvalidInput text to the client, and Postgres messages
// name constraints, columns, and sometimes values.
func translatePgError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23514": // check_violation
		return fmt.Errorf("%w: a target value is out of range", ErrInvalidInput)
	case "22003": // numeric_value_out_of_range
		return fmt.Errorf("%w: a target value is too large", ErrInvalidInput)
	case "23503": // foreign_key_violation
		return fmt.Errorf("%w: unknown exercise", ErrInvalidInput)
	case "23505": // unique_violation
		return ErrAlreadyExists
	}
	return err
}

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

const workoutColumns = `
	id, owner_user_id, name, sport, goal, notes, visibility, created_at, updated_at`

type scannable interface{ Scan(dest ...any) error }

func scanWorkout(row scannable) (*Workout, error) {
	var w Workout
	err := row.Scan(&w.ID, &w.OwnerUserID, &w.Name, &w.Sport, &w.Goal,
		&w.Notes, &w.Visibility, &w.CreatedAt, &w.UpdatedAt)
	if err != nil {
		return nil, err
	}
	w.Items = []Item{}
	return &w, nil
}

// visibleTo is the single place the read-authorization rule lives: you may
// see your own workouts and anything public. Written once and reused by both
// List and Get so the two can't drift apart — a Get that's more permissive
// than its List is a classic way to leak rows.
const visibleTo = `(owner_user_id = $1 OR visibility = 'public')`

func (r *PostgresRepository) List(ctx context.Context, userID string, f Filter) ([]Workout, error) {
	where := []string{visibleTo}
	args := []any{userID}

	// Mine/Shared narrow *within* what's already visible — they can never
	// widen it, because visibleTo is applied unconditionally above.
	switch {
	case f.Mine && !f.Shared:
		where = append(where, `owner_user_id = $1`)
	case f.Shared && !f.Mine:
		where = append(where, `(owner_user_id IS DISTINCT FROM $1 AND visibility = 'public')`)
	}
	if f.Sport != "" {
		args = append(args, f.Sport)
		where = append(where, fmt.Sprintf(`sport = $%d`, len(args)))
	}
	if f.Goal != "" {
		args = append(args, f.Goal)
		where = append(where, fmt.Sprintf(`goal = $%d`, len(args)))
	}

	rows, err := r.pool.Query(ctx, `SELECT `+workoutColumns+` FROM workouts WHERE `+
		strings.Join(where, " AND ")+` ORDER BY name, id`, args...)
	if err != nil {
		return nil, fmt.Errorf("workout: list: %w", err)
	}
	defer rows.Close()

	workouts := []Workout{}
	ids := []string{}
	for rows.Next() {
		w, err := scanWorkout(rows)
		if err != nil {
			return nil, fmt.Errorf("workout: scan: %w", err)
		}
		workouts = append(workouts, *w)
		ids = append(ids, w.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("workout: rows: %w", err)
	}
	if err := r.attachItems(ctx, workouts, ids); err != nil {
		return nil, err
	}
	return workouts, nil
}

// attachItems loads every listed workout's items in one query — one round
// trip for the whole page rather than one per workout.
func (r *PostgresRepository) attachItems(ctx context.Context, workouts []Workout, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.pool.Query(ctx, `
		SELECT workout_id, exercise_id, position, target_sets, target_reps,
		       target_weight_kg, target_seconds, target_distance_m, notes
		FROM workout_items
		WHERE workout_id = ANY($1)
		ORDER BY workout_id, position`, ids)
	if err != nil {
		return fmt.Errorf("workout: list items: %w", err)
	}
	defer rows.Close()

	byWorkout := make(map[string][]Item, len(ids))
	for rows.Next() {
		var (
			workoutID string
			it        Item
		)
		if err := rows.Scan(&workoutID, &it.ExerciseID, &it.Position, &it.TargetSets,
			&it.TargetReps, &it.TargetWeightKg, &it.TargetSeconds,
			&it.TargetDistanceM, &it.Notes); err != nil {
			return fmt.Errorf("workout: scan item: %w", err)
		}
		byWorkout[workoutID] = append(byWorkout[workoutID], it)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("workout: item rows: %w", err)
	}
	for i := range workouts {
		if items := byWorkout[workouts[i].ID]; items != nil {
			workouts[i].Items = items
		}
	}
	return nil
}

func (r *PostgresRepository) Get(ctx context.Context, userID, id string) (*Workout, error) {
	row := r.pool.QueryRow(ctx,
		`SELECT `+workoutColumns+` FROM workouts WHERE id = $2 AND `+visibleTo, userID, id)
	w, err := scanWorkout(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Same error whether it doesn't exist or isn't visible — telling
			// them apart would let a caller enumerate other people's IDs.
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("workout: get: %w", err)
	}
	one := []Workout{*w}
	if err := r.attachItems(ctx, one, []string{w.ID}); err != nil {
		return nil, err
	}
	return &one[0], nil
}

// assertSportsMatch rejects items whose exercise belongs to a different
// sport than the workout. Checked here rather than trusted from the client:
// "no mixed workouts" is a data-model guarantee, not a UI convention.
//
// One query for all the referenced exercises, not one per item.
func assertSportsMatch(ctx context.Context, tx pgx.Tx, sport Sport, items []Item) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]string, 0, len(items))
	for _, it := range items {
		ids = append(ids, it.ExerciseID)
	}

	rows, err := tx.Query(ctx, `SELECT id, sport FROM exercises WHERE id = ANY($1)`, ids)
	if err != nil {
		return fmt.Errorf("workout: check exercise sports: %w", err)
	}
	defer rows.Close()

	found := map[string]string{}
	for rows.Next() {
		var id, s string
		if err := rows.Scan(&id, &s); err != nil {
			return fmt.Errorf("workout: scan exercise sport: %w", err)
		}
		found[id] = s
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("workout: exercise sport rows: %w", err)
	}

	for _, it := range items {
		s, ok := found[it.ExerciseID]
		if !ok {
			return fmt.Errorf("%w: unknown exercise %q", ErrInvalidInput, it.ExerciseID)
		}
		if Sport(s) != sport {
			return fmt.Errorf("%w: %q is %s, workout is %s",
				ErrSportMismatch, it.ExerciseID, s, sport)
		}
	}
	return nil
}

func insertItems(ctx context.Context, tx pgx.Tx, workoutID string, items []Item) error {
	batch := &pgx.Batch{}
	for i, it := range items {
		// Position is assigned from the array order rather than trusted from
		// the client, so a caller can't create gaps, duplicates, or a list
		// whose stored order differs from the one they sent.
		batch.Queue(`
			INSERT INTO workout_items (
				workout_id, exercise_id, position, target_sets, target_reps,
				target_weight_kg, target_seconds, target_distance_m, notes
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			workoutID, it.ExerciseID, i, it.TargetSets, it.TargetReps,
			it.TargetWeightKg, it.TargetSeconds, it.TargetDistanceM, it.Notes)
	}
	results := tx.SendBatch(ctx, batch)
	for range items {
		if _, err := results.Exec(); err != nil {
			results.Close() //nolint:errcheck // returning the more useful error
			if t := translatePgError(err); !errors.Is(t, err) {
				return t
			}
			return fmt.Errorf("workout: insert item: %w", err)
		}
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("workout: item batch: %w", err)
	}
	return nil
}

func (r *PostgresRepository) Create(ctx context.Context, in NewWorkout) (*Workout, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("workout: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	if err := assertSportsMatch(ctx, tx, in.Sport, in.Items); err != nil {
		return nil, err
	}

	var created bool
	err = tx.QueryRow(ctx, `
		INSERT INTO workouts (id, owner_user_id, name, sport, goal, notes, visibility)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO NOTHING
		RETURNING true`,
		in.ID, in.OwnerUserID, in.Name, in.Sport, in.Goal, in.Notes, in.Visibility).Scan(&created)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("workout: create: %w", err)
	}

	if errors.Is(err, pgx.ErrNoRows) {
		// The ID already exists. IDs are client-generated, so this fallback
		// MUST be scoped to the caller — the same IDOR the activity module
		// had: without the owner predicate, replaying someone else's ID
		// would hand back their workout.
		var owner *string
		if err := tx.QueryRow(ctx,
			`SELECT owner_user_id FROM workouts WHERE id = $1`, in.ID).Scan(&owner); err != nil {
			return nil, fmt.Errorf("workout: create conflict: %w", err)
		}
		if owner == nil || *owner != in.OwnerUserID {
			return nil, ErrAlreadyExists
		}
		// Same owner re-sending the same ID is an idempotent retry.
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("workout: commit: %w", err)
		}
		return r.Get(ctx, in.OwnerUserID, in.ID)
	}

	if err := insertItems(ctx, tx, in.ID, in.Items); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("workout: commit: %w", err)
	}
	return r.Get(ctx, in.OwnerUserID, in.ID)
}

// requireOwner resolves a workout for writing.
//
// ErrForbidden is reserved for rows the caller can actually *see*; anything
// else is ErrNotFound. That distinction is the whole point: an earlier
// version selected only owner and sport, so writing to a stranger's PRIVATE
// workout returned 403 while a nonexistent ID returned 404 — and that pair
// of answers confirms the ID exists. Since IDs are client-generated and
// therefore often guessable ("push-day-a") rather than random, that made the
// write paths a practical enumeration oracle for private workouts, undoing
// the guarantee Get already upheld.
//
// FOR UPDATE locks the row for the transaction, so two concurrent
// ReplaceItems calls on one workout serialise instead of racing into a
// (workout_id, position) unique violation — a real case here, given the
// offline sync model retries.
func requireOwner(ctx context.Context, tx pgx.Tx, userID, workoutID string) (Sport, error) {
	var (
		owner      *string
		sport      Sport
		visibility Visibility
	)
	err := tx.QueryRow(ctx,
		`SELECT owner_user_id, sport, visibility FROM workouts WHERE id = $1 FOR UPDATE`,
		workoutID).Scan(&owner, &sport, &visibility)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("workout: load for write: %w", err)
	}

	isOwner := owner != nil && *owner == userID
	if isOwner {
		return sport, nil
	}
	if visibility != VisibilityPublic {
		// Not visible to this caller — indistinguishable from missing.
		return "", ErrNotFound
	}
	// Visible but not theirs. Official templates (nil owner) are always
	// public per the schema CHECK, so they land here: read-only, as intended.
	return "", ErrForbidden
}

func (r *PostgresRepository) ReplaceItems(ctx context.Context, userID, workoutID string, items []Item) (*Workout, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("workout: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	sport, err := requireOwner(ctx, tx, userID, workoutID)
	if err != nil {
		return nil, err
	}
	if err := assertSportsMatch(ctx, tx, sport, items); err != nil {
		return nil, err
	}

	// Replace wholesale rather than diffing: reordering is the common edit,
	// and a diff would have to dance around the (workout_id, position)
	// unique constraint for no real benefit at this size.
	if _, err := tx.Exec(ctx, `DELETE FROM workout_items WHERE workout_id = $1`, workoutID); err != nil {
		return nil, fmt.Errorf("workout: clear items: %w", err)
	}
	if err := insertItems(ctx, tx, workoutID, items); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE workouts SET updated_at = now() WHERE id = $1`, workoutID); err != nil {
		return nil, fmt.Errorf("workout: touch: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("workout: commit: %w", err)
	}
	return r.Get(ctx, userID, workoutID)
}

func (r *PostgresRepository) Delete(ctx context.Context, userID, id string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("workout: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	if _, err := requireOwner(ctx, tx, userID, id); err != nil {
		return err
	}
	// workout_items cascade.
	if _, err := tx.Exec(ctx, `DELETE FROM workouts WHERE id = $1`, id); err != nil {
		return fmt.Errorf("workout: delete: %w", err)
	}
	return tx.Commit(ctx)
}
