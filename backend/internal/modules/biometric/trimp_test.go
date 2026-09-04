package biometric

import (
	"math"
	"testing"
	"time"
)

func TestZoneForHR(t *testing.T) {
	const hrMax = 200.0
	cases := []struct {
		name string
		hr   float64
		want Zone
	}{
		{"well below zone 1", 80, ZoneNone},
		{"just under zone 1 floor", 99.999, ZoneNone}, // 49.9995% of 200
		{"exactly zone 1 floor (50%)", 100, Zone1},
		{"mid zone 1", 110, Zone1},
		{"just under zone 2 floor", 119.999, Zone1},
		{"exactly zone 2 floor (60%)", 120, Zone2},
		{"exactly zone 3 floor (70%)", 140, Zone3},
		{"exactly zone 4 floor (80%)", 160, Zone4},
		{"exactly zone 5 floor (90%)", 180, Zone5},
		{"at HRmax (100%)", 200, Zone5},
		{"above HRmax", 210, Zone5}, // zone 5 has no ceiling
		{"zero HR", 0, ZoneNone},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ZoneForHR(c.hr, hrMax); got != c.want {
				t.Errorf("ZoneForHR(%v, %v) = %v, want %v", c.hr, hrMax, got, c.want)
			}
		})
	}
}

func TestZoneForHR_NoHRMax(t *testing.T) {
	// No ceiling to measure a fraction against — must never guess a zone.
	for _, hrMax := range []float64{0, -1, -200} {
		if got := ZoneForHR(150, hrMax); got != ZoneNone {
			t.Errorf("ZoneForHR(150, %v) = %v, want ZoneNone", hrMax, got)
		}
	}
}

func TestTRIMP(t *testing.T) {
	cases := []struct {
		name    string
		minutes [5]float64
		want    float64
	}{
		{"all zero", [5]float64{0, 0, 0, 0, 0}, 0},
		{"only zone 1", [5]float64{10, 0, 0, 0, 0}, 10}, // 10 * 1
		{"only zone 5", [5]float64{0, 0, 0, 0, 10}, 50}, // 10 * 5
		{
			"a realistic BJJ roll",
			[5]float64{5, 10, 15, 8, 2},
			// 5*1 + 10*2 + 15*3 + 8*4 + 2*5 = 5+20+45+32+10
			112,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := TRIMP(c.minutes); got != c.want {
				t.Errorf("TRIMP(%v) = %v, want %v", c.minutes, got, c.want)
			}
		})
	}
}

func t0(offsetSec int) time.Time {
	return time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC).Add(time.Duration(offsetSec) * time.Second)
}

func TestZoneBreakdown_Empty(t *testing.T) {
	zones, avg, max := ZoneBreakdown(nil, 200)
	if zones != ([5]float64{}) {
		t.Errorf("zones = %v, want all zero", zones)
	}
	if avg != 0 || max != 0 {
		t.Errorf("avg/max = %v/%v, want 0/0", avg, max)
	}
}

func TestZoneBreakdown_SingleSample(t *testing.T) {
	// One sample can report avg/max but has no interval to attribute any
	// zone-minutes to — you cannot derive a duration from one point.
	samples := []HRSample{{MeasuredAt: t0(0), BPM: 150}}
	zones, avg, max := ZoneBreakdown(samples, 200)
	if zones != ([5]float64{}) {
		t.Errorf("zones = %v, want all zero for a single sample", zones)
	}
	if avg != 150 || max != 150 {
		t.Errorf("avg/max = %v/%v, want 150/150", avg, max)
	}
}

func TestZoneBreakdown_AvgAndMax(t *testing.T) {
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 100},
		{MeasuredAt: t0(60), BPM: 200},
		{MeasuredAt: t0(120), BPM: 150},
	}
	_, avg, max := ZoneBreakdown(samples, 200)
	if avg != 150 { // (100+200+150)/3
		t.Errorf("avg = %v, want 150", avg)
	}
	if max != 200 {
		t.Errorf("max = %v, want 200", max)
	}
}

func TestZoneBreakdown_UnsortedInputIsSortedFirst(t *testing.T) {
	// Deliberately out of order.
	samples := []HRSample{
		{MeasuredAt: t0(120), BPM: 200}, // zone 5 (100%)
		{MeasuredAt: t0(0), BPM: 100},   // zone 1 (50%)
		{MeasuredAt: t0(60), BPM: 100},  // zone 1 (50%)
	}
	zones, _, _ := ZoneBreakdown(samples, 200)
	// Sorted: t0..t60 at 100bpm (zone1, 1 minute), t60..t120 at 100bpm
	// (zone1, 1 minute) -- both intervals attributed to zone 1, the FIRST
	// sample of each pair, not zone 5.
	if zones[0] != 2 {
		t.Errorf("zone1 minutes = %v, want 2 (order-independent)", zones[0])
	}
	for i := 1; i < 5; i++ {
		if zones[i] != 0 {
			t.Errorf("zone%d minutes = %v, want 0", i+1, zones[i])
		}
	}
}

