package accomplishment

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const dateLayout = "2006-01-02"

// sportKey scopes this to jiu-jitsu.
//
// `contests` is deliberately cross-sport — it has to hold a powerlifting meet
// and a 10k — so the competition half MUST filter, or a road race would award a
// BJJ podium. The mat half reads `bjj_session_tags`, which only exist on BJJ
// sessions by construction (PutDetail refuses to attach a reflection to another
// sport); the join filters on sport anyway, because "by construction" is a
// claim about today's writers and this is one predicate.
const sportKey = "bjj"

type PostgresRepository struct {
	pool *pgxpool.Pool
}

func NewPostgresRepository(pool *pgxpool.Pool) *PostgresRepository {
	return &PostgresRepository{pool: pool}
}

// listQuery derives every kind in ONE round trip.
//
// Seven `LIMIT 1` subqueries UNIONed rather than seven calls: each is a
// first-row lookup rather than seven sequential round trips, so the
// whole thing is cheap. **That claim was optimistic and review measured it**;
// three corrections, none needing action at today's sizes:
//
//   - The `won` CTE cannot use an index and seq-scans `contest_matches` across
//     EVERY user. `contest_matches_user_method_idx` is partial on `method <> ”`
//     and this must include wins whose method was never recorded, so the planner
//     can never use it. This is the one part whose cost scales with everybody's
//     data rather than the caller's; an index on (user_id, result) is the fix
//     when it matters.
//   - `contests_user_held_idx` is (user_id, held_on DESC NULLS LAST) and these
//     branches order ASC NULLS LAST, which no scan direction of it produces --
//     backwards gives ASC NULLS FIRST. So each competition branch is a top-N
//     sort over the caller's own contests.
//   - The `scored` CTE rides `bjj_session_tags_user_position_idx` on its
//     `user_id` prefix only. The graduation EXISTS does get the technique index.
//
// An unmeasured claim in a comment is worse than a measured limitation, and
// the alternative is still seven sequential round trips to draw one screen.
//
// Every branch returns the same nine columns in the same order, with explicit
// casts on the NULLs — a UNION infers column types from the FIRST branch, so an
// uncast NULL there would type the column as `text` and fail the branch that
// puts an integer in it.
//
// **`ORDER BY` inside a UNION branch has to be parenthesised.** Without the
// parentheses Postgres reads a trailing ORDER BY as applying to the whole
// union, and the LIMIT with it — which would silently return ONE row for the
// entire result rather than one per kind. It parses, it runs, and it is wrong.
const listQuery = `
WITH
-- Every BJJ contest this athlete recorded, oldest first. Named once because
-- five branches below differ only in their WHERE.
--
-- held_on ASC NULLS LAST decides which entry is "first", and an undated one
-- sorts last rather than first: a contest nobody dated cannot be shown to
-- PRECEDE a dated one, and treating a NULL as the beginning of time would
-- hand the first-competition award to whichever entry happened to lack a date.
-- created_at, id make the order total, so which row wins is stable across
-- requests rather than whatever the planner returned that time.
entries AS (
    SELECT c.id, c.name, c.held_on, c.placement, c.entrants, c.created_at
    FROM contests c
    WHERE c.user_id = $1 AND c.sport = $3
),
-- The contests in which at least one match was won, and those won by
-- submission. Computed once as sets rather than as two correlated EXISTS
-- inside the branches.
won AS (
    -- No DISTINCT: GROUP BY already makes contest_id unique, and review measured
    -- the redundant one adding a Sort + Unique node above the HashAggregate for
    -- nothing.
    SELECT m.contest_id, bool_or(m.method = 'submission') AS by_submission
    FROM contest_matches m
    WHERE m.user_id = $1 AND m.result = 'won'
    GROUP BY m.contest_id
),
-- Every scored tag, dated in the caller's zone.
--
-- The date is derived from the SESSION, not from the tag's own created_at:
-- a reflection typed up on Sunday about Thursday's class belongs to Thursday.
-- created_at would date the act of typing, which is not what happened.
scored AS (
    SELECT t.id, t.session_id, t.technique_id, s.started_at,
           (s.started_at AT TIME ZONE $2)::date AS on_day
    FROM bjj_session_tags t
    JOIN sessions s ON s.id = t.session_id AND s.user_id = t.user_id
    WHERE t.user_id = $1 AND t.event = 'scored' AND s.sport = $3
)
(SELECT 'first_competition'::text AS kind, e.held_on AS achieved_on,
        e.id AS contest_id, e.name AS contest_name, e.placement, e.entrants,
        NULL::text AS session_id, NULL::text AS technique_id, NULL::text AS technique_name
 FROM entries e
 ORDER BY e.held_on ASC NULLS LAST, e.created_at ASC, e.id LIMIT 1)
UNION ALL
(SELECT 'first_match_won', e.held_on, e.id, e.name, e.placement, e.entrants, NULL, NULL, NULL
 FROM entries e JOIN won w ON w.contest_id = e.id
 ORDER BY e.held_on ASC NULLS LAST, e.created_at ASC, e.id LIMIT 1)
UNION ALL
(SELECT 'first_submission_win', e.held_on, e.id, e.name, e.placement, e.entrants, NULL, NULL, NULL
 FROM entries e JOIN won w ON w.contest_id = e.id AND w.by_submission
 ORDER BY e.held_on ASC NULLS LAST, e.created_at ASC, e.id LIMIT 1)
UNION ALL
-- Third or better. placement <= 3 and NOT NULL: a null placement is "not
-- recorded", never "did not place", so it can neither earn this nor be read as
-- having missed it.
(SELECT 'first_podium', e.held_on, e.id, e.name, e.placement, e.entrants, NULL, NULL, NULL
 FROM entries e WHERE e.placement IS NOT NULL AND e.placement <= 3
 ORDER BY e.held_on ASC NULLS LAST, e.created_at ASC, e.id LIMIT 1)
UNION ALL
(SELECT 'first_gold', e.held_on, e.id, e.name, e.placement, e.entrants, NULL, NULL, NULL
 FROM entries e WHERE e.placement = 1
 ORDER BY e.held_on ASC NULLS LAST, e.created_at ASC, e.id LIMIT 1)
UNION ALL
-- The first thing ever landed live. A tag with no technique still counts: "got
-- the sweep" without naming which is evidence the schema deliberately accepts,
-- and refusing to mark it here would quietly punish the fast logging path.
(SELECT 'first_scored', sc.on_day, NULL, NULL, NULL, NULL,
        sc.session_id, sc.technique_id, tech.name
 FROM scored sc
 LEFT JOIN techniques tech ON tech.id = sc.technique_id
 ORDER BY sc.started_at ASC, sc.id ASC LIMIT 1)
UNION ALL
-- The funnel completing: landed live a technique drilled in an EARLIER session.
--
-- Strictly earlier, and that is the point of the award rather than an
-- implementation detail. Drilling and landing something inside one class is an
-- ordinary afternoon; drilling it, going away, and hitting it live weeks later
-- is the thing the drilled → attempted → scored funnel exists to describe. Same
-- session would also make this award fire together with first_scored for most
-- athletes, which would make one of the two redundant.
(SELECT 'first_drilled_scored', sc.on_day, NULL, NULL, NULL, NULL,
        sc.session_id, sc.technique_id, tech.name
 FROM scored sc
 LEFT JOIN techniques tech ON tech.id = sc.technique_id
 WHERE sc.technique_id IS NOT NULL
   AND EXISTS (
       SELECT 1
       FROM bjj_session_tags d
       JOIN sessions ds ON ds.id = d.session_id AND ds.user_id = d.user_id
       WHERE d.user_id = $1
         -- ds.sport as well as ds.user_id. The scored side filters sport and this
         -- side did not, which review caught and DEMONSTRATED: a drilled tag on a
         -- strength session graduated a later BJJ score. Unreachable through any
         -- writer today, since PutDetail refuses to attach a reflection to another
         -- sport -- but that is precisely the "claim about today's writers" this
         -- file says it does not rely on, applied to two of three session joins
         -- and not the third.
         AND ds.sport = $3
         AND d.technique_id = sc.technique_id
         AND d.event = 'drilled'
         AND ds.started_at < sc.started_at
   )
 ORDER BY sc.started_at ASC, sc.id ASC LIMIT 1)
`

