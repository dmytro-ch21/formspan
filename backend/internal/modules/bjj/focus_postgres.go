package bjj

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
)

func (r *PostgresRepository) Focus(ctx context.Context, userID string) ([]Focus, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT f.technique_id, lib.name, lib.position, lib.category, f.started_on
		FROM bjj_focus f
		-- INNER, unlike the proficiency read's LEFT. There, a row with an
		-- unresolvable technique is an athlete's history and must survive; here
		-- it is an intention to work on something that no longer exists. The
		-- CASCADE means it cannot happen anyway -- this join simply agrees with
		-- the FK instead of quietly disagreeing with it.
		JOIN techniques lib ON lib.id = f.technique_id
		WHERE f.user_id = $1
		-- The athlete's own order. technique_id makes it total, so two entries
		-- sharing a position cannot swap between reads.
		ORDER BY f.position, f.technique_id`, userID)
	if err != nil {
		return nil, fmt.Errorf("bjj: focus: %w", err)
	}
	defer rows.Close()

	// Non-nil so this marshals to [] rather than null.
	out := []Focus{}
	for rows.Next() {
		var f Focus
		if err := rows.Scan(&f.TechniqueID, &f.Name, &f.Position, &f.Category, &f.StartedOn); err != nil {
			return nil, fmt.Errorf("bjj: scan focus: %w", err)
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (r *PostgresRepository) SetFocus(ctx context.Context, userID string, techniqueIDs []string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("bjj: begin focus: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Upsert first, then delete what is no longer listed. NOT delete-then-
	// insert, which is how `started_on` would be lost: the row would be gone
	// and come back with today's date, silently resetting the rotation clock on
	// every technique every time the athlete reorders the list.
	for i, id := range techniqueIDs {
		_, err := tx.Exec(ctx, `
			INSERT INTO bjj_focus (user_id, technique_id, position)
			VALUES ($1, $2, $3)
			-- position ONLY. started_on is deliberately absent: it records when
			-- this technique joined the list, and a re-save is not joining. Add
			-- it here and "you have been working on this five weeks" becomes
			-- "you have been working on this since the last time you touched
			-- the screen", which is worse than not having the column.
			ON CONFLICT (user_id, technique_id)
			DO UPDATE SET position = EXCLUDED.position`, userID, id, i)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23503" {
				return fmt.Errorf("%w: unknown technique", ErrInvalidInput)
			}
			return fmt.Errorf("bjj: set focus: %w", err)
		}
	}

	// `<> ALL` rather than `NOT IN`: NOT IN against a list containing NULL
	// yields NULL for every row and deletes nothing. No NULL can reach here
	// today, but the failure mode is a silent no-op rather than an error.
	if _, err := tx.Exec(ctx,
		`DELETE FROM bjj_focus WHERE user_id = $1 AND technique_id <> ALL($2)`,
		userID, techniqueIDs); err != nil {
		return fmt.Errorf("bjj: prune focus: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("bjj: commit focus: %w", err)
	}
	return nil
}
