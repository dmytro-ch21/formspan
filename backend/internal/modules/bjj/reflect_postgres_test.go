package bjj

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// draftUsageFixture builds the meter and cleans up after itself.
//
// Its own cleanup rather than borrowing another fixture's: this table is not
// among the ones they clear, and a leftover row would inflate the next run's
// quota count and fail a boundary test for reasons nothing in that test could
// explain.
func draftUsageFixture(t *testing.T, userIDs ...string) *PostgresDraftUsage {
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
	// Registered BEFORE the delete cleanup below, because t.Cleanup runs LIFO
	// and the delete still needs the pool open.
	t.Cleanup(func() { pool.Close() })
	t.Cleanup(func() {
		for _, u := range userIDs {
			if _, err := pool.Exec(ctx, `DELETE FROM bjj_reflection_drafts WHERE user_id = $1`, u); err != nil {
				t.Errorf("cleanup %s: %v", u, err)
			}
		}
	})
	return NewPostgresDraftUsage(pool)
}

func mustRecordDraft(t *testing.T, usage *PostgresDraftUsage, rec DraftRecord) {
	t.Helper()
	if err := usage.RecordDraft(context.Background(), rec); err != nil {
		t.Fatalf("record: %v", err)
	}
}

// TWO ATHLETES, because a single-user test passes against a missing user_id
// filter — and that bug would show only as somebody else's spending counting
// against this athlete's cap.
func TestDraftQuotaCountsOnlyTheCaller(t *testing.T) {
	usage := draftUsageFixture(t, "test_user_bjj_draft_a", "test_user_bjj_draft_b")
	ctx := context.Background()
	now := time.Now()

	for i := 0; i < 3; i++ {
		mustRecordDraft(t, usage, DraftRecord{UserID: "test_user_bjj_draft_a", Succeeded: true, Model: "m", TagCount: 2})
	}
	for i := 0; i < 7; i++ {
		mustRecordDraft(t, usage, DraftRecord{UserID: "test_user_bjj_draft_b", Succeeded: true})
	}

	q, err := usage.DraftQuota(ctx, "test_user_bjj_draft_a", now)
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if q.Used != 3 {
		t.Fatalf("used = %d, want 3 — another athlete's drafts are counting against this one", q.Used)
	}
	if q.Remaining != DailyReflectionDrafts-3 {
		t.Errorf("remaining = %d, want %d", q.Remaining, DailyReflectionDrafts-3)
	}
}

// A refusal and an upstream error both cost tokens. A meter that counted only
// successes would let a caller loop on input the model keeps declining and pay
// for every attempt.
func TestFailedDraftsCountTowardTheQuota(t *testing.T) {
	usage := draftUsageFixture(t, "test_user_bjj_draft_fail")
	ctx := context.Background()

	mustRecordDraft(t, usage, DraftRecord{UserID: "test_user_bjj_draft_fail", Succeeded: false})
	mustRecordDraft(t, usage, DraftRecord{UserID: "test_user_bjj_draft_fail", Succeeded: true, TagCount: 4})

	q, err := usage.DraftQuota(ctx, "test_user_bjj_draft_fail", time.Now())
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if q.Used != 2 {
		t.Errorf("used = %d, want 2 — the failed call spent tokens too", q.Used)
	}
}

// The window is ROLLING, and `now` is a parameter precisely so the boundary is
// testable without waiting a day.
func TestDraftQuotaAgesCallsOutOfTheWindow(t *testing.T) {
	usage := draftUsageFixture(t, "test_user_bjj_draft_window")
	ctx := context.Background()

	mustRecordDraft(t, usage, DraftRecord{UserID: "test_user_bjj_draft_window", Succeeded: true})

	// A day and a bit later, the row is outside the window and the athlete is
	// clear again.
	later := time.Now().Add(DraftQuotaWindow + time.Hour)
	q, err := usage.DraftQuota(ctx, "test_user_bjj_draft_window", later)
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if q.Used != 0 {
		t.Errorf("used = %d a day later, want 0 — the window is not rolling", q.Used)
	}
	if q.ResetsAt != nil {
		t.Errorf("resets_at = %v with nothing in the window", q.ResetsAt)
	}

	// And inside the window it is still counted, so the test above cannot pass
	// by the row never having been written.
	q, err = usage.DraftQuota(ctx, "test_user_bjj_draft_window", time.Now())
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if q.Used != 1 {
		t.Fatalf("used = %d inside the window, want 1", q.Used)
	}
	if q.ResetsAt == nil {
		t.Error("resets_at is nil with a call in the window — the client cannot say when one comes back")
	}
}
