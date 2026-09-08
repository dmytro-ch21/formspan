package biometric

import (
	"sort"
	"time"
)

// DirectGapFillThreshold is how long the direct (Bluetooth) heart-rate
// stream has to be silent before Apple Health / Health Connect samples are
// allowed to stand in for it (N528/#958).
//
// The priority rule, stated once so it is never re-argued per PR: for a
// session window, samples this app recorded itself from a monitor WIN; a
// health-store sample is used only inside a gap in that stream longer than
// this. "Take whichever is more accurate" is not a measurable rule — nobody
// can say which reading was right — but "which one arrived without a sync in
// the middle" is, and that is what this encodes. Thirty seconds: a Bluetooth
// link in a gym drops and reconnects in a few seconds routinely, and the
// health store's own cadence for the same watch is a sample every few seconds
// at best, so a shorter threshold would let two sources interleave over the
// same heartbeat; a much longer one would throw away real evidence during a
// genuine dropout.
const DirectGapFillThreshold = 30 * time.Second

// HRProvenance is what MergeHRSources reports about the samples it kept.
type HRProvenance struct {
	// DirectCount is how many kept samples came from a Bluetooth monitor.
	DirectCount int
	// FilledCount is how many health-store samples were kept to bridge gaps.
	FilledCount int
}

// MergeHRSources applies the priority rule above to the samples of one
// window. Pure; the input is not modified.
//
// With no direct samples the input is returned as it came (same slice), so
// every session recorded before N528 — and every session without a monitor —
// is computed exactly as before. With direct samples: all of them are kept;
// a non-direct sample is kept only if it falls inside a gap longer than
// `threshold`, where the gaps are the intervals between consecutive direct
// samples AND the two edges — window start to the first direct sample, last
// direct sample to window end — so a link that died ten minutes before the
// end still gets those ten minutes from the health store. A non-direct sample
// at exactly a direct sample's instant sits in a zero-length gap and is
// dropped. The result is sorted by time.
func MergeHRSources(samples []HRSample, windowStart, windowEnd time.Time, threshold time.Duration) ([]HRSample, HRProvenance) {
	var direct, other []HRSample
	for _, s := range samples {
		if s.Platform == PlatformBluetooth {
			direct = append(direct, s)
		} else {
			other = append(other, s)
		}
	}
	if len(direct) == 0 {
		return samples, HRProvenance{}
	}
	sort.SliceStable(direct, func(i, j int) bool { return direct[i].MeasuredAt.Before(direct[j].MeasuredAt) })

	prov := HRProvenance{DirectCount: len(direct)}
	out := make([]HRSample, 0, len(samples))
	out = append(out, direct...)

	// Gap edges: the window bounds stand in for a "direct sample" on either
	// side, so the edge intervals are measured the same way as inner ones.
	// A zero window bound (caller had none) makes that edge infinitely wide,
	// i.e. every non-direct sample outside the direct span is kept — the
	// conservative reading when the window is unknown.
	inGap := func(t time.Time) bool {
		// prev: latest direct sample at or before t; next: earliest at or after.
		i := sort.Search(len(direct), func(i int) bool { return !direct[i].MeasuredAt.Before(t) })
		// A direct sample AT this instant covers it outright — the doc's
		// "zero-length gap" case, made explicit rather than left to the
		// arithmetic below (which would measure to the previous direct
		// sample instead and let the health reading through).
		if i < len(direct) && direct[i].MeasuredAt.Equal(t) {
			return false
		}
		var prevAt, nextAt time.Time
		if i < len(direct) {
			nextAt = direct[i].MeasuredAt
		} else if !windowEnd.IsZero() {
			nextAt = windowEnd
		}
		if i > 0 {
			prevAt = direct[i-1].MeasuredAt
		} else if !windowStart.IsZero() {
			prevAt = windowStart
		}
		if prevAt.IsZero() || nextAt.IsZero() {
			return true
		}
		return nextAt.Sub(prevAt) > threshold
	}
	for _, s := range other {
		if inGap(s.MeasuredAt) {
			out = append(out, s)
			prov.FilledCount++
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].MeasuredAt.Before(out[j].MeasuredAt) })
	return out, prov
}
