package activity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

func (r *PostgresRepository) Create(ctx context.Context, in NewActivity) (*Activity, error) {
	row := r.pool.QueryRow(ctx, `
		INSERT INTO activities (id, user_id, kind, occurred_at, notes, details, request_id, trace_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (id) DO NOTHING
		RETURNING id, user_id, kind, occurred_at, notes, details, request_id, trace_id, created_at
	`, in.ID, in.UserID, in.Kind, in.OccurredAt, in.Notes, nullableJSON(in.Details), in.RequestID, in.TraceID)

	a, err := scanActivity(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// id already existed (ON CONFLICT DO NOTHING) — normally an
			// idempotent sync retry, so return the original row.
			//
			// Scoped to the caller: IDs are client-generated, so without the
			// user_id predicate this path would hand any authenticated caller
			// another user's activity simply by guessing/replaying its ID
			// (an IDOR), and would also silently swallow a colliding activity
			// from a second user while telling their client it synced fine.
			// A hit on someone else's ID is reported as a conflict instead.
			return r.getOwnedByID(ctx, in.ID, in.UserID)
		}
		return nil, err
	}
	return a, nil
}

func (r *PostgresRepository) getOwnedByID(ctx context.Context, id, userID string) (*Activity, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, user_id, kind, occurred_at, notes, details, request_id, trace_id, created_at
		FROM activities WHERE id = $1 AND user_id = $2`, id, userID)
	a, err := scanActivity(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The ID exists but belongs to someone else.
			return nil, ErrAlreadyExists
		}
		return nil, err
	}
	return a, nil
}

func (r *PostgresRepository) ListByUser(ctx context.Context, userID string) ([]Activity, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, user_id, kind, occurred_at, notes, details, request_id, trace_id, created_at
		FROM activities WHERE user_id = $1 ORDER BY occurred_at DESC, id DESC
		LIMIT $2`, userID, maxUserActivities)
	if err != nil {
		return nil, fmt.Errorf("activity: list: %w", err)
	}
	defer rows.Close()

	activities := []Activity{}
	for rows.Next() {
		a, err := scanActivity(rows)
		if err != nil {
			return nil, err
		}
		activities = append(activities, *a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("activity: rows: %w", err)
	}
	return activities, nil
}

// maxUserActivities bounds the per-user activity list — the last unbounded
// query in this module, and the only one both a user and an admin can reach.
//
// It was survivable while the response streamed straight out. It stopped being
// survivable when apihttp.ConditionalGet started buffering the whole identity
// body in order to hash it: an unbounded row count became an unbounded
// server-side allocation, one per in-flight request. Peak memory is now
// bounded by the largest response the API can produce, so no endpoint gets to
// be unbounded any more.
//
// Nothing writes this table today — the in-app logging form was removed, and
// mobile's `lib/activities.ts` outbox is intact plumbing with no caller. The
// bound is not waiting on that to change: the rows that exist are real, the
// endpoint is reachable by both a user and an admin, and an append-only audit
// log is the one shape guaranteed to grow monotonically the moment it is
// re-armed. A ceiling is cheaper to add now than to discover later.
//
// `activities` is an append-only audit log read newest-first; nothing in
// either client paginates it, so this is a ceiling rather than a page size.
//
// The `id` tiebreak is not decorative — it is the rule this module already
// documents on ListUsers, and adding a LIMIT is exactly what makes it bite.
// `occurred_at` is CLIENT-supplied (mobile writes it from local SQLite), so
// ties at the boundary are realistic, and without a unique second key
// Postgres gives no stable order for them: which row the cap includes can
// change between two identical requests. That is a correctness bug on its own,
// and it is also an ETag bug — a reordered array hashes differently, so the
// endpoint becomes a permanent cache miss on unchanged data, defeating the
// feature on the very endpoint this ceiling was added to protect.
const maxUserActivities = 500

// maxAdminUsers bounds the lookup list.
//
// The previous query had no LIMIT at all, scanned `activities` twice, and
// shipped every row to the browser so the table could filter client-side. At
// this size none of that mattered; it is the query that breaks first, and it
// was breaking on a dead table.
const maxAdminUsers = 500

