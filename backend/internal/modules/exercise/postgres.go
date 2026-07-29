package exercise

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

const selectColumns = `
	id, name, sport, movement_pattern, primary_muscles, secondary_muscles,
	equipment, load_type, is_unilateral, instructions, created_at, updated_at`

type scannable interface {
	Scan(dest ...any) error
}

func scanExercise(row scannable) (*Exercise, error) {
	var e Exercise
	err := row.Scan(
		&e.ID, &e.Name, &e.Sport, &e.MovementPattern, &e.PrimaryMuscles,
		&e.SecondaryMuscles, &e.Equipment, &e.LoadType, &e.IsUnilateral,
		&e.Instructions, &e.CreatedAt, &e.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// LIKE/ILIKE treat %, _ and \ as pattern metacharacters. Binding a parameter
// stops SQL injection but not *pattern* injection — a bare "%" typed into a
// search box would otherwise match the entire table. Different problem, same
// untrusted input.
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// List builds its WHERE clause from compile-time-constant fragments, adding
// only bound values — never user input — to the SQL text.
//
// The tempting alternative, one static query with an empty-string sentinel
// is actively worse here. pgx defaults to cached prepared statements, and
// once PostgreSQL settles on a generic plan the parameter is opaque, so it
// can't fold the OR away and the sport index becomes structurally
// unreachable — it seq-scans even for a highly selective value. Composing
// the clause gives one cached plan per filter shape, each able to use its
// index, at no injection cost.
func (r *PostgresRepository) List(ctx context.Context, f Filter) ([]Exercise, error) {
	var (
		where []string
		args  []any
	)
	if f.Sport != "" {
		args = append(args, f.Sport)
		where = append(where, fmt.Sprintf("sport = $%d", len(args)))
	}
	if f.Query != "" {
		args = append(args, likeEscaper.Replace(f.Query))
		where = append(where, fmt.Sprintf(`name ILIKE '%%' || $%d || '%%' ESCAPE '\'`, len(args)))
	}

	q := `SELECT ` + selectColumns + ` FROM exercises`
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, " AND ")
	}
	q += ` ORDER BY sport, name`

	rows, err := r.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("exercise: list: %w", err)
	}
	defer rows.Close()

	exercises := []Exercise{}
	for rows.Next() {
		e, err := scanExercise(rows)
		if err != nil {
			return nil, fmt.Errorf("exercise: scan: %w", err)
		}
		exercises = append(exercises, *e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("exercise: rows: %w", err)
	}
	return exercises, nil
}

func (r *PostgresRepository) Get(ctx context.Context, id string) (*Exercise, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+selectColumns+` FROM exercises WHERE id = $1`, id)
	e, err := scanExercise(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("exercise: get: %w", err)
	}
	return e, nil
}

// The trailing WHERE makes an unchanged row a genuine no-op rather than a
// rewrite. Without it `updated_at = now()` fires on every re-seed, so
// `updated_at` degrades into "time of last deploy" instead of "time of last
// content change" — which would break the delta sync an offline-first
// client wants ("give me everything changed since X" returning the whole
// catalog after every deploy), and churn the table for nothing.
//
// The comparison lists content columns only: including created_at/updated_at
// would make it trivially true every time and defeat the point.
const upsertSQL = `
	INSERT INTO exercises (
		id, name, sport, movement_pattern, primary_muscles,
		secondary_muscles, equipment, load_type, is_unilateral, instructions
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	ON CONFLICT (id) DO UPDATE SET
		name              = EXCLUDED.name,
		sport             = EXCLUDED.sport,
		movement_pattern  = EXCLUDED.movement_pattern,
		primary_muscles   = EXCLUDED.primary_muscles,
		secondary_muscles = EXCLUDED.secondary_muscles,
		equipment         = EXCLUDED.equipment,
		load_type         = EXCLUDED.load_type,
		is_unilateral     = EXCLUDED.is_unilateral,
		instructions      = EXCLUDED.instructions,
		updated_at        = now()
	WHERE (
		exercises.name, exercises.sport, exercises.movement_pattern,
		exercises.primary_muscles, exercises.secondary_muscles,
		exercises.equipment, exercises.load_type, exercises.is_unilateral,
		exercises.instructions
	) IS DISTINCT FROM (
		EXCLUDED.name, EXCLUDED.sport, EXCLUDED.movement_pattern,
		EXCLUDED.primary_muscles, EXCLUDED.secondary_muscles,
		EXCLUDED.equipment, EXCLUDED.load_type, EXCLUDED.is_unilateral,
		EXCLUDED.instructions
	)`

func upsertArgs(e Exercise) []any {
	return []any{
		e.ID, e.Name, e.Sport, e.MovementPattern, e.PrimaryMuscles,
		e.SecondaryMuscles, e.Equipment, e.LoadType, e.IsUnilateral, e.Instructions,
	}
}

// UpsertAll writes the whole catalog in one transaction, so a deploy either
// fully applies the content or leaves it untouched — a failure partway
// through a row-at-a-time loop would otherwise leave a half-updated catalog
// visible to readers until someone re-ran it.
func (r *PostgresRepository) UpsertAll(ctx context.Context, exercises []Exercise) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("exercise: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	batch := &pgx.Batch{}
	for _, e := range exercises {
		batch.Queue(upsertSQL, upsertArgs(e)...)
	}

	results := tx.SendBatch(ctx, batch)
	for i := range exercises {
		if _, err := results.Exec(); err != nil {
			results.Close() //nolint:errcheck // returning the more useful error
			return fmt.Errorf("exercise: upsert %q: %w", exercises[i].ID, err)
		}
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("exercise: batch: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("exercise: commit: %w", err)
	}
	return nil
}
