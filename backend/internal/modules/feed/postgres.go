package feed

import (
	"context"
	"fmt"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/modules/session"
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
//
//   - `p.share_training_with_friends` — the owner opted in. Joined and read
//     LIVE, so switching it off retracts every past session at once rather than
//     leaving already-published rows behind.
//
//   - `s.ended_at IS NOT NULL` — finished. An in-progress session is a live
//     location, which is a different disclosure entirely.
//
//   - `p.username IS NOT NULL` — the owner has a handle. A card with no name on
//     it is not a card, and the Go scan below skips such a row anyway. Doing it
//     HERE is what keeps the list and the count agreeing: skipping in Go alone
//     consumed a LIMIT slot and still counted the row, which is the same
//     list-versus-count divergence this file has now been bitten by twice.
//
//   - `s.ended_at >= now() - INTERVAL` — recent. The feed is what your friends
//     are doing, not an archive of what they have ever done; a week-old session
//     is history, and history is the owner's own screen. See FeedWindow.
//     Bound as `$2`, with the page's LIMIT/OFFSET at `$3`/`$4`, so the count
//     can run this same clause without binding parameters it never mentions.
//
//     An INSTANT, computed once per call and passed to both queries — not
//     `now() - interval` evaluated inside each. The page and the count are two
//     separate implicit transactions, so their `now()`s differ by the latency
//     between them, and a session ending inside that sliver would be in the
//     list and absent from the total. Milliseconds wide, and exactly the
//     divergence this clause exists to make impossible; one bound instant
//     removes it by construction rather than by being small.
//
//     It also keeps the arithmetic honest. `timestamptz - INTERVAL '3 days'`
//     is CALENDAR arithmetic in the session's zone — 71 or 73 real hours over
//     a DST edge — where subtracting a duration in Go is not. The literal is
//     the tempting simplification and it is the one that reintroduces a
//     timezone.
//
// Written as a const and used by BOTH the page query and the count, because a
// count that disagrees with its list is how a total ends up promising rows the
// list will not return. The window is inside it for exactly that reason: as a
// LIMIT-side filter it would have left the total counting rows the list had
// already dropped, and "+12 more" that loads nothing is worse than no total.
const visibleFrom = `
	FROM sessions s
	JOIN profiles p ON p.user_id = s.user_id
	WHERE s.user_id = ANY($1)
	  AND p.share_training_with_friends
	  AND s.ended_at IS NOT NULL
	  AND s.ended_at >= $2
	  AND p.username IS NOT NULL`

// FeedWindow is how far back the feed reaches.
//
// A ROLLING duration, not a number of calendar days, and that is a deliberate
// dodge rather than laziness. Calendar days need the reader's timezone, and
// this repository has already shipped one date bug that failed for seven hours
// a day west of Greenwich because a `::date` cast resolved through the server's
// zone. `ended_at` is timestamptz and `now()` is absolute, so this comparison
// has no zone in it at all and cannot acquire one.
//
// Three days rather than seven: the feed answers "what are my friends doing",
// and a session from last Tuesday does not answer it. It is also the whole of
// the retention story — NOTHING is deleted. The owner's history, calendar and
// session list are untouched and complete; this is a window on one surface.
const FeedWindow = 3 * 24 * time.Hour

// FeedWindowDays reports FeedWindow the way copy wants it — a count of days,
// not a duration — for `Page.WindowDays` (N13, #379).
//
// This is the ONE conversion, and everything that used to say "3 days" in its
// own words (two mobile strings, one line of OpenAPI prose) now reads this
// number off the response instead. Assumes FeedWindow is a whole multiple of
// 24h, which TestFeedWindowIsAWholeNumberOfDays pins — a window that were not
// would silently floor here (`72h` and, say, `80h` both round-trip through
// integer division without complaint), which is a worse failure than the
// stale prose this replaces, because there would be nothing left to grep for.
func FeedWindowDays() int {
	return int(FeedWindow / (24 * time.Hour))
}

// pageQuery is a const rather than an inline string so a test can EXPLAIN the
// SQL the repository actually runs.
//
// `sessions_user_ended_idx` only pays off while the window stays a boundary
// seek on that index. Nothing in the query says so, and the failure is silent:
// reorder a predicate, wrap `ended_at` in a cast or a `date_trunc`, add an OR,
// and Postgres quietly demotes it to a Filter over every friend's lifetime of
// training — the exact plan this index was added to remove. Only the plan can
// tell you, so the test reads the plan, and it can only read the real one if
// there is one string. Inline, the test would have had to restate the SQL, and
// a restated query proves the copy is fast.
const pageQuery = `
		SELECT s.id, p.username, p.display_name, s.sport, s.name, s.started_at, s.ended_at,
		       p.share_training_details,` +
	workingVolume + visibleFrom + `
		ORDER BY s.ended_at DESC, s.id
		LIMIT $3 OFFSET $4`

// workingVolume mirrors session.Summarise's rule in SQL.
//
// **A DUPLICATION, and a knowing one.** `Summarise` is deliberately in the
// domain "so both platforms report identical numbers", and this is a third
// implementation of it. The alternative is loading every set of every friend's
// session to sum two fields in Go — an N+1 over other people's training on the
// one endpoint most likely to be polled.
//
// The rule is IMPORTED now rather than restated: `session.SQLCountsAsSet`,
// `session.SQLWorkingSet` and `session.SQLTonnage`
// are the same strings the session module's own queries run, so a friend's row
// cannot drift from what the session's owner sees.
//
// It had drifted. This file kept counting drops after #238 taught the session
// module not to, and the test that pins it against `session.Summarise` could
// not see the difference because its fixture had no drop in it. Restating a
// rule and testing the restatement over data that cannot distinguish them is
// the shape of that whole class of bug.
//
// The count and the tonnage take DIFFERENT predicates, and that asymmetry is
// the point: a drop is part of the set above it so it adds no set, but its
// weight was moved so it still adds tonnage. Collapsing them back into one
// predicate — the obvious tidy-up — deletes a drop's work everywhere.
//
// `SQLTonnage` requires `exercises` LEFT JOINed as `e`, which the subquery
// below does. Left, not inner: a set whose exercise was retired keeps counting
// at face value rather than falling out of the sum.
//
// The test against `session.Summarise` stays. Sharing the string removes the
// drift; it does not remove the need to check that the SQL and the Go agree
// about what the string means.
const workingVolume = `
	COALESCE((
		SELECT count(*) FROM session_sets ss
		WHERE ss.session_id = s.id AND ` + session.SQLCountsAsSet + `
	), 0) AS working_sets,
	COALESCE((
		SELECT sum(` + session.SQLTonnage + `)
		FROM session_sets ss
		LEFT JOIN exercises e ON e.id = ss.exercise_id
		WHERE ss.session_id = s.id AND ` + session.SQLWorkingSet + `
		  AND ss.reps IS NOT NULL AND ss.weight_kg IS NOT NULL
	), 0) AS tonnage_kg`

func (r *PostgresRepository) List(ctx context.Context, userID string, limit, offset int) (Page, error) {
	// WindowDays set here, on the ONE Page value every return path below
	// shares — including the no-friends and no-longer-friends early returns —
	// so a client can never observe a Page missing it.
	page := Page{Items: []Item{}, Limit: limit, Offset: offset, WindowDays: FeedWindowDays()}

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

	// ONE instant for both queries below. See visibleFrom's note on `$2`.
	since := time.Now().UTC().Add(-FeedWindow)

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
	rows, err := r.pool.Query(ctx, pageQuery, ids, since, limit, offset)
	if err != nil {
		return page, fmt.Errorf("feed: list: %w", err)
	}
	defer rows.Close()
	// The ids whose owner opted into detail, split by sport because the two
	// live in different tables. Collected here rather than re-derived later:
	// THIS LIST IS THE AUTHORIZATION for the detail queries below, which do not
	// re-check ownership themselves, so nothing may be added to it that did not
	// come out of `visibleFrom` on this exact row.
	var liftIDs, matIDs []string
	for rows.Next() {
		var it Item
		it.Detail = []Detail{}
		// `username` is NOT NULL in practice for anyone who can be a friend —
		// the social graph is keyed on handles — but the column is nullable, so
		// it is scanned through a pointer rather than assumed.
		var handle *string
		var wantsDetail bool
		if err := rows.Scan(&it.ID, &handle, &it.DisplayName, &it.Sport, &it.Name,
			&it.StartedAt, &it.EndedAt, &wantsDetail, &it.WorkingSets, &it.TonnageKg); err != nil {
			return page, fmt.Errorf("feed: scan: %w", err)
		}
		if handle == nil {
			// Unreachable: `visibleFrom` excludes them, and befriending needs
			// both handles anyway. Belt and braces — a nil here would panic on
			// the deref below.
			continue
		}
		it.From = *handle
		if wantsDetail {
			if it.Sport == "bjj" {
				matIDs = append(matIDs, it.ID)
			} else {
				liftIDs = append(liftIDs, it.ID)
			}
		}
		page.Items = append(page.Items, it)
	}
	if err := rows.Err(); err != nil {
		return page, fmt.Errorf("feed: rows: %w", err)
	}

	if err := r.attachDetail(ctx, page.Items, liftIDs, matIDs); err != nil {
		return page, err
	}

	// The total, for the same reason `session.List` reports one: a client
	// needs to know whether asking for more is worth a round trip. Skipped
	// when a first page did not fill, since then the answer is already known —
	// the same shortcut, and the same saving on the overwhelmingly common case.
	if offset == 0 && len(page.Items) < limit {
		page.Total = len(page.Items)
		return page, nil
	}
	// Same clause, and the SAME `since` the page used — see visibleFrom.
	//
	// The window is `$2` and the page's LIMIT/OFFSET are `$3`/`$4` for this
	// reason: the shared clause has to be numbered so that BOTH queries bind
	// only the parameters they actually mention. Postgres infers a parameter's
	// type from where it appears, so a placeholder that is passed but never
	// referenced is an error — `could not determine data type of parameter $2`
	// — and not a harmless extra.
	if err := r.pool.QueryRow(ctx, `SELECT count(*)`+visibleFrom,
		ids, since).Scan(&page.Total); err != nil {
		return page, fmt.Errorf("feed: count: %w", err)
	}
	return page, nil
}

// attachDetail fills in the "what was done" band for the rows whose owner
// opted in.
//
// **TWO QUERIES FOR A WHOLE PAGE, NOT TWO PER ROW.** The obvious shape — ask
// per session as the card endpoint does — is an N+1 over other people's
// training on the one endpoint most likely to be polled, and it would get
// worse precisely as somebody's social graph grew. These fan out over the id
// set instead, so a page of 100 costs the same two round trips as a page of 1.
//
// # Why no ownership clause in either query
//
// Neither joins `sessions` to re-check who may read the row, and that is not
// an oversight — it is why `liftIDs`/`matIDs` are built where they are. Those
// ids came out of the page query, which applied all of `visibleFrom` (accepted
// friend, master switch on, finished, has a handle) plus the detail switch, to
// that exact row. Re-deriving the ids anywhere else, or letting a caller pass
// their own, moves the access decision out of the one place this package
// promises to keep it. Don't.
func (r *PostgresRepository) attachDetail(
	ctx context.Context, items []Item, liftIDs, matIDs []string,
) error {
	if len(liftIDs) == 0 && len(matIDs) == 0 {
		return nil
	}
	byID := make(map[string]*Item, len(items))
	for i := range items {
		byID[items[i].ID] = &items[i]
	}
	// Two calls rather than two `defer rows.Close()` in one body: a deferred
	// close fires at FUNCTION exit, not at the end of the block it was written
	// in, so a single function would hold both pool connections for the length
	// of the second query having finished with the first.
	if err := r.exerciseDetail(ctx, byID, liftIDs); err != nil {
		return err
	}
	return r.techniqueDetail(ctx, byID, matIDs)
}

// exerciseDetail mirrors sessioncard's exercise query, one session wider.
//
// The top set is MAX(weight) with the reps recorded AT that weight — not
// MAX(reps), which would pair a heavy single's load with a light set's reps and
// report a lift nobody performed.
func (r *PostgresRepository) exerciseDetail(
	ctx context.Context, byID map[string]*Item, ids []string,
) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.pool.Query(ctx, `
		SELECT ss.session_id, e.name,
		       MAX(ss.weight_kg),
		       (ARRAY_AGG(ss.reps ORDER BY ss.weight_kg DESC NULLS LAST, ss.reps DESC))[1]
		FROM session_sets ss
		JOIN exercises e ON e.id = ss.exercise_id
		WHERE ss.session_id = ANY($1) AND `+session.SQLWorkingSet+`
		GROUP BY ss.session_id, e.id, e.name
		ORDER BY ss.session_id, MIN(ss.position)`, ids)
	if err != nil {
		return fmt.Errorf("feed: detail exercises: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var sessionID, name string
		var weight *float64
		var reps *int
		if err := rows.Scan(&sessionID, &name, &weight, &reps); err != nil {
			return fmt.Errorf("feed: detail exercises scan: %w", err)
		}
		d := Detail{Name: name}
		switch {
		case weight != nil && *weight > 0 && reps != nil:
			d.Figure = fmt.Sprintf("%g kg × %d", *weight, *reps)
		case reps != nil:
			// Bodyweight work has no load, and "0 kg × 12" reads as a bug.
			d.Figure = fmt.Sprintf("× %d", *reps)
		}
		appendDetail(byID[sessionID], d)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("feed: detail exercises rows: %w", err)
	}
	return nil
}

// techniqueDetail is the BJJ half.
//
// Ordered by what the outcome MEANS rather than alphabetically, same as the
// card: what you scored with is the line worth reading, what you drilled is
// context.
//
// **`conceded` IS EXCLUDED, and only here.** Your own card shows what was done
// TO you because that is the half of a roll worth reviewing; a friend's feed is
// not the place to publish it, and this is the one screen where the athlete is
// not the reader. The card endpoint keeps it.
func (r *PostgresRepository) techniqueDetail(
	ctx context.Context, byID map[string]*Item, ids []string,
) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.pool.Query(ctx, `
		SELECT g.session_id, t.name, g.event, SUM(g.count)::int
		FROM bjj_session_tags g
		JOIN techniques t ON t.id = g.technique_id
		WHERE g.session_id = ANY($1) AND g.technique_id IS NOT NULL
		  AND g.event <> 'conceded'
		GROUP BY g.session_id, t.id, t.name, g.event
		ORDER BY g.session_id,
		         CASE g.event WHEN 'scored' THEN 0 WHEN 'attempted' THEN 1 ELSE 2 END,
		         SUM(g.count) DESC, t.name`, ids)
	if err != nil {
		return fmt.Errorf("feed: detail techniques: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var sessionID, name, event string
		var count int
		if err := rows.Scan(&sessionID, &name, &event, &count); err != nil {
			return fmt.Errorf("feed: detail techniques scan: %w", err)
		}
		d := Detail{Name: name, Outcome: event}
		if count > 1 {
			d.Count = count
		}
		appendDetail(byID[sessionID], d)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("feed: detail techniques rows: %w", err)
	}
	return nil
}

// appendDetail adds a line up to MaxDetail and counts the rest.
//
// The cap is applied HERE rather than as a per-session LIMIT in SQL, because a
// windowed LIMIT would also throw away the count — and "+4 more" is the thing
// that stops a five-line card implying a five-exercise session.
func appendDetail(it *Item, d Detail) {
	if it == nil {
		// A session id the page query did not return. Unreachable: the id sets
		// are built from those very rows.
		return
	}
	if len(it.Detail) >= MaxDetail {
		it.More++
		return
	}
	it.Detail = append(it.Detail, d)
}
