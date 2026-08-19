package workout

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
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

// maxWorkouts bounds the visible workout list.
//
// This is the one list on the platform whose size is driven by TOTAL USER
// COUNT rather than by one athlete's history: `visibleTo` admits every user's
// public workouts, so `?scope=shared` grows with the platform, and each row
// then fans out through attachItems.
//
// It mattered enough on its own; apihttp.ConditionalGet made it structural.
// That middleware buffers the whole identity body to hash it, so peak memory
// per in-flight request is now bounded by the largest response the API can
// produce — a claim that is only true if every list has a ceiling. This was
// the last one without one.
//
// The caller's OWN rows sort first, and that is what makes the cap safe rather
// than merely deterministic. `visibleTo` mixes your workouts with every user's
// public ones, so a plain `ORDER BY name, id` evicts alphabetically across
// ownership: once 500 public workouts sort ahead of it, your own workout named
// "Z…" silently vanishes from the default list. Measured — 501 public rows and
// the survivors were the first 500 by name, regardless of owner. Sorting the
// caller's own rows first means the eviction lands on other people's content,
// which is the only kind anyone can afford to lose.
//
// `IS NOT DISTINCT FROM`, not `=`. `owner_user_id` is NULLABLE — NULL is a
// VOLA-authored official template (migration 000006), and the
// `workouts_official_is_public` CHECK forces those public, so they are always
// in the default list. `NULL = $1` is NULL, and `ORDER BY … DESC` is NULLS
// FIRST, so `=` would have sorted every official template ABOVE the caller's
// own — reintroducing the exact eviction this ordering exists to prevent, by
// the one row class that outranks them. No official template exists yet, so
// nothing was broken in practice; the comment claiming otherwise was the
// dangerous part.
//
// `name, id` after it keeps the order total, so the cap's membership is stable
// and the response hashes the same way twice.
const maxWorkouts = 500

