package biometric

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// Mirrors running/postgres_test.go's structure and intent — see that file
// for the fuller argument behind each shape of case. Restated here rather
// than imported so this package stands alone.

func newTestRepo(t *testing.T) (*PostgresRepository, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	pool, err := database.NewPool(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered first so it closes LAST under LIFO cleanup — every other
	// t.Cleanup below still needs the pool open. See CLAUDE.md.
	t.Cleanup(pool.Close)
	return NewPostgresRepository(pool), pool
}

// seedSession writes a real `sessions` row spanning [startedAt, endedAt) —
// ComputeSessionMetrics needs the owner FK AND a finished window to exist.
func seedSession(t *testing.T, pool *pgxpool.Pool, id, userID string, startedAt, endedAt time.Time) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, sport, name, started_at, ended_at)
		VALUES ($1, $2, 'strength', 'Test session', $3, $4)`,
		id, userID, startedAt, endedAt)
	if err != nil {
		t.Fatalf("seed session: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id); err != nil {
			t.Logf("cleanup %s: %v", id, err)
		}
	})
}

// seedSessionSport is seedSession with a caller-chosen sport — needed for
// ListSessionLoad's cross-sport tests, where seedSession's hardcoded
// 'strength' would defeat the point.
func seedSessionSport(t *testing.T, pool *pgxpool.Pool, id, userID, sport string, startedAt, endedAt time.Time) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, sport, name, started_at, ended_at)
		VALUES ($1, $2, $3, 'Test session', $4, $5)`,
		id, userID, sport, startedAt, endedAt)
	if err != nil {
		t.Fatalf("seed session: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id); err != nil {
			t.Logf("cleanup %s: %v", id, err)
		}
	})
}

