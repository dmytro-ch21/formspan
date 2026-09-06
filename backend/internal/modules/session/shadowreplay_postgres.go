package session

import (
	"context"
	"fmt"
)

// ShadowReplayCandidates is N515/#903's own enumeration query — see
// Repository's doc comment on the method, shadowreplay.go for the pure
// comparison run against each candidate, and cmd/shadowreplay for the one
// caller.
//
// The filter mirrors, deliberately, the INTERSECTION of what RecentEfforts
// and RecentEffortsV2 both require before either engine can build anything
// from a row:
//
//   - SQLWorkingSet (completed, not a warm-up) — the same rule both queries
//     already apply.
//   - A real weight and rep count — workingSetsWithWeight's (v1) and
//     straightWorkingSetsWithWeight's (v2) own `WeightKg != nil && Reps !=
//     nil && WeightKg > 0`, restated here in SQL because there is no Set
//     value to call either Go function on yet.
//   - `s.ended_at IS NOT NULL` — RecentEffortsV2's own finished-only filter,
//     the STRICTER of the two (RecentEfforts doesn't require it). Candidates
//     are filtered to it anyway so a pair returned here is guaranteed usable
//     by BOTH engines' history reads, not merely v1's looser one — v1 may
//     still see additional, unfinished sessions ranked ahead of the one that
//     qualified this pair, and that's a real, reportable difference between
//     the two engines' inputs, not a bug in this enumeration.
//   - `e.load_type = 'weight_reps'` — anything else makes both engines
//     return the identical SuggestNotApplicable, which is agreement by
//     construction and not worth a database row to discover.
//
// DISTINCT rather than GROUP BY: nothing here is aggregated, only
// deduplicated. No per-user filter and no LIMIT — unlike every other method
// on this Repository, which are all scoped to one caller's own athlete_id —
// because this is a full-population offline read, never reachable from an
// HTTP handler.
func (r *PostgresRepository) ShadowReplayCandidates(ctx context.Context) ([]ProgressionCandidate, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT ss.user_id, ss.exercise_id
		FROM session_sets ss
		JOIN sessions s ON s.id = ss.session_id
		JOIN exercises e ON e.id = ss.exercise_id
		WHERE s.ended_at IS NOT NULL
		  AND `+SQLWorkingSet+`
		  AND ss.weight_kg IS NOT NULL AND ss.weight_kg > 0
		  AND ss.reps IS NOT NULL
		  AND e.load_type = 'weight_reps'
		ORDER BY ss.user_id, ss.exercise_id`)
	if err != nil {
		return nil, fmt.Errorf("session: shadow replay candidates: %w", err)
	}
	defer rows.Close()

	out := []ProgressionCandidate{}
	for rows.Next() {
		var c ProgressionCandidate
		if err := rows.Scan(&c.UserID, &c.ExerciseID); err != nil {
			return nil, fmt.Errorf("session: scan shadow replay candidate: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: shadow replay candidate rows: %w", err)
	}
	return out, nil
}
