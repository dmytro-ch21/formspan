package biometric

import (
	"math"
	"sort"
	"strconv"
	"time"
)

// RuleVersion is the current TRIMP/zone computation's version — bump it
// whenever zoneFloors, the zone-weight scheme, or the gap-attribution
// window below changes, so a session_metrics row a client has already read
// can be told apart from one computed under a different formula (design doc
// §6.3/§8 — every derived output carries its rule version).
const RuleVersion = 1

// Zone is one of Edwards' five heart-rate training zones, numbered 1-5 by
// increasing intensity as a fraction of HRmax.
type Zone int

const (
	// ZoneNone is below zone 1's floor — resting/recovery HR, outside
	// Edwards' five scored zones entirely (see TRIMP).
	ZoneNone Zone = 0
	Zone1    Zone = 1
	Zone2    Zone = 2
	Zone3    Zone = 3
	Zone4    Zone = 4
	Zone5    Zone = 5
)

// zoneFloors are each zone's lower bound as a fraction of HRmax — the
// standard 50/60/70/80/90% Edwards boundaries. Zone i (1-5) covers
// [zoneFloors[i-1], zoneFloors[i]) except zone 5, which has no upper bound:
// there is nothing above "hardest zone there is."
var zoneFloors = [5]float64{0.50, 0.60, 0.70, 0.80, 0.90}

// ZoneForHR reports which Edwards zone a heart rate falls in, given the
// athlete's HRmax. Boundaries are inclusive on the low end — a heart rate
// landing exactly on a floor belongs to the zone it opens, not the one below.
//
// hrMaxBPM <= 0 always returns ZoneNone: there is no ceiling to measure a
// fraction against, so classifying anything would be inventing precision the
// input doesn't support (design doc §7's rule, applied here).
func ZoneForHR(hrBPM, hrMaxBPM float64) Zone {
	if hrMaxBPM <= 0 {
		return ZoneNone
	}
	pct := hrBPM / hrMaxBPM
	z := ZoneNone
	for i, floor := range zoneFloors {
		if pct >= floor {
			z = Zone(i + 1)
		}
	}
	return z
}

// TRIMP computes Edwards' zone-weighted training impulse: the sum, over
// zones 1-5, of minutes spent in that zone times the zone's own weight
// (1 through 5) — Σ(minutes in zone × zone weight).
//
// Chosen over Banister's TRIMP specifically because it needs only HRmax, not
// resting HR, which would otherwise drag in a second daily read and a whole
// recovery pipeline this phase deliberately doesn't build — see the design
// doc's §3 and this ticket's own description for the full argument.
//
// minutesInZone is indexed 0..4 for zones 1..5. Minutes below zone 1 (index
// "zone 0" / ZoneNone) carry no weight in Edwards' formula and have no slot
// in this array — see ZoneBreakdown, which never attributes time to
// ZoneNone.
func TRIMP(minutesInZone [5]float64) float64 {
	var t float64
	for i, m := range minutesInZone {
		t += m * float64(i+1)
	}
	return t
}

// HRSample is one timestamped heart-rate reading, the shape ZoneBreakdown
// and Compute consume — independent of Sample/MetricType so this file has
// no storage dependency at all and can be tested with nothing but literals.
type HRSample struct {
	MeasuredAt time.Time
	BPM        float64
}

// maxSampleGapForZoneAttribution bounds how long a gap between two
// consecutive samples may be before the interval between them counts toward
// a zone at all.
//
// Apple Watch publishes background HR roughly every five minutes when the
// wearer is still (design doc §2) — sparse, but real evidence, and a session
// with no active platform workout running is exactly this sparse by design,
// not by malfunction. Six minutes gives that ordinary background cadence
// headroom without extrapolating a HEART RATE across a genuine gap — a
// session that goes quiet for 40 minutes (phone locked, watch removed) must
// not have that silence assumed to be spent at whatever the last known zone
// was. A capped-out interval simply isn't counted anywhere; the athlete's
// own TimeInZones legitimately sums to less than the session's duration when
// the evidence is this thin, and SampleCount is what tells a reader why.
const maxSampleGapForZoneAttribution = 6 * time.Minute

// ZoneBreakdown computes minutes-in-zone (index 0 = zone 1 .. index 4 =
// zone 5), average and peak HR, from a set of heart-rate samples. Samples
// need not be pre-sorted.
//
// The interval between two consecutive samples is attributed entirely to
// the FIRST sample's zone — the simplest defensible rule given real device
// data is irregularly spaced, and the one every consumer HR app effectively
// uses. Gaps longer than maxSampleGapForZoneAttribution are skipped
// entirely rather than attributed to any zone (see that constant's comment).
//
// hrMaxBPM <= 0 still returns a real avg/max — those need no ceiling — but
// leaves minutesInZone all zero, since ZoneForHR cannot classify anything
// without one. Callers that need to tell "really zero time in every zone"
// apart from "couldn't classify at all" read hrMaxBPM themselves; this
// function does not fabricate the distinction on its own (see Compute,
// which is the layer that actually makes that call by leaving TRIMP nil).
//
// Pure and independent of storage — table-driven tested on its own, and
// exactly the kind of domain logic that belongs in Go rather than SQL or a
// client (design doc §3: "derive on the backend, not the client").
func ZoneBreakdown(samples []HRSample, hrMaxBPM float64) (minutesInZone [5]float64, avgBPM, maxBPM float64) {
	if len(samples) == 0 {
		return
	}
	sorted := make([]HRSample, len(samples))
	copy(sorted, samples)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].MeasuredAt.Before(sorted[j].MeasuredAt) })

	var sum float64
	maxBPM = sorted[0].BPM
	for _, s := range sorted {
		sum += s.BPM
		if s.BPM > maxBPM {
			maxBPM = s.BPM
		}
	}
	avgBPM = sum / float64(len(sorted))

	for i := 0; i < len(sorted)-1; i++ {
		gap := sorted[i+1].MeasuredAt.Sub(sorted[i].MeasuredAt)
		if gap <= 0 || gap > maxSampleGapForZoneAttribution {
			continue
		}
		z := ZoneForHR(sorted[i].BPM, hrMaxBPM)
		if z == ZoneNone {
			continue
		}
		minutesInZone[z-1] += gap.Minutes()
	}
	return
}