// seedInProgressSession writes a session with no ended_at — the "still
// happening" state ComputeSessionMetrics must refuse.
func seedInProgressSession(t *testing.T, pool *pgxpool.Pool, id, userID string, startedAt time.Time) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, sport, name, started_at)
		VALUES ($1, $2, 'strength', 'Test session', $3)`,
		id, userID, startedAt)
	if err != nil {
		t.Fatalf("seed in-progress session: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id); err != nil {
			t.Logf("cleanup %s: %v", id, err)
		}
	})
}

// cleanupSamples registers a t.Cleanup that removes every biometric_samples
// row for the given users. Necessary because, unlike `sessions`, samples
// carry no FK back to anything this file already cleans up — they are
// independent rows scoped only by user_id (see the migration's retention
// comment: kept indefinitely, with no automatic expiry to lean on here
// either) — so a test that writes samples owns deleting them, the same
// "own the rows you write" discipline the library-fixture tests already
// follow for rows they READ.
func cleanupSamples(t *testing.T, pool *pgxpool.Pool, userIDs ...string) {
	t.Helper()
	ctx := context.Background()
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx,
			`DELETE FROM biometric_samples WHERE user_id = ANY($1)`, userIDs); err != nil {
			t.Logf("cleanup samples for %v: %v", userIDs, err)
		}
	})
}

func hrSample(id string, measuredAt time.Time, bpm float64) Sample {
	return Sample{
		ID: id, MetricType: MetricHeartRate, Source: SourceAppleWatch,
		SourcePlatform: PlatformHealthKit, Value: bpm, Unit: "bpm", MeasuredAt: measuredAt,
	}
}

// --- PutSamples / ListSamples -----------------------------------------------

func TestPutAndListSamples(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_bio_put_list"
	cleanupSamples(t, pool, user)
	base := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	in := []Sample{
		hrSample("bio-s1", base, 120),
		hrSample("bio-s2", base.Add(time.Minute), 130),
	}
	saved, err := repo.PutSamples(ctx, user, in)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if len(saved) != 2 {
		t.Fatalf("put returned %d samples, want 2", len(saved))
	}

	got, err := repo.ListSamples(ctx, user, MetricHeartRate, base.Add(-time.Hour), base.Add(time.Hour))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("list returned %d samples, want 2: %+v", len(got), got)
	}
	if got[0].ID != "bio-s1" || got[1].ID != "bio-s2" {
		t.Fatalf("list not in ascending measured_at order: %+v", got)
	}
}

func TestListSamplesExcludesOutOfRangeAndOtherMetricType(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_bio_list_range"
	cleanupSamples(t, pool, user)
	base := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	in := []Sample{
		hrSample("bio-range-in", base, 120),
		hrSample("bio-range-out", base.Add(2*time.Hour), 120), // outside the queried window
		{
			ID: "bio-range-other-metric", MetricType: MetricRestingHeartRate, Source: SourceAppleWatch,
			SourcePlatform: PlatformHealthKit, Value: 55, Unit: "bpm", MeasuredAt: base,
		},
	}
	if _, err := repo.PutSamples(ctx, user, in); err != nil {
		t.Fatalf("put: %v", err)
	}

	got, err := repo.ListSamples(ctx, user, MetricHeartRate, base.Add(-time.Minute), base.Add(time.Minute))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 || got[0].ID != "bio-range-in" {
		t.Fatalf("list = %+v, want exactly [bio-range-in]", got)
	}
}

// Idempotency: a retried sync batch (the ordinary case for this endpoint)
// must converge, not duplicate or error.
func TestPutSamplesRetryConverges(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_bio_put_retry"
	cleanupSamples(t, pool, user)
	base := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	in := []Sample{hrSample("bio-retry-1", base, 140)}

	if _, err := repo.PutSamples(ctx, user, in); err != nil {
		t.Fatalf("first put: %v", err)
	}
	saved, err := repo.PutSamples(ctx, user, in)
	if err != nil {
		t.Fatalf("retry put: %v", err)
	}
	if len(saved) != 1 || saved[0].Value != 140 {
		t.Fatalf("retry put = %+v, want the original row unchanged", saved)
	}

	got, err := repo.ListSamples(ctx, user, MetricHeartRate, base.Add(-time.Hour), base.Add(time.Hour))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d rows after a retried put, want exactly 1 (no duplicate)", len(got))
	}
}

// A submitted sample id already belonging to a DIFFERENT user must be
// refused without disclosing whose row it is, and must not leak the
// attacker's data into that id's slot — the identical IDOR shape
// activity.Create already guards.
func TestPutSamplesRefusesIDCollisionWithAnotherUser(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const owner, attacker = "user_bio_collision_owner", "user_bio_collision_attacker"
	cleanupSamples(t, pool, owner, attacker)
	base := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	if _, err := repo.PutSamples(ctx, owner, []Sample{hrSample("bio-collide-1", base, 100)}); err != nil {
		t.Fatalf("owner put: %v", err)
	}

	_, err := repo.PutSamples(ctx, attacker, []Sample{hrSample("bio-collide-1", base, 999)})
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("colliding id from another user gave %v, want ErrAlreadyExists", err)
	}

	// The owner's row must be completely unchanged.
	got, err := repo.ListSamples(ctx, owner, MetricHeartRate, base.Add(-time.Hour), base.Add(time.Hour))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 || got[0].Value != 100 {
		t.Fatalf("owner's sample after a refused collision = %+v, want value 100 unchanged", got)
	}
}

// A batch containing a mix of a fresh id and a colliding id must be refused
// WHOLESALE, not partially applied — a caller retrying a partial failure
// needs to be able to resend everything.
func TestPutSamplesRefusesWholeBatchOnAnyCollision(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const owner, attacker = "user_bio_partial_owner", "user_bio_partial_attacker"
	cleanupSamples(t, pool, owner, attacker)
	base := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	if _, err := repo.PutSamples(ctx, owner, []Sample{hrSample("bio-partial-taken", base, 100)}); err != nil {
		t.Fatalf("owner put: %v", err)
	}

	_, err := repo.PutSamples(ctx, attacker, []Sample{
		hrSample("bio-partial-fresh", base, 110),
		hrSample("bio-partial-taken", base, 999), // collides
	})
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("mixed batch gave %v, want ErrAlreadyExists", err)
	}

	// The "fresh" half must not have been committed either — the whole
	// point of refusing wholesale.
	got, err := repo.ListSamples(ctx, attacker, MetricHeartRate, base.Add(-time.Hour), base.Add(time.Hour))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %d samples for the attacker after a refused batch, want 0 (nothing partially applied)", len(got))
	}
}

// backend-reviewer, N476/#821: a retried batch that happens to name the SAME
// id twice must still converge as an ordinary idempotent retry — it must
// NOT be misread as "one of the two conflicting ids belongs to someone
// else" and refused with ErrAlreadyExists. That misreading is exactly what
// comparing a non-deduplicated missing-id count against getOwnedByIDs'
// distinct-row count produced before missingIDs deduplicated; this is the
// regression test for that fix.
func TestPutSamplesRetryWithADuplicateIDWithinTheSameBatchConverges(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_bio_dup_in_batch"
	cleanupSamples(t, pool, user)
	base := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	if _, err := repo.PutSamples(ctx, user, []Sample{hrSample("bio-dup-1", base, 120)}); err != nil {
		t.Fatalf("first put: %v", err)
	}

	// A retry batch that (for whatever client-side reason — a duplicate
	// queue entry, a re-triggered sync) names the same already-stored id
	// TWICE.
	saved, err := repo.PutSamples(ctx, user, []Sample{
		hrSample("bio-dup-1", base, 120),
		hrSample("bio-dup-1", base, 120),
	})
	if err != nil {
		t.Fatalf("retry with a duplicate id in the batch gave %v, want a converged idempotent retry", err)
	}
	if len(saved) != 1 {
		t.Fatalf("retry returned %d rows, want exactly 1 (the single owned sample)", len(saved))
	}

	got, err := repo.ListSamples(ctx, user, MetricHeartRate, base.Add(-time.Hour), base.Add(time.Hour))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d stored rows, want exactly 1 (no duplicate written)", len(got))
	}
}

// --- ComputeSessionMetrics / GetSessionMetrics ------------------------------

func TestComputeSessionMetrics_HappyPath(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-compute", "user_bio_compute"
	cleanupSamples(t, pool, user)
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	end := start.Add(10 * time.Minute)
	seedSession(t, pool, id, user, start, end)

	// 5 minutes at zone5 (180/200=90%), 5 minutes at zone1 (100/200=50%) —
	// each gap 5 minutes, within maxSampleGapForZoneAttribution (6 min).
	if _, err := repo.PutSamples(ctx, user, []Sample{
		hrSample("bio-compute-1", start, 180),
		hrSample("bio-compute-2", start.Add(5*time.Minute), 100),
		hrSample("bio-compute-3", start.Add(10*time.Minute), 100),
	}); err != nil {
		t.Fatalf("seed samples: %v", err)
	}

	m, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if m.SessionID != id {
		t.Fatalf("session_id = %q, want %q", m.SessionID, id)
	}
	if m.SampleCount != 3 {
		t.Fatalf("sample_count = %d, want 3", m.SampleCount)
	}
	if m.HRSource != HRSourceWindow {
		t.Fatalf("hr_source = %q, want window", m.HRSource)
	}
	if m.RuleVersion != RuleVersion {
		t.Fatalf("rule_version = %d, want %d", m.RuleVersion, RuleVersion)
	}
	wantTRIMP := 5.0*5 + 5.0*1 // 5 min zone5 + 5 min zone1
	if m.TRIMP == nil || *m.TRIMP != wantTRIMP {
		t.Fatalf("trimp = %v, want %v", m.TRIMP, wantTRIMP)
	}
	if m.TimeInZones["5"] != 5 || m.TimeInZones["1"] != 5 {
		t.Fatalf("time_in_zones = %+v, want zone1=5 zone5=5", m.TimeInZones)
	}
	// N483/#833: which HRmax (and its provenance) produced these zones must
	// be persisted alongside them.
	if m.HRMaxBPM == nil || *m.HRMaxBPM != 200 {
		t.Fatalf("hr_max_bpm = %v, want 200", m.HRMaxBPM)
	}
	if m.HRMaxSource == nil || *m.HRMaxSource != HRMaxSourceEstimated {
		t.Fatalf("hr_max_source = %v, want estimated", m.HRMaxSource)
	}

	// And it round-trips through GetSessionMetrics.
	got, err := repo.GetSessionMetrics(ctx, user, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.TRIMP == nil || *got.TRIMP != wantTRIMP {
		t.Fatalf("get trimp = %v, want %v", got.TRIMP, wantTRIMP)
	}
	if got.HRMaxBPM == nil || *got.HRMaxBPM != 200 {
		t.Fatalf("get hr_max_bpm = %v, want 200", got.HRMaxBPM)
	}
	if got.HRMaxSource == nil || *got.HRMaxSource != HRMaxSourceEstimated {
		t.Fatalf("get hr_max_source = %v, want estimated", got.HRMaxSource)
	}
}

// Zero samples: hr_source must be forced to 'none' even though the caller
// asked for 'window' — the honesty guarantee, proven at the storage layer
// this time rather than only in Compute's own unit tests.
func TestComputeSessionMetrics_NoSamplesForcesHRSourceNone(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-empty", "user_bio_empty"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(time.Hour))

	m, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWorkout)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if m.HRSource != HRSourceNone {
		t.Fatalf("hr_source = %q, want none (must not trust the caller's hint with zero samples)", m.HRSource)
	}
	if m.SampleCount != 0 {
		t.Fatalf("sample_count = %d, want 0", m.SampleCount)
	}
	if m.TRIMP != nil || m.AvgHRBPM != nil {
		t.Fatalf("trimp/avg should be nil with no samples: trimp=%v avg=%v", m.TRIMP, m.AvgHRBPM)
	}
	if m.HRMaxBPM != nil || m.HRMaxSource != nil {
		t.Fatalf("hr_max_bpm/hr_max_source should be nil with no samples: %v/%v", m.HRMaxBPM, m.HRMaxSource)
	}
}

func TestComputeSessionMetrics_SessionNotEndedIsInvalidInput(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-inprogress", "user_bio_inprogress"
	seedInProgressSession(t, pool, id, user, time.Now().UTC())

	_, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("compute on an in-progress session gave %v, want ErrInvalidInput", err)
	}
}

func TestComputeSessionMetrics_UnknownSessionIsNotFound(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	_, err := repo.ComputeSessionMetrics(ctx, "user_bio_ghost", "ses-does-not-exist", 200, HRMaxSourceEstimated, HRSourceWindow)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("compute against a missing session gave %v, want ErrNotFound", err)
	}
}

// Cross-user: computing against another user's session must answer
// ErrNotFound, and must not create a session_metrics row at all.
func TestComputeSessionMetrics_CannotBeComputedForAnotherUsersSession(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, owner, attacker = "ses-bio-owner", "user_bio_owner", "user_bio_attacker"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, owner, start, start.Add(time.Hour))

	_, err := repo.ComputeSessionMetrics(ctx, attacker, id, 200, HRMaxSourceEstimated, HRSourceWindow)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("computing against another user's session gave %v, want ErrNotFound", err)
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM session_metrics WHERE session_id = $1`, id).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("%d session_metrics rows exist after a refused cross-user compute", n)
	}
}

