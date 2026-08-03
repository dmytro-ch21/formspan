package technique

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

// Two column sets, deliberately. The prose fields (description, when_to_use,
// the three edge arrays) are most of the library's bytes, and a list request
// needs none of them: returning full rows ships ~550 KB to draw a scrolling
// list where ~70 KB will do.
const summaryColumns = `
	t.id, t.name, t.aliases, t.category, COALESCE(t.function, ''),
	t.position, t.position_detail,
	t.gi_no_gi, t.typical_belt, COALESCE(t.ibjjf_ruleset_id, '')`

const detailColumns = `
	t.id, t.name, t.aliases, t.category, COALESCE(t.function, ''),
	t.position, t.position_detail,
	t.gi_no_gi, t.typical_belt, t.description, t.when_to_use,
	t.setup_from, t.common_next_moves, t.common_counters,
	t.video_reference, t.source_notes, COALESCE(t.ibjjf_ruleset_id, ''),
	t.created_at, t.updated_at`

const rulesetColumns = `
	id, age_scope, rule_class, gi_allowed_belts, gi_note,
	no_gi_allowed_belts, no_gi_note, is_restricted, notes, sources`

// One column set, not two: at ten rows with ~250 words each the whole table is
// a few KB, so the summary/detail split the techniques need buys nothing here.
const positionColumns = `
	id, name, aliases, family, detail_includes, detail_excludes,
	order_index, description, priorities, created_at, updated_at`

type scannable interface{ Scan(dest ...any) error }