// exerciseHRWindow is the join-granularity decision for N490/#851: how to
// turn "when this exercise's sets were completed" into a time range worth
// reading heart-rate samples from.
//
// **Decision: per-exercise, not per-set** — every session_sets row sharing
// one exercise_id is grouped into a single window, rather than reading each
// set's own gap to its neighbours. The ticket's own alternative (per-set) was
// rejected on exactly the sparsity concern maxSampleGapForZoneAttribution
// already exists for: Apple Watch's background cadence is roughly one sample
// per five minutes when no active platform workout is running (this file's
// own comment on that constant), and one working set plus its rest is
// routinely SHORTER than that gap. A per-set window would, for the common
// case, contain zero samples — not a thin reading, no reading at all — which
// is a worse failure than the one this function exists to avoid: an
// exercise's block of sets between them cover enough wall-clock time to have
// a realistic chance of enclosing at least one real sample.
//
// **The boundary problem, and why the window is widened backward.**
// `performed_at` is stamped at the MOMENT A SET IS COMPLETED — the end of the
// interval it represents, never the start. Taking [minPerformedAt,
// maxPerformedAt] literally therefore excludes, by construction, the entire
// first set's own working time and whatever rest preceded it — exactly the
// exertion a "how hard was this exercise" report most needs. This mirrors
// ZoneBreakdown's own stance on the same asymmetry (attributing an interval
// to its FIRST sample because only the first is known to be real), applied
// here to completion events instead of HR samples.
//
// The fix is to widen the start backward by maxSampleGapForZoneAttribution —
// reusing that constant rather than inventing a second sparsity tolerance,
// because the question is the same one it already answers: how far back is
// it still honest to reach for evidence. It is never widened past the
// session's own start, since there is nothing before a session began.
//
// **Known, accepted limitation**: grouping by exercise_id rather than by
// contiguous position run means a superset (A, B, A, B) merges both of
// exercise A's occurrences into one window spanning the whole superset — this
// package has no first-class representation of a superset to do better with,
// and the common case (one exercise, one contiguous block of sets) is
// unaffected. Recorded here and in this ticket's history entry rather than
// hidden, since it is the reason a future superset feature may need to
// revisit this function specifically.
func exerciseHRWindow(minPerformedAt, maxPerformedAt, sessionStartedAt time.Time) (start, end time.Time) {
	start = minPerformedAt.Add(-maxSampleGapForZoneAttribution)
	if start.Before(sessionStartedAt) {
		start = sessionStartedAt
	}
	return start, maxPerformedAt
}

// Compute derives a session's metrics from its heart-rate samples.
//
// hrSourceHint is the caller's claim about how the samples were gathered
// (design doc §2's two-tier join). Compute never trusts that claim past the
// data it was actually given: with zero samples the result is always
// HRSourceNone regardless of hint — claiming "workout" or "window" evidence
// for zero samples would be exactly the false confidence system-design §7
// (and this package's HRSource doc comment) rules out.
//
// TRIMP and TimeInZones stay nil/empty whenever hrMaxBPM <= 0, even with
// real samples present — there is no ceiling to classify a zone against, so
// reporting a TRIMP of 0 would assert "measured, and it was zero effort"
// rather than "couldn't be computed", which is the wrong claim to make on
// missing input. AvgHRBPM/MaxHRBPM need no HRmax and are still reported.
//
// HRMaxBPM/HRMaxSource (design doc §3, N483/#833) are recorded on the result
// under the SAME gate as TRIMP/TimeInZones — hrMaxBPM > 0 — rather than
// whenever a caller happens to pass one: an HRmax that classified nothing
// (no samples, or hrMaxBPM <= 0) is not "the HRmax that produced this row's
// zones," so recording it there would misstate what actually happened. This
// does not validate hrMaxSource itself (callers are expected to have done
// that, matching hrSourceHint's own contract) — it only decides whether the
// pair is stamped onto the result at all.
func Compute(samples []HRSample, hrMaxBPM float64, hrMaxSource HRMaxSource, hrSourceHint HRSource) SessionMetrics {
	m := SessionMetrics{
		TimeInZones: map[string]float64{},
		SampleCount: len(samples),
	}
	if len(samples) == 0 {
		m.HRSource = HRSourceNone
		return m
	}
	m.HRSource = hrSourceHint

	zones, avg, max := ZoneBreakdown(samples, hrMaxBPM)
	avgInt := int(math.Round(avg))
	maxInt := int(math.Round(max))
	m.AvgHRBPM = &avgInt
	m.MaxHRBPM = &maxInt

	if hrMaxBPM > 0 {
		for i, mins := range zones {
			m.TimeInZones[strconv.Itoa(i+1)] = mins
		}
		trimp := TRIMP(zones)
		m.TRIMP = &trimp
		m.HRMaxBPM = &hrMaxBPM
		m.HRMaxSource = &hrMaxSource
	}
	return m
}
