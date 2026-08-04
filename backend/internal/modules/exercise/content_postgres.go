package exercise

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// contentReturning is the projection both writes read back.
//
// No COALESCE anywhere, unlike the technique module's: every column here is
// `NOT NULL` with a default, and the domain type models each absent value as an
// empty string or empty slice rather than as NULL. There is no field where
// "not recorded" is a different fact from "empty".
//
// Media is absent on purpose — it lives in `exercise_media` and no write on
// this path touches it. See ContentRepository.
const contentReturning = `
	id, name, sport, movement_pattern, movement_pattern_detail,
	primary_muscles, secondary_muscles, equipment, load_type,
	is_unilateral, instructions, source, created_at, updated_at`

type contentScannable interface {
	Scan(dest ...any) error
}

func scanContent(s contentScannable) (Exercise, error) {
	var e Exercise
	err := s.Scan(&e.ID, &e.Name, &e.Sport, &e.MovementPattern,
		&e.MovementPatternDetail, &e.PrimaryMuscles, &e.SecondaryMuscles,
		&e.Equipment, &e.LoadType, &e.IsUnilateral, &e.Instructions,
		&e.Source, &e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		return Exercise{}, err
	}
	// `[]`, never nil, for the same reason the export writes `[]`: these are
	// `TEXT[] NOT NULL` columns, and a nil slice round-tripping back through a
	// write would be sent as NULL and fail the constraint.
	e.PrimaryMuscles = nonNil(e.PrimaryMuscles)
	e.SecondaryMuscles = nonNil(e.SecondaryMuscles)
	e.Equipment = nonNil(e.Equipment)
	// Media is not selected here; a caller that needs it uses the read path.
	e.Media = []Media{}
	return e, nil
}

func nonNil(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

func (r *PostgresRepository) CreateExercise(ctx context.Context, e Exercise) (Exercise, error) {
	// No ON CONFLICT. A collision has to surface as an error rather than quietly
	// become an update: the id may already be a foreign key in a workout item or
	// a logged set, so rewriting the exercise behind it changes what somebody's
	// training history says they did.
	row := r.pool.QueryRow(ctx, `
		INSERT INTO exercises (
			id, name, sport, movement_pattern, movement_pattern_detail,
			primary_muscles, secondary_muscles, equipment, load_type,
			is_unilateral, instructions, source
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'admin')
		RETURNING `+contentReturning,
		e.ID, e.Name, e.Sport, e.MovementPattern, e.MovementPatternDetail,
		nonNil(e.PrimaryMuscles), nonNil(e.SecondaryMuscles), nonNil(e.Equipment),
		e.LoadType, e.IsUnilateral, e.Instructions)

	out, err := scanContent(row)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation
			return Exercise{}, ErrAlreadyExists
		}
		return Exercise{}, fmt.Errorf("exercise: create: %w", err)
	}
	return out, nil
}

func (r *PostgresRepository) UpdateExercise(ctx context.Context, e Exercise) (Exercise, error) {
	// `source = 'admin'` sits in the WHERE rather than a check in Go, so this is
	// one statement and cannot race. Editing a SEEDED row here would be reverted
	// by the next deploy's re-seed — silently, and only for the fields the
	// change-detection tuple covers, which is the worst kind of half-applied.
	row := r.pool.QueryRow(ctx, `
		UPDATE exercises SET
			name = $2, sport = $3, movement_pattern = $4,
			movement_pattern_detail = $5, primary_muscles = $6,
			secondary_muscles = $7, equipment = $8, load_type = $9,
			is_unilateral = $10, instructions = $11, updated_at = now()
		WHERE id = $1 AND source = 'admin'
		RETURNING `+contentReturning,
		e.ID, e.Name, e.Sport, e.MovementPattern, e.MovementPatternDetail,
		nonNil(e.PrimaryMuscles), nonNil(e.SecondaryMuscles), nonNil(e.Equipment),
		e.LoadType, e.IsUnilateral, e.Instructions)

	out, err := scanContent(row)
	if errors.Is(err, pgx.ErrNoRows) {
		// Covers both "no such exercise" and "that one is seeded". Told apart in
		// the handler, which looks the id up to say which — the two need
		// different advice, and a bare 404 for a row the console is displaying
		// reads as a bug.
		return Exercise{}, ErrNotFound
	}
	if err != nil {
		return Exercise{}, fmt.Errorf("exercise: update: %w", err)
	}
	return out, nil
}

func (r *PostgresRepository) GetExercise(ctx context.Context, id string) (Exercise, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+contentReturning+` FROM exercises WHERE id = $1`, id)
	out, err := scanContent(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Exercise{}, ErrNotFound
	}
	if err != nil {
		return Exercise{}, fmt.Errorf("exercise: get for write: %w", err)
	}
	return out, nil
}

func (r *PostgresRepository) Source(ctx context.Context, id string) (string, error) {
	var source string
	err := r.pool.QueryRow(ctx, `SELECT source FROM exercises WHERE id = $1`, id).Scan(&source)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("exercise: source: %w", err)
	}
	return source, nil
}

// AdminAuthored returns every console-authored exercise.
//
// Ordered by id so the exported file is byte-stable across runs — a re-export
// with no changes must produce no diff, or the review step the promotion path
// depends on becomes noise nobody reads.
func (r *PostgresRepository) AdminAuthored(ctx context.Context) ([]Exercise, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT `+contentReturning+` FROM exercises WHERE source = 'admin' ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("exercise: admin authored: %w", err)
	}
	defer rows.Close()
	out := []Exercise{}
	for rows.Next() {
		e, err := scanContent(rows)
		if err != nil {
			return nil, fmt.Errorf("exercise: scan authored: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// AdoptAsSeeded hands rows to the deploy once the exported JSON is committed
// and released.
//
// Scoped to `source = 'admin'`, and the reason is not the value — setting
// `seed` on a row that is already `seed` is invisible — but `updated_at`.
// Clients delta-sync on it, so an unscoped adoption makes every seeded exercise
// look changed to every device.
func (r *PostgresRepository) AdoptAsSeeded(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := r.pool.Exec(ctx,
		`UPDATE exercises SET source = 'seed', updated_at = now()
		 WHERE source = 'admin' AND id = ANY($1)`, ids)
	if err != nil {
		return fmt.Errorf("exercise: adopt: %w", err)
	}
	return nil
}
