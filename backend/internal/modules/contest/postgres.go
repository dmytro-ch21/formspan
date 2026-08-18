package contest

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

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

// maxList caps the entry list.
//
// api-conventions.md requires it: the conditional-GET stack buffers a whole
// response to hash it, so peak memory is bounded only if every list has a
// ceiling, and "a new list endpoint without a LIMIT silently unbounds this
// property" is written there in those words.
//
// The honest ceiling here is the PRODUCT, and it is worth stating rather than
// leaving to be discovered: 200 entries each carrying up to MaxMatches (64)
// matches is 12,800 match rows in one body. That is the bound. It is generous
// against reality — a decade of competing is a few dozen entries — and the
// alternative, paging a list an athlete reads as a single career record, buys
// nothing at this size.
const maxList = 200

const contestColumns = `id, sport, name, organisation, held_on, format, gi,
	division_belt, division_age, division_weight, placement, entrants, note,
	created_at, updated_at`

// querier is the slice of pgx shared by *pgxpool.Pool and pgx.Tx, so the match
// loader can be handed either. Load-bearing on the write paths: reading the
// matches back through the pool would open a SEPARATE connection that cannot
// see the transaction's uncommitted rows, so the response would omit exactly
// what was just written.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// translatePgError turns constraint violations into domain errors.
//
// Never let a raw SQL error escape — the module pattern requires it and the
// conventions forbid leaking database text to a client.
//
// The one worth reading twice is 22003. `contests.placement` is INTEGER and
// `contest_matches.position` is SMALLINT, and an overflow on either raises
// SQLSTATE 22003 — a numeric range error with NO constraint name on it. A
// translator that only switched on constraint names would let it fall through
// as an unmapped internal error, which is a 500 for what is plainly a bad
// request. The migration flags this trap explicitly; Validate bounds both
// values so this arm should be unreachable, and it is here because "should be"
// is not a guarantee.
func translatePgError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23503": // foreign_key_violation
		// The composite owner FK. A match naming a contest that does not exist
		// — or belongs to someone else — is refused by the database itself.
		// ErrNotFound, never a distinct "not yours": telling the two apart
		// would confirm the id exists, which is the enumeration leak the admin
		// module was fixed for.
		if strings.Contains(pgErr.ConstraintName, "contest_owner") {
			return ErrNotFound
		}
		// The only other FK on these tables is contest_matches.technique_id.
		return invalid("unknown technique")
	case "23514": // check_violation
		switch {
		case strings.Contains(pgErr.ConstraintName, "placement_within_field"):
			return invalid("placement cannot exceed entrants")
		case strings.Contains(pgErr.ConstraintName, "placement_positive"):
			return invalid("placement must be at least 1 when given")
		case strings.Contains(pgErr.ConstraintName, "entrants_positive"):
			return invalid("entrants must be at least 1 when given")
		case strings.Contains(pgErr.ConstraintName, "position_positive"):
			return invalid("a match position must be at least 1")
		}
		return invalid("a value is out of range")
	case "23505": // unique_violation
		// contest_matches_unique_position. Unreachable through this module —
		// positions are assigned server-side from array order — so it means the
		// assignment has been changed to trust a client. Reported as invalid
		// input rather than 500 because it is still the caller's payload that
		// produced it.
		return invalid("two matches cannot share a position")
	case "22003": // numeric_value_out_of_range
		return invalid("a number is too large")
	}
	return err
}

