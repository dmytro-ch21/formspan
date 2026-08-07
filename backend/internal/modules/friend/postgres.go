package friend

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

// resolve turns a handle into a user id, matching the lookup endpoint's
// semantics exactly: lower() so the expression index serves it, ErrNotFound
// for anything absent.
func (r *PostgresRepository) resolve(ctx context.Context, username string) (string, error) {
	var id string
	err := r.pool.QueryRow(ctx,
		`SELECT user_id FROM profiles WHERE lower(username) = lower($1)`, username).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", translate(err, "resolve")
	}
	return id, nil
}

func (r *PostgresRepository) Send(ctx context.Context, callerID, targetUsername string) error {
	// The caller must have a handle BEFORE anything else is looked at: the
	// request will sit in someone's inbox as a name, and an unnamed requester
	// renders as nothing. Checked first so the error is about the caller's
	// own state, not the target's.
	var callerHandle *string
	err := r.pool.QueryRow(ctx,
		`SELECT username FROM profiles WHERE user_id = $1`, callerID).Scan(&callerHandle)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return translate(err, "send")
	}
	if callerHandle == nil {
		return ErrNoUsername
	}

	targetID, err := r.resolve(ctx, targetUsername)
	if err != nil {
		return err
	}
	if targetID == callerID {
		return fmt.Errorf("%w: that is your own username", ErrInvalidInput)
	}

	a, b := pairOf(callerID, targetID)
	// The primary key does the whole uniqueness argument: a crossing request
	// (B asks A while A→B is pending) and a duplicate both land on the same
	// canonical row and come back 23505 — no read-then-write race window.
	_, err = r.pool.Exec(ctx, `
		INSERT INTO friendships (user_a, user_b, requested_by)
		VALUES ($1, $2, $3)`, a, b, callerID)
	return translate(err, "send")
}

func (r *PostgresRepository) Accept(ctx context.Context, callerID, fromUsername string) error {
	fromID, err := r.resolve(ctx, fromUsername)
	if err != nil {
		return err
	}
	a, b := pairOf(callerID, fromID)
	// Three conditions in one predicate, and each is load-bearing:
	//   pending        — an accepted row is not re-acceptable
	//   requested_by = the OTHER user — the sender cannot accept their own
	//   the pair       — an outsider's call matches nothing
	// RowsAffected 0 collapses every miss into one ErrNotFound, because
	// distinguishing "no request" from "you sent it yourself" confirms to a
	// sender that their request still exists.
	tag, err := r.pool.Exec(ctx, `
		UPDATE friendships SET status = 'accepted', accepted_at = now()
		WHERE user_a = $1 AND user_b = $2 AND status = 'pending' AND requested_by = $3`,
		a, b, fromID)
	if err != nil {
		return translate(err, "accept")
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *PostgresRepository) Remove(ctx context.Context, callerID, username string) error {
	otherID, err := r.resolve(ctx, username)
	if err != nil {
		return err
	}
	a, b := pairOf(callerID, otherID)
	// The caller is in the pair by construction of pairOf with their own id,
	// so this cannot touch a relationship the caller is not part of.
	tag, err := r.pool.Exec(ctx,
		`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, a, b)
	if err != nil {
		return translate(err, "remove")
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// otherSide picks the counterpart's profile columns for a row the caller is
// half of. Used by both list queries; the CASE keeps it one join.
//
// Both callers LIMIT. The conditional-GET stack buffers a whole identity body
// to hash it, so api-conventions.md holds peak memory bounded on the premise
// that every list has a ceiling — and the pending list is the sharp case,
// because it grows with OTHER people's actions: throwaway accounts sending
// requests inflate the victim's inbox without the victim doing anything. The
// username tiebreak is part of the same argument: a bare timestamp DESC can
// tie, and ties reorder between queries, which wobbles the ETag of a body
// nobody changed.
const cardSelect = `
	SELECT p.username, p.display_name, %s
	FROM friendships f
	JOIN profiles p ON p.user_id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
	WHERE (f.user_a = $1 OR f.user_b = $1)`

func (r *PostgresRepository) Friends(ctx context.Context, callerID string) ([]Card, error) {
	rows, err := r.pool.Query(ctx,
		fmt.Sprintf(cardSelect, "f.accepted_at")+`
		AND f.status = 'accepted'
		ORDER BY f.accepted_at DESC, p.username
		LIMIT 500`, callerID)
	if err != nil {
		return nil, translate(err, "friends")
	}
	return scanCards(rows)
}

func (r *PostgresRepository) Pending(ctx context.Context, callerID string) (Requests, error) {
	// Non-nil empties, so an empty inbox serialises as [] rather than null —
	// the list convention every other module follows.
	out := Requests{Incoming: []Card{}, Outgoing: []Card{}}
	rows, err := r.pool.Query(ctx,
		fmt.Sprintf(cardSelect, "f.created_at, f.requested_by")+`
		AND f.status = 'pending'
		ORDER BY f.created_at DESC, p.username
		LIMIT 500`, callerID)
	if err != nil {
		return out, translate(err, "pending")
	}
	defer rows.Close()
	for rows.Next() {
		var c Card
		var requestedBy string
		if err := rows.Scan(&c.Username, &c.DisplayName, &c.Since, &requestedBy); err != nil {
			return out, translate(err, "pending scan")
		}
		if requestedBy == callerID {
			out.Outgoing = append(out.Outgoing, c)
		} else {
			out.Incoming = append(out.Incoming, c)
		}
	}
	return out, rows.Err()
}

func scanCards(rows pgx.Rows) ([]Card, error) {
	defer rows.Close()
	out := []Card{}
	for rows.Next() {
		var c Card
		if err := rows.Scan(&c.Username, &c.DisplayName, &c.Since); err != nil {
			return nil, translate(err, "scan")
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func translate(err error, op string) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // the canonical pair already has a row
			return ErrAlreadyExists
		case "23514": // check_violation
			return ErrInvalidInput
		}
	}
	return fmt.Errorf("friend: %s: %w", op, err)
}