// maxDetailSessions bounds the per-user session list.
//
// An admin page answering "what has this person been doing" needs the recent
// shape of it, not an unbounded history — a two-year daily lifter would
// otherwise ship ~700 rows to render a screen nobody scrolls.
const maxDetailSessions = 50

// userSummaryCols is the summary projection, shared by the list and the
// single-user read so the two can't drift into reporting different numbers
// for the same account. Keyed on `u.user_id` — the id source, which is NOT
// `profiles` (see userIDs).
const userSummaryCols = `
	u.user_id,
	p.display_name,
	p.created_at,
	(SELECT count(*) FROM sessions s WHERE s.user_id = u.user_id),
	(SELECT max(s.started_at) FROM sessions s WHERE s.user_id = u.user_id),
	(SELECT count(*) FROM session_sets ss WHERE ss.user_id = u.user_id),
	COALESCE(
		(SELECT array_agg(m.module_key || ':' || m.enabled ORDER BY m.module_key)
		   FROM profile_modules m WHERE m.user_id = u.user_id),
		'{}')`

// userIDs enumerates every user the system knows about, from every table that
// records one — then LEFT JOINs profiles for the name.
//
// It does NOT start FROM profiles, and that is load-bearing: someone who
// signed up and trained but never finished onboarding has no profile row, and
// they are precisely the account an admin gets asked about. There is no FK
// from sessions to profiles, so this is a real state, not a hypothetical.
// TestPostgresRepository_ListUsers_IncludesProfilelessUsers pins it.
//
// `activities` stays in the union even though nothing writes it any more:
// dropping it would silently disappear whatever rows predate the form being
// removed. Cheap — it is a UNION of three indexed id columns.
const userIDs = `
	SELECT user_id FROM profiles
	UNION SELECT user_id FROM sessions
	UNION SELECT user_id FROM activities`

// ListUsers returns every user the system knows about, newest-active first.
//
// ONE query, no N+1, and it aggregates in subqueries rather than joining
// sessions and sets into the same GROUP BY — a join across both would
// multiply rows (sessions × sets) before collapsing them, which is how a
// "count" quietly becomes a product.
//
// Deliberately reads `sessions`/`session_sets` rather than `activities`: see
// UserSummary for why. `profile_modules` is joined but NOT interpreted here —
// absence means "registry default", which is knowledge this layer doesn't
// have. The raw enabled/disabled rows come back and the caller resolves them.
func (r *PostgresRepository) ListUsers(ctx context.Context) ([]UserSummary, error) {
	rows, err := r.pool.Query(ctx, `
		WITH ids AS (`+userIDs+`)
		SELECT`+userSummaryCols+`
		FROM ids u LEFT JOIN profiles p ON p.user_id = u.user_id
		-- user_id last, and not decoratively: without a unique tiebreak two
		-- profileless users with no sessions tie on (NULL, NULL), so once the
		-- cap binds it is nondeterministic WHICH of them the admin never sees.
		-- api-conventions.md says the same thing: never the timestamp alone.
		ORDER BY (SELECT max(s.started_at) FROM sessions s WHERE s.user_id = u.user_id)
			DESC NULLS LAST, p.created_at DESC NULLS LAST, u.user_id
		LIMIT $1`, maxAdminUsers)
	if err != nil {
		return nil, fmt.Errorf("activity: list users: %w", err)
	}
	defer rows.Close()

	users := []UserSummary{}
	for rows.Next() {
		var u UserSummary
		var stored []string
		if err := rows.Scan(&u.UserID, &u.DisplayName, &u.CreatedAt,
			&u.SessionCount, &u.LastSessionAt, &u.SetCount, &stored); err != nil {
			return nil, fmt.Errorf("activity: scan user: %w", err)
		}
		u.Modules = resolveEnabled(stored)
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("activity: rows: %w", err)
	}
	return users, nil
}

