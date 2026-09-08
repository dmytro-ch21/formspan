package biometric

import (
	"testing"
	"time"
)

// N528/#958 — the direct-wins / Health-fills-gaps rule, on its own.

var mergeBase = time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)

func direct(sec int, bpm float64) HRSample {
	return HRSample{MeasuredAt: mergeBase.Add(time.Duration(sec) * time.Second), BPM: bpm, Platform: PlatformBluetooth}
}

func health(sec int, bpm float64) HRSample {
	return HRSample{MeasuredAt: mergeBase.Add(time.Duration(sec) * time.Second), BPM: bpm, Platform: PlatformHealthKit}
}

func secondsOf(samples []HRSample) []int {
	out := make([]int, len(samples))
	for i, s := range samples {
		out[i] = int(s.MeasuredAt.Sub(mergeBase) / time.Second)
	}
	return out
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestMergeHRSources(t *testing.T) {
	const threshold = 30 * time.Second
	start, end := mergeBase, mergeBase.Add(10*time.Minute)

	cases := []struct {
		name       string
		in         []HRSample
		wantSecs   []int
		wantDirect int
		wantFilled int
	}{
		{
			name:     "no direct samples: health samples pass through untouched, no provenance",
			in:       []HRSample{health(0, 120), health(5, 122), health(10, 125)},
			wantSecs: []int{0, 5, 10},
		},
		{
			name:       "direct only: all kept, all direct",
			in:         []HRSample{direct(0, 130), direct(5, 131)},
			wantSecs:   []int{0, 5},
			wantDirect: 2,
		},
		{
			name: "health sample between two direct samples closer than the threshold is dropped",
			in:   []HRSample{direct(0, 130), health(10, 99), direct(20, 132)},
			// The direct stream covered that span; the health reading would only
			// interleave a second device over the same heartbeat.
			wantSecs:   []int{0, 20},
			wantDirect: 2,
		},
		{
			name:       "gap exactly at the threshold is NOT a gap (strictly longer required)",
			in:         []HRSample{direct(0, 130), health(15, 99), direct(30, 132)},
			wantSecs:   []int{0, 30},
			wantDirect: 2,
		},
		{
			name:       "gap one second past the threshold: the health samples inside it fill it",
			in:         []HRSample{direct(0, 130), health(10, 99), health(20, 98), direct(31, 132)},
			wantSecs:   []int{0, 10, 20, 31},
			wantDirect: 2, wantFilled: 2,
		},
		{
			name:       "a health sample at the same instant as a direct one sits in a zero-length gap and is dropped",
			in:         []HRSample{direct(0, 130), health(0, 99), direct(60, 132), health(60, 98)},
			wantSecs:   []int{0, 60},
			wantDirect: 2,
		},
		{
			name:       "link died before the end: the tail gap (last direct to window end) is filled from health",
			in:         []HRSample{direct(0, 130), direct(10, 131), health(300, 140), health(420, 138)},
			wantSecs:   []int{0, 10, 300, 420},
			wantDirect: 2, wantFilled: 2,
		},
		{
			name:       "link connected late: the head gap (window start to first direct) is filled from health",
			in:         []HRSample{health(5, 110), health(60, 115), direct(120, 130), direct(125, 131)},
			wantSecs:   []int{5, 60, 120, 125},
			wantDirect: 2, wantFilled: 2,
		},
		{
			name:       "short head gap (under threshold) is not filled",
			in:         []HRSample{health(5, 110), direct(20, 130), direct(25, 131)},
			wantSecs:   []int{20, 25},
			wantDirect: 2,
		},
		{
			name:       "unsorted input: result is sorted by time",
			in:         []HRSample{direct(120, 132), health(300, 140), direct(0, 130)},
			wantSecs:   []int{0, 120, 300},
			wantDirect: 2, wantFilled: 1,
		},
		{
			name:     "empty input",
			in:       nil,
			wantSecs: []int{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, prov := MergeHRSources(tc.in, start, end, threshold)
			if !equalInts(secondsOf(got), tc.wantSecs) {
				t.Fatalf("kept sample times = %v, want %v", secondsOf(got), tc.wantSecs)
			}
			if prov.DirectCount != tc.wantDirect || prov.FilledCount != tc.wantFilled {
				t.Fatalf("provenance = %+v, want direct=%d filled=%d", prov, tc.wantDirect, tc.wantFilled)
			}
		})
	}
}

func TestMergeHRSources_NoDirectReturnsTheInputSliceItself(t *testing.T) {
	// The pass-through contract: a pre-N528 session is computed from exactly
	// what it was computed from before — not a copy, not re-sorted, nothing.
	in := []HRSample{health(10, 120), health(0, 118)}
	got, prov := MergeHRSources(in, mergeBase, mergeBase.Add(time.Minute), DirectGapFillThreshold)
	if len(got) != 2 || &got[0] != &in[0] {
		t.Fatalf("expected the input slice back unchanged, got %v", secondsOf(got))
	}
	if prov != (HRProvenance{}) {
		t.Fatalf("provenance = %+v, want zero", prov)
	}
}

func TestMergeHRSources_UnknownWindowKeepsEveryHealthSampleOutsideTheDirectSpan(t *testing.T) {
	// Zero window bounds: the edges are unbounded gaps, so health samples
	// before the first / after the last direct sample are kept regardless
	// of distance — the conservative reading when the caller has no window.
	in := []HRSample{health(0, 110), direct(5, 130), direct(10, 131), health(12, 112)}
	got, prov := MergeHRSources(in, time.Time{}, time.Time{}, DirectGapFillThreshold)
	if !equalInts(secondsOf(got), []int{0, 5, 10, 12}) {
		t.Fatalf("kept = %v, want all four", secondsOf(got))
	}
	if prov.FilledCount != 2 {
		t.Fatalf("filled = %d, want 2", prov.FilledCount)
	}
}

func TestMergeHRSources_DoesNotMutateItsInput(t *testing.T) {
	in := []HRSample{direct(120, 132), health(300, 140), direct(0, 130)}
	before := secondsOf(in)
	MergeHRSources(in, mergeBase, mergeBase.Add(10*time.Minute), DirectGapFillThreshold)
	if !equalInts(secondsOf(in), before) {
		t.Fatalf("input reordered: %v, was %v", secondsOf(in), before)
	}
}

func TestSourcePlatformBluetoothIsValid(t *testing.T) {
	if !PlatformBluetooth.Valid() {
		t.Fatal("bluetooth must validate — PutSamples would refuse every direct recording otherwise")
	}
	found := false
	for _, p := range SourcePlatforms() {
		if p == PlatformBluetooth {
			found = true
		}
	}
	if !found {
		t.Fatal("SourcePlatforms() must list bluetooth")
	}
	if SourcePlatform("ble").Valid() {
		t.Fatal("only the exact spelling is accepted")
	}
}

func TestDirectGapFillThresholdIsANamedThirtySeconds(t *testing.T) {
	// The ticket asks for the threshold to be a named constant; pin the value
	// so a change to it is a deliberate edit to this test as well.
	if DirectGapFillThreshold != 30*time.Second {
		t.Fatalf("DirectGapFillThreshold = %v, want 30s", DirectGapFillThreshold)
	}
}

func TestSampleValidate_AcceptsAnHRMonitorSampleFromBluetooth(t *testing.T) {
	// Validate is what the handler runs on every PutSamples body — a
	// vocabulary that forgot either half would refuse every direct recording
	// with invalid_input, silently, from the athlete's point of view.
	s := Sample{
		ID: "ble-validate-1", MetricType: MetricHeartRate, Source: SourceHRMonitor,
		SourcePlatform: PlatformBluetooth, Value: 140, Unit: "bpm",
		MeasuredAt: time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC),
	}
	if err := s.Validate(); err != nil {
		t.Fatalf("Validate() = %v, want nil for a bluetooth/hr_monitor sample", err)
	}
	s.Source = Source("amazfit")
	if err := s.Validate(); err == nil {
		t.Fatal("an unknown source must still be refused — the vocabulary is closed on purpose")
	}
}

