package running

import "time"

// StandardDistance is a widely-recognized race distance a runner might chase
// as a goal of its own, independent of how long the run that produced it
// actually was — "I want a faster 5k" is a real ambition to hold inside a
// 10k training run, and this is what lets that ambition be tracked.
type StandardDistance struct {
	// Key is the stable identifier a client stores and this API names in
	// JSON — never the label, which is presentation and may localize later.
	Key       string  `json:"key"`
	Label     string  `json:"label"`
	DistanceM float64 `json:"distance_m"`
}

// standardDistances is the closed set this feature tracks: the four classic
// road-race lengths, in increasing order. Closed rather than open, because
// these are the distances a runner already has a mental benchmark for — "my
// 5k time" is something people just know — and an arbitrary window ("fastest
// 3.7km") would not be a personal record anyone recognizes as one.
var standardDistances = []StandardDistance{
	{Key: "5k", Label: "5K", DistanceM: 5000},
	{Key: "10k", Label: "10K", DistanceM: 10000},
	{Key: "half_marathon", Label: "Half marathon", DistanceM: 21097.5},
	{Key: "marathon", Label: "Marathon", DistanceM: 42195},
}

// StandardDistances returns the tracked distances, for a client rendering a
// picker without hardcoding the list a second time. Returns a copy, matching
// discipline.All's stance on the same hazard: a caller that sorted or
// filtered the slice in place would silently reorder it for everyone else.
func StandardDistances() []StandardDistance {
	out := make([]StandardDistance, len(standardDistances))
	copy(out, standardDistances)
	return out
}

// distanceTolerancePct is how far a contiguous run of splits' total distance
// may sit from a standard distance and still count as an attempt at it —
// expressed as a FRACTION OF THE TARGET, not a fixed metre count.
//
// A fixed tolerance cannot serve every tracked distance at once. Splits are
// typically recorded at ~1km auto-split boundaries (see the Split doc in
// running.go), so a standard distance that is not itself a round number of
// kilometres is approached but never exactly hit by any whole-split window:
// 21 one-kilometre splits sum to ~21,000m against the true half-marathon
// distance of 21,097.5m — a 97.5m gap — and 42 splits leave a marathon
// ~195m short, both from split-boundary rounding alone, before any GPS
// noise is added on top. Those gaps SCALE WITH THE TARGET DISTANCE, so the
// tolerance has to as well: a flat ±50m would refuse a clean marathon
// attempt on rounding alone (±50m is 0.12% of 42,195m), while a flat ±500m
// would accept a 5k effort that drifted 10% off distance and still call it
// comparable.
//
// ±1% covers both real sources of drift (split-boundary rounding, ordinary
// GPS noise) at every tracked distance, while staying tight enough that a
// "5k PR" still means something close to 5,000m. This is the balance the
// ticket asks to state explicitly: too tight (a small fixed metre count)
// and a slightly-long effort at the harder distances never counts; too
// loose (a large percentage, or a generous flat count) and the number stops
// being comparable across attempts — a "PR" that could have covered
// anywhere from 4,500m to 5,500m is not really a 5k time anymore.
const distanceTolerancePct = 0.01

// DistanceWindow is one contiguous stretch of a run's own splits whose total
// distance falls within tolerance of a StandardDistance — a candidate
// "personal-best pace for X" buried inside a longer run.
type DistanceWindow struct {
	Standard StandardDistance `json:"standard_distance"`

	// StartSplit/EndSplit index into the SAME Splits slice the caller
	// passed in, inclusive on both ends — the window is explainable against
	// the exact list a client already renders, not a synthesized range
	// nobody can check.
	StartSplit int `json:"start_split"`
	EndSplit   int `json:"end_split"`

	// ActualDistanceM/ActualDurationSeconds are exactly what the window
	// covered — real evidence, not a smoothed number.
	ActualDistanceM       float64 `json:"actual_distance_m"`
	ActualDurationSeconds float64 `json:"actual_duration_seconds"`

	// NormalizedDurationSeconds projects the window's own average pace onto
	// the standard distance EXACTLY (pace × Standard.DistanceM), so a
	// 4,980m window and a 5,020m window — both inside tolerance of "5k" —
	// produce directly comparable times instead of rewarding whichever one
	// happened to land closer to 5,000m by chance. This is the value a
	// historical-best comparison ranks on; see DistanceRecord.ValueSeconds.
	NormalizedDurationSeconds float64 `json:"normalized_duration_seconds"`
}