// GetUser is the per-athlete admin read: summary + recent sessions.
//
// TWO queries in ONE round trip via pgx.Batch, not two Query calls. Both are
// scoped to a single user id — this deliberately does not fetch every user
// and filter in the console, which is the shape the web Records page was
// caught doing (whole catalog down the wire to filter client-side).
//
// The session list carries its set count as a correlated subquery for the
// same reason ListUsers does: joining session_sets in would multiply rows
// before collapsing them.
func (r *PostgresRepository) GetUser(ctx context.Context, userID string) (*UserDetail, error) {
	batch := &pgx.Batch{}
	// Three indexed EXISTS probes rather than materialising the whole `ids`
	// union to find one row. No rows means the id is unknown EVERYWHERE, which
	// is what makes the 404 truthful — a user with sessions but no profile
	// must still resolve.
	batch.Queue(`SELECT`+userSummaryCols+`
		FROM (SELECT $1::text AS user_id) u
		LEFT JOIN profiles p ON p.user_id = u.user_id
		WHERE EXISTS (SELECT 1 FROM profiles   x WHERE x.user_id = $1)
		   OR EXISTS (SELECT 1 FROM sessions   x WHERE x.user_id = $1)
		   OR EXISTS (SELECT 1 FROM activities x WHERE x.user_id = $1)`, userID)
	batch.Queue(`
		SELECT s.id, s.sport, s.name, s.started_at, s.ended_at,
		       (SELECT count(*) FROM session_sets ss WHERE ss.session_id = s.id)
		FROM sessions s
		WHERE s.user_id = $1
		ORDER BY s.started_at DESC, s.id
		LIMIT $2`, userID, maxDetailSessions)

	br := r.pool.SendBatch(ctx, batch)
	defer br.Close()

	var d UserDetail
	var stored []string
	if err := br.QueryRow().Scan(&d.User.UserID, &d.User.DisplayName, &d.User.CreatedAt,
		&d.User.SessionCount, &d.User.LastSessionAt, &d.User.SetCount, &stored); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("activity: get user: %w", err)
	}
	d.User.Modules = resolveEnabled(stored)

	rows, err := br.Query()
	if err != nil {
		return nil, fmt.Errorf("activity: get user sessions: %w", err)
	}
	defer rows.Close()

	d.RecentSessions = []SessionSummary{}
	for rows.Next() {
		var s SessionSummary
		if err := rows.Scan(&s.ID, &s.Sport, &s.Name, &s.StartedAt, &s.EndedAt, &s.SetCount); err != nil {
			return nil, fmt.Errorf("activity: scan session: %w", err)
		}
		d.RecentSessions = append(d.RecentSessions, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("activity: session rows: %w", err)
	}
	return &d, nil
}

// resolveEnabled turns stored "key:bool" pairs into the enabled discipline
// labels, filling absent modules from the registry.
//
// This MUST go through the registry rather than being read straight from SQL.
// A profile created after migration 000020 has no rows at all until the user
// touches a toggle, so `SELECT ... WHERE enabled` undercounts every new user
// and returns nothing for a discipline added later. Absence means "default",
// not "off" — a distinction only the registry knows.
func resolveEnabled(stored []string) []string {
	explicit := make(map[string]bool, len(stored))
	for _, kv := range stored {
		if i := strings.LastIndex(kv, ":"); i > 0 {
			explicit[kv[:i]] = kv[i+1:] == "true"
		}
	}
	out := []string{}
	for _, m := range discipline.All() {
		on, ok := explicit[m.Key]
		if !ok {
			on = m.DefaultOn
		}
		if on {
			out = append(out, m.Label)
		}
	}
	return out
}

// scanner is satisfied by both pgx.Row (QueryRow) and pgx.Rows (Query, one
// row at a time via Next/Scan) — lets Create/getByID/ListByUser share one
// scan function instead of two near-identical copies.
type scanner interface {
	Scan(dest ...any) error
}

func scanActivity(row scanner) (*Activity, error) {
	var a Activity
	var details []byte
	err := row.Scan(&a.ID, &a.UserID, &a.Kind, &a.OccurredAt, &a.Notes, &details, &a.RequestID, &a.TraceID, &a.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		return nil, fmt.Errorf("activity: scan: %w", err)
	}
	if details != nil {
		a.Details = json.RawMessage(details)
	}
	return &a, nil
}

// nullableJSON avoids inserting the JSON literal "null" for a nil/empty
// Details — a real SQL NULL instead, so the column stays genuinely absent.
func nullableJSON(details json.RawMessage) any {
	if len(details) == 0 {
		return nil
	}
	return details
}
