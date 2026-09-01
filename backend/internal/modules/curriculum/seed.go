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
//
// Two content shapes, and a file may use either per curriculum: flat `items`
// (the original format — every existing syllabus), or `phases` each carrying
// its own items (the phase-structured belt curricula). Both at once is also
// legal; the flat items come first, unphased.
type SeedCurriculum struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Belt string `json:"belt"`
	// Track is the browse section — "belt", "foundations". Empty seeds NULL,
	// matching Belt's treatment one field up.
	Track       string      `json:"track"`
	Description string      `json:"description"`
	Phases      []SeedPhase `json:"phases"`
	Items       []SeedItem  `json:"items"`
}

type SeedPhase struct {
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Items       []SeedItem `json:"items"`
}

type SeedItem struct {
	// Kind is "technique" or "concept"; empty means technique, so the original
	// flat format keeps meaning what it meant.
	Kind        string `json:"kind"`
	TechniqueID string `json:"technique_id"`
	// Title is a concept's heading; empty on technique items, whose name is
	// the library's.
	Title                 string   `json:"title"`
	Notes                 string   `json:"notes"`
	TargetScored          *int     `json:"target_scored"`
	TargetDefended        *int     `json:"target_defended"`
	TargetSessions        *int     `json:"target_sessions"`
	MinHitRate            *float64 `json:"min_hit_rate"`
	TargetDrilledSessions *int     `json:"target_drilled_sessions"`
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
//
// **N123's read marks are a second thing this wholesale replace threatens,
// and are handled the same way progress always was — by not actually
// depending on the identity that gets replaced.** `curriculum_item_reads`
// DOES reference `curriculum_items.id`, which this function regenerates on
// every run, so without `captureConceptReads`/`restoreConceptReads` around
// the delete-and-reinsert below, every athlete's "read and understood" claim
// on every concept in a syllabus would be silently erased by every deploy.
// Both helpers live in `postgres.go`, shared with `replaceContent` (an owner
// `Update` has the identical problem for the identical reason) — see
// `conceptRead`'s own doc comment there for the full reasoning.
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
	// Empty-to-NULL for belt and track both: "" is not a belt and not a
	// section, and a sentinel empty string would sort among the real ones.
	var belt, track *string
	if c.Belt != "" {
		belt = &c.Belt
	}
	if c.Track != "" {
		track = &c.Track
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO curricula (id, owner_user_id, source, name, description, belt, track, visibility)
		VALUES ($1, NULL, 'seed', $2, $3, $4, $5, 'public')
		ON CONFLICT (id) DO UPDATE SET
			name        = excluded.name,
			description = excluded.description,
			belt        = excluded.belt,
			track       = excluded.track,
			updated_at  = now()
		-- Scoped to seed rows. Without this, an id collision with something the
		-- admin console authored would let a deploy silently overwrite it --
		-- which is the exact failure 000032's source column exists to prevent,
		-- and the reason that column was added before there was a second writer.
		WHERE curricula.source = 'seed'`,
		c.ID, c.Name, c.Description, belt, track)
	if err != nil {
		return translate(err, "seed curriculum "+c.ID)
	}

	// Guarded the same way as the upsert above, and it needs its own guard.
	//
	// Found while writing the workout seeder, which copied this file: the
	// upsert refuses to touch a row it does not own, and then this DELETE ran
	// unconditionally — so an id colliding with an admin-authored curriculum
	// left it named as the admin left it and EMPTIED of every item. The worse
	// of the two failures, because the name surviving makes it read as
	// somebody's own mistake rather than as a deploy.
	var seeded bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM curricula WHERE id = $1 AND source = 'seed')`,
		c.ID).Scan(&seeded); err != nil {
		return fmt.Errorf("curriculum: check seed ownership for %s: %w", c.ID, err)
	}
	if !seeded {
		return nil
	}

	// Captured before the delete below and restored by title once the
	// reinsert is done — N123. Without this, `cmd/seed` (run on every
	// deploy, and documented above as "safe to re-run" because progress
	// "lives in bjj_session_tags and is recomputed on read") would silently
	// erase every athlete's "read and understood" claim on every concept in
	// this syllabus each time it ran, even when nothing about the content
	// actually changed — because curriculum_items is replaced wholesale here
	// too, with fresh ids, and curriculum_item_reads cascades from them. See
	// conceptRead's own doc comment (postgres.go) for the full reasoning and
	// its accepted trade-offs.
	savedReads, err := captureConceptReads(ctx, tx, c.ID)
	if err != nil {
		return err
	}

	// Items first, phases second: the composite FK points from item to phase.
	if _, err := tx.Exec(ctx,
		`DELETE FROM curriculum_items WHERE curriculum_id = $1`, c.ID); err != nil {
		return fmt.Errorf("curriculum: clear seed items for %s: %w", c.ID, err)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM curriculum_phases WHERE curriculum_id = $1`, c.ID); err != nil {
		return fmt.Errorf("curriculum: clear seed phases for %s: %w", c.ID, err)
	}

	for i, p := range c.Phases {
		if _, err := tx.Exec(ctx, `
			INSERT INTO curriculum_phases (curriculum_id, sort_order, title, description)
			VALUES ($1, $2, $3, $4)`,
			c.ID, i, p.Title, p.Description); err != nil {
			return fmt.Errorf("curriculum: seed %s phase %d (%s): %w", c.ID, i, p.Title, err)
		}
	}

	// One dense sort order across the whole curriculum: flat items first,
	// unphased, then each phase's items in phase order.
	order := 0
	insert := func(it SeedItem, phase *int) error {
		kind := it.Kind
		if kind == "" {
			kind = "technique"
		}
		// NULL, not '', for a concept's technique column — the CHECK requires
		// it.
		var techniqueID *string
		if it.TechniqueID != "" {
			techniqueID = &it.TechniqueID
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO curriculum_items
				(curriculum_id, kind, technique_id, title, sort_order, phase_order, notes,
				 target_scored, target_defended, target_sessions, min_hit_rate,
				 target_drilled_sessions)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
			c.ID, kind, techniqueID, it.Title, order, phase, it.Notes,
			it.TargetScored, it.TargetDefended, it.TargetSessions, it.MinHitRate,
			it.TargetDrilledSessions)
		if err != nil {
			// Named loudly. The overwhelmingly likely cause is a technique_id
			// that is not in the library -- a typo in the JSON, or a technique
			// renamed out from under a syllabus -- and a foreign-key violation
			// reported as "invalid input" would send the next person looking at
			// the criteria instead of the id.
			return fmt.Errorf(
				"curriculum: seed %s item %d (%s): %w", c.ID, order, it.TechniqueID+it.Title, err)
		}
		order++
		return nil
	}
	for _, it := range c.Items {
		if err := insert(it, nil); err != nil {
			return err
		}
	}
	for pi, p := range c.Phases {
		phase := pi
		for _, it := range p.Items {
			if err := insert(it, &phase); err != nil {
				return err
			}
		}
	}
	return restoreConceptReads(ctx, tx, c.ID, savedReads)
}
