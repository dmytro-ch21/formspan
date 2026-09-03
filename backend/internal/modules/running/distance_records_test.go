package running

import (
	"math"
	"testing"
	"time"
)

// kmSplits builds n splits of exactly 1000m each, at secPerKm seconds apiece
// — the common "auto-split every kilometre" shape this module is built
// around.
func kmSplits(n int, secPerKm int) []Split {
	out := make([]Split, n)
	for i := range out {
		out[i] = Split{DistanceM: 1000, DurationSeconds: secPerKm}
	}
	return out
}

func almostEqual(a, b float64) bool {
	return math.Abs(a-b) < 1e-6
}

func TestBestDistanceWindows(t *testing.T) {
	t.Run("exact match", func(t *testing.T) {
		// 5 splits of exactly 1000m each is exactly 5000m — the "5k" target
		// with zero drift.
		splits := kmSplits(5, 240) // 4:00/km => 20:00 5k
		got := BestDistanceWindows(splits)
		w, ok := got["5k"]
		if !ok {
			t.Fatal("expected a 5k match on an exact 5000m window")
		}
		if w.StartSplit != 0 || w.EndSplit != 4 {
			t.Fatalf("window = [%d,%d], want [0,4]", w.StartSplit, w.EndSplit)
		}
		if !almostEqual(w.ActualDistanceM, 5000) {
			t.Fatalf("actual distance = %v, want 5000", w.ActualDistanceM)
		}
		if !almostEqual(w.ActualDurationSeconds, 1200) {
			t.Fatalf("actual duration = %v, want 1200", w.ActualDurationSeconds)
		}
		if !almostEqual(w.NormalizedDurationSeconds, 1200) {
			t.Fatalf("normalized duration = %v, want 1200 (exact distance needs no scaling)", w.NormalizedDurationSeconds)
		}
	})

	t.Run("just under the tolerance ceiling still matches", func(t *testing.T) {
		// 1% of 5000m is 50m, so the acceptable range is [4950, 5050]. A
		// window of 5049m sits just inside it.
		splits := []Split{
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1049, DurationSeconds: 252}, // total 5049m
		}
		got := BestDistanceWindows(splits)
		w, ok := got["5k"]
		if !ok {
			t.Fatal("expected a 5k match on a 5049m window (just inside +1% tolerance)")
		}
		if !almostEqual(w.ActualDistanceM, 5049) {
			t.Fatalf("actual distance = %v, want 5049", w.ActualDistanceM)
		}
	})

	t.Run("just over the tolerance ceiling does not match", func(t *testing.T) {
		// One metre further out: 5051m, just outside [4950, 5050].
		splits := []Split{
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1051, DurationSeconds: 252}, // total 5051m
		}
		got := BestDistanceWindows(splits)
		if w, ok := got["5k"]; ok {
			t.Fatalf("expected no 5k match on a 5051m window (just outside +1%% tolerance), got %+v", w)
		}
	})

	t.Run("just under the tolerance floor does not match", func(t *testing.T) {
		// [4950, 5050]; 4949m sits just outside the floor.
		splits := []Split{
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 1000, DurationSeconds: 240},
			{DistanceM: 949, DurationSeconds: 228}, // total 4949m
		}
		got := BestDistanceWindows(splits)
		if w, ok := got["5k"]; ok {
			t.Fatalf("expected no 5k match on a 4949m window (just outside -1%% tolerance), got %+v", w)
		}
	})

	t.Run("multiple candidate windows in one long run picks the fastest", func(t *testing.T) {
		// A 10km run as ten 1km splits, alternating pace so several
		// contiguous 5-split windows fall within 5k tolerance (all exactly
		// 5000m, since every split is exactly 1000m) — the fastest of them
		// must win.
		splits := []Split{
			{DistanceM: 1000, DurationSeconds: 300}, // 0
			{DistanceM: 1000, DurationSeconds: 300}, // 1
			{DistanceM: 1000, DurationSeconds: 220}, // 2 \
			{DistanceM: 1000, DurationSeconds: 220}, // 3  | fastest 5-window: 2-6
			{DistanceM: 1000, DurationSeconds: 220}, // 4  | = 1100s
			{DistanceM: 1000, DurationSeconds: 220}, // 5  |
			{DistanceM: 1000, DurationSeconds: 220}, // 6 /
			{DistanceM: 1000, DurationSeconds: 300}, // 7
			{DistanceM: 1000, DurationSeconds: 300}, // 8
			{DistanceM: 1000, DurationSeconds: 300}, // 9
		}
		got := BestDistanceWindows(splits)
		w, ok := got["5k"]
		if !ok {
			t.Fatal("expected a 5k match")
		}
		if w.StartSplit != 2 || w.EndSplit != 6 {
			t.Fatalf("fastest window = [%d,%d], want [2,6]", w.StartSplit, w.EndSplit)
		}
		if !almostEqual(w.ActualDurationSeconds, 1100) {
			t.Fatalf("fastest window duration = %v, want 1100", w.ActualDurationSeconds)
		}
	})

	t.Run("no match when the run is shorter than every standard distance", func(t *testing.T) {
		splits := kmSplits(3, 300) // 3km total — short of even a 5k by a lot
		got := BestDistanceWindows(splits)
		if len(got) != 0 {
			t.Fatalf("expected no matches on a 3km run, got %+v", got)
		}
	})

	t.Run("empty splits produce no matches", func(t *testing.T) {
		got := BestDistanceWindows(nil)
		if len(got) != 0 {
			t.Fatalf("expected no matches on no splits, got %+v", got)
		}
	})

	t.Run("half marathon matches a whole-kilometre-split run within tolerance", func(t *testing.T) {
		// 21 one-kilometre splits sum to 21,000m against the true half
		// marathon distance of 21,097.5m — a 97.5m gap from split-boundary
		// rounding alone, comfortably inside the ±210.975m (1%) tolerance.
		splits := kmSplits(21, 300)
		got := BestDistanceWindows(splits)
		w, ok := got["half_marathon"]
		if !ok {
			t.Fatal("expected a half_marathon match on 21 whole-km splits")
		}
		if w.StartSplit != 0 || w.EndSplit != 20 {
			t.Fatalf("window = [%d,%d], want [0,20]", w.StartSplit, w.EndSplit)
		}
	})

	t.Run("marathon matches a whole-kilometre-split run within tolerance", func(t *testing.T) {
		// 42 splits sum to 42,000m against the true 42,195m marathon
		// distance — a 195m gap, inside the ±421.95m (1%) tolerance.
		splits := kmSplits(42, 300)
		got := BestDistanceWindows(splits)
		if _, ok := got["marathon"]; !ok {
			t.Fatal("expected a marathon match on 42 whole-km splits")
		}
	})

	t.Run("normalization scales an off-target window's duration to the exact standard distance", func(t *testing.T) {
		// A single 5040m split (within the +1% / +50m tolerance of 5000m)
		// run in 1008s has a pace of 0.2 s/m; projected onto exactly 5000m
		// that is 1000s — not the raw 1008s the window itself took.
		splits := []Split{{DistanceM: 5040, DurationSeconds: 1008}}
		got := BestDistanceWindows(splits)
		w, ok := got["5k"]
		if !ok {
			t.Fatal("expected a 5k match on a 5040m single split")
		}
		if !almostEqual(w.ActualDurationSeconds, 1008) {
			t.Fatalf("actual duration = %v, want 1008 (unnormalized)", w.ActualDurationSeconds)
		}
		if !almostEqual(w.NormalizedDurationSeconds, 1000) {
			t.Fatalf("normalized duration = %v, want 1000", w.NormalizedDurationSeconds)
		}
	})
}