func scanSummary(row scannable) (*Summary, error) {
	var s Summary
	err := row.Scan(&s.ID, &s.Name, &s.Aliases, &s.Category, &s.Function,
		&s.Position, &s.PositionDetail, &s.GiNoGi, &s.TypicalBelt,
		&s.IBJJFRulesetID)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func scanTechnique(row scannable) (*Technique, error) {
	var t Technique
	err := row.Scan(&t.ID, &t.Name, &t.Aliases, &t.Category, &t.Function,
		&t.Position, &t.PositionDetail, &t.GiNoGi, &t.TypicalBelt, &t.Description,
		&t.WhenToUse, &t.SetupFrom, &t.CommonNextMoves, &t.CommonCounters,
		&t.VideoReference, &t.SourceNotes, &t.IBJJFRulesetID,
		&t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func scanRuleset(row scannable) (*Ruleset, error) {
	var r Ruleset
	err := row.Scan(&r.ID, &r.AgeScope, &r.RuleClass, &r.GiAllowedBelts,
		&r.GiNote, &r.NoGiAllowedBelts, &r.NoGiNote, &r.IsRestricted,
		&r.Notes, &r.Sources)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func scanPosition(row scannable) (*Position, error) {
	var p Position
	err := row.Scan(&p.ID, &p.Name, &p.Aliases, &p.Family, &p.DetailIncludes,
		&p.DetailExcludes, &p.OrderIndex, &p.Description, &p.Priorities,
		&p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// List composes its WHERE from compile-time-constant fragments plus bound
// values, so each filter shape gets its own cached plan that can use its
// index — rather than one static query with disabled predicates, which
// Postgres can't optimise once it settles on a generic plan.
func (r *PostgresRepository) List(ctx context.Context, f Filter) ([]Summary, error) {
	var (
		where []string
		args  []any
	)
	if f.Position != "" {
		args = append(args, f.Position)
		where = append(where, fmt.Sprintf("t.position = $%d", len(args)))
	}
	if f.Category != "" {
		args = append(args, f.Category)
		where = append(where, fmt.Sprintf("t.category = $%d", len(args)))
	}
	if f.GiNoGi != "" {
		// Asking for gi should include techniques that work in both — a
		// filter that hid every "Both" entry would hide most of the library.
		args = append(args, f.GiNoGi)
		where = append(where, fmt.Sprintf("(t.gi_no_gi = $%d OR t.gi_no_gi = 'Both')", len(args)))
	}
	if f.Query != "" {
		// Match the name OR any alias. Half this library is known by two
		// names — "Kesa-Gatame Escape" and "scarf hold escape" are the same
		// technique, and searching only `name` finds one of them.
		args = append(args, database.LikeTerm(f.Query))
		n := len(args)
		where = append(where, "("+database.LikeClause("t.name", n)+
			" OR EXISTS (SELECT 1 FROM unnest(t.aliases) a WHERE "+
			database.LikeClause("a", n)+"))")
	}

	q := `SELECT ` + summaryColumns + ` FROM techniques t`
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, " AND ")
	}
	q += ` ORDER BY t.position, t.category, t.name`

	rows, err := r.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("technique: list: %w", err)
	}
	defer rows.Close()

	summaries := []Summary{}
	for rows.Next() {
		s, err := scanSummary(rows)
		if err != nil {
			return nil, fmt.Errorf("technique: scan: %w", err)
		}
		summaries = append(summaries, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("technique: rows: %w", err)
	}
	return summaries, nil
}

func (r *PostgresRepository) Get(ctx context.Context, id string) (*Technique, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+detailColumns+` FROM techniques t WHERE t.id = $1`, id)
	t, err := scanTechnique(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("technique: get: %w", err)
	}

	// Resolved here rather than left to the client: a technique detail is one
	// request. LEFT-join semantics by hand because the ruleset is nullable —
	// the 450 rows seeded before this migration may not carry one yet, and a
	// missing ruleset must not turn a readable technique into a 500.
	if t.IBJJFRulesetID != "" {
		rr := r.pool.QueryRow(ctx, `SELECT `+rulesetColumns+` FROM ibjjf_rulesets WHERE id = $1`, t.IBJJFRulesetID)
		rs, err := scanRuleset(rr)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("technique: get ruleset: %w", err)
		}
		t.IBJJF = rs
	}
	return t, nil
}

// Rulesets returns all of them — there are 25, so paging or filtering would be
// ceremony. Clients fetch this once and keep it: it is what turns a summary's
// ibjjf_ruleset_id into a legality badge without a request per row.
func (r *PostgresRepository) Rulesets(ctx context.Context) ([]Ruleset, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+rulesetColumns+` FROM ibjjf_rulesets ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("technique: rulesets: %w", err)
	}
	defer rows.Close()

	out := []Ruleset{}
	for rows.Next() {
		rs, err := scanRuleset(rows)
		if err != nil {
			return nil, fmt.Errorf("technique: scan ruleset: %w", err)
		}
		out = append(out, *rs)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("technique: ruleset rows: %w", err)
	}
	return out, nil
}

// Positions returns all ten in reading order. `id` breaks ties so the order is
// total rather than merely sorted — two entries sharing an order_index would
// otherwise come back in whatever order the scan produced, and a glossary that
// reshuffles between opens looks broken.
func (r *PostgresRepository) Positions(ctx context.Context) ([]Position, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+positionColumns+` FROM positions ORDER BY order_index, id`)
	if err != nil {
		return nil, fmt.Errorf("technique: positions: %w", err)
	}
	defer rows.Close()

	out := []Position{}
	for rows.Next() {
		p, err := scanPosition(rows)
		if err != nil {
			return nil, fmt.Errorf("technique: scan position: %w", err)
		}
		out = append(out, *p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("technique: position rows: %w", err)
	}
	return out, nil
}

func (r *PostgresRepository) GetPosition(ctx context.Context, id string) (*Position, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+positionColumns+` FROM positions WHERE id = $1`, id)
	p, err := scanPosition(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("technique: get position: %w", err)
	}
	return p, nil
}

const upsertPositionSQL = `
	INSERT INTO positions (
		id, name, aliases, family, detail_includes, detail_excludes,
		order_index, description, priorities
	)
	-- COALESCE because naming the columns explicitly means the DEFAULT '{}'
	-- never applies, and pgx encodes a nil Go slice as SQL NULL. A Position
	-- built in code with any array field left unset would otherwise fail the
	-- NOT NULL constraint mid-batch, reporting a constraint name rather than
	-- the entry. Seed data is normalised too; this makes it unconditional.
	-- The ::text[] casts are required, not decoration: inside COALESCE a bare
	-- '{}' is inferred as text and the statement fails to prepare.
	VALUES ($1, $2, $3, $4, COALESCE($5, '{}'::text[]), COALESCE($6, '{}'::text[]),
		$7, $8, $9)
	ON CONFLICT (id) DO UPDATE SET
		name            = EXCLUDED.name,
		aliases         = EXCLUDED.aliases,
		family          = EXCLUDED.family,
		detail_includes = EXCLUDED.detail_includes,
		detail_excludes = EXCLUDED.detail_excludes,
		order_index     = EXCLUDED.order_index,
		description     = EXCLUDED.description,
		priorities      = EXCLUDED.priorities,
		updated_at      = now()
	WHERE (
		positions.name, positions.aliases, positions.family,
		positions.detail_includes, positions.detail_excludes,
		positions.order_index, positions.description, positions.priorities
	) IS DISTINCT FROM (
		EXCLUDED.name, EXCLUDED.aliases, EXCLUDED.family,
		EXCLUDED.detail_includes, EXCLUDED.detail_excludes,
		EXCLUDED.order_index, EXCLUDED.description, EXCLUDED.priorities
	)`

// UpsertPositions has no ordering requirement against UpsertAll — nothing holds
// an FK to these. Atomicity comes from pgx's SendBatch running the batch in an
// implicit transaction, same as UpsertRulesets.
//
// It also deletes anything no longer in the seed. That is NOT the orphan-prune
// rulesets need — those are content-addressed, so editing one mints a new id
// and strands the old row. These ids are hand-authored and stable, so editing
// prose updates in place and cannot strand anything. What it covers is the two
// cases stable ids do not solve: removing an entry from positions.json, and
// renaming an id. Without it the old row keeps being served forever, and a
// rename shows the athlete two glossary entries for one position.
func (r *PostgresRepository) UpsertPositions(ctx context.Context, positions []Position) error {
	// The prune below deletes everything not in `ids`, and `x <> ALL('{}')` is
	// TRUE — so an empty slice truncates the glossary. validatePositions
	// already rejects an empty seed, but that guard lives two layers away in
	// another file, and the failure here is silent data loss inside a deploy
	// command. Cheap to make the repository safe on its own.
	if len(positions) == 0 {
		return fmt.Errorf("technique: refusing to upsert an empty position set")
	}

	ids := make([]string, 0, len(positions))
	batch := &pgx.Batch{}
	for _, p := range positions {
		batch.Queue(upsertPositionSQL, p.ID, p.Name, p.Aliases, p.Family,
			p.DetailIncludes, p.DetailExcludes, p.OrderIndex, p.Description,
			p.Priorities)
		ids = append(ids, p.ID)
	}
	// Queued last so it runs inside the same implicit transaction: the delete
	// can never take effect without the writes that justify it. Guarded on a
	// non-empty list by validatePositions, which rejects an empty glossary —
	// otherwise this would truncate the table on a bad parse.
	batch.Queue(`DELETE FROM positions WHERE id <> ALL($1)`, ids)

	results := r.pool.SendBatch(ctx, batch)
	for i := range positions {
		if _, err := results.Exec(); err != nil {
			results.Close() //nolint:errcheck // returning the more useful error
			return fmt.Errorf("technique: upsert position %q: %w", positions[i].ID, err)
		}
	}
	if _, err := results.Exec(); err != nil {
		results.Close() //nolint:errcheck // returning the more useful error
		return fmt.Errorf("technique: prune positions: %w", err)
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("technique: position batch: %w", err)
	}
	return nil
}

const upsertRulesetSQL = `
	INSERT INTO ibjjf_rulesets (
		id, age_scope, rule_class, gi_allowed_belts, gi_note,
		no_gi_allowed_belts, no_gi_note, is_restricted, notes, sources
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	ON CONFLICT (id) DO UPDATE SET
		age_scope           = EXCLUDED.age_scope,
		rule_class          = EXCLUDED.rule_class,
		gi_allowed_belts    = EXCLUDED.gi_allowed_belts,
		gi_note             = EXCLUDED.gi_note,
		no_gi_allowed_belts = EXCLUDED.no_gi_allowed_belts,
		no_gi_note          = EXCLUDED.no_gi_note,
		is_restricted       = EXCLUDED.is_restricted,
		notes               = EXCLUDED.notes,
		sources             = EXCLUDED.sources,
		updated_at          = now()
	WHERE (
		ibjjf_rulesets.age_scope, ibjjf_rulesets.rule_class,
		ibjjf_rulesets.gi_allowed_belts, ibjjf_rulesets.gi_note,
		ibjjf_rulesets.no_gi_allowed_belts, ibjjf_rulesets.no_gi_note,
		ibjjf_rulesets.is_restricted, ibjjf_rulesets.notes,
		ibjjf_rulesets.sources
	) IS DISTINCT FROM (
		EXCLUDED.age_scope, EXCLUDED.rule_class,
		EXCLUDED.gi_allowed_belts, EXCLUDED.gi_note,
		EXCLUDED.no_gi_allowed_belts, EXCLUDED.no_gi_note,
		EXCLUDED.is_restricted, EXCLUDED.notes,
		EXCLUDED.sources
	)`

// DeleteOrphanRulesets removes rulesets nothing references. Safe only after
// techniques have been upserted — see Seed.
func (r *PostgresRepository) DeleteOrphanRulesets(ctx context.Context) error {
	_, err := r.pool.Exec(ctx, `
		DELETE FROM ibjjf_rulesets rs
		WHERE NOT EXISTS (
			SELECT 1 FROM techniques t WHERE t.ibjjf_ruleset_id = rs.id
		)`)
	if err != nil {
		return fmt.Errorf("technique: prune rulesets: %w", err)
	}
	return nil
}

// UpsertRulesets must run before UpsertAll.
//
// Atomicity comes from pgx's SendBatch, which runs the whole batch in an
// implicit transaction — stated explicitly because it is invisible at the call
// site, and a refactor to per-row Exec would silently lose it.
// — techniques carry an FK to these,
// so seeding in the other order fails on the constraint.
func (r *PostgresRepository) UpsertRulesets(ctx context.Context, rulesets []Ruleset) error {
	batch := &pgx.Batch{}
	for _, rs := range rulesets {
		batch.Queue(upsertRulesetSQL, rs.ID, rs.AgeScope, rs.RuleClass,
			rs.GiAllowedBelts, rs.GiNote, rs.NoGiAllowedBelts, rs.NoGiNote,
			rs.IsRestricted, rs.Notes, rs.Sources)
	}
	results := r.pool.SendBatch(ctx, batch)
	for i := range rulesets {
		if _, err := results.Exec(); err != nil {
			results.Close() //nolint:errcheck // returning the more useful error
			return fmt.Errorf("technique: upsert ruleset %q: %w", rulesets[i].ID, err)
		}
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("technique: ruleset batch: %w", err)
	}
	return nil
}

// The trailing WHERE keeps an unchanged row a true no-op, so updated_at
// means "last content change" rather than "last deploy" — same reasoning as
// the exercise catalog, and the same prerequisite for delta sync.
const upsertSQL = `
	INSERT INTO techniques (
		id, name, aliases, category, position, position_detail, gi_no_gi,
		typical_belt, description, setup_from, common_counters,
		when_to_use, common_next_moves, video_reference, source_notes,
		ibjjf_ruleset_id, function
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
		NULLIF($16, ''), NULLIF($17, ''))
	ON CONFLICT (id) DO UPDATE SET
		name            = EXCLUDED.name,
		aliases         = EXCLUDED.aliases,
		category        = EXCLUDED.category,
		function        = EXCLUDED.function,
		position        = EXCLUDED.position,
		position_detail = EXCLUDED.position_detail,
		gi_no_gi        = EXCLUDED.gi_no_gi,
		typical_belt    = EXCLUDED.typical_belt,
		description     = EXCLUDED.description,
		setup_from      = EXCLUDED.setup_from,
		common_counters = EXCLUDED.common_counters,
		when_to_use       = EXCLUDED.when_to_use,
		common_next_moves = EXCLUDED.common_next_moves,
		video_reference   = EXCLUDED.video_reference,
		source_notes      = EXCLUDED.source_notes,
		ibjjf_ruleset_id  = EXCLUDED.ibjjf_ruleset_id,
		updated_at      = now()
	WHERE (
		techniques.name, techniques.aliases, techniques.category,
		techniques.position, techniques.position_detail, techniques.gi_no_gi,
		techniques.typical_belt, techniques.description,
		techniques.setup_from, techniques.common_counters,
		techniques.when_to_use, techniques.common_next_moves,
		techniques.video_reference, techniques.source_notes,
		techniques.ibjjf_ruleset_id, techniques.function
	) IS DISTINCT FROM (
		EXCLUDED.name, EXCLUDED.aliases, EXCLUDED.category,
		EXCLUDED.position, EXCLUDED.position_detail, EXCLUDED.gi_no_gi,
		EXCLUDED.typical_belt, EXCLUDED.description,
		EXCLUDED.setup_from, EXCLUDED.common_counters,
		EXCLUDED.when_to_use, EXCLUDED.common_next_moves,
		EXCLUDED.video_reference, EXCLUDED.source_notes,
		EXCLUDED.ibjjf_ruleset_id, EXCLUDED.function
	)`

// UpsertAll writes the whole library in one transaction, so a deploy either
// fully applies the content or leaves it untouched.
func (r *PostgresRepository) UpsertAll(ctx context.Context, techniques []Technique) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("technique: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once Commit succeeds

	batch := &pgx.Batch{}
	for _, t := range techniques {
		batch.Queue(upsertSQL, t.ID, t.Name, t.Aliases, t.Category, t.Position,
			t.PositionDetail, t.GiNoGi, t.TypicalBelt, t.Description,
			t.SetupFrom, t.CommonCounters, t.WhenToUse, t.CommonNextMoves,
			t.VideoReference, t.SourceNotes, t.IBJJFRulesetID, t.Function)
	}

	results := tx.SendBatch(ctx, batch)
	for i := range techniques {
		if _, err := results.Exec(); err != nil {
			results.Close() //nolint:errcheck // returning the more useful error
			return fmt.Errorf("technique: upsert %q: %w", techniques[i].ID, err)
		}
	}
	if err := results.Close(); err != nil {
		return fmt.Errorf("technique: batch: %w", err)
	}
	return tx.Commit(ctx)
}