// The core requirement this ticket calls out explicitly: a user must never
// see another user's biometric data, on the read path too.
func TestGetSessionMetrics_CrossUserIsolation(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, owner, other = "ses-bio-read-iso", "user_bio_read_iso_owner", "user_bio_read_iso_other"
	cleanupSamples(t, pool, owner)
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, owner, start, start.Add(time.Hour))

	if _, err := repo.PutSamples(ctx, owner, []Sample{hrSample("bio-read-iso-1", start, 150)}); err != nil {
		t.Fatalf("seed samples: %v", err)
	}
	if _, err := repo.ComputeSessionMetrics(ctx, owner, id, 200, HRMaxSourceEstimated, HRSourceWindow); err != nil {
		t.Fatalf("compute: %v", err)
	}

	if _, err := repo.GetSessionMetrics(ctx, other, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-user get gave %v, want ErrNotFound", err)
	}
}

// And the raw samples themselves: ListSamples must never surface a
// different user's readings.
func TestListSamples_CrossUserIsolation(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const owner, other = "user_bio_samples_iso_owner", "user_bio_samples_iso_other"
	cleanupSamples(t, pool, owner)
	base := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	if _, err := repo.PutSamples(ctx, owner, []Sample{hrSample("bio-samples-iso-1", base, 150)}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := repo.ListSamples(ctx, other, MetricHeartRate, base.Add(-time.Hour), base.Add(time.Hour))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("another user's samples leaked: %+v", got)
	}
}

