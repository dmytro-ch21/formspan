package technique

import (
	"context"
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
	COALESCE(to_position, ''), source, created_at, updated_at`

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

func (r *PostgresRepository) CreateTechnique(ctx context.Context, t Technique) (Technique, error) {
	// No ON CONFLICT. A collision has to surface as an error rather than
	// quietly become an update: the id may already be a foreign key in
	// somebody's training record, so rewriting the technique behind it changes
	// what their history says they did.
	row := r.pool.QueryRow(ctx, `
		INSERT INTO techniques (
			id, name, aliases, category, position, position_detail, gi_no_gi,
			typical_belt, description, setup_from, common_counters, when_to_use,
			common_next_moves, video_reference, source_notes, ibjjf_ruleset_id,
			function, to_position, source
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
			NULLIF($16, ''), NULLIF($17, ''), NULLIF($18, ''), 'admin')
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

func (r *PostgresRepository) UpdateTechnique(ctx context.Context, t Technique) (Technique, error) {
	// ANY row is editable here, and the write TAKES OWNERSHIP of it.
	//
	// `source = 'admin'` used to sit in the WHERE, refusing seeded rows: an
	// edit to one would be reverted by the next deploy's re-seed — silently,
	// and only for the fields the change-detection tuple covers, which is the
	// worst kind of half-applied. That was the right refusal while the
	// spreadsheet owned 450 of the 542 and a JSON edit could not stick either.
	//
	// With the spreadsheet retired the refusal has no remedy to point at, so it
	// moves to the SET clause instead: the row becomes admin-owned by the act
	// of editing it, and the seed's own `WHERE source = 'seed'` then skips it
	// forever after. That is what makes this safe rather than merely permitted
	// — remove `source = 'admin'` from the SET and the next deploy quietly
	// undoes every edit made here, which is exactly the hazard the WHERE was
	// guarding against.
	//
	// Getting the row back under the deploy is `exportcontent -adopt`, after
	// the JSON is committed and shipped. Still one statement, so it cannot
	// race.
	row := r.pool.QueryRow(ctx, `
		UPDATE techniques SET
			name = $2, aliases = $3, category = $4, position = $5,
			position_detail = $6, gi_no_gi = $7, typical_belt = $8,
			description = $9, setup_from = $10, common_counters = $11,
			when_to_use = $12, common_next_moves = $13, video_reference = $14,
			source_notes = $15, ibjjf_ruleset_id = NULLIF($16, ''),
			function = NULLIF($17, ''), to_position = NULLIF($18, ''),
			source = 'admin', updated_at = now()
		WHERE id = $1
		RETURNING `+contentReturning,
		t.ID, t.Name, t.Aliases, t.Category, t.Position, t.PositionDetail, t.GiNoGi,
		t.TypicalBelt, t.Description, t.SetupFrom, t.CommonCounters, t.WhenToUse,
		t.CommonNextMoves, t.VideoReference, t.SourceNotes, t.IBJJFRulesetID,
		t.Function, t.ToPosition)

	out, err := scanContent(row)
	if errors.Is(err, pgx.ErrNoRows) {
		// Now means exactly one thing — no such id. It used to also mean "that
		// one is seeded", which the handler looked up to explain.
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
		&t.ToPosition, &t.Source, &t.CreatedAt, &t.UpdatedAt)
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
