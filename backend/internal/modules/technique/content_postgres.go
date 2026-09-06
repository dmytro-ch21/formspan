package technique

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
// COALESCE on three columns because they are genuinely NULL in the database:
// the writes below apply NULLIF the same way the seed's upsert does, because
// an empty string is not a legal value for any of them — `ibjjf_ruleset_id` has a foreign key,
// and `function`/`to_position` are validated vocabularies where empty means
// "not recorded". The domain type models that as an empty string throughout.
//
// Two writers applying different rules to one table is the hazard this whole
// feature exists to avoid, and this is where it showed up first: the INSERT
// without NULLIF failed the ruleset foreign key on every technique that had no
// ruleset, which is most of them.
const contentReturning = `
	id, name, aliases, category, position, position_detail, gi_no_gi,
	typical_belt, description, setup_from, common_counters, when_to_use,
	common_next_moves, video_reference, source_notes,
	COALESCE(ibjjf_ruleset_id, ''), COALESCE(function, ''),
	COALESCE(to_position, ''), source, status, created_at, updated_at`

func (r *PostgresRepository) KnownPositions(ctx context.Context) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT position FROM techniques
		WHERE position <> '' ORDER BY position`)
	if err != nil {
		return nil, fmt.Errorf("technique: known positions: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, fmt.Errorf("technique: scan position: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (r *PostgresRepository) CreateTechnique(ctx context.Context, t Technique, actor string) (Technique, error) {
	return r.writeWithRevision(ctx, actor, ActionCreate, func(tx pgx.Tx) (Technique, error) {
		return createWithin(ctx, tx, t)
	})
}

func createWithin(ctx context.Context, tx pgx.Tx, t Technique) (Technique, error) {
	// No ON CONFLICT. A collision has to surface as an error rather than
	// quietly become an update: the id may already be a foreign key in
	// somebody's training record, so rewriting the technique behind it changes
	// what their history says they did.
	row := tx.QueryRow(ctx, `
		INSERT INTO techniques (
			id, name, aliases, category, position, position_detail, gi_no_gi,
			typical_belt, description, setup_from, common_counters, when_to_use,
			common_next_moves, video_reference, source_notes, ibjjf_ruleset_id,
			function, to_position, source, status
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
			NULLIF($16, ''), NULLIF($17, ''), NULLIF($18, ''), 'admin', 'draft')
		RETURNING `+contentReturning,
		t.ID, t.Name, t.Aliases, t.Category, t.Position, t.PositionDetail, t.GiNoGi,
		t.TypicalBelt, t.Description, t.SetupFrom, t.CommonCounters, t.WhenToUse,
		t.CommonNextMoves, t.VideoReference, t.SourceNotes, t.IBJJFRulesetID,
		t.Function, t.ToPosition)

	out, err := scanContent(row)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			switch pgErr.Code {
			case "23505": // unique_violation
				return Technique{}, ErrAlreadyExists
			case "23503": // foreign_key_violation — the ruleset reference
				return Technique{}, fmt.Errorf("%w: unknown ibjjf_ruleset_id", ErrInvalidInput)
			}
		}
		return Technique{}, fmt.Errorf("technique: create: %w", err)
	}
	return out, nil
}

// updateSQL is shared by the edit path and Restore, which must write the row
// exactly the same way — a restore that misses a column is a rollback to a
// state that never existed.
const updateSQL = `
	UPDATE techniques SET
		name = $2, aliases = $3, category = $4, position = $5,
		position_detail = $6, gi_no_gi = $7, typical_belt = $8,
		description = $9, setup_from = $10, common_counters = $11,
		when_to_use = $12, common_next_moves = $13, video_reference = $14,
		source_notes = $15, ibjjf_ruleset_id = NULLIF($16, ''),
		function = NULLIF($17, ''), to_position = NULLIF($18, ''),
		source = 'admin', updated_at = now()
	WHERE id = $1
	RETURNING ` + contentReturning

// updateWithin runs the edit inside a caller's transaction, so the write and
// its revision commit together.
//
// `status` is absent from the SET on purpose, in both callers: editing a
// published technique must not withdraw it, and restoring an old revision must
// not unpublish it. Visibility changes only through Publish.
func updateWithin(ctx context.Context, tx pgx.Tx, t Technique) (Technique, error) {
	row := tx.QueryRow(ctx, updateSQL,
		t.ID, t.Name, t.Aliases, t.Category, t.Position, t.PositionDetail, t.GiNoGi,
		t.TypicalBelt, t.Description, t.SetupFrom, t.CommonCounters, t.WhenToUse,
		t.CommonNextMoves, t.VideoReference, t.SourceNotes, t.IBJJFRulesetID,
		t.Function, t.ToPosition)
	out, err := scanContent(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Technique{}, ErrNotFound
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return Technique{}, fmt.Errorf("%w: unknown ibjjf_ruleset_id", ErrInvalidInput)
		}
		return Technique{}, fmt.Errorf("technique: update: %w", err)
	}
	return out, nil
}

// UpdateTechnique edits ANY row and TAKES OWNERSHIP of it.
//
// `source = 'admin'` used to sit in the WHERE, refusing seeded rows: an edit to
// one would be reverted by the next deploy's re-seed — silently, and only for
// the fields the change-detection tuple covers, which is the worst kind of
// half-applied. That was the right refusal while the spreadsheet owned 450 of
// the 542 and a JSON edit could not stick either.
//
// With the spreadsheet retired the refusal has no remedy to point at, so it
// moved to the SET clause: the row becomes admin-owned by the act of editing
// it, and the seed's own `WHERE source = 'seed'` skips it forever after. Remove
// `source = 'admin'` from the SET and the next deploy quietly undoes every edit
// made here. `exportcontent -adopt` is how a row goes back under the deploy.
//
// A transaction now, because the edit and its revision have to land together.
func (r *PostgresRepository) UpdateTechnique(ctx context.Context, t Technique, actor string) (Technique, error) {
	return r.writeWithRevision(ctx, actor, ActionUpdate, func(tx pgx.Tx) (Technique, error) {
		return updateWithin(ctx, tx, t)
	})
}

// Publish makes a draft visible to athletes. One-way, deliberately.
//
// There is no unpublish — that is RetireTechnique's job, below, and the two
// are not the same operation wearing different names. Withdrawing a LIVE
// technique is a different and much riskier operation than finishing a new
// one: training records tag it by id, curricula list it, and the focus screen
// resolves it — none of which filter on status, correctly, because an
// athlete's own history must not develop holes when a curator changes their
// mind. Hiding a live technique from the library while all of that still
// points at it is a half-state nobody asked for, and building it casually is
// how it would arrive. If a published technique is wrong, editing it is the
// fix; if it should stop being recommended going forward while everything
// that already happened against it keeps meaning what it meant, that is
// retiring it, and unlike publishing, retiring can be undone.
//
// `WHERE status = 'draft'` rather than an unconditional SET so that publishing
// something already published is ErrNotFound rather than a silent no-op that
// reports success — the caller learns its view is stale.
func (r *PostgresRepository) Publish(ctx context.Context, id, actor string) (Technique, error) {
	return r.writeWithRevision(ctx, actor, ActionPublish, func(tx pgx.Tx) (Technique, error) {
		row := tx.QueryRow(ctx, `
			UPDATE techniques SET status = 'published', updated_at = now()
			WHERE id = $1 AND status = 'draft'
			RETURNING `+contentReturning, id)
		out, err := scanContent(row)
		if errors.Is(err, pgx.ErrNoRows) {
			return Technique{}, ErrNotFound
		}
		if err != nil {
			return Technique{}, fmt.Errorf("technique: publish: %w", err)
		}
		return out, nil
	})
}

// RetireTechnique marks a live technique retired. Unlike Publish, this is
// NOT the only way visibility ever changes — ReactivateTechnique undoes it —
// and unlike deleting the row, it touches nothing outside `techniques`.
//
// THE WHOLE POINT (F23/#523): bjj_session_tags.technique_id and
// curriculum_items.technique_id are never read by this statement, let alone
// written. A retired technique is still the row every existing tag and every
// existing roadmap item points at — see postgres.go's Get, which is the read
// path that has to keep resolving it, and migration 000095 for why the two
// foreign keys no longer need a SET NULL or a CASCADE to protect that: a real
// DELETE of a referenced row is refused outright now, and this path never
// attempts one.
//
// `WHERE status = 'published'`, matching Publish: retiring a draft (never
// live, nothing could reference it yet) or a technique already retired is
// ErrNotFound rather than a silent no-op.
func (r *PostgresRepository) RetireTechnique(ctx context.Context, id, actor string) (Technique, error) {
	return r.writeWithRevision(ctx, actor, ActionRetire, func(tx pgx.Tx) (Technique, error) {
		row := tx.QueryRow(ctx, `
			UPDATE techniques SET status = 'retired', updated_at = now()
			WHERE id = $1 AND status = 'published'
			RETURNING `+contentReturning, id)
		out, err := scanContent(row)
		if errors.Is(err, pgx.ErrNoRows) {
			return Technique{}, ErrNotFound
		}
		if err != nil {
			return Technique{}, fmt.Errorf("technique: retire: %w", err)
		}
		return out, nil
	})
}

// ReactivateTechnique is RetireTechnique's inverse: 'retired' back to
// 'published'. Retiring has to be reversible — a technique retired by
// mistake, or one that starts being taught again, cannot otherwise get back
// to visible without a raw SQL update — which is the property that makes it
// a genuinely different decision from Publish's one-way visibility change.
//
// `WHERE status = 'retired'`, for the same staleness reason as above.
func (r *PostgresRepository) ReactivateTechnique(ctx context.Context, id, actor string) (Technique, error) {
	return r.writeWithRevision(ctx, actor, ActionReactivate, func(tx pgx.Tx) (Technique, error) {
		row := tx.QueryRow(ctx, `
			UPDATE techniques SET status = 'published', updated_at = now()
			WHERE id = $1 AND status = 'retired'
			RETURNING `+contentReturning, id)
		out, err := scanContent(row)
		if errors.Is(err, pgx.ErrNoRows) {
			return Technique{}, ErrNotFound
		}
		if err != nil {
			return Technique{}, fmt.Errorf("technique: reactivate: %w", err)
		}
		return out, nil
	})
}

// recordRevision appends the technique's post-write state to its history.
//
// Takes a tx rather than the pool, and every caller passes the one it wrote
// through: an update that lands without its revision is an edit nobody can see
// or undo, which is precisely the state this table exists to make impossible.
// Atomic or neither.
//
// The revision number is computed inside the transaction from the rows already
// there. Two concurrent writers could read the same MAX and collide — which the
// UNIQUE constraint turns into a failed transaction rather than a lost history.
// One author today, so it will not fire; a silently overwritten revision if it
// ever did would be the worst possible failure for an audit trail.
func recordRevision(ctx context.Context, tx pgx.Tx, t Technique, actor, action string) error {
	payload, err := json.Marshal(t)
	if err != nil {
		return fmt.Errorf("technique: marshal revision: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO technique_revisions (technique_id, revision, actor, action, payload)
		VALUES ($1,
			COALESCE((SELECT MAX(revision) FROM technique_revisions WHERE technique_id = $1), 0) + 1,
			$2, $3, $4)`, t.ID, actor, action, payload)
	if err != nil {
		return fmt.Errorf("technique: record revision: %w", err)
	}
	return nil
}