func TestComputeSessionMetrics_RecomputeUpdatesInPlace(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-recompute", "user_bio_recompute"
	cleanupSamples(t, pool, user)
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(30*time.Minute))

	if _, err := repo.PutSamples(ctx, user, []Sample{
		hrSample("bio-recompute-1", start, 100),
	}); err != nil {
		t.Fatalf("seed first sample: %v", err)
	}
	first, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow)
	if err != nil {
		t.Fatalf("first compute: %v", err)
	}
	if first.SampleCount != 1 {
		t.Fatalf("first sample_count = %d, want 1", first.SampleCount)
	}

	// More samples arrive later — the watch syncs after the app already
	// closed (design doc §6.4) — and a recompute must pick them up in the
	// SAME row, not create a second one.
	if _, err := repo.PutSamples(ctx, user, []Sample{
		hrSample("bio-recompute-2", start.Add(10*time.Minute), 150),
	}); err != nil {
		t.Fatalf("seed second sample: %v", err)
	}
	second, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow)
	if err != nil {
		t.Fatalf("second compute: %v", err)
	}
	if second.SampleCount != 2 {
		t.Fatalf("second sample_count = %d, want 2", second.SampleCount)
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM session_metrics WHERE session_id = $1`, id).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("%d session_metrics rows for one session after a recompute, want 1", n)
	}
}

// N483/#833's core acceptance criterion: a recompute against a DIFFERENT
// HRmax (e.g. once an observed maximum replaces the athlete's estimate, per
// design doc §3) must not silently overwrite hr_max_bpm/hr_max_source with
// no record of the change -- and since ComputeSessionMetrics UPSERTs one row
// per session (see postgres.go), "no record" would otherwise be exactly what
// happened. The row itself IS that record: it must always reflect exactly
// the HRmax/source the MOST RECENT call actually used, never a value left
// over from an earlier compute.
func TestComputeSessionMetrics_RecomputeWithDifferentHRMaxOverwritesProvenance(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-hrmax-recompute", "user_bio_hrmax_recompute"
	cleanupSamples(t, pool, user)
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(30*time.Minute))

	// 171 bpm sits exactly on zone 5's floor (90%) against a 190 HRmax, but
	// only 83% -- zone 4 -- against a 205 HRmax, so the two computes below
	// classify this SAME sample into different zones, not just different
	// TRIMP arithmetic on the same classification.
	if _, err := repo.PutSamples(ctx, user, []Sample{
		hrSample("bio-hrmax-recompute-1", start, 171),
		hrSample("bio-hrmax-recompute-2", start.Add(5*time.Minute), 100),
	}); err != nil {
		t.Fatalf("seed samples: %v", err)
	}

	// First compute: the seeded 220-age estimate.
	first, err := repo.ComputeSessionMetrics(ctx, user, id, 190, HRMaxSourceEstimated, HRSourceWindow)
	if err != nil {
		t.Fatalf("first compute: %v", err)
	}
	if first.HRMaxBPM == nil || *first.HRMaxBPM != 190 {
		t.Fatalf("first hr_max_bpm = %v, want 190", first.HRMaxBPM)
	}
	if first.HRMaxSource == nil || *first.HRMaxSource != HRMaxSourceEstimated {
		t.Fatalf("first hr_max_source = %v, want estimated", first.HRMaxSource)
	}
	firstTRIMP := first.TRIMP

	// The athlete's observed maximum arrives later and supersedes the
	// estimate -- a recompute against a DIFFERENT HRmax and a DIFFERENT
	// source.
	second, err := repo.ComputeSessionMetrics(ctx, user, id, 205, HRMaxSourceObserved, HRSourceWindow)
	if err != nil {
		t.Fatalf("second compute: %v", err)
	}
	if second.HRMaxBPM == nil || *second.HRMaxBPM != 205 {
		t.Fatalf("second hr_max_bpm = %v, want 205 -- the recompute's value must win", second.HRMaxBPM)
	}
	if second.HRMaxSource == nil || *second.HRMaxSource != HRMaxSourceObserved {
		t.Fatalf("second hr_max_source = %v, want observed -- the recompute's provenance must win",
			second.HRMaxSource)
	}
	if firstTRIMP != nil && second.TRIMP != nil && *firstTRIMP == *second.TRIMP {
		t.Fatalf("trimp unchanged (%v) after a different hr_max_bpm -- the recompute did not actually reclassify",
			*second.TRIMP)
	}

	// And reading it back confirms there is exactly one row, carrying only
	// the SECOND compute's provenance -- nothing about the first HRmax
	// survives anywhere for a reader to find.
	got, err := repo.GetSessionMetrics(ctx, user, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.HRMaxBPM == nil || *got.HRMaxBPM != 205 {
		t.Fatalf("get hr_max_bpm = %v, want 205", got.HRMaxBPM)
	}
	if got.HRMaxSource == nil || *got.HRMaxSource != HRMaxSourceObserved {
		t.Fatalf("get hr_max_source = %v, want observed", got.HRMaxSource)
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM session_metrics WHERE session_id = $1`, id).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("%d session_metrics rows after a recompute with a different HRmax, want 1 (no history row created)", n)
	}
}

