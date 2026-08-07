package share

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool    *pgxpool.Pool
	reg     Registry
	friends Friends
}

func NewPostgresRepository(pool *pgxpool.Pool, reg Registry, friends Friends) *PostgresRepository {
	return &PostgresRepository{pool: pool, reg: reg, friends: friends}
}

func (r *PostgresRepository) Create(ctx context.Context, callerID string, in New) error {
	copier, known := r.reg[in.ResourceType]
	if !known {
		return ErrInvalidInput
	}

	// Friendship FIRST, and its failure is ErrNotFound. Not-a-friend and
	// no-such-handle are one answer, so this endpoint cannot be used to
	// enumerate accounts or to discover who is friends with whom.
	toID, ok, err := r.friends.FriendID(ctx, callerID, in.ToUsername)
	if err != nil {
		return fmt.Errorf("share: friend lookup: %w", err)
	}
	if !ok {
		return ErrNotFound
	}

	// Then the resource, whose miss is the SAME error — so a caller cannot
	// distinguish "that id is not real" from "that id is not mine to send".
	label, ok, err := copier.Describe(ctx, in.ResourceID, callerID)
	if err != nil {
		return fmt.Errorf("share: describe %s: %w", in.ResourceType, err)
	}
	if !ok {
		return ErrNotFound
	}
	// RUNES, not bytes. Slicing bytes can split a multi-byte character, and
	// Postgres rejects invalid UTF-8 with 22021 — untranslated, so a 500.
	// Unreachable today (sequence names cap below this) and reachable the
	// moment a Copier with longer labels registers; Japanese BJJ terminology
	// makes multi-byte labels ordinary rather than exotic.
	if r := []rune(label); len(r) > maxLabel {
		label = string(r[:maxLabel])
	}

	// The partial unique index is the sole arbiter of "already sent" — no
	// read-then-write window, same argument as friendships' primary key.
	_, err = r.pool.Exec(ctx, `
		INSERT INTO shares (resource_type, resource_id, resource_label, from_user_id, to_user_id)
		VALUES ($1, $2, $3, $4, $5)`,
		in.ResourceType, in.ResourceID, label, callerID, toID)
	return translate(err, "create")
}

// pendingCards is the one query both directions run. Composed rather than
// written twice: the two differ only in which end of the row is the caller and
// which is the counterpart, and this repo's own sequence module carries a
// comment about what happens when the same rule is expressed twice and only
// one copy gets updated.
//
// The counterpart's handle is joined LIVE, so a rename propagates to every
// list it appears in. The label beside it is the deliberate exception — it is
// a record of what was said, not a view of a live thing.
const pendingCards = `
	SELECT s.id, s.resource_type, s.resource_label, p.username, s.created_at
	FROM shares s
	JOIN profiles p ON p.user_id = s.%s
	WHERE s.%s = $1 AND s.status = 'pending'
	ORDER BY s.created_at DESC, s.id
	LIMIT $2`

// cardRow is what both directions scan into before being named. It exists so
// the scan is written once; the wire shapes stay distinct.
type cardRow struct {
	id, resourceType, resourceLabel, handle string
	createdAt                               time.Time
}