// BestDistanceWindows finds, for every StandardDistance, the fastest
// contiguous window of splits whose total distance is within tolerance —
// the single best "5k-equivalent effort" (etc.) buried inside this one run,
// if any. A StandardDistance with no matching window is simply absent from
// the result, not zero.
//
// Matched against SPLITS, not the raw GPS track. A split is already the
// run's own distance-segmented shape (SessionDetail.Splits) — the same list
// a client already renders — so a match lands on a boundary a person can
// see and check, rather than an arbitrary point along the raw route that
// appears nowhere in the UI. The cost is resolution: a match can only be as
// fine-grained as the splits actually recorded, so a run logged as two
// back-to-back 5k halves can never yield a 10k-window match at some OTHER
// boundary. That is a property of the input a client chose to send, not a
// gap in this algorithm.
//
// O(n²) over the split count, deliberately not the tighter two-pointer
// form: n is bounded by MaxSplits (500), so the worst case is on the order
// of 250,000 additions — trivial — and the simpler form is the one worth
// reading five years from now over the one worth benchmarking today.
func BestDistanceWindows(splits []Split) map[string]DistanceWindow {
	out := map[string]DistanceWindow{}
	n := len(splits)
	if n == 0 {
		return out
	}

	// Prefix sums, 1-indexed so prefixDist[i] is the total distance covered
	// by splits[0:i] — prefixDist[end+1]-prefixDist[start] is then the
	// distance of the contiguous window splits[start..end].
	prefixDist := make([]float64, n+1)
	prefixDur := make([]float64, n+1)
	for i, s := range splits {
		prefixDist[i+1] = prefixDist[i] + s.DistanceM
		prefixDur[i+1] = prefixDur[i] + float64(s.DurationSeconds)
	}

	for _, sd := range standardDistances {
		tolerance := sd.DistanceM * distanceTolerancePct
		lo, hi := sd.DistanceM-tolerance, sd.DistanceM+tolerance

		var best *DistanceWindow
		for start := 0; start < n; start++ {
			for end := start; end < n; end++ {
				dist := prefixDist[end+1] - prefixDist[start]
				if dist > hi {
					// Every split has strictly positive distance
					// (Split.valid requires it), so extending the window
					// further can only grow it — no later `end` at this
					// `start` can come back into range.
					break
				}
				if dist < lo {
					continue
				}
				dur := prefixDur[end+1] - prefixDur[start]
				cand := DistanceWindow{
					Standard:                  sd,
					StartSplit:                start,
					EndSplit:                  end,
					ActualDistanceM:           dist,
					ActualDurationSeconds:     dur,
					NormalizedDurationSeconds: dur / dist * sd.DistanceM,
				}
				if best == nil || cand.NormalizedDurationSeconds < best.NormalizedDurationSeconds {
					b := cand
					best = &b
				}
			}
		}
		if best != nil {
			out[sd.Key] = *best
		}
	}
	return out
}

// recentDistanceWindow mirrors session.recentWindow (14 days) exactly — the
// same "you just did this" judgment call, for the same reason: someone who
// runs twice a week should still see Tuesday's PR flagged fresh on Thursday.
// Not imported from the session package: this module already duplicates
// sportKey and other storage-level facts from that package rather than
// importing them (see running.go's doc comment on sportKey), and the same
// reasoning applies here — this is a fact about how THIS module presents
// recency, not a dependency on session's own internal constant.
const recentDistanceWindow = 14 * 24 * time.Hour

