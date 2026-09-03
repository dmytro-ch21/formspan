package biometric

import (
	"context"
	"errors"
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

	m, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRSourceWindow)
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

	// And it round-trips through GetSessionMetrics.
	got, err := repo.GetSessionMetrics(ctx, user, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.TRIMP == nil || *got.TRIMP != wantTRIMP {
		t.Fatalf("get trimp = %v, want %v", got.TRIMP, wantTRIMP)
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

	m, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRSourceWorkout)
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
}

func TestComputeSessionMetrics_SessionNotEndedIsInvalidInput(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, user = "ses-bio-inprogress", "user_bio_inprogress"
	seedInProgressSession(t, pool, id, user, time.Now().UTC())

	_, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRSourceWindow)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("compute on an in-progress session gave %v, want ErrInvalidInput", err)
	}
}

func TestComputeSessionMetrics_UnknownSessionIsNotFound(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	_, err := repo.ComputeSessionMetrics(ctx, "user_bio_ghost", "ses-does-not-exist", 200, HRSourceWindow)
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

	_, err := repo.ComputeSessionMetrics(ctx, attacker, id, 200, HRSourceWindow)
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
	if _, err := repo.ComputeSessionMetrics(ctx, owner, id, 200, HRSourceWindow); err != nil {
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
	first, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRSourceWindow)
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
	second, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRSourceWindow)
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
	if _, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRSourceWindow); err != nil {
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

	m, err := repo.ComputeSessionMetrics(ctx, user, id, 200, HRSourceWindow)
	if err != nil {
		t.Fatalf("compute: %v", err)
	}
	if m.ActiveKcal == nil || *m.ActiveKcal != 201 { // round(120.4+80.2) = 201
		t.Fatalf("active_kcal = %v, want 201", m.ActiveKcal)
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
