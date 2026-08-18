package sequence

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

// visibleTo is the authorization predicate, written once.
//
// A sequence is readable when the caller owns it or it is VOLA-authored
// (ownerless). Note this is NOT curriculum's predicate: there is no
// `visibility = 'public'` arm, because sequences are never published — sharing
// copies a row to the recipient rather than widening who may read this one.
//
// Composed into every read rather than retyped, because the same rule expressed
// twice is exactly the shape that produced a cross-user enumeration bug in two
// other modules here, each time by one query being updated and the other not.
const visibleTo = `(s.owner_user_id IS NULL OR s.owner_user_id = $1)`

// selectSequence is the column list every read shares, including the resolved
// start-position name. LEFT JOIN, not JOIN: `start_position_id` is nullable and
// its FK is ON DELETE SET NULL, so an inner join would silently drop every
// sequence whose start was never named or whose position has since been pruned.
const selectSequence = `
	SELECT s.id, s.owner_user_id, s.name, s.description,
	       s.start_position_id, COALESCE(p.name, ''),
	       s.created_at, s.updated_at,
	       (SELECT count(*) FROM bjj_sequence_steps st WHERE st.sequence_id = s.id)
	FROM bjj_sequences s
	LEFT JOIN positions p ON p.id = s.start_position_id`

func scanSequence(row pgx.Row, userID string) (Sequence, error) {
	var s Sequence
	if err := row.Scan(&s.ID, &s.OwnerUserID, &s.Name, &s.Description,
		&s.StartPositionID, &s.StartPositionName,
		&s.CreatedAt, &s.UpdatedAt, &s.StepCount); err != nil {
		return Sequence{}, err
	}
	s.Editable = s.OwnerUserID != nil && *s.OwnerUserID == userID
	// The positive fact, beside the permission one. They coincide today only
	// because `visibleTo` has no public arm — see the field docs and T9.
	s.Official = s.OwnerUserID == nil
	return s, nil
}

func (r *PostgresRepository) List(ctx context.Context, userID string) ([]Sequence, error) {
	rows, err := r.pool.Query(ctx, selectSequence+`
		WHERE `+visibleTo+`
		ORDER BY s.updated_at DESC, s.id
		LIMIT `+fmt.Sprint(maxList), userID)
	if err != nil {
		return nil, translate(err, "list")
	}
	defer rows.Close()

	// Non-nil empty, so an athlete with no sequences serialises as `[]` rather
	// than `null` — the convention every list endpoint here follows, and the
	// difference between a client rendering an empty state and crashing on a
	// null map.
	out := make([]Sequence, 0)
	for rows.Next() {
		s, err := scanSequence(rows, userID)
		if err != nil {
			return nil, translate(err, "list scan")
		}
		// Steps deliberately left nil here — see Sequence.Steps.
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, translate(err, "list")
	}
	return out, nil
}

func (r *PostgresRepository) Get(ctx context.Context, id, userID string) (Sequence, error) {
	s, err := scanSequence(r.pool.QueryRow(ctx, selectSequence+`
		WHERE `+visibleTo+` AND s.id = $2`, userID, id), userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Covers "does not exist" AND "belongs to somebody else"
			// identically, which is the point: distinguishing them tells a
			// caller that an id they guessed is real.
			return Sequence{}, ErrNotFound
		}
		return Sequence{}, translate(err, "get")
	}
	steps, err := r.steps(ctx, id)
	if err != nil {
		return Sequence{}, err
	}
	s.Steps = steps
	return s, nil
}

