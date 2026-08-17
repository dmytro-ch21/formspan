package session

import "time"

// LoadHistory is one exercise's arc: what was lifted, session by session.
//
// **This is the web screen, deliberately.** N6 asked for per-exercise load over
// time and paired itself with N5's mobile weight chart, but it does not pass
// N5's carve-out. That carve-out requires the decision being informed to be one
// made away from a computer, and the at-the-rack decision — "what do I put on
// the bar today" — is *already* answered on the phone by the double-progression
// recommendation (`app/session/[id].tsx`), compressed to a line because between
// sets nobody reads a rationale. A chart next to it would not inform a decision
// that recommendation leaves open; it answers "did my squat go up over the last
// three months", which is asked while planning the next block, at a desk.
//
// So the series is served to the analytical surface, where it can have the
// things the carve-out forbids on mobile: axes, values, and more than one
// metric at a time.
type LoadHistory struct {
	ExerciseID string `json:"exercise_id"`
	// LoadType comes from the catalog, never the caller, because it decides
	// which of the fields below are meaningful — the same reason `Records`
	// reads it server-side rather than trusting a client to know.
	LoadType string      `json:"load_type"`
	Points   []LoadPoint `json:"points"`
}

// LoadPoint is one session's worth of that exercise.
//
// A session, not a set and not a day. A set is noise — five sets of five are
// one data point about strength, not five. A day merges a morning and an
// evening session into an average neither of them was.
type LoadPoint struct {
	SessionID string    `json:"session_id"`
	StartedAt time.Time `json:"started_at"`

	// TopWeightKg is the heaviest working set, in storage units, so the client
	// formats it the way it formats everything else.
	//
	// Nullable, and it is worth saying why a *weight* can be absent: a set can
	// be bodyweight, timed or a distance, and those carry no weight at all.
	TopWeightKg *float64 `json:"top_weight_kg"`

	// BestOneRMKg is the best estimate this session supports, or null when no
	// set can support one.
	//
	// Null is a real and common answer, not an error: `EstimateOneRM` refuses
	// past twelve effective reps because every rep-max formula diverges there,
	// so a session of high-rep back-off sets legitimately has no estimate.
	// Rendering that as a gap rather than a zero is the same discipline N5
	// applied to a missing weigh-in — a chart's default is to invent a line
	// across the hole.
	BestOneRMKg *float64 `json:"best_1rm_kg"`
	// BestOneRMReps, BestOneRMWeightKg and BestOneRMAssistedReps are the set
	// that produced the estimate.
	//
	// Carried for the same reason `Record.AssistedReps` is: a modelled number
	// with no evidence under it cannot be checked, and "112kg" means something
	// different when it came from 100×5 than from 110×2.
	//
	// **Reps is the FULL count and assisted rides alongside**, matching how
	// `Record` reports evidence — so a client can render "8 (5 alone)". The
	// estimate itself is computed from the SOLO count by `EstimateSetOneRM`;
	// showing the full count under a solo-derived number without the assisted
	// figure beside it would make the evidence unrecheckable, which is exactly
	// the mismatch `Record` documents having produced once.
	BestOneRMReps         *int     `json:"best_1rm_reps"`
	BestOneRMWeightKg     *float64 `json:"best_1rm_weight_kg"`
	BestOneRMAssistedReps *int     `json:"best_1rm_assisted_reps"`

	// TonnageKg is this exercise's contribution to the session, under the one
	// tonnage rule (`SQLTonnage`) — implements included, drops included,
	// warm-ups excluded.
	TonnageKg float64 `json:"tonnage_kg"`
	// Sets counts what `SQLCountsAsSet` counts, so a drop set does not read as
	// a second set here while reading as one set everywhere else.
	Sets int `json:"sets"`
	Reps int `json:"reps"`
}

// maxLoadHistoryPoints bounds the series.
//
// An unbounded per-user list is the reviewable defect this module has been
// caught on before; it is also a real one here, since the query is "every set
// of this exercise, ever" for somebody who may have trained it weekly for
// years. The window is applied in SQL by session, so the cap costs the oldest
// sessions rather than truncating the newest — a chart that silently loses its
// right-hand edge would be worse than one that starts late.
const maxLoadHistoryPoints = 400

// LoadHistoryFilter scopes the series. Both bounds are optional; the cap above
// applies regardless.
type LoadHistoryFilter struct {
	From *time.Time
	To   *time.Time
	// Limit is the number of SESSIONS to return. Zero means the maximum, and
	// anything above it is clamped rather than honoured.
	//
	// A field rather than a bare constant so the "drops the oldest, keeps the
	// newest" property is provable with three fixtures instead of four hundred
	// and one. A cap nothing can afford to test is a cap nobody has tested.
	Limit int
}

// points returns the effective session cap for a filter.
func (f LoadHistoryFilter) points() int {
	if f.Limit <= 0 || f.Limit > maxLoadHistoryPoints {
		return maxLoadHistoryPoints
	}
	return f.Limit
}
