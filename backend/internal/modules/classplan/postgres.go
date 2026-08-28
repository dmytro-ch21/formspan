package classplan

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

// selectClassPlan is the column list every read shares, including the
// computed block count and total duration — both derived on every read
// rather than stored, so they can never drift from the blocks table they
// summarise.
const selectClassPlan = `
	SELECT p.id, p.owner_user_id, p.name, p.description, p.created_at, p.updated_at,
	       (SELECT count(*) FROM class_plan_blocks b WHERE b.class_plan_id = p.id),
	       COALESCE((SELECT sum(duration_minutes) FROM class_plan_blocks b WHERE b.class_plan_id = p.id), 0)
	FROM class_plans p`

func scanClassPlan(row pgx.Row) (ClassPlan, error) {
	var p ClassPlan
	if err := row.Scan(&p.ID, &p.OwnerUserID, &p.Name, &p.Description,
		&p.CreatedAt, &p.UpdatedAt, &p.BlockCount, &p.TotalDurationMinutes); err != nil {
		return ClassPlan{}, err
	}
	return p, nil
}

func (r *PostgresRepository) List(ctx context.Context, callerUserID string) ([]ClassPlan, error) {
	rows, err := r.pool.Query(ctx, selectClassPlan+`
		WHERE p.owner_user_id = $1
		ORDER BY p.updated_at DESC, p.id
		LIMIT `+fmt.Sprint(maxList), callerUserID)
	if err != nil {
		return nil, translate(err, "list")
	}
	defer rows.Close()

	// Non-nil empty, so a coach with no plans serialises as `[]` rather than
	// `null` — the convention every list endpoint here follows.
	out := make([]ClassPlan, 0)
	for rows.Next() {
		p, err := scanClassPlan(rows)
		if err != nil {
			return nil, translate(err, "list scan")
		}
		// Blocks deliberately left nil here — see ClassPlan.Blocks.
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, translate(err, "list")
	}
	return out, nil
}

func (r *PostgresRepository) Get(ctx context.Context, id, callerUserID string) (ClassPlan, error) {
	p, err := scanClassPlan(r.pool.QueryRow(ctx, selectClassPlan+`
		WHERE p.owner_user_id = $1 AND p.id = $2`, callerUserID, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Covers "does not exist" AND "belongs to somebody else"
			// identically — see the package doc comment on why there is no
			// ErrForbidden here at all, unlike sequence.
			return ClassPlan{}, ErrNotFound
		}
		return ClassPlan{}, translate(err, "get")
	}
	blocks, err := r.blocks(ctx, id)
	if err != nil {
		return ClassPlan{}, err
	}
	p.Blocks = blocks
	return p, nil
}

// blocks reads one plan's schedule, in order, with the technique projection
// resolved. LEFT JOIN, not JOIN: technique_id is nullable (only a
// technique_drill block has one), so an inner join would drop every
// non-technique_drill block entirely.
func (r *PostgresRepository) blocks(ctx context.Context, classPlanID string) ([]Block, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT b.sort_order, b.type, b.duration_minutes, b.technique_id, b.free_text, b.notes,
		       t.name, t.position
		FROM class_plan_blocks b
		LEFT JOIN techniques t ON t.id = b.technique_id
		WHERE b.class_plan_id = $1
		ORDER BY b.sort_order`, classPlanID)
	if err != nil {
		return nil, translate(err, "blocks")
	}
	defer rows.Close()

	out := make([]Block, 0)
	for rows.Next() {
		var b Block
		var techName, techPosition *string
		if err := rows.Scan(&b.Order, &b.Type, &b.DurationMinutes, &b.TechniqueID, &b.FreeText, &b.Notes,
			&techName, &techPosition); err != nil {
			return nil, translate(err, "blocks scan")
		}
		if techName != nil {
			b.TechniqueName = *techName
		}
		if techPosition != nil {
			b.TechniquePosition = *techPosition
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, translate(err, "blocks")
	}
	return out, nil
}

func (r *PostgresRepository) Create(ctx context.Context, callerUserID string, in NewClassPlan) (ClassPlan, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return ClassPlan{}, translate(err, "create")
	}
	// A plan written without its blocks is an empty schedule, so the two
	// writes are one unit. Rollback is a no-op after a successful commit.
	defer func() { _ = tx.Rollback(ctx) }()

	// COALESCE, not a branch: an empty client id falls through to the
	// column default (gen_random_uuid) inside the same statement, matching
	// sequence.PostgresRepository.Create.
	var id string
	var clientID *string
	if in.ID != "" {
		clientID = &in.ID
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO class_plans (id, owner_user_id, name, description)
		VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4)
		ON CONFLICT (id) DO NOTHING
		RETURNING id`,
		clientID, callerUserID, in.Name, in.Description).Scan(&id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ClassPlan{}, translate(err, "create")
	}

	if errors.Is(err, pgx.ErrNoRows) {
		// The id already exists. Ids are client-supplied here, so this
		// fallback MUST be scoped to the caller — without the owner
		// predicate, replaying somebody else's id would hand back their
		// plan. The exact IDOR sequence.go documents and workouts warns
		// about, and a client id is exactly what makes it reachable.
		var owner string
		if err := tx.QueryRow(ctx,
			`SELECT owner_user_id FROM class_plans WHERE id = $1`, in.ID).Scan(&owner); err != nil {
			return ClassPlan{}, translate(err, "create conflict")
		}
		if owner != callerUserID {
			return ClassPlan{}, ErrAlreadyExists
		}
		// Same owner, same id: an idempotent sync retry. Return what is
		// stored WITHOUT rewriting the blocks — the stored copy may since
		// have been edited on web, and a retry of the original push must
		// not silently revert it.
		if err := tx.Commit(ctx); err != nil {
			return ClassPlan{}, translate(err, "create commit")
		}
		return r.Get(ctx, in.ID, callerUserID)
	}

	if err := insertBlocks(ctx, tx, id, in.Blocks); err != nil {
		return ClassPlan{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ClassPlan{}, translate(err, "create commit")
	}
	return r.Get(ctx, id, callerUserID)
}