func TestZoneBreakdown_AttributesIntervalToFirstSamplesZone(t *testing.T) {
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 180},   // zone 5 (90% of 200)
		{MeasuredAt: t0(120), BPM: 100}, // zone 1 -- but this is the LAST sample, contributes no interval
	}
	zones, _, _ := ZoneBreakdown(samples, 200)
	if zones[4] != 2 { // 2 minutes at zone 5
		t.Errorf("zone5 minutes = %v, want 2", zones[4])
	}
	if zones[0] != 0 {
		t.Errorf("zone1 minutes = %v, want 0 (last sample starts no interval)", zones[0])
	}
}

func TestZoneBreakdown_GapAtThresholdIsCounted(t *testing.T) {
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 150}, // zone 3 (75%)
		{MeasuredAt: t0(0).Add(maxSampleGapForZoneAttribution), BPM: 150},
	}
	zones, _, _ := ZoneBreakdown(samples, 200)
	if zones[2] != 6 { // exactly at the boundary: still counted
		t.Errorf("zone3 minutes = %v, want 6 (gap exactly at threshold must count)", zones[2])
	}
}

func TestZoneBreakdown_GapPastThresholdIsSkipped(t *testing.T) {
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 150},
		{MeasuredAt: t0(0).Add(maxSampleGapForZoneAttribution + time.Second), BPM: 150},
	}
	zones, _, _ := ZoneBreakdown(samples, 200)
	if zones != ([5]float64{}) {
		t.Errorf("zones = %v, want all zero -- gap past threshold must not be attributed", zones)
	}
}

func TestZoneBreakdown_NoHRMaxLeavesZonesZeroButKeepsAvgMax(t *testing.T) {
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 150},
		{MeasuredAt: t0(60), BPM: 170},
	}
	zones, avg, max := ZoneBreakdown(samples, 0)
	if zones != ([5]float64{}) {
		t.Errorf("zones = %v, want all zero with no HRmax", zones)
	}
	if avg != 160 || max != 170 {
		t.Errorf("avg/max = %v/%v, want 160/170 (no HRmax needed for these)", avg, max)
	}
}

func TestZoneBreakdown_NegativeOrZeroGapIsSkipped(t *testing.T) {
	// Two samples with the identical timestamp -- a zero-length interval
	// contributes nothing, and must not be silently treated as a huge
	// negative-duration credit either.
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 150},
		{MeasuredAt: t0(0), BPM: 190},
	}
	zones, _, _ := ZoneBreakdown(samples, 200)
	if zones != ([5]float64{}) {
		t.Errorf("zones = %v, want all zero for a zero-length interval", zones)
	}
}

func TestCompute_NoSamplesForcesHRSourceNone(t *testing.T) {
	m := Compute(nil, 200, HRMaxSourceEstimated, HRSourceWorkout) // caller claims high confidence
	if m.HRSource != HRSourceNone {
		t.Errorf("HRSource = %v, want HRSourceNone -- must never trust a hint past the data", m.HRSource)
	}
	if m.SampleCount != 0 {
		t.Errorf("SampleCount = %v, want 0", m.SampleCount)
	}
	if m.AvgHRBPM != nil || m.MaxHRBPM != nil || m.TRIMP != nil {
		t.Error("Avg/Max/TRIMP must all be nil with zero samples")
	}
	if m.HRMaxBPM != nil || m.HRMaxSource != nil {
		t.Errorf("HRMaxBPM/HRMaxSource = %v/%v, want nil/nil with zero samples", m.HRMaxBPM, m.HRMaxSource)
	}
	if m.TimeInZones == nil || len(m.TimeInZones) != 0 {
		t.Errorf("TimeInZones = %v, want a non-nil empty map", m.TimeInZones)
	}
}

func TestCompute_UsesTheHintWhenSamplesArePresent(t *testing.T) {
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 150},
		{MeasuredAt: t0(600), BPM: 160},
	}
	m := Compute(samples, 200, HRMaxSourceEstimated, HRSourceWindow)
	if m.HRSource != HRSourceWindow {
		t.Errorf("HRSource = %v, want HRSourceWindow", m.HRSource)
	}
	if m.SampleCount != 2 {
		t.Errorf("SampleCount = %v, want 2", m.SampleCount)
	}
}