// Revisions returns the history, newest first.
func (r *PostgresRepository) Revisions(ctx context.Context, id string) ([]Revision, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT revision, actor, action, payload, created_at
		FROM technique_revisions WHERE technique_id = $1
		ORDER BY revision DESC`, id)
	if err != nil {
		return nil, fmt.Errorf("technique: revisions: %w", err)
	}
	defer rows.Close()
	out := []Revision{}
	for rows.Next() {
		var rev Revision
		var payload []byte
		if err := rows.Scan(&rev.Revision, &rev.Actor, &rev.Action, &payload, &rev.CreatedAt); err != nil {
			return nil, fmt.Errorf("technique: scan revision: %w", err)
		}
		if err := json.Unmarshal(payload, &rev.Payload); err != nil {
			return nil, fmt.Errorf("technique: parse revision %d: %w", rev.Revision, err)
		}
		out = append(out, rev)
	}
	return out, rows.Err()
}

// Restore writes an earlier revision's content back over the current row.
//
// CONTENT ONLY — `status` is not restored, because `updateWithin` does not set
// it. Rolling back to a revision from before the technique was published would
// otherwise unpublish it, and there is no unpublish (see Publish). An operator
// restoring wording would silently withdraw the technique from every athlete's
// library, which is not what "undo my last edit" means to anyone.
//
// Appends rather than truncates: the state you rolled back FROM stays in the
// history, so a restore is itself undoable. A rollback that erases its own
// evidence is how an audit trail becomes a rumour.
func (r *PostgresRepository) Restore(ctx context.Context, id string, revision int, actor string) (Technique, error) {
	return r.writeWithRevision(ctx, actor, ActionRestore, func(tx pgx.Tx) (Technique, error) {
		var payload []byte
		err := tx.QueryRow(ctx, `
			SELECT payload FROM technique_revisions
			WHERE technique_id = $1 AND revision = $2`, id, revision).Scan(&payload)
		if errors.Is(err, pgx.ErrNoRows) {
			return Technique{}, ErrNotFound
		}
		if err != nil {
			return Technique{}, fmt.Errorf("technique: read revision: %w", err)
		}
		var want Technique
		if err := json.Unmarshal(payload, &want); err != nil {
			return Technique{}, fmt.Errorf("technique: parse revision %d: %w", revision, err)
		}
		// The id comes from the PATH, not the payload: a revision whose payload
		// carried a different id would otherwise rewrite some other technique.
		want.ID = id
		return updateWithin(ctx, tx, want)
	})
}

// writeWithRevision is the one place a console write and its history are tied
// together. Every caller goes through it so none can forget.
func (r *PostgresRepository) writeWithRevision(
	ctx context.Context, actor, action string, write func(pgx.Tx) (Technique, error),
) (Technique, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Technique{}, fmt.Errorf("technique: begin %s: %w", action, err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	out, err := write(tx)
	if err != nil {
		return Technique{}, err
	}
	if err := recordRevision(ctx, tx, out, actor, action); err != nil {
		return Technique{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Technique{}, fmt.Errorf("technique: commit %s: %w", action, err)
	}
	return out, nil
}

// GetTechnique reads one row through the same projection the writes return, so
// a partial update overlays onto exactly the shape it will write back.
func (r *PostgresRepository) GetTechnique(ctx context.Context, id string) (Technique, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+contentReturning+` FROM techniques WHERE id = $1`, id)
	t, err := scanContent(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Technique{}, ErrNotFound
	}
	if err != nil {
		return Technique{}, fmt.Errorf("technique: get for update: %w", err)
	}
	return t, nil
}

// Source reports where a technique came from, so a refusal can explain itself
// rather than 404 at an id that plainly exists.
func (r *PostgresRepository) Source(ctx context.Context, id string) (string, error) {
	var source string
	err := r.pool.QueryRow(ctx, `SELECT source FROM techniques WHERE id = $1`, id).Scan(&source)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("technique: source: %w", err)
	}
	return source, nil
}

func scanContent(s scannable) (Technique, error) {
	var t Technique
	err := s.Scan(&t.ID, &t.Name, &t.Aliases, &t.Category, &t.Position,
		&t.PositionDetail, &t.GiNoGi, &t.TypicalBelt, &t.Description,
		&t.SetupFrom, &t.CommonCounters, &t.WhenToUse, &t.CommonNextMoves,
		&t.VideoReference, &t.SourceNotes, &t.IBJJFRulesetID, &t.Function,
		&t.ToPosition, &t.Source, &t.Status, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return Technique{}, err
	}
	return t, nil
}

// AdminAuthored returns every console-authored technique, for the export.
//
// Ordered by id so the exported file is byte-stable across runs — a re-export
// with no changes must produce no diff, or the review step the promotion path
// depends on becomes noise nobody reads.
// maxConsoleSearch bounds the console's search.
//
// AdminAuthored above is deliberately unbounded — it grows one technique at a
// time and the export must see all of it. This one reads the WHOLE catalog, so
// it needs a ceiling: 542 full rows is ~570 KB of mostly prose the console
// renders none of.
const maxConsoleSearch = 100

// SearchAll finds any technique by name, id or alias, seeded ones included.
//
// The console could not offer this before: PATCH refused a seeded row, so
// listing rows that 409 when clicked would have been worse than not listing
// them. Now that every row is editable, the opposite is true — a console that
// can only show you the handful it authored cannot fix the typo you came to
// fix.
//
// Separate from the public List, which returns summaries and no `source`. The
// console needs the ownership badge, and it is already admin-gated.
func (r *PostgresRepository) SearchAll(ctx context.Context, query string) ([]Technique, error) {
	// database.LikeTerm, not the raw string — the same helper the public List
	// uses, for the same reason. Unescaped, a `_` matches any character (so
	// "half_guard" finds "half-guard"), a `%` matches everything, and a
	// trailing backslash escapes this pattern's own closing `%` and turns a
	// contains-search into ends-with-a-literal-percent. No injection — the
	// value is bound — but wrong results with nothing reporting it.
	rows, err := r.pool.Query(ctx, `
		SELECT `+contentReturning+` FROM techniques
		WHERE `+database.LikeClause("name", 1)+`
		   OR `+database.LikeClause("id", 1)+`
		   OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE `+database.LikeClause("a", 1)+`)
		ORDER BY name
		LIMIT $2`, database.LikeTerm(query), maxConsoleSearch)
	if err != nil {
		return nil, fmt.Errorf("technique: console search: %w", err)
	}
	defer rows.Close()
	out := []Technique{}
	for rows.Next() {
		t, err := scanContent(rows)
		if err != nil {
			return nil, fmt.Errorf("technique: scan search: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (r *PostgresRepository) AdminAuthored(ctx context.Context) ([]Technique, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT `+contentReturning+` FROM techniques WHERE source = 'admin' ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("technique: admin authored: %w", err)
	}
	defer rows.Close()
	out := []Technique{}
	for rows.Next() {
		t, err := scanContent(rows)
		if err != nil {
			return nil, fmt.Errorf("technique: scan authored: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// AdoptAsSeeded hands rows to the deploy: once the exported JSON is committed
// and released, the file is the owner and the seeder must be able to update
// them.
//
// Separate from the export, and run after the deploy rather than with it. Flip
// too early and the row is owned by a release that does not carry it — the
// seeder skips ids it has never heard of, so the content survives, but it is no
// longer editable in the console either. Stranded between two owners.
func (r *PostgresRepository) AdoptAsSeeded(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	// Scoped to admin rows: adopting is a one-way move, and re-running it must
	// not touch anything the deploy already owns.
	_, err := r.pool.Exec(ctx,
		`UPDATE techniques SET source = 'seed', updated_at = now()
		 WHERE source = 'admin' AND id = ANY($1)`, ids)
	if err != nil {
		return fmt.Errorf("technique: adopt: %w", err)
	}
	return nil
}