func TestSampleValidate_BluetoothAndHRMonitorGoTogether(t *testing.T) {
	base := Sample{
		ID: "ble-pair-1", MetricType: MetricHeartRate, Value: 140, Unit: "bpm",
		MeasuredAt: time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC),
	}
	cases := []struct {
		name     string
		source   Source
		platform SourcePlatform
		wantOK   bool
	}{
		{"bluetooth + hr_monitor", SourceHRMonitor, PlatformBluetooth, true},
		{"bluetooth + apple_watch — platform claims direct, source says otherwise", SourceAppleWatch, PlatformBluetooth, false},
		{"healthkit + hr_monitor — source claims a monitor, platform says a health store", SourceHRMonitor, PlatformHealthKit, false},
		{"healthkit + apple_watch — untouched pre-N528 pair", SourceAppleWatch, PlatformHealthKit, true},
		{"health_connect + android_wearable — untouched pre-N528 pair", SourceAndroidWearable, PlatformHealthConnect, true},
		{"manual + manual — untouched pre-N528 pair", SourceManual, PlatformManual, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := base
			s.Source, s.SourcePlatform = tc.source, tc.platform
			err := s.Validate()
			if (err == nil) != tc.wantOK {
				t.Fatalf("Validate() = %v, want ok=%v", err, tc.wantOK)
			}
		})
	}
}
