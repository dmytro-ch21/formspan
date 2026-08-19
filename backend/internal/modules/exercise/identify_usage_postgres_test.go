package exercise

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// Integration tests for the identify meter (N48).
//
// These cover what the handler tests structurally CANNOT: the handler's fake
// meter implements its own counting, so a broken WHERE clause in the real query
// leaves every handler test green. The scoping — one athlete, one window — is
// the thing standing between a per-athlete quota and a global one, so it is
// checked here against real Postgres.

func newIdentifyUsage(t *testing.T) (*PostgresIdentifyUsage, context.Context) {
	t.Helper()

	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered before the row cleanup below, so under LIFO the delete runs
	// first while the pool is still open — the documented trap in this repo.
	t.Cleanup(pool.Close)

	usage := NewPostgresIdentifyUsage(pool)
	return usage, ctx
}

// seedIdentifications writes rows at explicit ages, so the window boundary is
// exercised without waiting a day.
func seedIdentifications(t *testing.T, u *PostgresIdentifyUsage, ctx context.Context, userID string, ages ...time.Duration) {
	t.Helper()
	t.Cleanup(func() {
		_, _ = u.pool.Exec(ctx, `DELETE FROM exercise_identifications WHERE user_id = $1`, userID)
	})
	_, _ = u.pool.Exec(ctx, `DELETE FROM exercise_identifications WHERE user_id = $1`, userID)
	for _, age := range ages {
		if _, err := u.pool.Exec(ctx, `
			INSERT INTO exercise_identifications (user_id, succeeded, model, candidate_count, created_at)
			VALUES ($1, true, 'test-model', 2, $2)`,
			userID, time.Now().Add(-age)); err != nil {
			t.Fatalf("seed identification: %v", err)
		}
	}
}

func TestIdentifyQuotaCountsOnlyTheCaller(t *testing.T) {
	u, ctx := newIdentifyUsage(t)
	seedIdentifications(t, u, ctx, "user_a", time.Hour, 2*time.Hour, 3*time.Hour)
	seedIdentifications(t, u, ctx, "user_b", time.Hour)

	q, err := u.Quota(ctx, "user_a", time.Now())
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if q.Used != 3 {
		t.Fatalf("used %d, want 3 — a quota that counts other athletes' calls is a global cap wearing a per-athlete label", q.Used)
	}
	if q.Remaining != DailyIdentifications-3 {
		t.Errorf("remaining %d, want %d", q.Remaining, DailyIdentifications-3)
	}
}

func TestIdentifyQuotaCountsOnlyInsideTheWindow(t *testing.T) {
	u, ctx := newIdentifyUsage(t)
	// Two inside, two outside. A missing `created_at >` clause counts all four
	// and the athlete never gets the day back.
	seedIdentifications(t, u, ctx, "user_window",
		time.Hour, 23*time.Hour,
		25*time.Hour, 400*time.Hour)

	q, err := u.Quota(ctx, "user_window", time.Now())
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if q.Used != 2 {
		t.Fatalf("used %d, want 2 — calls older than the window must age out", q.Used)
	}
	// ResetsAt derives from the OLDEST call INSIDE the window (23h ago), so the
	// next slot frees in about an hour. Taken from the oldest row overall it
	// would be wildly wrong.
	if q.ResetsAt == nil {
		t.Fatal("resets_at is nil with calls in the window")
	}
	if d := time.Until(*q.ResetsAt); d > 90*time.Minute || d < 30*time.Minute {
		t.Errorf("resets in %v, want about an hour — computed from the wrong row", d)
	}
}

func TestFailedIdentificationsCountTowardTheQuota(t *testing.T) {
	u, ctx := newIdentifyUsage(t)
	t.Cleanup(func() {
		_, _ = u.pool.Exec(ctx, `DELETE FROM exercise_identifications WHERE user_id = $1`, "user_fail_db")
	})
	_, _ = u.pool.Exec(ctx, `DELETE FROM exercise_identifications WHERE user_id = $1`, "user_fail_db")

	// A refusal and an outage both spent tokens.
	for _, ok := range []bool{false, false, true} {
		if err := u.Record(ctx, IdentifyRecord{
			UserID: "user_fail_db", Succeeded: ok, Model: "test-model", CandidateCount: 0,
		}); err != nil {
			t.Fatalf("record: %v", err)
		}
	}

	q, err := u.Quota(ctx, "user_fail_db", time.Now())
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if q.Used != 3 {
		t.Fatalf("used %d, want 3 — a quota counting only successes lets a caller "+
			"loop on a photo the model keeps declining and pay for every attempt", q.Used)
	}
}

func TestAnUnusedIdentifyQuotaHasNoReset(t *testing.T) {
	u, ctx := newIdentifyUsage(t)
	seedIdentifications(t, u, ctx, "user_empty") // no rows

	q, err := u.Quota(ctx, "user_empty", time.Now())
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if q.Used != 0 || !q.Allowed() {
		t.Fatalf("fresh athlete: %+v", q)
	}
	if q.ResetsAt != nil {
		t.Errorf("resets_at %v with nothing used — there is nothing waiting to expire", q.ResetsAt)
	}
}

// Record round-trips the fields anyone investigating a bill would ask for.
func TestRecordStoresTheAnswerButNeverThePhoto(t *testing.T) {
	u, ctx := newIdentifyUsage(t)
	t.Cleanup(func() {
		_, _ = u.pool.Exec(ctx, `DELETE FROM exercise_identifications WHERE user_id = $1`, "user_round")
	})
	_, _ = u.pool.Exec(ctx, `DELETE FROM exercise_identifications WHERE user_id = $1`, "user_round")

	if err := u.Record(ctx, IdentifyRecord{
		UserID: "user_round", Succeeded: true, Model: "gpt-5.6-luna", CandidateCount: 3,
	}); err != nil {
		t.Fatalf("record: %v", err)
	}

	var model string
	var count int
	var ok bool
	if err := u.pool.QueryRow(ctx, `
		SELECT model, candidate_count, succeeded FROM exercise_identifications
		 WHERE user_id = $1`, "user_round").Scan(&model, &count, &ok); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if model != "gpt-5.6-luna" || count != 3 || !ok {
		t.Errorf("stored model=%q count=%d ok=%v", model, count, ok)
	}

	// The table must have no column that could hold the photograph. That is
	// what keeps this table free of a retention question and of anything a
	// breach would expose.
	var imageCols int
	if err := u.pool.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.columns
		 WHERE table_name = 'exercise_identifications'
		   AND (column_name LIKE '%image%' OR data_type = 'bytea')`).Scan(&imageCols); err != nil {
		t.Fatalf("inspect columns: %v", err)
	}
	if imageCols != 0 {
		t.Errorf("the meter has %d column(s) that could hold photo bytes", imageCols)
	}
}
