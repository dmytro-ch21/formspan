package workout

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The VOLA-authored public workout plans, embedded so a deploy carries them.
//
// Same shape as the curriculum, technique and exercise catalogs:
// version-controlled JSON, upserted by `cmd/seed`, safe to re-run. Editing
// this file and deploying is how a plan changes.
//
//go:embed workouts.json
var seedJSON []byte

// SeedWorkout is one plan as authored. Deliberately NOT the domain `Workout`:
// that carries per-caller state (`editable`, the owner) which is meaningless in
// a content file, and reusing it would invite somebody to author a value for
// it.
type SeedWorkout struct {
	ID    string     `json:"id"`
	Name  string     `json:"name"`
	Sport string     `json:"sport"`
	Goal  string     `json:"goal"`
	Notes string     `json:"notes"`
	Items []SeedItem `json:"items"`
}

type SeedItem struct {
	ExerciseID string `json:"exercise_id"`
	TargetSets *int   `json:"target_sets"`
	TargetReps *int   `json:"target_reps"`
	// float, not int: the column is NUMERIC(6,2) and 2.5 kg increments are
	// standard. An int here would reject 62.5 at unmarshal time.
	TargetWeightKg  *float64 `json:"target_weight_kg"`
	TargetSeconds   *int     `json:"target_seconds"`
	TargetDistanceM *int     `json:"target_distance_m"`
	Notes           string   `json:"notes"`
}

// SeedData parses the embedded plans. Exported so a test can read them without
// a database — which is how the exercise-id integrity check stays cheap.
func SeedData() ([]SeedWorkout, error) {
	var out []SeedWorkout
	if err := json.Unmarshal(seedJSON, &out); err != nil {
		return nil, fmt.Errorf("workout: parse seed: %w", err)
	}
	return out, nil
}

// Seed writes the public plans, and returns how many it wrote.
//
// **Ownerless, public, source='seed'.** Those three together are what makes a
// plan VOLA-authored content rather than somebody's own: the nullable owner is
// this table's existing convention, the CHECK requires an ownerless row to be
// public, and `source` is what scopes this writer to rows a deploy owns.
//
// **Stable ids from the JSON**, not generated — that is what makes this an
// upsert rather than a duplicate factory. Re-running after editing a plan
// updates it in place rather than adding a seventeenth copy to everyone's
// browse list.
//
// **Items are replaced wholesale on every run**, because the file is the source
// of truth for a plan's contents and a removed exercise must actually go. That
// is safe here in a way it would not be for a session: nobody's logged data
// references a workout item. An athlete who *copied* this plan owns their copy
// outright and is untouched — see `Copy`.
//
// **Removing a plan from the JSON does not remove it from the database.** This
// only ever writes; there is no prune. A retired plan stays public until
// somebody deletes the row by hand — worth knowing before assuming a deleted
// entry disappeared.
//
// Runs AFTER exercises in `cmd/seed`, and the order is load-bearing rather than
// tidy: every item is a foreign key into the catalog, so seeding these first
// fails on a fresh database with an error about an exercise that is merely not
// written yet.
func Seed(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	data, err := SeedData()
	if err != nil {
		return 0, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("workout: begin seed: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Counts rows actually WRITTEN, not plans in the file. They differ exactly
	// when an id collides with a workout somebody owns — which the guard below
	// skips — and a log line claiming sixteen when it wrote fifteen is the kind
	// of small untruth that makes the next person distrust the whole output.
	written := 0
	for _, w := range data {
		ok, err := seedOne(ctx, tx, w)
		if err != nil {
			return 0, err
		}
		if ok {
			written++
		} else {
			// The only signal that an id collided with a workout somebody owns.
			// Without naming it, the entire evidence is an off-by-one in a
			// deploy log that nobody alerts on.
			log.Printf("workout: seed: skipped %s — that id belongs to a user", w.ID)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("workout: commit seed: %w", err)
	}
	return written, nil
}

// nullIfEmpty keeps an unset goal out of the CHECK's way.
//
// `workouts_goal_valid` is `goal IS NULL OR goal IN (...)`, so an empty string
// is NOT a permitted value — it is a constraint violation that fails the whole
// seed transaction, and therefore the deploy, since this runs as Railway's
// preDeployCommand. Omitting `goal` is the natural shape for the first BJJ or
// running plan (goal is a strength concept), which is exactly when somebody
// would hit it.
func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Reports whether the plan was written. False means the id belongs to a
// workout somebody owns, so the deploy left it alone.
func seedOne(ctx context.Context, tx pgx.Tx, w SeedWorkout) (bool, error) {
	_, err := tx.Exec(ctx, `
		INSERT INTO workouts (id, owner_user_id, source, name, sport, goal, notes, visibility)
		VALUES ($1, NULL, 'seed', $2, $3, $4, $5, 'public')
		ON CONFLICT (id) DO UPDATE SET
			name       = excluded.name,
			sport      = excluded.sport,
			goal       = excluded.goal,
			notes      = excluded.notes,
			updated_at = now()
		-- Scoped to seed rows. Without this, an id collision with a workout
		-- somebody owns would let a deploy silently overwrite their training —
		-- the exact failure the source column exists to prevent, and the reason
		-- 000043 defaults it to 'user' rather than 'seed'.
		WHERE workouts.source = 'seed'`,
		w.ID, w.Name, w.Sport, nullIfEmpty(w.Goal), w.Notes)
	if err != nil {
		return false, fmt.Errorf("workout: seed %s: %w", w.ID, translatePgError(err))
	}

	// Guarded the same way as the upsert above: if the row belongs to somebody,
	// the INSERT changed nothing and this must not clear their exercises
	// either. Without the EXISTS, a colliding id would leave the athlete's plan
	// named as they left it and emptied of everything in it.
	var seeded bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM workouts WHERE id = $1 AND source = 'seed')`,
		w.ID).Scan(&seeded); err != nil {
		return false, fmt.Errorf("workout: check seed ownership for %s: %w", w.ID, err)
	}
	if !seeded {
		return false, nil
	}

	if _, err := tx.Exec(ctx,
		`DELETE FROM workout_items WHERE workout_id = $1`, w.ID); err != nil {
		return false, fmt.Errorf("workout: clear seed items for %s: %w", w.ID, err)
	}

	for i, it := range w.Items {
		_, err := tx.Exec(ctx, `
			INSERT INTO workout_items (
				workout_id, exercise_id, position,
				target_sets, target_reps, target_weight_kg,
				target_seconds, target_distance_m, notes
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			w.ID, it.ExerciseID, i,
			it.TargetSets, it.TargetReps, it.TargetWeightKg,
			it.TargetSeconds, it.TargetDistanceM, it.Notes)
		if err != nil {
			return false, fmt.Errorf("workout: seed item %s/%s: %w", w.ID, it.ExerciseID, translatePgError(err))
		}
	}
	return true, nil
}
