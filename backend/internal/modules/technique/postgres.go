package technique

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
	id, name, aliases, category, position, position_detail, gi_no_gi,
	typical_belt, description, setup_from, common_counters,
	created_at, updated_at`

type scannable interface{ Scan(dest ...any) error }

func scanTechnique(row scannable) (*Technique, error) {
	var t Technique
	err := row.Scan(&t.ID, &t.Name, &t.Aliases, &t.Category, &t.Position,
		&t.PositionDetail, &t.GiNoGi, &t.TypicalBelt, &t.Description,
		&t.SetupFrom, &t.CommonCounters, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// Same pattern-injection guard as the exercise catalog: binding the
// parameter stops SQL injection but not LIKE metacharacters, so a bare "%"
// would otherwise turn a search into a full-table match.
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// List composes its WHERE from compile-time-constant fragments plus bound
// values, so each filter shape gets its own cached plan that can use its
// index — rather than one static query with disabled predicates, which
// Postgres can't optimise once it settles on a generic plan.
func (r *PostgresRepository) List(ctx context.Context, f Filter) ([]Technique, error) {
	var (
		where []string
		args  []any
	)
	if f.Position != "" {
		args = append(args, f.Position)
		where = append(where, fmt.Sprintf("position = $%d", len(args)))
	}
	if f.Category != "" {
		args = append(args, f.Category)
		where = append(where, fmt.Sprintf("category = $%d", len(args)))
	}
	if f.GiNoGi != "" {
		// Asking for gi should include techniques that work in both — a
		// filter that hid every "Both" entry would hide most of the library.
		args = append(args, f.GiNoGi)
		where = append(where, fmt.Sprintf("(gi_no_gi = $%d OR gi_no_gi = 'Both')", len(args)))
	}
	if f.Query != "" {
		args = append(args, likeEscaper.Replace(f.Query))
		where = append(where, fmt.Sprintf(`name ILIKE '%%' || $%d || '%%' ESCAPE '\'`, len(args)))
	}

	q := `SELECT ` + selectColumns + ` FROM techniques`
	if len(where) > 0 {
		q += ` WHERE ` + strings.Join(where, " AND ")
	}
	q += ` ORDER BY position, category, name`

	rows, err := r.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("technique: list: %w", err)
	}
	defer rows.Close()

	techniques := []Technique{}
	for rows.Next() {
		t, err := scanTechnique(rows)
		if err != nil {
			return nil, fmt.Errorf("technique: scan: %w", err)
		}
		techniques = append(techniques, *t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("technique: rows: %w", err)
	}
	return techniques, nil
}

func (r *PostgresRepository) Get(ctx context.Context, id string) (*Technique, error) {
	row := r.pool.QueryRow(ctx, `SELECT `+selectColumns+` FROM techniques WHERE id = $1`, id)
	t, err := scanTechnique(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("technique: get: %w", err)
	}
	return t, nil
}

// The trailing WHERE keeps an unchanged row a true no-op, so updated_at
// means "last content change" rather than "last deploy" — same reasoning as
// the exercise catalog, and the same prerequisite for delta sync.
const upsertSQL = `
	INSERT INTO techniques (
		id, name, aliases, category, position, position_detail, gi_no_gi,
		typical_belt, description, setup_from, common_counters
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	ON CONFLICT (id) DO UPDATE SET
		name            = EXCLUDED.name,
		aliases         = EXCLUDED.aliases,
		category        = EXCLUDED.category,
		position        = EXCLUDED.position,
		position_detail = EXCLUDED.position_detail,
		gi_no_gi        = EXCLUDED.gi_no_gi,
		typical_belt    = EXCLUDED.typical_belt,
		description     = EXCLUDED.description,
		setup_from      = EXCLUDED.setup_from,
		common_counters = EXCLUDED.common_counters,
		updated_at      = now()
	WHERE (
		techniques.name, techniques.aliases, techniques.category,
		techniques.position, techniques.position_detail, techniques.gi_no_gi,
		techniques.typical_belt, techniques.description,
		techniques.setup_from, techniques.common_counters
	) IS DISTINCT FROM (
		EXCLUDED.name, EXCLUDED.aliases, EXCLUDED.category,
		EXCLUDED.position, EXCLUDED.position_detail, EXCLUDED.gi_no_gi,
		EXCLUDED.typical_belt, EXCLUDED.description,
		EXCLUDED.setup_from, EXCLUDED.common_counters
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
			t.SetupFrom, t.CommonCounters)
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