func TestBestDistanceRecords(t *testing.T) {
	t.Run("picks the faster of two runs for the same standard distance", func(t *testing.T) {
		slow := RunSplits{
			SessionID: "ses-slow",
			Splits:    kmSplits(5, 300), // 25:00 5k
			StartedAt: time.Now().Add(-30 * 24 * time.Hour),
		}
		fast := RunSplits{
			SessionID: "ses-fast",
			Splits:    kmSplits(5, 240), // 20:00 5k
			StartedAt: time.Now().Add(-1 * time.Hour),
		}
		got := BestDistanceRecords([]RunSplits{slow, fast})
		if len(got) != 1 {
			t.Fatalf("got %d records, want 1", len(got))
		}
		r := got[0]
		if r.SessionID != "ses-fast" {
			t.Fatalf("winning session = %q, want ses-fast", r.SessionID)
		}
		if !almostEqual(r.ValueSeconds, 1200) {
			t.Fatalf("value_seconds = %v, want 1200", r.ValueSeconds)
		}
		if !r.IsRecent {
			t.Fatal("expected the winning (1-hour-old) run to be flagged recent")
		}
	})

	t.Run("an older PR is not recent even if it still wins", func(t *testing.T) {
		only := RunSplits{
			SessionID: "ses-old",
			Splits:    kmSplits(5, 240),
			StartedAt: time.Now().Add(-30 * 24 * time.Hour),
		}
		got := BestDistanceRecords([]RunSplits{only})
		if len(got) != 1 {
			t.Fatalf("got %d records, want 1", len(got))
		}
		if got[0].IsRecent {
			t.Fatal("expected a 30-day-old record to NOT be flagged recent")
		}
	})

	t.Run("results are ordered by increasing standard distance regardless of input order", func(t *testing.T) {
		run := RunSplits{
			SessionID: "ses-marathon",
			Splits:    kmSplits(42, 300),
			StartedAt: time.Now(),
		}
		got := BestDistanceRecords([]RunSplits{run})
		wantOrder := []string{"5k", "10k", "half_marathon", "marathon"}
		if len(got) != len(wantOrder) {
			t.Fatalf("got %d records, want %d", len(got), len(wantOrder))
		}
		for i, key := range wantOrder {
			if got[i].Standard.Key != key {
				t.Fatalf("records[%d].Standard.Key = %q, want %q", i, got[i].Standard.Key, key)
			}
		}
	})

	t.Run("no runs produce no records", func(t *testing.T) {
		got := BestDistanceRecords(nil)
		if len(got) != 0 {
			t.Fatalf("got %d records, want 0", len(got))
		}
	})

	t.Run("a run with no qualifying window contributes nothing", func(t *testing.T) {
		short := RunSplits{SessionID: "ses-short", Splits: kmSplits(2, 300), StartedAt: time.Now()}
		got := BestDistanceRecords([]RunSplits{short})
		if len(got) != 0 {
			t.Fatalf("got %d records from a 2km run, want 0", len(got))
		}
	})
}

func TestStandardDistancesReturnsACopy(t *testing.T) {
	got := StandardDistances()
	if len(got) != 4 {
		t.Fatalf("got %d standard distances, want 4", len(got))
	}
	got[0].Key = "mutated"
	if standardDistances[0].Key == "mutated" {
		t.Fatal("mutating the returned slice mutated the package's own registry")
	}
}
