package bjj

import (
	"context"
	"time"
)

/*
Where the athlete scores and where they get stuck.

`bjj_session_tags` has carried `position` since it was written, and until now
nothing read it back — the design doc names a "position heatmap" as one of the
three views the table was shaped for, and this is that view. Every tag already
records where the exchange happened; the aggregate is the whole feature.

# Why position rather than technique

`ListProficiency` already answers "how is my triangle going", and that is the
narrower question. The one an athlete actually acts on is **"where am I losing
the round"** — and it is not a technique question, because getting passed from
half guard is a hundred different passes and one problem. A position is also
the unit a coach thinks in and the unit a drilling plan is written in.

# Scored and conceded are not a score

The pair is deliberately reported side by side rather than folded into a ratio
or a rating, for the same reason `Proficiency` refuses to be a 1–5: a ratio
hides its denominator, and "3 scored, 14 conceded from half guard" is a finding
where "0.18" is a number nobody can argue with. The client may compute a rate
for ordering; the API reports the facts.

# What this deliberately does not do

**It does not tell you what to drill.** Concessions from a position are equally
consistent with a hole in the athlete's game and with the fact that they spend
every round there on purpose. Nothing here can tell those apart, and a
recommendation that cannot would be confidently wrong about a third of the
time.
*/

// PositionStat is one position's accumulated evidence.
type PositionStat struct {
	// Position is the tag's own string. Free-ish text by schema, but in
	// practice the vocabulary `lib/positions.ts` renders — reported verbatim
	// rather than mapped, so a value this build does not recognise still
	// appears instead of vanishing into an "other" bucket.
	Position string `json:"position"`

	// The live outcomes, from the athlete's side.
	//
	// Scored and Conceded are the pair the whole view exists for: what you
	// finish from here, and what gets done to you here. Attempted and Defended
	// are their near misses — went for it and missed, and stopped them going
	// for it — so the four together read as one exchange from both ends.
	Scored    int `json:"scored"`
	Attempted int `json:"attempted"`
	Conceded  int `json:"conceded"`
	Defended  int `json:"defended"`

	// Drilled is practice rather than a live outcome, and is kept separate for
	// that reason. It is also what makes a gap visible: a position conceded
	// often with nothing drilled for it is a different problem from one
	// conceded often despite hours of work on it.
	Drilled int `json:"drilled"`

	// Sessions is the honesty check on every number above — twelve exchanges
	// in one bad night is not the evidence twelve across six weeks is.
	Sessions int       `json:"sessions"`
	LastSeen time.Time `json:"last_seen"`
}

// Live is how many live exchanges this position produced, either direction.
//
// The denominator a client orders by, and a method rather than a field so it
// cannot drift from the parts it is made of.
func (p PositionStat) Live() int {
	return p.Scored + p.Attempted + p.Conceded + p.Defended
}

// maxPositionRows caps the response.
//
// The vocabulary is small — nine or so families — so this is a guard against a
// drifted or hand-typed value flooding the list rather than a real paging
// concern. Same reasoning as the proficiency cap, and the ORDER BY below is
// total for the same reason: a nondeterministic tail makes the ETag on this
// endpoint a permanent cache miss.
const maxPositionRows = 60

// ListPositions returns the caller's position map, most live evidence first.
func (r *PostgresRepository) ListPositions(
	ctx context.Context, userID string,
) ([]PositionStat, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT
			t.position,
			SUM(CASE WHEN t.event = 'scored'    THEN t.count ELSE 0 END)::int,
			SUM(CASE WHEN t.event = 'attempted' THEN t.count ELSE 0 END)::int,
			SUM(CASE WHEN t.event = 'conceded'  THEN t.count ELSE 0 END)::int,
			SUM(CASE WHEN t.event = 'defended'  THEN t.count ELSE 0 END)::int,
			SUM(CASE WHEN t.event = 'drilled'   THEN t.count ELSE 0 END)::int,
			COUNT(DISTINCT t.session_id)::int,
			MAX(s.started_at)
		FROM bjj_session_tags t
		-- Joined on (id, user_id) like every other read of this table: the tag
		-- carries its own user_id and the composite FK keeps the two in step,
		-- but joining on id alone would make correctness depend on that
		-- invariant holding rather than on the query saying what it means.
		JOIN sessions s ON s.id = t.session_id AND s.user_id = t.user_id
		WHERE t.user_id = $1 AND t.position <> ''
		GROUP BY t.position
		ORDER BY
			-- Live exchanges first: the positions where a conclusion is safest.
			-- Drilled is excluded from the ordering on purpose — a position you
			-- have only ever drilled has told you nothing about a round.
			SUM(CASE WHEN t.event IN ('scored', 'attempted', 'conceded', 'defended')
			         THEN t.count ELSE 0 END) DESC,
			-- Total, so the tail cannot reorder between identical requests.
			t.position
		LIMIT $2`, userID, maxPositionRows)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Non-nil, so an athlete with no mat time encodes as [] rather than null.
	out := make([]PositionStat, 0)
	for rows.Next() {
		var p PositionStat
		if err := rows.Scan(&p.Position, &p.Scored, &p.Attempted, &p.Conceded,
			&p.Defended, &p.Drilled, &p.Sessions, &p.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// PositionReader is the port the handler depends on.
type PositionReader interface {
	ListPositions(ctx context.Context, userID string) ([]PositionStat, error)
}

var _ PositionReader = (*PostgresRepository)(nil)

// Context is the small amount of interpretation the API is willing to do.
//
// Not a recommendation — see the note at the top. These are two counts the
// client would otherwise re-derive identically in three places, and putting
// them here keeps one definition of "enough evidence to say anything".
type PositionsSummary struct {
	// Positions with any live evidence at all.
	Positions int `json:"positions"`
	// MinLive is the threshold below which a position is reported but should
	// not be drawn a conclusion from. Sent rather than hard-coded in the
	// client so the two cannot disagree about what "enough" means.
	MinLive int `json:"min_live"`
}

// MinLiveExchanges is where a position stops being an anecdote.
//
// Five, and it is a judgement rather than a measurement: below it a single bad
// night dominates, and the honest thing is to show the row and withhold the
// verdict. The clients read this off the response rather than repeating it.
const MinLiveExchanges = 5
