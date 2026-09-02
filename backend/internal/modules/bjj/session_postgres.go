package bjj

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const detailColumns = `
	session_id, kind, gi, rounds, round_minutes, session_rpe,
	academy, note, body_note, created_at, updated_at`

// translateSessionPgError turns constraint violations into domain errors.
//
// The interesting one is the owner foreign key. `bjj_session_details` and
// `bjj_session_tags` reference `sessions (id, user_id)` as a pair, so a write
// naming a session that does not exist — or that belongs to somebody else —
// is refused by the database itself.
//
// That is a backstop, not the authorization: PutDetail checks ownership
// explicitly, because the FK covers neither sport nor the upsert's DO UPDATE
// path (see the notes there). What it does cover is the race the explicit
// check cannot — a session deleted between the check and the write — so this
// translation still has to be right.
//
// Both cases map to ErrNotFound, and identically: telling them apart would
// confirm that an id exists, which is the enumeration leak the admin module
// was fixed for.
func translateSessionPgError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23503": // foreign_key_violation
		if strings.Contains(pgErr.ConstraintName, "session_owner") {
			return ErrNotFound
		}
		return fmt.Errorf("%w: unknown technique", ErrInvalidInput)
	case "23514": // check_violation
		switch {
		case strings.Contains(pgErr.ConstraintName, "rpe"):
			return fmt.Errorf("%w: session RPE must be between 1 and 10", ErrInvalidInput)
		case strings.Contains(pgErr.ConstraintName, "count"):
			return fmt.Errorf("%w: a tag count must be at least 1", ErrInvalidInput)
		}
		return fmt.Errorf("%w: a value is out of range", ErrInvalidInput)
	case "22003":
		return fmt.Errorf("%w: a value is too large", ErrInvalidInput)
	}
	return err
}

