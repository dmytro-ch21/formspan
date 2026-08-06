package curriculum

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The VOLA-authored belt syllabuses, embedded so a deploy carries them.
//
// Same shape as the technique and exercise catalogs: version-controlled JSON,
// upserted by `cmd/seed`, safe to re-run. Editing this file and deploying is
// how a syllabus changes.
//
//go:embed curricula.json
var seedJSON []byte

// SeedCurriculum is one syllabus as authored. Deliberately NOT the domain
// `Curriculum` type: that one carries per-caller state (enrolled, editable,
// progress) which is meaningless in a content file, and reusing it would invite
// somebody to author a value for it.
type SeedCurriculum struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Belt        string     `json:"belt"`
	Description string     `json:"description"`
	Items       []SeedItem `json:"items"`
}

type SeedItem struct {
	TechniqueID    string   `json:"technique_id"`
	Notes          string   `json:"notes"`
	TargetScored   *int     `json:"target_scored"`
	TargetDefended *int     `json:"target_defended"`
	TargetSessions *int     `json:"target_sessions"`
	MinHitRate     *float64 `json:"min_hit_rate"`
}

// SeedData parses the embedded syllabuses. Exported so a test can read them
// without a database — which is how the id-integrity check below stays cheap.
func SeedData() ([]SeedCurriculum, error) {
	var out []SeedCurriculum
	if err := json.Unmarshal(seedJSON, &out); err != nil {
		return nil, fmt.Errorf("curriculum: parse seed: %w", err)
	}
	return out, nil
}

// Seed writes the syllabuses, and returns how many it wrote.
//
// **Ownerless, public, source='seed'.** Those three together are what makes a
// syllabus VOLA-authored content rather than somebody's list: nullable owner is
// the workouts convention, the CHECK requires an ownerless row to be public,
// and `source` is what lets a future prune scope itself to deploy-owned rows
// without touching anything the admin console wrote.
//
// **Stable ids from the JSON**, not generated — that is what makes this an
// upsert rather than a duplicate factory. Re-running after editing a syllabus
// updates it in place, and every athlete's enrollment survives, because
// enrollment references the id.
//
// **Items are replaced wholesale on every run.** A syllabus is content and the
// file is the source of truth, so a removed item must actually go. Note what
// that costs and why it is still right: `curriculum_items` cascades from the
// curriculum but is deleted here directly, so an athlete's PROGRESS is
// untouched — progress lives in `bjj_session_tags` and is recomputed on read,
// which is exactly the property that makes reseeding safe.
func Seed(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	data, err := SeedData()
	if err != nil {
		return 0, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("curriculum: begin seed: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, c := range data {
		if err := seedOne(ctx, tx, c); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("curriculum: commit seed: %w", err)
	}
	return len(data), nil
}

func seedOne(ctx context.Context, tx pgx.Tx, c SeedCurriculum) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO curricula (id, owner_user_id, source, name, description, belt, visibility)
		VALUES ($1, NULL, 'seed', $2, $3, $4, 'public')
		ON CONFLICT (id) DO UPDATE SET
			name        = excluded.name,
			description = excluded.description,
			belt        = excluded.belt,
			updated_at  = now()
		-- Scoped to seed rows. Without this, an id collision with something the
		-- admin console authored would let a deploy silently overwrite it --
		-- which is the exact failure 000032's source column exists to prevent,
		-- and the reason that column was added before there was a second writer.
		WHERE curricula.source = 'seed'`,
		c.ID, c.Name, c.Description, c.Belt)
	if err != nil {
		return translate(err, "seed curriculum "+c.ID)
	}

	if _, err := tx.Exec(ctx,
		`DELETE FROM curriculum_items WHERE curriculum_id = $1`, c.ID); err != nil {
		return fmt.Errorf("curriculum: clear seed items for %s: %w", c.ID, err)
	}

	for i, it := range c.Items {
		_, err := tx.Exec(ctx, `
			INSERT INTO curriculum_items
				(curriculum_id, technique_id, sort_order, notes,
				 target_scored, target_defended, target_sessions, min_hit_rate)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			c.ID, it.TechniqueID, i, it.Notes,
			it.TargetScored, it.TargetDefended, it.TargetSessions, it.MinHitRate)
		if err != nil {
			// Named loudly. The overwhelmingly likely cause is a technique_id
			// that is not in the library -- a typo in the JSON, or a technique
			// renamed out from under a syllabus -- and a foreign-key violation
			// reported as "invalid input" would send the next person looking at
			// the criteria instead of the id.
			return fmt.Errorf(
				"curriculum: seed %s item %d (%s): %w", c.ID, i, it.TechniqueID, err)
		}
	}
	return nil
}