func (r *PostgresRepository) List(ctx context.Context, userID string, f Filter) ([]Workout, error) {
	where := []string{visibleTo}
	args := []any{userID}

	// Mine/Shared narrow *within* what's already visible — they can never
	// widen it, because visibleTo is applied unconditionally above.
	switch {
	case f.Mine && !f.Public:
		where = append(where, `owner_user_id = $1`)
	case f.Public && !f.Mine:
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

	args = append(args, maxWorkouts)
	rows, err := r.pool.Query(ctx, `SELECT `+workoutColumns+` FROM workouts WHERE `+
		strings.Join(where, " AND ")+` ORDER BY (owner_user_id IS NOT DISTINCT FROM $1) DESC, name, id
		LIMIT $`+fmt.Sprint(len(args)), args...)
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

	// PUBLISHED ONLY, so a draft reads as an unknown id rather than a usable
	// one. A draft is an exercise the operator has not finished; putting it in
	// a workout would make the item reference something `GET /exercises/{id}`
	// answers 404 for, and the client renders a hole it cannot explain.
	//
	// Falling out of `found` — rather than a distinct "that one is a draft" —
	// is the point: telling a caller apart from an unknown id would hand any
	// authenticated user an existence oracle over unpublished content, which is
	// exactly what the catalog's own read path refuses to do.
	//
	// Safe to tighten: publishing is one-way and drafts are new here, so no
	// existing row can already reference one.
	rows, err := tx.Query(ctx,
		`SELECT id, sport FROM exercises WHERE id = ANY($1) AND status = 'published'`, ids)
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

// Rename changes a template's name and nothing else.
//
// The name was fixed at creation until this existed: `PUT /items` replaces the
// item list, `DELETE` removes the whole template, and there was no third verb —
// so a template named in a hurry on the gym floor stayed that way, and the only
// way to correct it was to rebuild it and lose every plan pointing at it.
func (r *PostgresRepository) Rename(ctx context.Context, userID, workoutID, name string) (*Workout, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("workout: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	// The same ownership gate ReplaceItems uses, and load-bearing for the same
	// reason: ids are client-supplied here, so without it any id you can guess
	// is renameable. `requireOwner` also refuses a public template you can see
	// but do not own, with ErrForbidden rather than ErrNotFound.
	if _, err := requireOwner(ctx, tx, userID, workoutID); err != nil {
		return nil, err
	}
	// No owner predicate here, and that is safe ONLY because `requireOwner`
	// above holds `SELECT ... FOR UPDATE` on this row for the rest of the
	// transaction. Move the gate outside the tx, or swap it for a non-locking
	// read, and this silently becomes a race with nothing failing.
	if _, err := tx.Exec(ctx,
		`UPDATE workouts SET name = $2, updated_at = now() WHERE id = $1`,
		workoutID, name); err != nil {
		return nil, translatePgError(fmt.Errorf("workout: rename: %w", err))
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("workout: commit: %w", err)
	}
	return r.Get(ctx, userID, workoutID)
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

// --- share.Copier -----------------------------------------------------------
//
// The two methods that make a workout shareable. This is the whole of what the
// module owes the share system: say what it is called, and know how to
// duplicate it. **Nothing here imports the share package** — these satisfy an
// interface declared over there, and cmd/api/main.go is what pairs them up.
// Read `internal/modules/share/share.go` for why the dependency runs that way.

// Describe returns the workout's name for a recipient's inbox card.
//
// VISIBILITY, not ownership, and the same `visibleTo` both reads use — so a
// caller can pass on a VOLA Workout or another athlete's published plan. That
// is not a loophole: "Copy to my workouts" already gives them their own copy of
// exactly those, so sharing one hands over nothing they could not fetch
// themselves. ok=false covers "no such id" and "not visible to you" alike,
// collapsed so that sharing cannot be used to test whether a guessed id is real
// — and workout ids are CLIENT-SUPPLIED here, so they are guessable
// ("push-day-a") in a way a uuid is not. The same reasoning `requireOwner`
// records for the write paths.
func (r *PostgresRepository) Describe(ctx context.Context, resourceID, sharerID string) (string, bool, error) {
	var name string
	err := r.pool.QueryRow(ctx, `
		SELECT name FROM workouts WHERE `+visibleTo+` AND id = $2`,
		sharerID, resourceID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("workout: describe: %w", err)
	}
	return name, true, nil
}

// Copy is the self-serve half of CopyTo: same duplication, no share involved.
//
// It DELEGATES rather than reimplementing. `CopyTo` already re-applies
// `visibleTo`, renumbers the items and forces the copy private, and a second
// routine would be a second place for those to drift — the mistake the web
// client was making instead, with a `createWorkout` followed by a
// `replaceItems` that could strand an empty workout between them. Passing the
// caller as both the "sharer" and the new owner is the self-copy case: the
// visibility check runs against the person asking.
//
// `ok == false` means not visible to this caller, which for a direct request is
// indistinguishable from not existing and must stay that way.
func (r *PostgresRepository) Copy(ctx context.Context, userID, id string) (*Workout, error) {
	newID, ok, err := database.CopySelf(ctx, r.pool, r.CopyTo, id, userID)
	if err != nil {
		return nil, fmt.Errorf("workout: copy: %w", err)
	}
	if !ok {
		return nil, ErrNotFound
	}
	// Read back through the ordinary path, so the response is what a subsequent
	// GET returns rather than a hand-assembled near-copy of it.
	return r.Get(ctx, userID, newID)
}

// CopyTo duplicates a workout and its items into another athlete's ownership,
// inside the share module's transaction.
//
// A SERVER-GENERATED id, always — never the source's. Ids in this table are
// client-supplied, so reusing one would collide on the primary key, and worse,
// would make the recipient's template answer to the sender's offline sync
// retries: `Create`'s `ON CONFLICT (id) DO NOTHING` path treats a repeated id
// from its owner as an idempotent retry.
//
// Three columns are deliberately NOT copied, and each would be a live bug:
//
//   - `source` must default to 'user'. Copying it from a seeded VOLA Workout
//     would insert `('seed', <owner>)`, which the
//     `workouts_owned_rows_are_never_seeded` CHECK rejects — so accepting a
//     shared VOLA Workout would fail the whole transaction. If it somehow got
//     past, the next deploy's seeder would own the recipient's copy.
//   - `visibility` is forced to 'private'. The shelf's plans are 'public', so
//     copying it through would publish the recipient's copy to every athlete
//     on the platform as a side effect of accepting a share.
//   - `created_at`/`updated_at` default to now. This copy is new to them.
//
// The items are re-inserted rather than pointed at, because that is what
// snapshot semantics MEAN: after this returns the two templates have no
// relationship, and the sender can reorder, retarget or delete theirs without
// touching what the recipient now owns. `position` is re-derived from the read
// order rather than copied, so a source with gaps yields a dense one — and
// `workout_items_position_unique` makes that a correctness matter, not tidiness.
func (r *PostgresRepository) CopyTo(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
	var (
		name, notes string
		sport       Sport
		goal        *Goal
	)
	// The SAME visibility predicate the share was authorized under, re-applied
	// at accept time. Authorization happened when the share was SENT and this
	// runs whenever the recipient gets round to accepting; a bare `WHERE id =
	// $1` would copy whatever holds that id by then. With client-supplied ids,
	// one freed by a delete and re-taken by another athlete is not hypothetical.
	err := tx.QueryRow(ctx, `
		SELECT name, sport, goal, notes
		FROM workouts WHERE `+visibleTo+` AND id = $2`,
		sharerID, resourceID).Scan(&name, &sport, &goal, &notes)
	if errors.Is(err, pgx.ErrNoRows) {
		// Deleted between sending and accepting — or no longer the sharer's to
		// pass on. The share module clears the dead row rather than letting it
		// fail this way forever.
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("workout: copy read: %w", err)
	}

	var newID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO workouts (id, owner_user_id, name, sport, goal, notes, visibility)
		VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'private')
		RETURNING id`,
		newOwnerID, name, sport, goal, notes).Scan(&newID); err != nil {
		return "", false, fmt.Errorf("workout: copy insert: %w", err)
	}

	// One statement rather than read-then-loop: the items never leave the
	// database, so a long template costs one round trip and cannot half-copy.
	if _, err := tx.Exec(ctx, `
		INSERT INTO workout_items (
			workout_id, exercise_id, position, target_sets, target_reps,
			target_weight_kg, target_seconds, target_distance_m, notes
		)
		SELECT $1, exercise_id,
		       row_number() OVER (ORDER BY position) - 1,
		       target_sets, target_reps, target_weight_kg, target_seconds,
		       target_distance_m, notes
		FROM workout_items WHERE workout_id = $2`,
		newID, resourceID); err != nil {
		return "", false, fmt.Errorf("workout: copy items: %w", err)
	}
	return newID, true, nil
}
