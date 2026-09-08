package biometric

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// N528/#958 — the merge rule applied through the real ComputeSessionMetrics
// path: the direct samples' provenance lands in session_metrics, survives a
// read-back, and a session without a monitor is exactly as before.

func bleSample(id string, measuredAt time.Time, bpm float64) Sample {
	return Sample{
		ID: id, MetricType: MetricHeartRate, Source: SourceHRMonitor,
		SourcePlatform: PlatformBluetooth, Value: bpm, Unit: "bpm", MeasuredAt: measuredAt,
	}
}

func TestPutSamples_AcceptsBluetoothPlatform(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_bio_ble_put"
	cleanupSamples(t, pool, user)
	saved, err := repo.PutSamples(ctx, user, []Sample{bleSample("bio-ble-put-1", time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC), 140)})
	if err != nil {
		t.Fatalf("put bluetooth sample: %v", err)
	}
	if len(saved) != 1 || saved[0].SourcePlatform != PlatformBluetooth || saved[0].Source != SourceHRMonitor {
		t.Fatalf("saved = %+v, want one bluetooth/hr_monitor sample", saved)
	}
}

func TestComputeSessionMetrics_DirectSamplesWinAndHealthFillsTheGap(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-ble-merge", "user_bio_ble_merge"
	cleanupSamples(t, pool, user)
	start := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	end := start.Add(10 * time.Minute)
	seedSession(t, pool, id, user, start, end)

	// Direct stream for the first five minutes, then the link dies; Apple
	// Health has the whole session (the watch kept recording, and Zepp
	// synced later). Health samples inside the live stream must be ignored;
	// the ones in the dead five minutes must fill it.
	in := []Sample{
		bleSample("ble-1", start, 150),
		bleSample("ble-2", start.Add(1*time.Minute), 152),
		bleSample("ble-3", start.Add(2*time.Minute), 154),
		bleSample("ble-4", start.Add(5*time.Minute), 156),
		hrSample("hk-1", start.Add(30*time.Second), 90),               // inside a 60s direct gap -> filled (gap > 30s)
		hrSample("hk-2", start.Add(2*time.Minute+10*time.Second), 91), // inside the 3-minute direct gap -> filled
		hrSample("hk-3", start.Add(7*time.Minute), 160),               // tail gap -> filled
		hrSample("hk-4", start.Add(9*time.Minute), 158),               // tail gap -> filled
	}
	if _, err := repo.PutSamples(ctx, user, in); err != nil {
		t.Fatalf("seed samples: %v", err)
	}

	m, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow, nil, nil)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if m.HRDirectCount != 4 {
		t.Fatalf("hr_direct_count = %d, want 4", m.HRDirectCount)
	}
	// 4 direct + 4 health kept (hk-1 sits in a 60s gap, hk-2 in a 180s gap,
	// hk-3/hk-4 in the 5-minute tail) = 8.
	if m.SampleCount != 8 {
		t.Fatalf("sample_count = %d, want 8 (4 direct + 4 gap-filled)", m.SampleCount)
	}
	if m.MaxHRBPM == nil || *m.MaxHRBPM != 160 {
		t.Fatalf("max_hr_bpm = %v, want 160 — the tail's health samples are real evidence", m.MaxHRBPM)
	}

	// Read-back carries the provenance too — the report reads GET, not the
	// compute response.
	got, err := repo.GetSessionMetrics(ctx, user, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.HRDirectCount != 4 {
		t.Fatalf("read-back hr_direct_count = %d, want 4", got.HRDirectCount)
	}
}