func (r *PostgresRepository) List(ctx context.Context, userID, tz string) ([]Accomplishment, error) {
	rows, err := r.pool.Query(ctx, listQuery, userID, tz, sportKey)
	if err != nil {
		return nil, fmt.Errorf("accomplishment: list: %w", err)
	}
	defer rows.Close()

	// Non-nil: an athlete with nothing yet marshals as [] rather than null, and
	// "nothing yet" is the normal state of a new account rather than an error.
	out := []Accomplishment{}
	for rows.Next() {
		var (
			a          Accomplishment
			kind       string
			achievedOn *time.Time
		)
		if err := rows.Scan(&kind, &achievedOn, &a.ContestID, &a.ContestName,
			&a.Placement, &a.Entrants, &a.SessionID, &a.TechniqueID, &a.TechniqueName); err != nil {
			return nil, fmt.Errorf("accomplishment: scan: %w", err)
		}
		a.Kind = Kind(kind)
		basis, ok := BasisOf(a.Kind)
		if !ok {
			// Unreachable while the query and the vocabulary agree, and it
			// fails LOUDLY rather than defaulting. Defaulting would pick one of
			// `measured`/`reported` for a kind nobody classified, and the
			// flattering answer is the likely default — a reported award
			// rendering as externally verified is the one wrong answer this
			// module must never give.
			return nil, fmt.Errorf("accomplishment: unclassified kind %q", kind)
		}
		a.Basis = basis
		if achievedOn != nil {
			// A calendar date, never an RFC3339 instant: rendered as midnight
			// UTC it shows as the PREVIOUS DAY for anyone west of Greenwich
			// once a client localises it.
			d := achievedOn.Format(dateLayout)
			a.AchievedOn = &d
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("accomplishment: list: %w", err)
	}

	sortChronologically(out)
	return out, nil
}