// PutDetail upserts the BJJ detail for a session and replaces its tags.
//
// One transaction, because a detail row whose tags failed to write is a
// session that renders as though the athlete recorded nothing live — the
// reflection would look lost even though it partly landed.
func (r *PostgresRepository) PutDetail(
	ctx context.Context, userID string, d SessionDetail,
) (SessionDetail, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return SessionDetail{}, fmt.Errorf("bjj: begin: %w", err)
	}
	// No-op once the transaction has been committed; this is the pgx idiom
	// for "roll back unless we got to the end".
	defer func() { _ = tx.Rollback(ctx) }()

	// Ownership AND sport, read explicitly inside the transaction.
	//
	// The composite owner FK cannot do this job alone, for two reasons that
	// are easy to get wrong:
	//
	//  1. It says nothing about sport. Without this check a BJJ reflection
	//     attaches happily to a strength session — verified — which
	//     contradicts the contract and, worse, pollutes the tag stream every
	//     deferred BJJ feature reads with evidence hanging off a barbell
	//     workout.
	//  2. It does not fire at all on the upsert's DO UPDATE path. See the
	//     note on the WHERE clause below.
	//
	// `session/postgres.go`'s assertSportsMatch is the same guard for sets,
	// for the same reason: some invariants are not expressible as a foreign
	// key.
	var sport string
	err = tx.QueryRow(ctx,
		`SELECT sport FROM sessions WHERE id = $1 AND user_id = $2`,
		d.SessionID, userID).Scan(&sport)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionDetail{}, ErrNotFound
	}
	if err != nil {
		return SessionDetail{}, err
	}
	// A session of another sport answers exactly as a missing one does. From
	// this module's side "a BJJ session with that id" genuinely does not
	// exist, and saying which of the two it is would confirm the id belongs
	// to somebody's account.
	if sport != sportKey {
		return SessionDetail{}, ErrNotFound
	}

	row := tx.QueryRow(ctx, `
		INSERT INTO bjj_session_details
			(session_id, user_id, kind, gi, rounds, round_minutes, session_rpe,
			 academy, note, body_note)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (session_id) DO UPDATE SET
			kind          = excluded.kind,
			gi            = excluded.gi,
			rounds        = excluded.rounds,
			round_minutes = excluded.round_minutes,
			session_rpe   = excluded.session_rpe,
			academy       = excluded.academy,
			note          = excluded.note,
			body_note     = excluded.body_note,
			updated_at    = now()
		-- Load-bearing. Do not remove this thinking the foreign key covers it.
		--
		-- On the INSERT path the composite owner FK does reject a session that
		-- is not this caller's. On the DO UPDATE path it does not run at all:
		-- Postgres skips the referential-integrity check when no referencing
		-- column changes, and the update above rewrites only payload columns —
		-- session_id and user_id are untouched by design. So for an existing
		-- row this predicate is the only thing standing between one athlete
		-- and another's reflection.
		--
		-- It is defence in depth behind the ownership SELECT above, and the
		-- two are genuinely independent — deleting either one alone still
		-- refuses a cross-user update. That independence is also why no test
		-- routed through PutDetail can prove this line is still here: the
		-- SELECT answers first, so the suite stays green without it.
		-- TestUpsertPredicateRefusesACrossUserUpdateAtTheSQLLevel therefore
		-- issues this statement directly, as an attacker, and asserts the
		-- database refuses it on its own. Change this clause and that test
		-- is what fails.
		WHERE bjj_session_details.user_id = $2
		RETURNING `+detailColumns,
		d.SessionID, userID, string(d.Kind), d.Gi, d.Rounds, d.RoundMinutes,
		d.SessionRPE, d.Academy, d.Note, d.BodyNote)

	out, err := scanDetail(row)
	if errors.Is(err, pgx.ErrNoRows) {
		// The row exists but the WHERE above excluded it — someone else owns
		// this session id. Same answer as "no such session", for the same
		// non-disclosure reason.
		return SessionDetail{}, ErrNotFound
	}
	if err != nil {
		return SessionDetail{}, translateSessionPgError(err)
	}

	// Replace wholesale. The client re-sends the desired state, so deleting
	// and re-inserting is what makes a retry converge rather than duplicate.
	if _, err := tx.Exec(ctx,
		`DELETE FROM bjj_session_tags WHERE session_id = $1 AND user_id = $2`,
		d.SessionID, userID); err != nil {
		return SessionDetail{}, translateSessionPgError(err)
	}

	// Batched, matching insertSets in the session module. One Exec per tag
	// is up to MaxTags sequential round trips inside the transaction, all
	// while holding the detail row's lock from the upsert above.
	if len(d.Tags) > 0 {
		batch := &pgx.Batch{}
		for _, t := range d.Tags {
			// user_id is passed rather than sub-queried, same as the sets
			// batch: the composite owner FK checks it against `sessions`, so
			// a wrong value is refused by the database rather than needing a
			// correlated lookup per row.
			batch.Queue(`
				INSERT INTO bjj_session_tags
					(session_id, user_id, category, event, position, technique_id, count, label)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				d.SessionID, userID, string(t.Category), string(t.Event),
				t.Position, t.TechniqueID, t.Count, t.Label)
		}
		results := tx.SendBatch(ctx, batch)
		for i := range d.Tags {
			if _, err := results.Exec(); err != nil {
				results.Close() //nolint:errcheck // returning the more useful error
				if t := translateSessionPgError(err); !errors.Is(t, err) {
					return SessionDetail{}, t
				}
				return SessionDetail{}, fmt.Errorf("bjj: insert tag %d: %w", i, err)
			}
		}
		if err := results.Close(); err != nil {
			return SessionDetail{}, fmt.Errorf("bjj: tag batch: %w", err)
		}
	}

	// Inside the transaction, so what comes back is what this call wrote.
	out.Tags, err = r.listTags(ctx, tx, userID, d.SessionID)
	if err != nil {
		return SessionDetail{}, fmt.Errorf("bjj: list tags: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return SessionDetail{}, fmt.Errorf("bjj: commit: %w", err)
	}
	return out, nil
}

func (r *PostgresRepository) GetDetail(
	ctx context.Context, userID, sessionID string,
) (SessionDetail, error) {
	// Both reads in one transaction, for the same reason PutDetail reads its
	// tags before COMMIT. On the pool these are two separate implicit
	// transactions, so a PutDetail committing between them returns a detail
	// row from before the write and tags from after — a reflection that never
	// existed in that combination. The mobile outbox retries, so two reads
	// racing one write is the ordinary case here, not a rare one.
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return SessionDetail{}, fmt.Errorf("bjj: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row := tx.QueryRow(ctx, `
		SELECT `+detailColumns+`
		FROM bjj_session_details
		WHERE session_id = $1 AND user_id = $2`, sessionID, userID)

	d, err := scanDetail(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionDetail{}, ErrNotFound
	}
	if err != nil {
		return SessionDetail{}, err
	}

	d.Tags, err = r.listTags(ctx, tx, userID, sessionID)
	if err != nil {
		return SessionDetail{}, fmt.Errorf("bjj: list tags: %w", err)
	}
	// Read-only, so a rollback would do — committing keeps the pgx idiom
	// uniform with PutDetail and releases the snapshot explicitly.
	if err := tx.Commit(ctx); err != nil {
		return SessionDetail{}, fmt.Errorf("bjj: commit: %w", err)
	}
	return d, nil
}

// listTags takes a querier rather than using r.pool so it can run inside the
// caller's transaction. Read outside it, PutDetail could return the tags of a
// concurrent write to the same session instead of the ones it just stored.
func (r *PostgresRepository) listTags(
	ctx context.Context, q querier, userID, sessionID string,
) ([]Tag, error) {
	rows, err := q.Query(ctx, `
		SELECT id, category, event, position, technique_id, count, label
		FROM bjj_session_tags
		WHERE session_id = $1 AND user_id = $2
		-- Stable order so a re-read renders the chips in the same sequence the
		-- athlete entered them; id is insertion order.
		ORDER BY id`, sessionID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Non-nil empty slice: this marshals to [] rather than null, so a client
	// can iterate it without a null check.
	out := []Tag{}
	for rows.Next() {
		var (
			t        Tag
			category string
			event    string
		)
		if err := rows.Scan(&t.ID, &category, &event, &t.Position,
			&t.TechniqueID, &t.Count, &t.Label); err != nil {
			return nil, err
		}
		t.Category = Category(category)
		t.Event = Event(event)
		out = append(out, t)
	}
	return out, rows.Err()
}

func scanDetail(s scanner) (SessionDetail, error) {
	var (
		d    SessionDetail
		kind string
	)
	err := s.Scan(&d.SessionID, &kind, &d.Gi, &d.Rounds, &d.RoundMinutes,
		&d.SessionRPE, &d.Academy, &d.Note, &d.BodyNote, &d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		return SessionDetail{}, err
	}
	d.Kind = Kind(kind)
	d.Tags = []Tag{}
	return d, nil
}
