package exercise

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
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
//
// `load_mode` IS here, and its absence was a live data-loss bug rather than a
// tidiness issue: `cmd/exportcontent` writes `exercises.json` from these rows,
// so an unselected column came back as "" and overwrote the file's real value.
// `NormalizeLoadMode` then reads "" as 'total', and because the seeder's
// change-detection tuple now includes the column, the next deploy ACTIVELY
// rewrites `per_side` back to `total` — reinstating the exact silent halving
// this whole change exists to kill. Anything the export writes has to be
// selected here.
const contentReturning = `
	id, name, sport, movement_pattern, movement_pattern_detail,
	primary_muscles, secondary_muscles, equipment, load_type,
	is_unilateral, load_mode, instructions, source, status, created_at, updated_at`

type contentScannable interface {
	Scan(dest ...any) error
}

func scanContent(s contentScannable) (Exercise, error) {
	var e Exercise
	err := s.Scan(&e.ID, &e.Name, &e.Sport, &e.MovementPattern,
		&e.MovementPatternDetail, &e.PrimaryMuscles, &e.SecondaryMuscles,
		&e.Equipment, &e.LoadType, &e.IsUnilateral, &e.LoadMode, &e.Instructions,
		&e.Source, &e.Status, &e.CreatedAt, &e.UpdatedAt)
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

func (r *PostgresRepository) CreateExercise(ctx context.Context, e Exercise, actor string) (Exercise, error) {
	return r.writeWithRevision(ctx, actor, ActionCreate, func(tx pgx.Tx) (Exercise, error) {
		return createWithin(ctx, tx, e)
	})
}

func createWithin(ctx context.Context, tx pgx.Tx, e Exercise) (Exercise, error) {
	// No ON CONFLICT. A collision has to surface as an error rather than quietly
	// become an update: the id may already be a foreign key in a workout item or
	// a logged set, so rewriting the exercise behind it changes what somebody's
	// training history says they did.
	//
	// 'draft', explicitly: the column default is 'published' because it has to
	// describe the 504 rows the migration backfilled, which is exactly the
	// wrong thing for a new one.
	row := tx.QueryRow(ctx, `
		INSERT INTO exercises (
			id, name, sport, movement_pattern, movement_pattern_detail,
			primary_muscles, secondary_muscles, equipment, load_type,
			is_unilateral, load_mode, instructions, source, status
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'admin','draft')
		RETURNING `+contentReturning,
		e.ID, e.Name, e.Sport, e.MovementPattern, e.MovementPatternDetail,
		nonNil(e.PrimaryMuscles), nonNil(e.SecondaryMuscles), nonNil(e.Equipment),
		e.LoadType, e.IsUnilateral, NormalizeLoadMode(e.LoadMode), e.Instructions)

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

func (r *PostgresRepository) UpdateExercise(ctx context.Context, e Exercise, actor string) (Exercise, error) {
	return r.writeWithRevision(ctx, actor, ActionUpdate, func(tx pgx.Tx) (Exercise, error) {
		return updateWithin(ctx, tx, e)
	})
}

// updateWithin runs the edit inside a caller's transaction, so the write and
// its revision commit together. Shared with Restore, which must write the row
// exactly the same way — a restore that misses a column is a rollback to a
// state that never existed.
//
// `status` is absent from the SET on purpose, in both callers: editing a
// published exercise must not withdraw it, and restoring an old revision must
// not unpublish it. Visibility changes only through Publish.
func updateWithin(ctx context.Context, tx pgx.Tx, e Exercise) (Exercise, error) {
	// ANY row is editable here, and the write TAKES OWNERSHIP of it — the same
	// change the technique catalog made when the authoring spreadsheet was
	// retired, for the same reason and with the same load-bearing detail.
	//
	// `source = 'admin'` used to sit in the WHERE, refusing seeded rows,
	// because an edit to one would be reverted by the next deploy's re-seed.
	// It now sits in the SET instead: editing a row makes it admin-owned, and
	// the seed's own `WHERE source = 'seed'` skips it from then on. Remove it
	// from the SET and the next deploy quietly undoes every edit made here.
	//
	// Still one statement, so it cannot race. `exportcontent -adopt` is how a
	// row goes back under the deploy.
	//
	// NOTE the media caveat that already applies to admin-owned rows now
	// applies to these too: `upsertMedia`'s prune is not scoped by source, so a
	// re-seed of a row whose JSON says `"media": []` still removes its media.
	// That is why exportcontent preserves the key.
	row := tx.QueryRow(ctx, `
		UPDATE exercises SET
			name = $2, sport = $3, movement_pattern = $4,
			movement_pattern_detail = $5, primary_muscles = $6,
			secondary_muscles = $7, equipment = $8, load_type = $9,
			is_unilateral = $10, load_mode = $11, instructions = $12,
			source = 'admin', updated_at = now()
		WHERE id = $1
		RETURNING `+contentReturning,
		e.ID, e.Name, e.Sport, e.MovementPattern, e.MovementPatternDetail,
		nonNil(e.PrimaryMuscles), nonNil(e.SecondaryMuscles), nonNil(e.Equipment),
		e.LoadType, e.IsUnilateral, NormalizeLoadMode(e.LoadMode), e.Instructions)

	out, err := scanContent(row)
	if errors.Is(err, pgx.ErrNoRows) {
		// Now means exactly one thing — no such id.
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

// writeWithRevision ties a console write to its history entry. Every write
// goes through it so none can forget: an edit that lands without its revision
// is a change nobody can see or undo.
func (r *PostgresRepository) writeWithRevision(
	ctx context.Context, actor, action string, write func(pgx.Tx) (Exercise, error),
) (Exercise, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Exercise{}, fmt.Errorf("exercise: begin %s: %w", action, err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	out, err := write(tx)
	if err != nil {
		return Exercise{}, err
	}
	if err := recordRevision(ctx, tx, out, actor, action); err != nil {
		return Exercise{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Exercise{}, fmt.Errorf("exercise: commit %s: %w", action, err)
	}
	return out, nil
}

// recordRevision appends the exercise's post-write state to its history.
//
// The payload is the CONTENT projection, which excludes media — that lives in
// `exercise_media`, the console cannot author it, and the write path does not
// touch it. Including it would promise a restore that puts pictures back, and
// it would not.
func recordRevision(ctx context.Context, tx pgx.Tx, e Exercise, actor, action string) error {
	payload, err := json.Marshal(e)
	if err != nil {
		return fmt.Errorf("exercise: marshal revision: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO exercise_revisions (exercise_id, revision, actor, action, payload)
		VALUES ($1,
			COALESCE((SELECT MAX(revision) FROM exercise_revisions WHERE exercise_id = $1), 0) + 1,
			$2, $3, $4)`, e.ID, actor, action, payload)
	if err != nil {
		return fmt.Errorf("exercise: record revision: %w", err)
	}
	return nil
}

// Publish makes a draft visible to athletes. One-way — see the technique
// catalog's Publish for why there is no unpublish: workout items and logged
// sets reference an exercise by id, and none of those reads filter on status.
func (r *PostgresRepository) Publish(ctx context.Context, id, actor string) (Exercise, error) {
	return r.writeWithRevision(ctx, actor, ActionPublish, func(tx pgx.Tx) (Exercise, error) {
		row := tx.QueryRow(ctx, `
			UPDATE exercises SET status = 'published', updated_at = now()
			WHERE id = $1 AND status = 'draft'
			RETURNING `+contentReturning, id)
		out, err := scanContent(row)
		if errors.Is(err, pgx.ErrNoRows) {
			return Exercise{}, ErrNotFound
		}
		if err != nil {
			return Exercise{}, fmt.Errorf("exercise: publish: %w", err)
		}
		return out, nil
	})
}

// Revisions returns the history, newest first. Empty for a row the console has
// never touched, which is all 504 seeded ones.
func (r *PostgresRepository) Revisions(ctx context.Context, id string) ([]Revision, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT revision, actor, action, payload, created_at
		FROM exercise_revisions WHERE exercise_id = $1
		ORDER BY revision DESC`, id)
	if err != nil {
		return nil, fmt.Errorf("exercise: revisions: %w", err)
	}
	defer rows.Close()
	out := []Revision{}
	for rows.Next() {
		var rev Revision
		var payload []byte
		if err := rows.Scan(&rev.Revision, &rev.Actor, &rev.Action, &payload, &rev.CreatedAt); err != nil {
			return nil, fmt.Errorf("exercise: scan revision: %w", err)
		}
		if err := json.Unmarshal(payload, &rev.Payload); err != nil {
			return nil, fmt.Errorf("exercise: parse revision %d: %w", rev.Revision, err)
		}
		// The one read path whose `load_mode` does NOT come from the column.
		// A revision is a JSON snapshot, and `exercise_revisions` (000039)
		// predates the column (000052) — so a revision recorded between those
		// two deploys has no `load_mode` key at all, unmarshals to "", and
		// would serialise as `"load_mode": ""` against a schema whose enum
		// admits only `total` and `per_side`.
		//
		// Normalised here rather than left to the client, matching what
		// `upsertArgs` already does on the way in.
		//
		// NOTE this normalisation is DISPLAY only, and deliberately does not
		// speak for what a restore does. It used to: while `updateWithin` never
		// wrote the column, restoring such a revision preserved the live value
		// for free. That stopped being true when the column joined the SET
		// clause, so `Restore` now carries its own absent-key rule — see it
		// there. The two must stay in step: this one makes an old revision
		// LOOK like `total` in the console's history, and if the restore rule
		// were dropped, clicking it would make it BE `total`.
		rev.Payload.LoadMode = NormalizeLoadMode(rev.Payload.LoadMode)
		out = append(out, rev)
	}
	return out, rows.Err()
}

// Restore writes an earlier revision's content back as a NEW revision.
//
// Appends rather than truncates, and never touches `status` — both for the
// reasons the technique catalog's Restore records.
func (r *PostgresRepository) Restore(ctx context.Context, id string, revision int, actor string) (Exercise, error) {
	return r.writeWithRevision(ctx, actor, ActionRestore, func(tx pgx.Tx) (Exercise, error) {
		var payload []byte
		err := tx.QueryRow(ctx, `
			SELECT payload FROM exercise_revisions
			WHERE exercise_id = $1 AND revision = $2`, id, revision).Scan(&payload)
		if errors.Is(err, pgx.ErrNoRows) {
			return Exercise{}, ErrNotFound
		}
		if err != nil {
			return Exercise{}, fmt.Errorf("exercise: read revision: %w", err)
		}
		var want Exercise
		if err := json.Unmarshal(payload, &want); err != nil {
			return Exercise{}, fmt.Errorf("exercise: parse revision %d: %w", revision, err)
		}
		// The id comes from the PATH, not the payload: a revision whose payload
		// carried a different id would otherwise rewrite some other exercise.
		want.ID = id

		// `load_mode` is the one field a revision can be SILENT about rather
		// than merely wrong about, and silence has to mean "leave it" here.
		//
		// `exercise_revisions` (000039) predates the column (000052), so a
		// snapshot taken between those deploys has no `load_mode` key at all.
		// It unmarshals to "", and letting that reach the UPDATE turns it into
		// `total` — so restoring an old revision of a dumbbell exercise would
		// silently halve it, pass the CHECK, and answer 200. The console's
		// revision list even renders that revision AS `total`, which makes the
		// damage look deliberate.
		//
		// This only became reachable when this change added the column to
		// `updateWithin`'s SET clause. Before, the UPDATE never wrote it and
		// the RETURNING re-read the live value, so restore preserved it for
		// free. That free preservation is what is being paid for here.
		//
		// Absent ONLY — a revision that does carry a value is restored as it
		// stands, which is what "copies that revision's content back" has
		// always claimed and did not previously do for this column.
		if want.LoadMode == "" {
			if err := tx.QueryRow(ctx,
				`SELECT load_mode FROM exercises WHERE id = $1`, id,
			).Scan(&want.LoadMode); err != nil {
				return Exercise{}, fmt.Errorf("exercise: read load_mode for restore: %w", err)
			}
		}
		return updateWithin(ctx, tx, want)
	})
}

// SearchAll finds any exercise by name or id, seeded ones included, so the
// console can reach the whole catalog rather than only what it wrote.
//
// Capped for the same reason the technique search is: this reads the WHOLE
// catalog and 504 full rows is payload the console renders none of.
const maxConsoleSearch = 100

func (r *PostgresRepository) SearchAll(ctx context.Context, query string) ([]Exercise, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+contentReturning+` FROM exercises
		WHERE `+database.LikeClause("name", 1)+`
		   OR `+database.LikeClause("id", 1)+`
		ORDER BY name
		LIMIT $2`, database.LikeTerm(query), maxConsoleSearch)
	if err != nil {
		return nil, fmt.Errorf("exercise: console search: %w", err)
	}
	defer rows.Close()
	out := []Exercise{}
	for rows.Next() {
		e, err := scanContent(rows)
		if err != nil {
			return nil, fmt.Errorf("exercise: scan search: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
