package exercise

import (
	"context"
	"errors"
	"fmt"

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

// List applies both filters in SQL rather than in Go. The catalog is small
// today, but filtering after fetching everything is the kind of thing that
// stays invisible until the table has a few thousand rows.
func (r *PostgresRepository) List(ctx context.Context, f Filter) ([]Exercise, error) {
	// $1/$2 are always bound; an empty value disables that predicate, which
	// keeps this a single static query plan instead of concatenated SQL.
	rows, err := r.pool.Query(ctx, `
		SELECT `+selectColumns+`
		FROM exercises
		WHERE ($1 = '' OR sport = $1)
		  AND ($2 = '' OR name ILIKE '%' || $2 || '%')
		ORDER BY sport, name`, f.Sport, f.Query)
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

// Upsert is idempotent on id so re-running the seed is always safe — that's
// what lets seeding be a normal deploy step rather than a one-shot someone
// has to remember not to repeat. created_at is deliberately preserved.
func (r *PostgresRepository) Upsert(ctx context.Context, e Exercise) error {
	_, err := r.pool.Exec(ctx, `
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
			updated_at        = now()`,
		e.ID, e.Name, e.Sport, e.MovementPattern, e.PrimaryMuscles,
		e.SecondaryMuscles, e.Equipment, e.LoadType, e.IsUnilateral, e.Instructions)
	if err != nil {
		return fmt.Errorf("exercise: upsert %q: %w", e.ID, err)
	}
	return nil
}