// DistanceRecord is one distance-normalized personal best across the
// caller's whole running history, and the run and window that produced it —
// matching the evidence stance session.Record already takes: a number
// nobody has to just trust.
//
// A DELIBERATELY SEPARATE mechanism from session.Record/RecordKind, not an
// extension of it — see the history entry this type landed with for the
// full reasoning. In short: session.Record's evidence is a single
// session_sets ROW (SessionID plus a value already sitting on that row),
// and its generic Records() query finds a maximum with one SQL window
// function per exercise because every candidate value already IS a row in
// that table. A distance-normalized PR's evidence is a WINDOW — a start and
// end split index within one session's own Splits array, which lives in a
// JSONB column and is never itself a row. Forcing that into RecordKind
// would mean either inventing StartSplit/EndSplit fields nothing else on
// that type needs, or silently dropping the window and returning a bare
// duration nobody could check against the splits list they can already
// see. Both are worse than a second, smaller, purpose-built mechanism that
// says exactly what it is and lives entirely inside this module.
type DistanceRecord struct {
	// StandardDistance is the StandardDistance.Key this record is for
	// ("5k", "10k", "half_marathon", "marathon") — flattened to a bare
	// string on the wire rather than nesting the whole StandardDistance
	// struct, matching PersonalRecord.kind's own shape (a string plus
	// sibling value fields, not a nested object) so a client already
	// familiar with GET /v1/records sees the same pattern here.
	StandardDistance string `json:"standard_distance"`
	// DistanceM is that standard distance's own canonical length in metres
	// (5000, 10000, 21097.5 or 42195) — a convenience so a client need not
	// separately look StandardDistance up against StandardDistances().
	// Distinct from ActualDistanceM below, which is what the matched
	// window really covered.
	DistanceM float64 `json:"distance_m"`

	// ValueSeconds is the winning window's NormalizedDurationSeconds — what
	// a "PR" comparison ranks on, for the reason DistanceWindow's own doc
	// gives.
	ValueSeconds float64 `json:"value_seconds"`

	SessionID  string `json:"session_id"`
	StartSplit int    `json:"start_split"`
	EndSplit   int    `json:"end_split"`

	ActualDistanceM       float64 `json:"actual_distance_m"`
	ActualDurationSeconds float64 `json:"actual_duration_seconds"`

	// AchievedAt is the session's own start time — not the detail row's
	// created_at/updated_at — matching session.Record.AchievedAt's stance:
	// the record was set when the run happened, not when it was saved or
	// last edited.
	AchievedAt time.Time `json:"achieved_at"`
	// IsRecent mirrors session.Record.IsRecent's window and reason exactly.
	IsRecent bool `json:"is_recent"`
}

// RunSplits is one session's splits and start time, the shape
// BestDistanceRecords scans — deliberately just those three fields, not a
// full SessionDetail, so this stays testable with plain literals and so a
// repository only has to fetch what this computation actually reads.
type RunSplits struct {
	SessionID string
	Splits    []Split
	StartedAt time.Time
}

// BestDistanceRecords finds the best DistanceRecord per StandardDistance
// across every run supplied — the caller's whole distance-normalized PR
// history in one pass. Pure and storage-agnostic, so it is tested directly
// against constructed splits and PostgresRepository.DistanceRecords is
// nothing but "fetch the rows, call this."
//
// Ties (an identical ValueSeconds from two different runs) resolve to
// whichever run appears EARLIER in the input slice. This only matters for
// determinism — real-valued paces essentially never tie — and it means the
// caller (the repository) controls tie-breaking by controlling query order,
// the same relationship session.Records has with its own SQL ORDER BY.
func BestDistanceRecords(runs []RunSplits) []DistanceRecord {
	cutoff := time.Now().Add(-recentDistanceWindow)
	best := map[string]DistanceRecord{}
	for _, run := range runs {
		for key, w := range BestDistanceWindows(run.Splits) {
			cand := DistanceRecord{
				StandardDistance:      w.Standard.Key,
				DistanceM:             w.Standard.DistanceM,
				ValueSeconds:          w.NormalizedDurationSeconds,
				SessionID:             run.SessionID,
				StartSplit:            w.StartSplit,
				EndSplit:              w.EndSplit,
				ActualDistanceM:       w.ActualDistanceM,
				ActualDurationSeconds: w.ActualDurationSeconds,
				AchievedAt:            run.StartedAt,
			}
			existing, ok := best[key]
			if !ok || cand.ValueSeconds < existing.ValueSeconds {
				best[key] = cand
			}
		}
	}

	// Iterate standardDistances rather than the map directly, so the result
	// is always in the same (increasing-distance) order regardless of Go's
	// randomized map iteration — the same reason session.Records iterates
	// its caller-supplied `ids` rather than its internal map.
	out := make([]DistanceRecord, 0, len(standardDistances))
	for _, sd := range standardDistances {
		r, ok := best[sd.Key]
		if !ok {
			continue
		}
		r.IsRecent = r.AchievedAt.After(cutoff)
		out = append(out, r)
	}
	return out
}
