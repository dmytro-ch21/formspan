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
	id, name, sport, movement_pattern, movement_pattern_detail, primary_muscles,
	secondary_muscles, equipment, load_type, is_unilateral, load_mode, implements, instructions,
	created_at, updated_at`

type scannable interface {
	Scan(dest ...any) error
}

func scanExercise(row scannable) (*Exercise, error) {
	var e Exercise
	err := row.Scan(
		&e.ID, &e.Name, &e.Sport, &e.MovementPattern, &e.MovementPatternDetail, &e.PrimaryMuscles,
		&e.SecondaryMuscles, &e.Equipment, &e.LoadType, &e.IsUnilateral, &e.LoadMode, &e.Implements,
		&e.Instructions, &e.CreatedAt, &e.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	// Derived here rather than in a handler because this is the ONLY place a
	// row becomes an Exercise — every read path, public and admin, comes
	// through it. Put it in one serializer and the other one ships `null`.
	//
	// Normalised to a non-nil slice, because a nil one marshals to `null` and
	// that is a THIRD state clients would have to handle: absent (stale row,
	// fall back), `[]` (grip is meaningless here, show no picker) and `null`
	// (…the same as which?). A squat must serialize `[]`.
	if g := OfferedGrips(e.MovementPattern); g != nil {
		e.OfferedGrips = g
	} else {
		e.OfferedGrips = []string{}
	}
	return &e, nil
}

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
	// Ranked when there is a query, alphabetical when there is not — see
	// `SearchClause` for why matching and ranking are separate concerns.
	order := " ORDER BY sport, name"
	if f.Query != "" {
		clause, qargs := SearchClause(f.Query, len(args)+1)
		where = append(where, clause)
		args = append(args, qargs...)
		// Only worth ranking when something can match. A tokenless query binds
		// no arguments and its clause is `false`.
		if len(qargs) > 0 {
			rank, rankArg := SearchRank(f.Query, len(args)+1)
			args = append(args, rankArg)
			// Sport first so a filtered list still groups, then closeness, then
			// name as the tiebreak — without that last one, equally-similar
			// rows order arbitrarily and a list reshuffles between identical
			// requests.
			order = " ORDER BY sport, " + rank + ", name"
		}
	}

	// DRAFTS ARE NOT PUBLIC — here and Get, the only two places that know it.
	// Deliberately not a filter a caller can turn off: a draft that becomes
	// visible by passing a query parameter is not a draft.
	//
	// Prepended so it survives every filter combination above, including none
	// of them — which is why the `if len(where)` guard is gone.
	where = append([]string{"status = '" + StatusPublished + "'"}, where...)

	q := `SELECT ` + selectColumns + ` FROM exercises`
	q += ` WHERE ` + strings.Join(where, " AND ")
	q += order

	rows, err := r.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("exercise: list: %w", err)
	}
	defer rows.Close()

	exercises := []Exercise{}
	ids := []string{}
	for rows.Next() {
		e, err := scanExercise(rows)
		if err != nil {
			return nil, fmt.Errorf("exercise: scan: %w", err)
		}
		exercises = append(exercises, *e)
		ids = append(ids, e.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("exercise: rows: %w", err)
	}

	if err := r.attachMedia(ctx, exercises, ids); err != nil {
		return nil, err
	}
	return exercises, nil
}

// attachMedia fetches every listed exercise's media in a single query and
// stitches it in memory. One query for the whole page rather than one per
// exercise — the N+1 here would be invisible with 12 rows and painful with
// 500.
func (r *PostgresRepository) attachMedia(ctx context.Context, exercises []Exercise, ids []string) error {
	if len(ids) == 0 {
		return nil
	}

	// Ordered semantically, not alphabetically. `ORDER BY kind` would put
	// "end" before "start", which is backwards for a movement and exactly
	// the sort of thing that ships as "why is the finish position first?".
	// `position` leads so an author can override; the CASE breaks ties
	// deterministically when every row leaves position at its default.
	rows, err := r.pool.Query(ctx, `
		SELECT exercise_id, kind, storage_key, content_type, width, height, position,
			-- Versions the URL the handler assembles, so replacing the bytes at
			-- a storage key actually reaches clients instead of being masked by
			-- every cache between here and the phone.
			updated_at
		FROM exercise_media
		WHERE exercise_id = ANY($1)
		ORDER BY exercise_id, position,
			CASE kind
				WHEN 'thumbnail'  THEN 0
				WHEN 'demo'       THEN 1
				WHEN 'start'      THEN 2
				WHEN 'end'        THEN 3
				WHEN 'demo_video' THEN 4
				ELSE 5
			END`, ids)
	if err != nil {
		return fmt.Errorf("exercise: list media: %w", err)
	}
	defer rows.Close()

	byExercise := make(map[string][]Media, len(ids))
	for rows.Next() {
		var (
			exerciseID string
			m          Media
		)
		if err := rows.Scan(&exerciseID, &m.Kind, &m.StorageKey, &m.ContentType,
			&m.Width, &m.Height, &m.Position, &m.UpdatedAt); err != nil {
			return fmt.Errorf("exercise: scan media: %w", err)
		}
		byExercise[exerciseID] = append(byExercise[exerciseID], m)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("exercise: media rows: %w", err)
	}

	for i := range exercises {
		// Always a non-nil slice so the JSON is `[]`, never `null` — a
		// client shouldn't need to handle both for "no media".
		if m := byExercise[exercises[i].ID]; m != nil {
			exercises[i].Media = m
		} else {
			exercises[i].Media = []Media{}
		}
	}
	return nil
}

func (r *PostgresRepository) Get(ctx context.Context, id string) (*Exercise, error) {
	// A draft is ErrNotFound, not a 403: a caller has no business knowing an id
	// exists before it is published.
	row := r.pool.QueryRow(ctx, `SELECT `+selectColumns+` FROM exercises
		WHERE id = $1 AND status = '`+StatusPublished+`'`, id)
	e, err := scanExercise(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("exercise: get: %w", err)
	}

	one := []Exercise{*e}
	if err := r.attachMedia(ctx, one, []string{e.ID}); err != nil {
		return nil, err
	}
	return &one[0], nil
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
		id, name, sport, movement_pattern, movement_pattern_detail,
		primary_muscles, secondary_muscles, equipment, load_type,
		is_unilateral, instructions, status, load_mode, implements
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
	ON CONFLICT (id) DO UPDATE SET
		name              = EXCLUDED.name,
		sport             = EXCLUDED.sport,
		movement_pattern  = EXCLUDED.movement_pattern,
		movement_pattern_detail = EXCLUDED.movement_pattern_detail,
		primary_muscles   = EXCLUDED.primary_muscles,
		secondary_muscles = EXCLUDED.secondary_muscles,
		equipment         = EXCLUDED.equipment,
		load_type         = EXCLUDED.load_type,
		is_unilateral     = EXCLUDED.is_unilateral,
		instructions      = EXCLUDED.instructions,
		status            = EXCLUDED.status,
		load_mode         = EXCLUDED.load_mode,
		implements        = EXCLUDED.implements,
		updated_at        = now()
	-- Scoped to seeded rows: a deploy must not revert admin-authored content.
	-- See migration 000032 and the same guard on techniques.
	WHERE exercises.source = 'seed' AND (
		exercises.name, exercises.sport, exercises.movement_pattern,
		exercises.movement_pattern_detail, exercises.primary_muscles, exercises.secondary_muscles,
		exercises.equipment, exercises.load_type, exercises.is_unilateral,
		exercises.instructions, exercises.status, exercises.load_mode, exercises.implements
	) IS DISTINCT FROM (
		EXCLUDED.name, EXCLUDED.sport, EXCLUDED.movement_pattern,
		EXCLUDED.movement_pattern_detail, EXCLUDED.primary_muscles, EXCLUDED.secondary_muscles,
		EXCLUDED.equipment, EXCLUDED.load_type, EXCLUDED.is_unilateral,
		EXCLUDED.instructions, EXCLUDED.status, EXCLUDED.load_mode, EXCLUDED.implements
	)`