// steps reads one chain, in order, with the library fields resolved.
//
// The technique join is INNER: `technique_id` is NOT NULL with an FK, so a step
// without a technique cannot exist. The position join is LEFT for the same
// reason as the start position — nil means not recorded or ends the exchange,
// and both are legal.
func (r *PostgresRepository) steps(ctx context.Context, sequenceID string) ([]Step, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT st.technique_id, t.name, t.position, t.category, COALESCE(t.function, ''),
		       st.sort_order, st.ends_at_position_id, COALESCE(p.name, ''), st.notes
		FROM bjj_sequence_steps st
		JOIN techniques t ON t.id = st.technique_id
		LEFT JOIN positions p ON p.id = st.ends_at_position_id
		WHERE st.sequence_id = $1
		ORDER BY st.sort_order`, sequenceID)
	if err != nil {
		return nil, translate(err, "steps")
	}
	defer rows.Close()

	out := make([]Step, 0)
	for rows.Next() {
		var s Step
		if err := rows.Scan(&s.TechniqueID, &s.Name, &s.Position, &s.Category, &s.Function,
			&s.Order, &s.EndsAtPositionID, &s.EndsAtPositionName, &s.Notes); err != nil {
			return nil, translate(err, "steps scan")
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, translate(err, "steps")
	}
	return out, nil
}

func (r *PostgresRepository) Create(ctx context.Context, userID string, in NewSequence) (Sequence, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Sequence{}, translate(err, "create")
	}
	// A sequence written without its steps is a chain that claims nothing, so
	// the two writes are one unit. Rollback is a no-op after a successful
	// commit.
	defer func() { _ = tx.Rollback(ctx) }()

	// COALESCE, not a branch: an empty client id falls through to the column
	// default (gen_random_uuid) inside the same statement, so the web path and
	// the offline-capture path are one query rather than two spellings that
	// can drift.
	var id string
	var clientID *string
	if in.ID != "" {
		clientID = &in.ID
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO bjj_sequences (id, owner_user_id, name, description, start_position_id)
		VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4, $5)
		ON CONFLICT (id) DO NOTHING
		RETURNING id`,
		clientID, userID, in.Name, in.Description, in.StartPositionID).Scan(&id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Sequence{}, translate(err, "create")
	}

	if errors.Is(err, pgx.ErrNoRows) {
		// The id already exists. Ids are client-supplied here, so this fallback
		// MUST be scoped to the caller — without the owner predicate, replaying
		// somebody else's id hands back their sequence. That is the IDOR the
		// activity module shipped and workouts documents; it is not
		// hypothetical, and a client id is exactly what makes it reachable.
		var owner *string
		if err := tx.QueryRow(ctx,
			`SELECT owner_user_id FROM bjj_sequences WHERE id = $1`, in.ID).Scan(&owner); err != nil {
			return Sequence{}, translate(err, "create conflict")
		}
		if owner == nil || *owner != userID {
			return Sequence{}, ErrAlreadyExists
		}
		// Same owner, same id: an idempotent sync retry. Return what is stored
		// WITHOUT rewriting the steps — the stored copy is the one the athlete
		// may since have edited on web, and a retry of the original push must
		// not silently revert it.
		if err := tx.Commit(ctx); err != nil {
			return Sequence{}, translate(err, "create commit")
		}
		return r.Get(ctx, in.ID, userID)
	}

	if err := insertSteps(ctx, tx, id, in.Steps); err != nil {
		return Sequence{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Sequence{}, translate(err, "create commit")
	}
	return r.Get(ctx, id, userID)
}