// Deleting the session must take its metrics with it.
func TestDeletingTheSessionCascadesToSessionMetrics(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-cascade", "user_bio_cascade"
	cleanupSamples(t, pool, user)
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(time.Hour))

	if _, err := repo.PutSamples(ctx, user, []Sample{hrSample("bio-cascade-1", start, 150)}); err != nil {
		t.Fatalf("seed sample: %v", err)
	}
	if _, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow); err != nil {
		t.Fatalf("compute: %v", err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id); err != nil {
		t.Fatalf("delete session: %v", err)
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM session_metrics WHERE session_id = $1`, id).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("%d session_metrics rows survived the session delete", n)
	}
}

// The upsert's WHERE predicate, exercised directly against the database —
// mirrors running's TestUpsertPredicateRefusesACrossUserUpdateAtTheSQLLevel
// exactly, and for the identical reason: no call through the repository can
// reach this line with the wrong user_id (the ownership SELECT in
// ComputeSessionMetrics answers ErrNotFound first), so nothing through the
// public API can prove the predicate is still there once it exists.
func TestSessionMetricsUpsertPredicateRefusesACrossUserUpdateAtTheSQLLevel(t *testing.T) {
	_, pool := newTestRepo(t)
	ctx := context.Background()
	const id, owner, attacker = "ses-bio-sql", "user_bio_sql_owner", "user_bio_sql_attacker"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, owner, start, start.Add(time.Hour))

	if _, err := pool.Exec(ctx, `
		INSERT INTO session_metrics (session_id, user_id, hr_source, sample_count, rule_version)
		VALUES ($1, $2, 'window', 3, 1)`, id, owner); err != nil {
		t.Fatalf("seed metrics: %v", err)
	}

	// The statement ComputeSessionMetrics issues, minus the Go-level
	// ownership guard. Note the attacker's user_id is NOT in the SET list —
	// that is what stops the foreign key from re-checking, and why this
	// predicate has to exist.
	tag, err := pool.Exec(ctx, `
		INSERT INTO session_metrics (session_id, user_id, hr_source, sample_count, rule_version)
		VALUES ($1, $2, 'workout', 999, 1)
		ON CONFLICT (session_id) DO UPDATE SET
			hr_source    = excluded.hr_source,
			sample_count = excluded.sample_count
		WHERE session_metrics.user_id = $2`, id, attacker)
	if err != nil {
		t.Fatalf("upsert errored rather than matching no rows: %v", err)
	}
	if n := tag.RowsAffected(); n != 0 {
		t.Fatalf("cross-user upsert touched %d row(s); the WHERE predicate is gone", n)
	}

	var sampleCount int
	if err := pool.QueryRow(ctx,
		`SELECT sample_count FROM session_metrics WHERE session_id = $1`, id).Scan(&sampleCount); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if sampleCount != 3 {
		t.Fatalf("owner's row was modified: sample_count=%d, want 3", sampleCount)
	}
}

// hr_source's database-level CHECK — defence in depth behind the Go-side
// HRSource.Valid(), per the migration's comment.
func TestSessionMetricsHRSourceCheckConstraintRejectsUnknownValues(t *testing.T) {
	_, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-check", "user_bio_check"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(time.Hour))

	_, err := pool.Exec(ctx, `
		INSERT INTO session_metrics (session_id, user_id, hr_source, sample_count, rule_version)
		VALUES ($1, $2, 'made_up_value', 0, 1)`, id, user)
	if err == nil {
		t.Fatal("insert with an invalid hr_source succeeded, want a check_violation")
	}
}

// N483/#833's hr_max_source CHECK — the same defence-in-depth stance the
// migration takes on hr_max_source that 000089 already takes on hr_source,
// exercised directly against the database rather than only through Go's
// HRMaxSource.Valid().
func TestSessionMetricsHRMaxSourceCheckConstraintRejectsUnknownValues(t *testing.T) {
	_, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-hrmax-check", "user_bio_hrmax_check"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(time.Hour))

	_, err := pool.Exec(ctx, `
		INSERT INTO session_metrics (session_id, user_id, hr_source, sample_count, rule_version, hr_max_source)
		VALUES ($1, $2, 'window', 0, 1, 'made_up_value')`, id, user)
	if err == nil {
		t.Fatal("insert with an invalid hr_max_source succeeded, want a check_violation")
	}
}

// A NULL hr_max_source must remain legal at the database level -- that is
// exactly the "computed before N483 shipped" state the migration's own
// comment documents, and the CHECK constraint has to allow it explicitly
// (`hr_max_source IS NULL OR ...`) rather than only the two named values.
func TestSessionMetricsHRMaxSourceCheckConstraintAllowsNull(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-hrmax-null", "user_bio_hrmax_null"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(time.Hour))

	// A row written the way a pre-N483 caller would have -- no
	// hr_max_bpm/hr_max_source at all, simulating a legacy row this
	// migration never backfills.
	if _, err := pool.Exec(ctx, `
		INSERT INTO session_metrics (session_id, user_id, hr_source, sample_count, rule_version)
		VALUES ($1, $2, 'window', 0, 1)`, id, user); err != nil {
		t.Fatalf("insert pre-N483-shaped row: %v", err)
	}

	got, err := repo.GetSessionMetrics(ctx, user, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.HRMaxBPM != nil || got.HRMaxSource != nil {
		t.Fatalf("hr_max_bpm/hr_max_source = %v/%v, want nil/nil for a legacy row", got.HRMaxBPM, got.HRMaxSource)
	}
}

func TestComputeSessionMetrics_ActiveEnergySummed(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-kcal", "user_bio_kcal"
	cleanupSamples(t, pool, user)
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(time.Hour))

	if _, err := repo.PutSamples(ctx, user, []Sample{
		{ID: "bio-kcal-1", MetricType: MetricActiveEnergy, Source: SourceAppleWatch,
			SourcePlatform: PlatformHealthKit, Value: 120.4, Unit: "kcal", MeasuredAt: start.Add(time.Minute)},
		{ID: "bio-kcal-2", MetricType: MetricActiveEnergy, Source: SourceAppleWatch,
			SourcePlatform: PlatformHealthKit, Value: 80.2, Unit: "kcal", MeasuredAt: start.Add(10 * time.Minute)},
	}); err != nil {
		t.Fatalf("seed active_energy: %v", err)
	}

	m, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if m.ActiveKcal == nil || *m.ActiveKcal != 201 { // round(120.4+80.2) = 201
		t.Fatalf("active_kcal = %v, want 201", m.ActiveKcal)
	}
}

// --- ListSessionLoad ---------------------------------------------------

// N489/#850's core claim: BJJ, strength and running sessions all contribute
// to one cross-sport load view, because TRIMP is computed identically
// regardless of sport.
func TestListSessionLoad_SpansAllThreeSports(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_bio_load_sports"
	cleanupSamples(t, pool, user)
	base := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	for i, sport := range []string{"bjj", "strength", "running"} {
		id := "ses-bio-load-" + sport
		start := base.Add(time.Duration(i) * 24 * time.Hour)
		seedSessionSport(t, pool, id, user, sport, start, start.Add(30*time.Minute))
		// Gap under maxSampleGapForZoneAttribution (6 min) so the interval is
		// actually attributed to a zone -- a wider gap is skipped entirely
		// (trimp.go) and would make this test assert 0 > 0 for the wrong reason.
		if _, err := repo.PutSamples(ctx, user, []Sample{
			hrSample("bio-load-"+sport+"-1", start, 150),
			hrSample("bio-load-"+sport+"-2", start.Add(5*time.Minute), 160),
		}); err != nil {
			t.Fatalf("seed samples for %s: %v", sport, err)
		}
		if _, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow); err != nil {
			t.Fatalf("compute for %s: %v", sport, err)
		}
	}

	got, err := repo.ListSessionLoad(ctx, user, base.Add(-time.Hour), base.Add(3*24*time.Hour))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d sessions, want 3 (one per sport): %+v", len(got), got)
	}
	sports := map[string]bool{}
	for _, l := range got {
		sports[l.Sport] = true
		if l.TRIMP <= 0 {
			t.Errorf("session %s: trimp = %v, want > 0", l.SessionID, l.TRIMP)
		}
	}
	for _, sport := range []string{"bjj", "strength", "running"} {
		if !sports[sport] {
			t.Errorf("missing %s in the result: %+v", sport, got)
		}
	}
	// Ascending by started_at.
	if got[0].Sport != "bjj" || got[1].Sport != "strength" || got[2].Sport != "running" {
		t.Fatalf("not ascending by started_at: %+v", got)
	}
}

// backend-reviewer, N489/#850: ListSessionLoad shipped with no row ceiling
// of its own — only the date-range cap (maxSessionLoadRangeDays), which
// bounds TIME, not ROW COUNT, the exact gap docs/architecture/api-
// conventions.md's conditional-GET section calls out for a new list
// endpoint. Fixed with MaxSessionLoadRows + a `LIMIT`. Seeding 5000 real
// rows to exercise the constant itself is impractical (mirrors
// ListSamples' own untested MaxSamplesPerListQuery for the same reason),
// so this proves the CLAUSE — a literal small LIMIT against a few real
// rows — both truncates and keeps the OLDEST rows given the query's own
// `ORDER BY s.started_at, s.id`, which is the property that makes hitting
// the real cap "narrow from/to" rather than "lose recent data silently".
func TestListSessionLoad_LimitTruncatesToTheOldestRowsFirst(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_bio_load_cap"
	cleanupSamples(t, pool, user)
	base := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	for i := 0; i < 5; i++ {
		id := fmt.Sprintf("ses-bio-load-cap-%d", i)
		start := base.Add(time.Duration(i) * 24 * time.Hour)
		seedSession(t, pool, id, user, start, start.Add(30*time.Minute))
		if _, err := repo.PutSamples(ctx, user, []Sample{
			hrSample(fmt.Sprintf("bio-load-cap-%d-1", i), start, 150),
			hrSample(fmt.Sprintf("bio-load-cap-%d-2", i), start.Add(5*time.Minute), 160),
		}); err != nil {
			t.Fatalf("seed samples %d: %v", i, err)
		}
		if _, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow); err != nil {
			t.Fatalf("compute %d: %v", i, err)
		}
	}

	// The exact shape ListSessionLoad's query takes, minus the Go-level
	// constant -- a literal LIMIT 3 against 5 real rows.
	rows, err := pool.Query(ctx, `
		SELECT s.id
		FROM sessions s
		JOIN session_metrics m ON m.session_id = s.id
		WHERE s.user_id = $1 AND m.user_id = $1 AND m.trimp IS NOT NULL
			AND s.started_at >= $2 AND s.started_at <= $3
		ORDER BY s.started_at, s.id
		LIMIT 3`, user, base.Add(-time.Hour), base.Add(10*24*time.Hour))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	want := []string{"ses-bio-load-cap-0", "ses-bio-load-cap-1", "ses-bio-load-cap-2"}
	if len(ids) != len(want) {
		t.Fatalf("got %d rows with LIMIT 3, want %d: %v", len(ids), len(want), ids)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("row %d = %q, want %q (LIMIT must keep the OLDEST rows first): %v", i, ids[i], want[i], ids)
		}
	}
}

// The honesty rule this ticket's acceptance criteria call out explicitly: a
// session with hr_source='none' (no HR evidence — the athlete has no
// wearable, or it never synced) must be excluded from the trend, not counted
// as zero load.
func TestListSessionLoad_ExcludesHRSourceNoneSessions(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-load-none", "user_bio_load_none"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(time.Hour))

	// No samples put at all -- Compute forces hr_source to 'none' and leaves
	// trimp nil regardless of the caller's hint (see trimp.go's Compute).
	if _, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow); err != nil {
		t.Fatalf("compute: %v", err)
	}

	got, err := repo.ListSessionLoad(ctx, user, start.Add(-time.Hour), start.Add(time.Hour))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("hr_source=none session appeared in the load trend: %+v, want excluded entirely (not zero)", got)
	}
}

// A session nobody has ever called ComputeMetrics for at all -- the most
// common state (design doc §6.4: enrichment is not blocking) -- must be
// excluded exactly like an hr_source='none' one, not surfaced as some other
// kind of gap.
func TestListSessionLoad_ExcludesSessionsWithNoComputedMetricsAtAll(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-load-uncomputed", "user_bio_load_uncomputed"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(time.Hour))
	// Deliberately never call ComputeSessionMetrics for this session.

	got, err := repo.ListSessionLoad(ctx, user, start.Add(-time.Hour), start.Add(time.Hour))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("never-enriched session appeared in the load trend: %+v", got)
	}
}

func TestListSessionLoad_ExcludesOutOfRangeSessions(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-load-range", "user_bio_load_range"
	cleanupSamples(t, pool, user)
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(30*time.Minute))
	if _, err := repo.PutSamples(ctx, user, []Sample{hrSample("bio-load-range-1", start, 150)}); err != nil {
		t.Fatalf("seed samples: %v", err)
	}
	if _, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRMaxSourceEstimated, HRSourceWindow); err != nil {
		t.Fatalf("compute: %v", err)
	}

	// A window that does not contain this session's started_at at all.
	got, err := repo.ListSessionLoad(ctx, user, start.Add(24*time.Hour), start.Add(48*time.Hour))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("out-of-range session appeared in the load trend: %+v", got)
	}
}

// The cross-user isolation this module's every other read already
// guarantees, exercised on the new query too.
func TestListSessionLoad_CrossUserIsolation(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, owner, other = "ses-bio-load-iso", "user_bio_load_iso_owner", "user_bio_load_iso_other"
	cleanupSamples(t, pool, owner)
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, owner, start, start.Add(30*time.Minute))
	if _, err := repo.PutSamples(ctx, owner, []Sample{hrSample("bio-load-iso-1", start, 150)}); err != nil {
		t.Fatalf("seed samples: %v", err)
	}
	if _, err := repo.ComputeSessionMetrics(ctx, owner, id, 200, HRMaxSourceEstimated, HRSourceWindow); err != nil {
		t.Fatalf("compute: %v", err)
	}

	got, err := repo.ListSessionLoad(ctx, other, start.Add(-time.Hour), start.Add(time.Hour))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("another user's session load leaked: %+v", got)
	}
}

func TestGetSessionMetrics_NoneComputedYetIsNotFound(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-none", "user_bio_none"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, user, start, start.Add(time.Hour))

	if _, err := repo.GetSessionMetrics(ctx, user, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get with nothing computed gave %v, want ErrNotFound", err)
	}
}

// --- ListExerciseHR (N490/#851) ---------------------------------------------

// seedExercise writes a minimal, owned catalog row this file's ListExerciseHR
// tests reference by exercise_id — session_sets.exercise_id is a NOT NULL FK,
// so a fixture set needs a real one behind it. ON CONFLICT DO NOTHING because
// several tests reuse the same handful of ids.
func seedExercise(t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status)
		VALUES ($1, $1, 'strength', 'squat', 'weight_reps', 'published')
		ON CONFLICT (id) DO NOTHING`, id); err != nil {
		t.Fatalf("seed exercise %s: %v", id, err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM exercises WHERE id = $1`, id); err != nil {
			t.Logf("cleanup exercise %s: %v", id, err)
		}
	})
}

type fixtureSet struct {
	ExerciseID  string
	Position    int
	Completed   bool
	PerformedAt *time.Time
}

// seedSets writes session_sets rows straight to the table — the domain
// helper (session.ReplaceSets) lives in a different package, and this file
// only needs to express raw states, several of which (an uncompleted set
// carrying a stale performed_at) that helper would never itself produce.
//
// Registers the session_sets cleanup AFTER each exercise's own cleanup, so
// under LIFO the sets are gone before their exercise's delete runs — the
// FK would otherwise refuse it.
func seedSets(t *testing.T, pool *pgxpool.Pool, userID, sessionID string, sets []fixtureSet) {
	t.Helper()
	ctx := context.Background()
	for _, s := range sets {
		seedExercise(t, pool, s.ExerciseID)
		if _, err := pool.Exec(ctx, `
			INSERT INTO session_sets (session_id, user_id, exercise_id, position, set_type, completed, performed_at)
			VALUES ($1, $2, $3, $4, 'working', $5, $6)`,
			sessionID, userID, s.ExerciseID, s.Position, s.Completed, s.PerformedAt); err != nil {
			t.Fatalf("seed set %+v: %v", s, err)
		}
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM session_sets WHERE session_id = $1`, sessionID); err != nil {
			t.Logf("cleanup session_sets for %s: %v", sessionID, err)
		}
	})
}