func upsertArgs(e Exercise) []any {
	return []any{
		e.ID, e.Name, e.Sport, e.MovementPattern, e.MovementPatternDetail,
		e.PrimaryMuscles, e.SecondaryMuscles, e.Equipment, e.LoadType,
		e.IsUnilateral, e.Instructions, NormalizeStatus(e.Status), NormalizeLoadMode(e.LoadMode),
		NormalizeImplements(e.Implements),
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

	if err := upsertMedia(ctx, tx, exercises); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("exercise: commit: %w", err)
	}
	return nil
}

const mediaUpsertSQL = `
	INSERT INTO exercise_media (
		exercise_id, kind, storage_key, content_type, width, height, position
	) VALUES ($1, $2, $3, $4, $5, $6, $7)
	ON CONFLICT (exercise_id, kind, position) DO UPDATE SET
		storage_key  = EXCLUDED.storage_key,
		content_type = EXCLUDED.content_type,
		width        = EXCLUDED.width,
		height       = EXCLUDED.height,
		updated_at   = now()
	WHERE (
		exercise_media.storage_key, exercise_media.content_type,
		exercise_media.width, exercise_media.height
	) IS DISTINCT FROM (
		EXCLUDED.storage_key, EXCLUDED.content_type,
		EXCLUDED.width, EXCLUDED.height
	)`