func TestComputeSessionMetrics_HealthSampleInsideLiveDirectStreamIsDropped(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-ble-dense", "user_bio_ble_dense"
	cleanupSamples(t, pool, user)
	start := time.Date(2026, 9, 8, 11, 0, 0, 0, time.UTC)
	end := start.Add(1 * time.Minute)
	seedSession(t, pool, id, user, start, end)
	in := []Sample{
		bleSample("ble-d-1", start, 150),
		bleSample("ble-d-2", start.Add(20*time.Second), 152),
		bleSample("ble-d-3", start.Add(40*time.Second), 154),
		bleSample("ble-d-4", start.Add(60*time.Second), 156),
		hrSample("hk-d-1", start.Add(10*time.Second), 250), // would be the max if it leaked in
	}
	if _, err := repo.PutSamples(ctx, user, in); err != nil {
		t.Fatalf("seed samples: %v", err)
	}
	m, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow, nil, nil)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if m.SampleCount != 4 || m.HRDirectCount != 4 {
		t.Fatalf("sample_count/direct = %d/%d, want 4/4", m.SampleCount, m.HRDirectCount)
	}
	if m.MaxHRBPM == nil || *m.MaxHRBPM != 156 {
		t.Fatalf("max_hr_bpm = %v, want 156 — the health sample inside the live stream must not leak in", m.MaxHRBPM)
	}
}

func TestComputeSessionMetrics_NoMonitorIsUnchanged(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-ble-none", "user_bio_ble_none"
	cleanupSamples(t, pool, user)
	start := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	end := start.Add(10 * time.Minute)
	seedSession(t, pool, id, user, start, end)
	if _, err := repo.PutSamples(ctx, user, []Sample{
		hrSample("hk-n-1", start, 180),
		hrSample("hk-n-2", start.Add(5*time.Minute), 100),
		hrSample("hk-n-3", start.Add(10*time.Minute), 100),
	}); err != nil {
		t.Fatalf("seed samples: %v", err)
	}
	m, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow, nil, nil)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if m.SampleCount != 3 || m.HRDirectCount != 0 {
		t.Fatalf("no-monitor session: count/direct = %d/%d, want 3/0", m.SampleCount, m.HRDirectCount)
	}
	wantTRIMP := 5.0*5 + 5.0*1 // identical to TestComputeSessionMetrics_HappyPath
	if m.TRIMP == nil || *m.TRIMP != wantTRIMP {
		t.Fatalf("trimp = %v, want %v — the pre-N528 arithmetic must be untouched", m.TRIMP, wantTRIMP)
	}
}

func TestListExerciseHR_DirectStreamWinsPerExerciseToo(t *testing.T) {
	// The per-exercise read applies the same rule as the session's metrics:
	// a health-store sample inside a live direct stream must not leak into
	// an exercise's max, or the two numbers on one screen would disagree
	// about where they came from.
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-exhr-ble", "user_bio_exhr_ble"
	const ex = "bio_fx_ex_ble_squat"
	start := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	end := start.Add(30 * time.Minute)
	seedSession(t, pool, id, user, start, end)
	cleanupSamples(t, pool, user)
	seedSets(t, pool, user, id, []fixtureSet{
		{ExerciseID: ex, Position: 0, Completed: true, PerformedAt: at(start, 5)},
		{ExerciseID: ex, Position: 1, Completed: true, PerformedAt: at(start, 8)},
		{ExerciseID: ex, Position: 2, Completed: true, PerformedAt: at(start, 11)},
	})
	// A dense direct stream, one sample every 20s across the whole exercise
	// window — no gap ever reaches the 30s threshold.
	var in []Sample
	for sec := 0; sec <= 12*60; sec += 20 {
		in = append(in, bleSample(fmt.Sprintf("exhr-ble-%d", sec), start.Add(time.Duration(sec)*time.Second), 150))
	}
	// And one Apple Health reading in the middle of it that would become the
	// max if the rule were skipped here.
	in = append(in, hrSample("exhr-hk-spike", start.Add(6*time.Minute+10*time.Second), 250))
	if _, err := repo.PutSamples(ctx, user, in); err != nil {
		t.Fatalf("seed samples: %v", err)
	}
	got, err := repo.ListExerciseHR(ctx, user, id)
	if err != nil {
		t.Fatalf("list exercise hr: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d exercises, want 1: %+v", len(got), got)
	}
	if got[0].MaxHRBPM != 150 {
		t.Fatalf("max_hr_bpm = %v, want 150 — the health spike inside the live direct stream leaked into the per-exercise read", got[0].MaxHRBPM)
	}
}