func (r *PostgresRepository) Update(ctx context.Context, id, callerUserID string, in ClassPlanUpdate) (ClassPlan, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return ClassPlan{}, translate(err, "update")
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Ownership resolved INSIDE the transaction, by SELECT ... FOR UPDATE —
	// matching sequence.PostgresRepository.Update. The row lock is what
	// stops a concurrent delete landing between the check and the writes
	// below, and resolving it once here (rather than folding it into the
	// UPDATE's WHERE clause) means the blocks replace further down does not
	// need to repeat the same predicate.
	var owner string
	if err := tx.QueryRow(ctx,
		`SELECT owner_user_id FROM class_plans WHERE id = $1 FOR UPDATE`, id).Scan(&owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ClassPlan{}, ErrNotFound
		}
		return ClassPlan{}, translate(err, "update")
	}
	// ErrNotFound, NOT ErrForbidden, for a foreign row — and this is the
	// one place this module's write path most obviously differs from
	// sequence's. There is no ownerless class plan a caller could
	// legitimately read but not write (see the package doc comment), so
	// "not owned" and "does not exist" are already the same case here, on
	// every path, not only reads. Collapsing them keeps PATCH from becoming
	// the existence oracle a split answer would make it — 404 for an unreal
	// id, something else for a real one belonging to somebody else.
	if owner != callerUserID {
		return ClassPlan{}, ErrNotFound
	}

	// COALESCE per column so a nil field leaves the stored value alone —
	// unlike sequence there is no nullable field here needing the
	// SetX/CASE treatment StartPositionID does, since Name and Description
	// are never cleared to NULL, only left alone or replaced.
	if _, err := tx.Exec(ctx, `
		UPDATE class_plans
		SET name = COALESCE($2, name),
		    description = COALESCE($3, description),
		    updated_at = now()
		WHERE id = $1`,
		id, in.Name, in.Description); err != nil {
		return ClassPlan{}, translate(err, "update")
	}

	// nil means leave the plan's blocks alone; non-nil (including empty)
	// replaces them wholesale.
	if in.Blocks != nil {
		if _, err := tx.Exec(ctx, `DELETE FROM class_plan_blocks WHERE class_plan_id = $1`, id); err != nil {
			return ClassPlan{}, translate(err, "update blocks")
		}
		if err := insertBlocks(ctx, tx, id, in.Blocks); err != nil {
			return ClassPlan{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ClassPlan{}, translate(err, "update commit")
	}
	return r.Get(ctx, id, callerUserID)
}

// insertBlocks writes a plan's schedule in order. sort_order is assigned
// HERE from the slice index rather than taken from the client — the unique
// constraint on (class_plan_id, sort_order) means a client-supplied ordinal
// can collide, and the client's array order is already the authoritative
// statement of the schedule. Matches sequence.insertSteps exactly.
func insertBlocks(ctx context.Context, tx pgx.Tx, classPlanID string, blocks []NewBlock) error {
	for i, b := range blocks {
		if _, err := tx.Exec(ctx, `
			INSERT INTO class_plan_blocks
				(class_plan_id, sort_order, type, duration_minutes, technique_id, free_text, notes)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			classPlanID, i, b.Type, b.DurationMinutes, b.TechniqueID, b.FreeText, b.Notes); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23503" {
				// The one violation worth naming specifically: a
				// technique_id the catalog does not have. Wrapped (%w)
				// rather than a bare ErrInvalidInput, so errors.Is still
				// matches while the client is told WHICH block is wrong.
				return fmt.Errorf("%w: block %d references a technique id that does not exist", ErrInvalidInput, i)
			}
			return translate(err, "insert block")
		}
	}
	return nil
}

func (r *PostgresRepository) Delete(ctx context.Context, id, callerUserID string) error {
	// Resolved the same way Update does, rather than folding ownership into
	// the DELETE's WHERE clause — so a foreign row and a nonexistent one
	// answer identically, matching Get and Update rather than giving a
	// third answer about the same permission.
	var owner string
	if err := r.pool.QueryRow(ctx,
		`SELECT owner_user_id FROM class_plans WHERE id = $1`, id).Scan(&owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return translate(err, "delete")
	}
	if owner != callerUserID {
		return ErrNotFound
	}
	// Blocks go with it via ON DELETE CASCADE.
	if _, err := r.pool.Exec(ctx,
		`DELETE FROM class_plans WHERE id = $1 AND owner_user_id = $2`, id, callerUserID); err != nil {
		return translate(err, "delete")
	}
	return nil
}

// translate turns Postgres constraint violations into domain errors, so no
// raw SQL error can escape this package — the module pattern's rule, and
// what stops a database message reaching a client.
func translate(err error, op string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation — two blocks in one slot
			return ErrInvalidInput
		case "23503": // foreign_key_violation — a technique id that isn't real
			return ErrInvalidInput
		case "23514": // check_violation — e.g. the technique/free_text XOR
			return ErrInvalidInput
		}
	}
	return fmt.Errorf("classplan: %s: %w", op, err)
}
