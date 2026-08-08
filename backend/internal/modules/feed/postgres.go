package feed

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool    *pgxpool.Pool
	friends Friends
}

func NewPostgresRepository(pool *pgxpool.Pool, friends Friends) *PostgresRepository {
	return &PostgresRepository{pool: pool, friends: friends}
}

// visibleFrom is the whole of the access rule, written once.
//
// Three conditions, and every one of them is load-bearing:
//
//   - `s.user_id = ANY($1)` — an ACCEPTED friend. The id set comes from the
//     friend module, which is the only thing that knows what accepted means.
//   - `p.share_training_with_friends` — the owner opted in. Joined and read
//     LIVE, so switching it off retracts every past session at once rather than
//     leaving already-published rows behind.
//   - `s.ended_at IS NOT NULL` — finished. An in-progress session is a live
//     location, which is a different disclosure entirely.
//   - `p.username IS NOT NULL` — the owner has a handle. A card with no name on
//     it is not a card, and the Go scan below skips such a row anyway. Doing it
//     HERE is what keeps the list and the count agreeing: skipping in Go alone
//     consumed a LIMIT slot and still counted the row, which is the same
//     list-versus-count divergence this file has now been bitten by twice.
//
// Written as a const and used by BOTH the page query and the count, because a
// count that disagrees with its list is how a total ends up promising rows the
// list will not return.
const visibleFrom = `
	FROM sessions s
	JOIN profiles p ON p.user_id = s.user_id
	WHERE s.user_id = ANY($1)
	  AND p.share_training_with_friends
	  AND s.ended_at IS NOT NULL
	  AND p.username IS NOT NULL`

// workingVolume mirrors session.Summarise's rule in SQL.
//
// **A DUPLICATION, and a knowing one.** `Summarise` is deliberately in the
// domain "so both platforms report identical numbers", and this is a third
// implementation of it. The alternative is loading every set of every friend's
// session to sum two fields in Go — an N+1 over other people's training on the
// one endpoint most likely to be polled.
//
// The rule it has to match: uncompleted sets contribute nothing, warm-ups
// contribute nothing, and tonnage needs both reps and weight. A test asserts
// this against `session.Summarise` over the same fixture rather than trusting
// the comment.
const workingVolume = `
	COALESCE((
		SELECT count(*) FROM session_sets ss
		WHERE ss.session_id = s.id AND ss.completed AND ss.set_type <> 'warmup'
	), 0) AS working_sets,
	COALESCE((
		SELECT sum(ss.reps * ss.weight_kg) FROM session_sets ss
		WHERE ss.session_id = s.id AND ss.completed AND ss.set_type <> 'warmup'
		  AND ss.reps IS NOT NULL AND ss.weight_kg IS NOT NULL
	), 0) AS tonnage_kg`

func (r *PostgresRepository) List(ctx context.Context, userID string, limit, offset int) (Page, error) {
	page := Page{Items: []Item{}, Limit: limit, Offset: offset}

	ids, err := r.friends.FriendIDs(ctx, userID)
	if err != nil {
		return page, fmt.Errorf("feed: friend ids: %w", err)
	}
	// No friends, no feed — and no query. Postgres would happily run
	// `= ANY('{}')` and return nothing, but skipping it means an athlete with
	// no social graph costs this endpoint two round trips less than nothing.
	if len(ids) == 0 {
		return page, nil
	}
	if len(ids) > maxFriends {
		ids = ids[:maxFriends]
	}
	// The caller's own sessions are never in their feed. This cannot happen
	// through `FriendIDs` — the friendships table has no self-pair, and a CHECK
	// forbids `user_a = user_b` — but the exclusion is the sort of thing that
	// should not depend on a constraint two modules away.
	filtered := ids[:0]
	for _, id := range ids {
		if id != userID {
			filtered = append(filtered, id)
		}
	}
	ids = filtered
	if len(ids) == 0 {
		return page, nil
	}

	// ORDER BY ended_at DESC, id — a TOTAL order, per the paging convention.
	// `ended_at` alone can tie (two friends finishing in the same microsecond
	// is unlikely; a client supplying its own `ended_at` on a sync retry is
	// not), and a tie reorders between pages, which drops or duplicates rows
	// across an offset boundary.
	//
	// Ordered by when the session ENDED rather than when it started, because
	// that is when it became visible: a session started on Monday and finished
	// on Tuesday arrives in the feed on Tuesday, and a feed whose rows appear
	// below ones you have already scrolled past is a feed that hides things.
	rows, err := r.pool.Query(ctx, `
		SELECT s.id, p.username, p.display_name, s.sport, s.name, s.started_at, s.ended_at,`+
		workingVolume+visibleFrom+`
		ORDER BY s.ended_at DESC, s.id
		LIMIT $2 OFFSET $3`, ids, limit, offset)
	if err != nil {
		return page, fmt.Errorf("feed: list: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var it Item
		// `username` is NOT NULL in practice for anyone who can be a friend —
		// the social graph is keyed on handles — but the column is nullable, so
		// it is scanned through a pointer rather than assumed.
		var handle *string
		if err := rows.Scan(&it.ID, &handle, &it.DisplayName, &it.Sport, &it.Name,
			&it.StartedAt, &it.EndedAt, &it.WorkingSets, &it.TonnageKg); err != nil {
			return page, fmt.Errorf("feed: scan: %w", err)
		}
		if handle == nil {
			// Unreachable: `visibleFrom` excludes them, and befriending needs
			// both handles anyway. Belt and braces — a nil here would panic on
			// the deref below.
			continue
		}
		it.From = *handle
		page.Items = append(page.Items, it)
	}
	if err := rows.Err(); err != nil {
		return page, fmt.Errorf("feed: rows: %w", err)
	}

	// The total, for the same reason `session.List` reports one: a client
	// needs to know whether asking for more is worth a round trip. Skipped
	// when a first page did not fill, since then the answer is already known —
	// the same shortcut, and the same saving on the overwhelmingly common case.
	if offset == 0 && len(page.Items) < limit {
		page.Total = len(page.Items)
		return page, nil
	}
	if err := r.pool.QueryRow(ctx, `SELECT count(*)`+visibleFrom, ids).Scan(&page.Total); err != nil {
		return page, fmt.Errorf("feed: count: %w", err)
	}
	return page, nil
}
