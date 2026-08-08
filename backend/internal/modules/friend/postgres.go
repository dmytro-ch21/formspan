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

// FriendID resolves a handle to the user id of an ACCEPTED friend of the
// caller, satisfying share.Friends.
//
// ONE not-found answer for three different misses — no such handle, a handle
// that is not your friend, and a pending-but-unaccepted request. That collapse is
// the whole reason this lives here rather than being assembled by the caller
// out of a lookup plus a friendship read: two calls can be told apart, and
// being able to tell them apart turns any endpoint that shares to a handle
// into an oracle for "does this account exist" and "who is friends with whom".
func (r *PostgresRepository) FriendID(ctx context.Context, callerID, username string) (string, bool, error) {
	var id string
	err := r.pool.QueryRow(ctx, `
		SELECT p.user_id
		FROM profiles p
		JOIN friendships f
		  ON (f.user_a = LEAST(p.user_id, $1) AND f.user_b = GREATEST(p.user_id, $1))
		WHERE lower(p.username) = lower($2)
		  AND p.user_id <> $1
		  AND f.status = 'accepted'`, callerID, username).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, translate(err, "friend id")
	}
	return id, true, nil
}

// PendingCount is how many people are waiting on this caller to answer,
// satisfying notification.Counter.
//
// INCOMING ONLY. An outgoing request is pending too and is emphatically not
// waiting for you — badging it would send someone to a screen to look at
// something they already did. `requested_by <> $1` is the whole distinction,
// and it is the one thing to get wrong here.
//
// Capped: the count is for a badge, and a badge showing "312" is the same
// information as "lots". Counting a bounded subquery also means one athlete
// cannot make another athlete's cheapest, most-polled endpoint expensive by
// sending them requests.
func (r *PostgresRepository) PendingCount(ctx context.Context, callerID string) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT count(*) FROM (
			SELECT 1 FROM friendships
			WHERE (user_a = $1 OR user_b = $1)
			  AND status = 'pending'
			  AND requested_by <> $1
			LIMIT $2
		) capped`, callerID, maxBadgeCount).Scan(&n)
	if err != nil {
		return 0, translate(err, "pending count")
	}
	return n, nil
}

// FriendIDs returns the user ids of everyone who has ACCEPTED a friendship
// with the caller, satisfying feed.Friends.
//
// **The one place this module yields a user id in bulk, and it is deliberate
// that it stays inside the process.** This package's contract is that handles
// cross the wire in both directions and ids never do — that is why `Friends`
// returns cards and why `FriendID` resolves exactly one handle. Nothing here
// changes that: no handler calls this, it is wired into the feed module in
// `cmd/api/main.go`, and the feed's own rows carry handles.
//
// Same 500 ceiling as `Friends`, and for the same reason: it is what the
// social graph is allowed to be, and a caller fanning out over the result must
// not be able to exceed it.
func (r *PostgresRepository) FriendIDs(ctx context.Context, callerID string) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END
		FROM friendships
		WHERE (user_a = $1 OR user_b = $1)
		  AND status = 'accepted'
		ORDER BY accepted_at DESC
		LIMIT 500`, callerID)
	if err != nil {
		return nil, translate(err, "friend ids")
	}
	defer rows.Close()
	// Non-nil, so a caller building a query from it gets an empty ANY() rather
	// than a nil that reads as "no filter".
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, translate(err, "friend ids scan")
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, translate(err, "friend ids rows")
	}
	return ids, nil
}