func (r *PostgresRepository) Update(ctx context.Context, id, userID string, in Update) (Sequence, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Sequence{}, translate(err, "update")
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Ownership resolved INSIDE the transaction and by SELECT ... FOR UPDATE,
	// not by a WHERE clause on the UPDATE alone. Two reasons: the steps replace
	// below is a separate statement that would otherwise need the same
	// predicate repeated, and the row lock is what stops a concurrent delete
	// landing between the check and the writes.
	var owner *string
	if err := tx.QueryRow(ctx,
		`SELECT owner_user_id FROM bjj_sequences WHERE id = $1 FOR UPDATE`, id).Scan(&owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Sequence{}, ErrNotFound
		}
		return Sequence{}, translate(err, "update")
	}
	// SPLIT, and the split is the whole point. Collapsing these two into one
	// ErrForbidden made PATCH an existence oracle: 404 for an id that is not
	// real, 403 for one that is somebody else's. That is the same cross-user
	// enumeration this codebase has now shipped three times, relocated to the
	// write path — and the comment that used to sit here claimed "the handler
	// decides the client hears 404", which the handler never did.
	//
	// An ownerless row is VOLA-authored reference content that EVERY caller can
	// already read, so 403 tells them nothing they did not have. Another
	// athlete's row must be indistinguishable from one that never existed.
	if owner == nil {
		return Sequence{}, ErrForbidden
	}
	if *owner != userID {
		return Sequence{}, ErrNotFound
	}

	// COALESCE per column so a nil field leaves the stored value alone. The
	// start position cannot use it — COALESCE cannot express "set to NULL",
	// which is exactly what SetStartPosition exists to say — so it gets its own
	// CASE keyed on a boolean parameter.
	if _, err := tx.Exec(ctx, `
		UPDATE bjj_sequences
		SET name = COALESCE($2, name),
		    description = COALESCE($3, description),
		    start_position_id = CASE WHEN $4 THEN $5 ELSE start_position_id END,
		    updated_at = now()
		WHERE id = $1`,
		id, in.Name, in.Description, in.SetStartPosition, in.StartPositionID); err != nil {
		return Sequence{}, translate(err, "update")
	}

	// nil means leave the chain alone; non-nil (including empty) replaces it.
	if in.Steps != nil {
		if _, err := tx.Exec(ctx, `DELETE FROM bjj_sequence_steps WHERE sequence_id = $1`, id); err != nil {
			return Sequence{}, translate(err, "update steps")
		}
		if err := insertSteps(ctx, tx, id, in.Steps); err != nil {
			return Sequence{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Sequence{}, translate(err, "update commit")
	}
	return r.Get(ctx, id, userID)
}

// insertSteps writes a chain in order. sort_order is assigned HERE from the
// slice index rather than taken from the client: the unique constraint on
// (sequence_id, sort_order) means a client-supplied ordinal can collide, and
// the client's array order is already the authoritative statement of sequence.
func insertSteps(ctx context.Context, tx pgx.Tx, sequenceID string, steps []NewStep) error {
	for i, s := range steps {
		if _, err := tx.Exec(ctx, `
			INSERT INTO bjj_sequence_steps
				(sequence_id, technique_id, sort_order, ends_at_position_id, notes)
			VALUES ($1, $2, $3, $4, $5)`,
			sequenceID, s.TechniqueID, i, s.EndsAtPositionID, s.Notes); err != nil {
			return translate(err, "insert step")
		}
	}
	return nil
}

func (r *PostgresRepository) Delete(ctx context.Context, id, userID string) error {
	// Resolved the same way Update does, rather than by folding ownership into
	// the WHERE clause. A bare `AND owner_user_id = $2` answers 404 for a
	// VOLA-authored row while Update answers 403 for the same row and the same
	// caller — one module giving two answers about one permission, which stops
	// being merely untidy the day reference chains ship.
	var owner *string
	if err := r.pool.QueryRow(ctx,
		`SELECT owner_user_id FROM bjj_sequences WHERE id = $1`, id).Scan(&owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return translate(err, "delete")
	}
	if owner == nil {
		return ErrForbidden
	}
	if *owner != userID {
		// Indistinguishable from "never existed", as above.
		return ErrNotFound
	}
	// Steps go with it via ON DELETE CASCADE.
	if _, err := r.pool.Exec(ctx,
		`DELETE FROM bjj_sequences WHERE id = $1 AND owner_user_id = $2`, id, userID); err != nil {
		return translate(err, "delete")
	}
	return nil
}

// translate turns Postgres constraint violations into domain errors, so no raw
// SQL error can escape this package — the module pattern's rule, and what stops
// a database message reaching a client.
func translate(err error, op string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation — two steps in one slot
			return ErrInvalidInput
		case "23503": // foreign_key_violation — a technique or position id that isn't real
			return ErrInvalidInput
		case "23514": // check_violation
			return ErrInvalidInput
		}
	}
	return fmt.Errorf("sequence: %s: %w", op, err)
}