func (r *PostgresRepository) pending(ctx context.Context, callerID, counterpart, caller, op string) ([]cardRow, error) {
	rows, err := r.pool.Query(ctx, fmt.Sprintf(pendingCards, counterpart, caller), callerID, maxList)
	if err != nil {
		return nil, translate(err, op)
	}
	defer rows.Close()
	out := []cardRow{}
	for rows.Next() {
		var c cardRow
		if err := rows.Scan(&c.id, &c.resourceType, &c.resourceLabel, &c.handle, &c.createdAt); err != nil {
			return nil, translate(err, op+" scan")
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (r *PostgresRepository) Inbox(ctx context.Context, callerID string) ([]Card, error) {
	rows, err := r.pending(ctx, callerID, "from_user_id", "to_user_id", "inbox")
	if err != nil {
		return nil, err
	}
	out := []Card{}
	for _, c := range rows {
		out = append(out, Card{
			ID: c.id, ResourceType: c.resourceType, ResourceLabel: c.resourceLabel,
			From: c.handle, CreatedAt: c.createdAt,
		})
	}
	return out, nil
}

// Sent is the mirror: the caller is the sender, so the counterpart joined is
// the recipient. Pending only — see the Repository interface for why.
func (r *PostgresRepository) Sent(ctx context.Context, callerID string) ([]SentCard, error) {
	rows, err := r.pending(ctx, callerID, "to_user_id", "from_user_id", "sent")
	if err != nil {
		return nil, err
	}
	out := []SentCard{}
	for _, c := range rows {
		out = append(out, SentCard{
			ID: c.id, ResourceType: c.resourceType, ResourceLabel: c.resourceLabel,
			To: c.handle, CreatedAt: c.createdAt,
		})
	}
	return out, nil
}

func (r *PostgresRepository) Accept(ctx context.Context, callerID, shareID string) (Accepted, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Accepted{}, translate(err, "accept")
	}
	// The copy and the status flip are ONE unit. Rollback is a no-op after a
	// successful commit; before one, it is what stops a copy existing for a
	// share that still reads as pending.
	defer func() { _ = tx.Rollback(ctx) }()

	// FOR UPDATE, because two taps on a slow connection are two concurrent
	// accepts of the same row, and without the lock both would pass the
	// status test and both would copy. The predicates are the authorization:
	// addressed TO the caller and still pending, so a sender accepting their
	// own share and an outsider accepting somebody else's are the same
	// ErrNotFound as a share that never existed.
	var resourceType, resourceID, sharerID string
	err = tx.QueryRow(ctx, `
		SELECT resource_type, resource_id, from_user_id FROM shares
		WHERE id = $1 AND to_user_id = $2 AND status = 'pending'
		FOR UPDATE`, shareID, callerID).Scan(&resourceType, &resourceID, &sharerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Accepted{}, ErrNotFound
	}
	if err != nil {
		return Accepted{}, translate(err, "accept claim")
	}

	copier, ok := r.reg[resourceType]
	if !ok {
		// A type this build cannot copy: a module removed, or a deploy rolled
		// back under a share stored by a newer one. DELIBERATELY NOT CLEARED,
		// unlike the deleted-source branch below — that resource is gone for
		// good, whereas this one may be perfectly intact and merely
		// unreachable from this binary. Deleting here would be irreversible
		// damage done on account of a deploy.
		return Accepted{}, ErrGone
	}
	newID, ok, err := copier.CopyTo(ctx, tx, resourceID, sharerID, callerID)
	if err != nil {
		return Accepted{}, fmt.Errorf("share: copy %s: %w", resourceType, err)
	}
	if !ok {
		// Deleted between sending and accepting. There is no foreign key that
		// could have prevented this — resource_id is polymorphic — so it is
		// handled here instead, by clearing the dead share rather than
		// leaving it to fail identically forever.
		if _, err := tx.Exec(ctx, `DELETE FROM shares WHERE id = $1`, shareID); err != nil {
			return Accepted{}, translate(err, "accept clear")
		}
		if err := tx.Commit(ctx); err != nil {
			return Accepted{}, translate(err, "accept clear commit")
		}
		return Accepted{}, ErrGone
	}

	if _, err := tx.Exec(ctx, `
		UPDATE shares
		SET status = 'accepted', accepted_at = now(), copied_resource_id = $2
		WHERE id = $1`, shareID, newID); err != nil {
		return Accepted{}, translate(err, "accept mark")
	}
	if err := tx.Commit(ctx); err != nil {
		return Accepted{}, translate(err, "accept commit")
	}
	return Accepted{ResourceType: resourceType, ResourceID: newID}, nil
}

func (r *PostgresRepository) Delete(ctx context.Context, callerID, shareID string) error {
	// ASYMMETRIC ON PURPOSE, and the asymmetry is a privacy control rather
	// than a permission model.
	//
	// The RECIPIENT may remove a row in any status: declining a pending one,
	// or clearing an accepted one, which takes nothing away because the copy
	// is already theirs.
	//
	// The SENDER may only remove a PENDING one. Without that predicate this
	// endpoint is a perfect accept-vs-decline oracle, which is precisely what
	// the sent list's pending-only design exists to prevent — accepting
	// leaves the row, declining deletes it, so a status-blind DELETE answers
	// 204 for accepted and 404 for declined. Record the ids from your sent
	// list, wait for them to disappear from it, then delete each one: one
	// request per share, deterministic, no timing analysis.
	//
	// The asymmetry pre-dated the sent list and was unreachable — a sender had
	// no way to learn a share id, since POST returns 204 with no body, the
	// inbox is recipient-scoped, and the ids are random UUIDs. Handing the
	// sender their own ids is what armed it, so the fix ships with the feature
	// that would have armed it.
	tag, err := r.pool.Exec(ctx, `
		DELETE FROM shares
		WHERE id = $1
		  AND (to_user_id = $2 OR (from_user_id = $2 AND status = 'pending'))`,
		shareID, callerID)
	if err != nil {
		return translate(err, "delete")
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func translate(err error, op string) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation — the partial pending index
			return ErrAlreadyExists
		case "23514": // check_violation — self-share, or the accepted/copy invariant
			return ErrInvalidInput
		}
	}
	// Never let a raw SQL error escape: the handler turns this into a generic
	// 500 and logs the detail server-side.
	return fmt.Errorf("share: %s: %w", op, err)
}
