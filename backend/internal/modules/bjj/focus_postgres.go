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

func (r *PostgresRepository) SetFocus(ctx context.Context, userID string, techniqueIDs []string, source *FocusSource) error {
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

	// Which ids this write is allowed to attribute to the roadmap. A roadmap
	// write also re-sends the athlete's own entries, so this is a strict subset
	// of `techniqueIDs` and never the whole of it — see FocusSource.
	claimed := make(map[string]bool)
	if source != nil {
		for _, id := range source.TechniqueIDs {
			claimed[id] = true
		}
	}

	// Upsert first, then delete what is no longer listed. NOT delete-then-
	// insert, which is how `started_on` would be lost: the row would be gone
	// and come back with today's date, silently resetting the rotation clock on
	// every technique every time the athlete reorders the list.
	for _, e := range ordered {
		// The origin a row gets IF THIS WRITE INSERTS IT. On an existing row it
		// is ignored, which is the whole both-sources rule: a technique the
		// athlete picked by hand and a roadmap later also names stays
		// 'athlete', and therefore survives that roadmap's deactivation.
		origin := originAthlete
		if claimed[e.id] {
			origin = originRoadmap
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO bjj_focus (user_id, technique_id, position, origin)
			VALUES ($1, $2, $3, $4)
			-- position ONLY. started_on is deliberately absent: it records when
			-- this technique joined the list, and a re-save is not joining. Add
			-- it here and "you have been working on this five weeks" becomes
			-- "you have been working on this since the last time you touched
			-- the screen", which is worse than not having the column.
			--
			-- origin is absent for the SAME reason, and the failure is worse
			-- than a wrong date. Put it in this SET clause and every ordinary
			-- re-save rewrites provenance: a plain reorder from the proficiency
			-- screen sends no roadmap, so every roadmap-placed row would launder
			-- itself into 'athlete' and become undeletable — silently restoring
			-- the exact bug this column exists to fix, on the most ordinary edit
			-- there is. This is the fourth instance of the pattern that blanked
			-- data three times in exercise's updateWithin (migrations 000052,
			-- 000057, 000061), and it is guarded by
			-- TestReSavingAFocusListDoesNotRewriteProvenance rather than by
			-- anyone reading this comment.
			ON CONFLICT (user_id, technique_id)
			DO UPDATE SET position = EXCLUDED.position`, userID, e.id, e.position, origin)
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

	// Record the roadmap's claim, AFTER the prune so a row this write dropped
	// cannot be given a source it will never lose. Same sorted iteration as the
	// upsert, for the same lock-ordering reason.
	for _, e := range ordered {
		if !claimed[e.id] {
			continue
		}
		// THE GUARD IS `origin = 'roadmap'`, and it is doing two jobs at once.
		//
		// It lets a SECOND roadmap claim a row the first one placed — which is
		// what keeps "two roadmaps active, deactivate one" from taking the
		// other's technique away — while refusing to claim a row the athlete
		// owns ('athlete') or one whose provenance predates this column
		// ('unknown'). Both of those are sovereign, and staying out of the
		// sources table is what makes them so: ReleaseFocusSource can only ever
		// reach a row that has a source.
		if _, err := tx.Exec(ctx, `
			INSERT INTO bjj_focus_sources (user_id, technique_id, curriculum_id)
			SELECT f.user_id, f.technique_id, $3
			FROM bjj_focus f
			WHERE f.user_id = $1 AND f.technique_id = $2 AND f.origin = 'roadmap'
			ON CONFLICT DO NOTHING`, userID, e.id, source.CurriculumID); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23503" {
				// The curricula FK. Same generic shape as the technique case —
				// the client is told its input was bad, never which table said so.
				return fmt.Errorf("%w: unknown curriculum", ErrInvalidInput)
			}
			return fmt.Errorf("bjj: attribute focus: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("bjj: commit focus: %w", err)
	}
	return nil
}

// ReleaseFocusSource withdraws one roadmap's claim and removes what is left
// unclaimed. See FocusRepository for why it lives in this package.
func (r *PostgresRepository) ReleaseFocusSource(ctx context.Context, userID, curriculumID string) error {
	// ONE statement, and the `curriculum_id <> $2` in the NOT EXISTS is
	// load-bearing rather than tidy.
	//
	// A data-modifying CTE and the statement around it both read the SAME
	// SNAPSHOT: the outer DELETE cannot see the rows `released` is removing. So
	// the obvious spelling — "no sources remain" — evaluates against the sources
	// that still include this curriculum's, is false for every row, and deletes
	// NOTHING while reporting success. That is a silent no-op wearing the shape
	// of a fix, so the subquery excludes $2 explicitly instead of relying on an
	// ordering the snapshot does not give it.
	//
	// `origin = 'roadmap'` is belt-and-braces: a row that is 'athlete' or
	// 'unknown' can never have a source (SetFocus refuses to give it one), so
	// this predicate should be redundant. It stays because "should be" is doing
	// the work of a constraint that does not exist, and the cost of being wrong
	// is deleting something the athlete chose.
	if _, err := r.pool.Exec(ctx, `
		WITH released AS (
			DELETE FROM bjj_focus_sources
			WHERE user_id = $1 AND curriculum_id = $2
			RETURNING technique_id
		)
		DELETE FROM bjj_focus f
		USING released rel
		WHERE f.user_id = $1
		  AND f.technique_id = rel.technique_id
		  AND f.origin = 'roadmap'
		  AND NOT EXISTS (
			  SELECT 1 FROM bjj_focus_sources s
			  WHERE s.user_id = f.user_id
			    AND s.technique_id = f.technique_id
			    AND s.curriculum_id <> $2
		  )`, userID, curriculumID); err != nil {
		return fmt.Errorf("bjj: release focus source: %w", err)
	}
	return nil
}