func at(base time.Time, minutes float64) *time.Time {
	tm := base.Add(time.Duration(minutes * float64(time.Minute)))
	return &tm
}

// TestListExerciseHR_HeavierCompoundReadsHigherThanAccessory is the
// automatable half of this ticket's own acceptance criterion — the human
// device check confirms the SAME shape against a real wearable, this
// confirms the arithmetic and windowing that shape depends on: two
// exercises' sets, completed at genuinely different times, read back with
// genuinely different heart rates, in the order they were trained.
func TestListExerciseHR_HeavierCompoundReadsHigherThanAccessory(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-exhr-happy", "user_bio_exhr_happy"
	const exSquat, exLateral = "bio_fx_ex_squat", "bio_fx_ex_lateral"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	end := start.Add(30 * time.Minute)
	seedSession(t, pool, id, user, start, end)
	cleanupSamples(t, pool, user)

	// Squats: three sets completed at +5/+8/+11 minutes. Their window is
	// [start (clamped), +11] — the lookback from +5 would reach before the
	// session began, so it clamps to the session's own start.
	// Lateral raises: two sets completed at +20/+22 minutes — window
	// [+14, +22], with no overlap with the squats' window.
	seedSets(t, pool, user, id, []fixtureSet{
		{ExerciseID: exSquat, Position: 0, Completed: true, PerformedAt: at(start, 5)},
		{ExerciseID: exSquat, Position: 1, Completed: true, PerformedAt: at(start, 8)},
		{ExerciseID: exSquat, Position: 2, Completed: true, PerformedAt: at(start, 11)},
		{ExerciseID: exLateral, Position: 3, Completed: true, PerformedAt: at(start, 20)},
		{ExerciseID: exLateral, Position: 4, Completed: true, PerformedAt: at(start, 22)},
	})

	if _, err := repo.PutSamples(ctx, user, []Sample{
		hrSample("exhr-sq-1", *at(start, 2), 170),
		hrSample("exhr-sq-2", *at(start, 6), 175),
		hrSample("exhr-sq-3", *at(start, 10), 165),
		hrSample("exhr-lat-1", *at(start, 15), 115),
		hrSample("exhr-lat-2", *at(start, 18), 120),
		hrSample("exhr-lat-3", *at(start, 21), 110),
	}); err != nil {
		t.Fatalf("seed samples: %v", err)
	}

	got, err := repo.ListExerciseHR(ctx, user, id)
	if err != nil {
		t.Fatalf("list exercise hr: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d exercises, want 2: %+v", len(got), got)
	}
	// Trained-order, not alphabetical (bio_fx_ex_lateral < bio_fx_ex_squat
	// lexically, so this also proves the ORDER BY MIN(position) is doing
	// something rather than agreeing with a coincidence).
	if got[0].ExerciseID != exSquat || got[1].ExerciseID != exLateral {
		t.Fatalf("wrong order: %+v", got)
	}
	if got[0].AvgHRBPM != 170 || got[0].MaxHRBPM != 175 || got[0].SampleCount != 3 {
		t.Errorf("squats = %+v, want avg=170 max=175 count=3", got[0])
	}
	if got[1].AvgHRBPM != 115 || got[1].MaxHRBPM != 120 || got[1].SampleCount != 3 {
		t.Errorf("laterals = %+v, want avg=115 max=120 count=3", got[1])
	}
	if got[0].AvgHRBPM <= got[1].AvgHRBPM {
		t.Fatalf("the heavy compound (squats, avg=%d) did not read higher than the accessory "+
			"movement (laterals, avg=%d) — this is the exact intensity signal the ticket exists to surface",
			got[0].AvgHRBPM, got[1].AvgHRBPM)
	}
}