// upsertMedia syncs each seeded exercise's media, then touches the parent
// exercise's updated_at for any that actually changed.
//
// That last step matters more than it looks: a client delta-syncing on
// exercises.updated_at would otherwise never learn that an image was
// swapped, because the exercise row itself didn't change. Media is part of
// what the client caches, so it has to be part of what marks the row stale.
//
// Unlike the exercise upsert, this one *does* delete: media rows absent from
// the JSON are removed, so the file is authoritative for which assets exist.
// Safe here in a way it isn't for exercises themselves, since nothing
// references a media row by ID.
func upsertMedia(ctx context.Context, tx pgx.Tx, exercises []Exercise) error {
	var (
		exerciseIDs = make([]string, 0, len(exercises))
		keepIDs     []string
		keepKinds   []string
		keepPos     []int
	)
	for _, e := range exercises {
		exerciseIDs = append(exerciseIDs, e.ID)
		for _, m := range e.Media {
			keepIDs = append(keepIDs, e.ID)
			keepKinds = append(keepKinds, string(m.Kind))
			keepPos = append(keepPos, m.Position)
		}
	}

	if _, err := tx.Exec(ctx, `
		DELETE FROM exercise_media
		WHERE exercise_id = ANY($1)
		  AND (exercise_id, kind, position) NOT IN (
			SELECT * FROM unnest($2::text[], $3::text[], $4::int[])
		  )`, exerciseIDs, keepIDs, keepKinds, keepPos); err != nil {
		return fmt.Errorf("exercise: prune media: %w", err)
	}

	changed := map[string]bool{}
	for _, e := range exercises {
		for _, m := range e.Media {
			tag, err := tx.Exec(ctx, mediaUpsertSQL,
				e.ID, m.Kind, m.StorageKey, m.ContentType, m.Width, m.Height, m.Position)
			if err != nil {
				return fmt.Errorf("exercise: upsert media %q/%s: %w", e.ID, m.Kind, err)
			}
			if tag.RowsAffected() > 0 {
				changed[e.ID] = true
			}
		}
	}

	if len(changed) == 0 {
		return nil
	}
	touched := make([]string, 0, len(changed))
	for id := range changed {
		touched = append(touched, id)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE exercises SET updated_at = now() WHERE id = ANY($1)`, touched); err != nil {
		return fmt.Errorf("exercise: touch after media change: %w", err)
	}
	return nil
}
