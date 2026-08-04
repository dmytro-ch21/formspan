package bjj

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

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
		ORDER BY f.position, f.technique_id
		-- The cap lives in the handler, which is the only writer today. This
		-- puts the bound next to the thing it protects: history.md already
		-- anticipates curricula writing pre-authored focus rows, and that would
		-- be a second writer with no ceiling of its own.
		LIMIT $2`, userID, maxFocus)
	if err != nil {
		return nil, fmt.Errorf("bjj: focus: %w", err)
	}
	defer rows.Close()

	// Non-nil so this marshals to [] rather than null.
	out := []Focus{}
	for rows.Next() {
		var (
			f         Focus
			startedOn time.Time
		)
		if err := rows.Scan(&f.TechniqueID, &f.Name, &f.Position, &f.Category, &startedOn); err != nil {
			return nil, fmt.Errorf("bjj: scan focus: %w", err)
		}
		// Formatted here rather than left to encoding/json — see the field.
		f.StartedOn = startedOn.Format(dateLayout)
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

	// nil is not the same as empty to pgx: `[]string(nil)` binds as SQL NULL,
	// and `technique_id <> ALL(NULL)` is NULL for every row, so the prune below
	// would delete nothing and a PUT with no body would return 200 having
	// changed nothing. That is the exact failure the `<> ALL` choice was made
	// to avoid — the NULL simply moved from an ELEMENT of the array to the
	// array parameter itself. The handler also rejects a missing field, so this
	// is the second of two guards rather than the only one.
	if techniqueIDs == nil {
		techniqueIDs = []string{}
	}

	// Lock in a canonical order, NOT the athlete's ranking.
	//
	// The upsert takes a row lock per id, so iterating in array order means two
	// devices saving the same techniques ranked differently take the same locks
	// in opposite orders. Measured before this: 23 deadlocks in 40 concurrent
	// rounds, surfacing as a 500. Sorting the ITERATION while keeping `position`
	// from the original index makes every transaction take locks in the same
	// sequence — measured 0 in 40 — and leaves the stored ranking untouched.
	type entry struct {
		id       string
		position int
	}
	ordered := make([]entry, len(techniqueIDs))
	for i, id := range techniqueIDs {
		ordered[i] = entry{id: id, position: i}
	}
	sort.Slice(ordered, func(a, b int) bool { return ordered[a].id < ordered[b].id })

	// Upsert first, then delete what is no longer listed. NOT delete-then-
	// insert, which is how `started_on` would be lost: the row would be gone
	// and come back with today's date, silently resetting the rotation clock on
	// every technique every time the athlete reorders the list.
	for _, e := range ordered {
		_, err := tx.Exec(ctx, `
			INSERT INTO bjj_focus (user_id, technique_id, position)
			VALUES ($1, $2, $3)
			-- position ONLY. started_on is deliberately absent: it records when
			-- this technique joined the list, and a re-save is not joining. Add
			-- it here and "you have been working on this five weeks" becomes
			-- "you have been working on this since the last time you touched
			-- the screen", which is worse than not having the column.
			ON CONFLICT (user_id, technique_id)
			DO UPDATE SET position = EXCLUDED.position`, userID, e.id, e.position)
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