func (r *PostgresRepository) List(ctx context.Context, userID string) ([]Contest, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+contestColumns+`
		FROM contests
		WHERE user_id = $1
		-- Newest first, undated last. `+"`contests_user_held_idx`"+` is declared
		-- (user_id, held_on DESC NULLS LAST) precisely so this ordering is the
		-- index's own and an undated entry sinks without the planner giving up
		-- on it.
		--
		-- `+"`created_at, id`"+` make the order TOTAL, which the cap below turns
		-- from tidiness into correctness: two entries at the same tournament on
		-- the same day are the ordinary case (gi and no-gi), and without a
		-- tiebreak they can swap between requests. That would flap the ETag
		-- body hash for no reason and, at the boundary, let one row appear
		-- twice while another never appears at all.
		ORDER BY held_on DESC NULLS LAST, created_at DESC, id
		LIMIT $2`, userID, maxList)
	if err != nil {
		return nil, fmt.Errorf("contest: list: %w", err)
	}
	defer rows.Close()

	// Non-nil: this marshals to [] rather than null.
	out := []Contest{}
	byID := map[string]*Contest{}
	ids := []string{}
	for rows.Next() {
		c, err := scanContest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("contest: list: %w", err)
	}
	// Indexed AFTER the loop, never during it: `out` grows by append, so a
	// pointer taken inside the loop can be left dangling into a stale backing
	// array the moment it reallocates, and the matches would attach to nothing.
	for i := range out {
		byID[out[i].ID] = &out[i]
		ids = append(ids, out[i].ID)
	}

	// One query for every entry's matches rather than one per entry. The N+1
	// this avoids is the first thing the backend reviewer looks for, and at 200
	// entries it is 200 round trips to render one screen.
	if err := attachMatches(ctx, r.pool, userID, ids, byID); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *PostgresRepository) Get(ctx context.Context, userID, id string) (*Contest, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT `+contestColumns+`
		FROM contests
		-- user_id in the WHERE, always. Without it this is an IDOR: any id from
		-- any account would be readable.
		WHERE id = $1 AND user_id = $2`, id, userID)
	c, err := scanContest(row)
	if err != nil {
		return nil, err
	}
	if err := attachMatches(ctx, r.pool, userID, []string{c.ID}, map[string]*Contest{c.ID: c}); err != nil {
		return nil, err
	}
	return c, nil
}

func (r *PostgresRepository) Create(ctx context.Context, userID string, in Input) (*Contest, error) {
	// One transaction, for the reason `bjj.PutDetail` gives: an entry whose
	// matches failed to write is a competitive record that reads as though the
	// athlete turned up and never fought, and it would look that way
	// permanently with nothing flagging the loss.
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("contest: begin: %w", err)
	}
	// No-op once committed; the pgx idiom for "roll back unless we reach the
	// end".
	defer func() { _ = tx.Rollback(ctx) }()

	heldOn, err := parseDate(in.HeldOn)
	if err != nil {
		return nil, err
	}

	// `id` omitted so the column default mints it. Server-side, matching
	// `bjj_promotions`: client ids exist in this schema to make OFFLINE retries
	// idempotent, and there is no outbox behind a contest — it is entered at a
	// desk with a connection — so a client id would buy nothing here.
	row := tx.QueryRow(ctx, `
		INSERT INTO contests
			(user_id, sport, name, organisation, held_on, format, gi,
			 division_belt, division_age, division_weight, placement, entrants, note)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING `+contestColumns,
		userID, in.Sport, in.Name, in.Organisation, heldOn, string(in.Format), in.Gi,
		in.DivisionBelt, in.DivisionAge, in.DivisionWeight, in.Placement, in.Entrants, in.Note)
	c, err := scanContest(row)
	if err != nil {
		return nil, err
	}

	if err := insertMatches(ctx, tx, userID, c.ID, in.Matches); err != nil {
		return nil, err
	}
	// Read back through the TRANSACTION, so the response is what actually
	// landed rather than an echo of the request.
	if err := attachMatches(ctx, tx, userID, []string{c.ID}, map[string]*Contest{c.ID: c}); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("contest: commit: %w", err)
	}
	return c, nil
}

// Update replaces the entry and every one of its matches.
//
// Wholesale replacement rather than a per-match diff, matching
// `curriculum`'s items and `bjj`'s tags. The alternative needs stable match
// identity across edits, which this table deliberately does not offer — see
// the note on Match about why `id` is not exposed.
func (r *PostgresRepository) Update(ctx context.Context, userID, id string, in Input) (*Contest, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("contest: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	heldOn, err := parseDate(in.HeldOn)
	if err != nil {
		return nil, err
	}

	row := tx.QueryRow(ctx, `
		UPDATE contests SET
			sport = $3, name = $4, organisation = $5, held_on = $6, format = $7, gi = $8,
			division_belt = $9, division_age = $10, division_weight = $11,
			placement = $12, entrants = $13, note = $14, updated_at = now()
		-- user_id in the WHERE, never trusted from the body. This is the whole
		-- authorization for the write: without it any id from any account is
		-- editable, which is the IDOR shape the reviewers have caught twice
		-- here. It also makes "not yours" and "not there" the same answer,
		-- which is what stops the endpoint confirming an id exists.
		WHERE id = $1 AND user_id = $2
		RETURNING `+contestColumns,
		id, userID, in.Sport, in.Name, in.Organisation, heldOn, string(in.Format), in.Gi,
		in.DivisionBelt, in.DivisionAge, in.DivisionWeight, in.Placement, in.Entrants, in.Note)
	c, err := scanContest(row)
	if err != nil {
		// scanContest maps pgx.ErrNoRows to ErrNotFound, so an entry that does
		// not exist — or is not the caller's — stops here, BEFORE the delete
		// below could touch anything.
		return nil, err
	}

	// Scoped by user_id as well as contest_id. Redundant behind the composite
	// FK and the ownership proven by the UPDATE above, and kept because a
	// delete is the one statement where being wrong is unrecoverable.
	if _, err := tx.Exec(ctx,
		`DELETE FROM contest_matches WHERE contest_id = $1 AND user_id = $2`, id, userID); err != nil {
		return nil, fmt.Errorf("contest: clear matches: %w", err)
	}
	if err := insertMatches(ctx, tx, userID, id, in.Matches); err != nil {
		return nil, err
	}
	if err := attachMatches(ctx, tx, userID, []string{c.ID}, map[string]*Contest{c.ID: c}); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("contest: commit: %w", err)
	}
	return c, nil
}

func (r *PostgresRepository) Delete(ctx context.Context, userID, id string) error {
	// The matches go with it: `contest_matches_contest_owner_fk` is ON DELETE
	// CASCADE, so no second statement and no orphan window.
	tag, err := r.pool.Exec(ctx, `DELETE FROM contests WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return fmt.Errorf("contest: delete: %w", err)
	}
	// Zero rows is indistinguishable from "belongs to someone else", and
	// deliberately so.
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// insertMatches writes one entry's bracket. Positions come from Validate,
// which numbered them from array order; nothing here trusts a client's.
func insertMatches(ctx context.Context, tx pgx.Tx, userID, contestID string, matches []Match) error {
	if len(matches) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, m := range matches {
		batch.Queue(`
			INSERT INTO contest_matches
				(contest_id, user_id, position, result, method, technique_id, opponent, note)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			contestID, userID, m.Position, string(m.Result), string(m.Method),
			m.TechniqueID, m.Opponent, m.Note)
	}
	results := tx.SendBatch(ctx, batch)
	for range matches {
		if _, err := results.Exec(); err != nil {
			// Closed before returning — the batch owns the connection until it
			// is, and the transaction cannot be rolled back while it does.
			_ = results.Close()
			return translatePgError(err)
		}
	}
	if err := results.Close(); err != nil {
		return translatePgError(err)
	}
	return nil
}

// attachMatches loads the matches for every listed contest in one query and
// hangs them off the given entries.
func attachMatches(ctx context.Context, q querier, userID string, ids []string, byID map[string]*Contest) error {
	// Every entry gets a non-nil slice even when it has no matches, so the
	// field marshals as [] rather than null on an entry recorded as a placement
	// alone — which is an ordinary entry, not an edge case.
	for _, c := range byID {
		c.Matches = []Match{}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.Query(ctx, `
		SELECT contest_id, position, result, method, technique_id, opponent, note
		FROM contest_matches
		-- user_id as well as the id list. The ids came from rows already scoped
		-- to this caller, so this is belt and braces — and it is the cheap kind:
		-- `+"`contest_matches_user_method_idx`"+` leads with user_id, and a read
		-- that cannot return another athlete's row by construction is one fewer
		-- thing a future edit can get wrong.
		WHERE user_id = $1 AND contest_id = ANY($2)
		-- Bracket order, and the reason it matters: position is what makes
		-- "lost in the final" different from "lost the first match". Served by
		-- contest_matches_unique_position's own btree.
		ORDER BY contest_id, position`, userID, ids)
	if err != nil {
		return fmt.Errorf("contest: matches: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			contestID string
			m         Match
			result    string
			method    string
		)
		if err := rows.Scan(&contestID, &m.Position, &result, &method,
			&m.TechniqueID, &m.Opponent, &m.Note); err != nil {
			return fmt.Errorf("contest: scan match: %w", err)
		}
		m.Result, m.Method = Result(result), Method(method)
		if c, ok := byID[contestID]; ok {
			c.Matches = append(c.Matches, m)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("contest: matches: %w", err)
	}
	return nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanContest(s scanner) (*Contest, error) {
	var (
		c      Contest
		heldOn *time.Time
		format string
	)
	err := s.Scan(&c.ID, &c.Sport, &c.Name, &c.Organisation, &heldOn, &format, &c.Gi,
		&c.DivisionBelt, &c.DivisionAge, &c.DivisionWeight,
		&c.Placement, &c.Entrants, &c.Note, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, translatePgError(err)
	}
	c.Format = Format(format)
	if heldOn != nil {
		// Formatted as a calendar date, never marshalled as an RFC3339 instant.
		// A DATE rendered as midnight UTC shows as the PREVIOUS DAY for anyone
		// west of Greenwich once a client localises it — the trap CLAUDE.md
		// keeps a whole test-suite timezone for.
		d := heldOn.Format(dateLayout)
		c.HeldOn = &d
	}
	// Non-nil for the same reason the loader sets it: a caller that never
	// reaches attachMatches (nothing does today, but scanContest is the shared
	// path) still gets [] rather than null.
	c.Matches = []Match{}
	return &c, nil
}

func parseDate(in *string) (*time.Time, error) {
	if in == nil || *in == "" {
		return nil, nil
	}
	t, err := time.Parse(dateLayout, *in)
	if err != nil {
		return nil, invalid("held_on must be YYYY-MM-DD or null")
	}
	return &t, nil
}