// ─── share.Copier ───────────────────────────────────────────────────────────
//
// Sequences are the first shareable thing, and this is the whole of what a
// module owes the share system: say what it is called, and know how to
// duplicate it. Nothing here imports the share package — these two methods
// satisfy an interface declared over there, and cmd/api/main.go is what pairs
// them up.

// Describe returns the sequence's name for a recipient's inbox card.
//
// VISIBILITY, not ownership: a caller who can read a VOLA-authored chain can
// pass it on, and doing so gives the recipient nothing they could not have
// fetched themselves. ok=false covers both "no such id" and "not visible to
// you", collapsed so that sharing cannot be used to test whether a guessed id
// is real.
func (r *PostgresRepository) Describe(ctx context.Context, resourceID, sharerID string) (string, bool, error) {
	var name string
	// visibleTo, composed rather than retyped — the const's own comment says
	// why, and review caught this query having retyped it. Note the argument
	// order it fixes: visibleTo references $1 as the caller.
	err := r.pool.QueryRow(ctx, `
		SELECT s.name FROM bjj_sequences s WHERE `+visibleTo+` AND s.id = $2`,
		sharerID, resourceID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, translate(err, "describe")
	}
	return name, true, nil
}

// CopyTo duplicates a sequence and its steps into another athlete's ownership,
// inside the share module's transaction.
//
// A NEW id, always — never the source's, even though ids here can be
// client-supplied. Two athletes owning rows with one id would collide on the
// primary key for the second copy and, worse, would make the recipient's chain
// answer to the sender's offline sync retries.
//
// The steps are re-inserted rather than the row being pointed at, because that
// is what snapshot semantics MEAN: after this returns, the two chains have no
// relationship at all, and the sender can rename, reorder or delete theirs
// without touching what the recipient now owns. `sort_order` is re-derived
// from the read order rather than copied, so a source with gaps in its
// ordering yields a dense one.
func (r *PostgresRepository) CopyTo(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
	var name, description string
	var startPositionID *string
	// The SAME visibility predicate the share was authorized under, re-applied
	// at accept time. A bare `WHERE id = $1` would copy whatever holds that id
	// now — and ids here can be client-supplied, so one freed by a delete and
	// claimed by another athlete is a shape the type system does not prevent.
	err := tx.QueryRow(ctx, `
		SELECT s.name, s.description, s.start_position_id
		FROM bjj_sequences s WHERE `+visibleTo+` AND s.id = $2`,
		sharerID, resourceID).Scan(&name, &description, &startPositionID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Deleted between sending and accepting — or no longer the sharer's to
		// pass on. The share module clears the dead row rather than letting it
		// fail this way forever.
		return "", false, nil
	}
	if err != nil {
		return "", false, translate(err, "copy read")
	}

	var newID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO bjj_sequences (owner_user_id, name, description, start_position_id)
		VALUES ($1, $2, $3, $4)
		RETURNING id`,
		newOwnerID, name, description, startPositionID).Scan(&newID); err != nil {
		return "", false, translate(err, "copy insert")
	}

	// One statement rather than read-then-loop: the steps never leave the
	// database, so a long chain costs one round trip and cannot half-copy.
	if _, err := tx.Exec(ctx, `
		INSERT INTO bjj_sequence_steps
			(sequence_id, technique_id, sort_order, ends_at_position_id, notes)
		SELECT $1, technique_id,
		       row_number() OVER (ORDER BY sort_order) - 1,
		       ends_at_position_id, notes
		FROM bjj_sequence_steps WHERE sequence_id = $2`,
		newID, resourceID); err != nil {
		return "", false, translate(err, "copy steps")
	}
	return newID, true, nil
}