// Three ways an exercise can have NOTHING honest to report, all excluded
// entirely rather than shown at zero.
func TestListExerciseHR_ExcludesExercisesWithNoHonestWindowOrEvidence(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-exhr-excl", "user_bio_exhr_excl"
	const exNoTimestamp, exUncompleted, exEmptyWindow, exReal = "bio_fx_ex_notime", "bio_fx_ex_undone", "bio_fx_ex_empty", "bio_fx_ex_real"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	end := start.Add(30 * time.Minute)
	seedSession(t, pool, id, user, start, end)
	cleanupSamples(t, pool, user)

	seedSets(t, pool, user, id, []fixtureSet{
		// Completed, but never ticked live (or logged before N490 shipped)
		// — no performed_at to build a window from at all.
		{ExerciseID: exNoTimestamp, Position: 0, Completed: true, PerformedAt: nil},
		// Carries a performed_at, but completed is false — an un-ticked
		// correction must not anchor a window off a stale timestamp.
		{ExerciseID: exUncompleted, Position: 1, Completed: false, PerformedAt: at(start, 5)},
		// A real, honestly-timestamped completed set, but its derived
		// window contains zero heart_rate samples.
		{ExerciseID: exEmptyWindow, Position: 2, Completed: true, PerformedAt: at(start, 29)},
		// The control: a real window with a real sample, so this test
		// cannot pass by the query returning nothing at all.
		{ExerciseID: exReal, Position: 3, Completed: true, PerformedAt: at(start, 10)},
	})
	if _, err := repo.PutSamples(ctx, user, []Sample{
		hrSample("exhr-excl-real", *at(start, 9), 140),
		// Deliberately placed INSIDE exUncompleted's own derived window
		// ([start, +5min], from its lone performed_at at +5min) — so this
		// exercise is excluded because it is not `completed`, not merely
		// because its window happens to be empty. Without this sample, a
		// query that forgot the `completed` filter entirely would still
		// pass this test by accident, since the window would have nothing
		// in it either way.
		hrSample("exhr-excl-uncompleted-decoy", *at(start, 2), 130),
	}); err != nil {
		t.Fatalf("seed samples: %v", err)
	}

	got, err := repo.ListExerciseHR(ctx, user, id)
	if err != nil {
		t.Fatalf("list exercise hr: %v", err)
	}
	if len(got) != 1 || got[0].ExerciseID != exReal {
		t.Fatalf("got %+v, want exactly [%s]", got, exReal)
	}
}

func TestListExerciseHR_SessionNotEndedIsInvalidInput(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-exhr-inprogress", "user_bio_exhr_inprogress"
	seedInProgressSession(t, pool, id, user, time.Now().UTC())

	if _, err := repo.ListExerciseHR(ctx, user, id); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("list against an in-progress session gave %v, want ErrInvalidInput", err)
	}
}

func TestListExerciseHR_UnknownSessionIsNotFound(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	if _, err := repo.ListExerciseHR(ctx, "user_bio_exhr_ghost", "ses-does-not-exist"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("list against a missing session gave %v, want ErrNotFound", err)
	}
}

// Cross-user: the same non-disclosure stance ComputeSessionMetrics already
// takes — another user's session must read as not-found, never as an
// empty-but-real list.
func TestListExerciseHR_CannotBeListedForAnotherUsersSession(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, owner, attacker = "ses-bio-exhr-owner", "user_bio_exhr_owner", "user_bio_exhr_attacker"
	start := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedSession(t, pool, id, owner, start, start.Add(time.Hour))

	if _, err := repo.ListExerciseHR(ctx, attacker, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("listing against another user's session gave %v, want ErrNotFound", err)
	}
}