func TestCompute_NoHRMaxLeavesTRIMPAndZonesAbsentButKeepsAvgMax(t *testing.T) {
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 150},
		{MeasuredAt: t0(600), BPM: 160},
	}
	m := Compute(samples, 0, HRMaxSourceEstimated, HRSourceWindow)
	if m.TRIMP != nil {
		t.Errorf("TRIMP = %v, want nil -- cannot compute without HRmax", *m.TRIMP)
	}
	if len(m.TimeInZones) != 0 {
		t.Errorf("TimeInZones = %v, want empty -- cannot classify without HRmax", m.TimeInZones)
	}
	if m.AvgHRBPM == nil || *m.AvgHRBPM != 155 {
		t.Errorf("AvgHRBPM should still be reported: got %v, want 155", m.AvgHRBPM)
	}
	if m.HRMaxBPM != nil || m.HRMaxSource != nil {
		t.Errorf("HRMaxBPM/HRMaxSource = %v/%v, want nil/nil -- hrMaxBPM <= 0 classified nothing",
			m.HRMaxBPM, m.HRMaxSource)
	}
}

func TestCompute_TimeInZonesAndTRIMPAgree(t *testing.T) {
	// 5-minute gap: within maxSampleGapForZoneAttribution (6 minutes), so
	// the interval is attributed rather than skipped.
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 180},                                  // zone 5
		{MeasuredAt: t0(int(5 * time.Minute / time.Second)), BPM: 100}, // zone 1, ends the interval
	}
	m := Compute(samples, 200, HRMaxSourceEstimated, HRSourceWindow)
	if m.TimeInZones["5"] != 5 {
		t.Errorf(`TimeInZones["5"] = %v, want 5`, m.TimeInZones["5"])
	}
	wantTRIMP := 5.0 * 5 // 5 minutes at zone 5's weight
	if m.TRIMP == nil || *m.TRIMP != wantTRIMP {
		t.Errorf("TRIMP = %v, want %v", m.TRIMP, wantTRIMP)
	}
}

func TestCompute_TRIMPZeroInputsMatchesEdwardsFormulaDirectly(t *testing.T) {
	// Cross-check: Compute's derived TRIMP must equal calling TRIMP()
	// directly on the same zone breakdown -- guards against the two ever
	// drifting apart.
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 110},                                   // zone 1
		{MeasuredAt: t0(int(5 * time.Minute / time.Second)), BPM: 130},  // zone 3
		{MeasuredAt: t0(int(15 * time.Minute / time.Second)), BPM: 190}, // zone 5
		{MeasuredAt: t0(int(20 * time.Minute / time.Second)), BPM: 100}, // ends last interval
	}
	zones, _, _ := ZoneBreakdown(samples, 200)
	want := TRIMP(zones)
	m := Compute(samples, 200, HRMaxSourceEstimated, HRSourceWindow)
	if m.TRIMP == nil || !almostEqual(*m.TRIMP, want) {
		t.Errorf("Compute TRIMP = %v, want %v (from ZoneBreakdown+TRIMP directly)", m.TRIMP, want)
	}
}

// N483/#833: the whole point of this ticket -- a row that DID classify
// zones must record which HRmax and which provenance did it, byte for byte
// what the caller supplied, so a later reader can tell an estimated row from
// an observed one without re-deriving anything.
func TestCompute_RecordsHRMaxAndSourceWhenZonesAreClassified(t *testing.T) {
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 150},
		{MeasuredAt: t0(600), BPM: 160},
	}
	m := Compute(samples, 187.5, HRMaxSourceObserved, HRSourceWindow)
	if m.HRMaxBPM == nil || *m.HRMaxBPM != 187.5 {
		t.Fatalf("HRMaxBPM = %v, want 187.5", m.HRMaxBPM)
	}
	if m.HRMaxSource == nil || *m.HRMaxSource != HRMaxSourceObserved {
		t.Fatalf("HRMaxSource = %v, want HRMaxSourceObserved", m.HRMaxSource)
	}
}

func TestCompute_RecordsEstimatedSourceDistinctlyFromObserved(t *testing.T) {
	samples := []HRSample{
		{MeasuredAt: t0(0), BPM: 150},
		{MeasuredAt: t0(600), BPM: 160},
	}
	m := Compute(samples, 200, HRMaxSourceEstimated, HRSourceWindow)
	if m.HRMaxSource == nil || *m.HRMaxSource != HRMaxSourceEstimated {
		t.Fatalf("HRMaxSource = %v, want HRMaxSourceEstimated", m.HRMaxSource)
	}
}

func almostEqual(a, b float64) bool { return math.Abs(a-b) < 1e-9 }
