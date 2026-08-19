package nutrition

import (
	"context"
	"testing"
	"time"
)

// usageFor builds a metering repository and cleans up after itself.
//
// Its own cleanup rather than reusing repoFor's, because that one deletes the
// food-log tables and this table is not among them — an estimate row left
// behind would inflate the next run's quota count and fail a boundary test
// for reasons nothing in that test could explain.
func usageFor(t *testing.T, userIDs ...string) *PostgresEstimateUsage {
	t.Helper()
	pool := testPool(t)
	t.Cleanup(func() {
		for _, u := range userIDs {
			if _, err := pool.Exec(context.Background(),
				`DELETE FROM nutrition_estimates WHERE user_id = $1`, u); err != nil {
				t.Errorf("cleanup %s: %v", u, err)
			}
		}
	})
	return NewPostgresEstimateUsage(pool)
}

func TestQuotaCountsOnlyTheCallerAndOnlyTheirPath(t *testing.T) {
	// TWO USERS AND BOTH PATHS, because a single-user single-path test passes
	// against three different bugs: a missing user_id filter, a missing source
	// filter, and both at once. Each would only show as somebody else's
	// spending counting against this athlete's cap.
	usage := usageFor(t, "est_a", "est_b")
	ctx := context.Background()
	now := time.Now()

	for i := 0; i < 3; i++ {
		mustRecord(t, usage, EstimateRecord{UserID: "est_a", Source: SourceText, Succeeded: true})
	}
	mustRecord(t, usage, EstimateRecord{UserID: "est_a", Source: SourcePhoto, Succeeded: true})
	// Another athlete, hammering both paths.
	for i := 0; i < 9; i++ {
		mustRecord(t, usage, EstimateRecord{UserID: "est_b", Source: SourceText, Succeeded: true})
		mustRecord(t, usage, EstimateRecord{UserID: "est_b", Source: SourcePhoto, Succeeded: true})
	}

	text, err := usage.Quota(ctx, "est_a", SourceText, now)
	if err != nil {
		t.Fatalf("text quota: %v", err)
	}
	if text.Used != 3 {
		t.Fatalf("text used = %d, want 3 — another athlete's or another path's calls are counting", text.Used)
	}
	photo, err := usage.Quota(ctx, "est_a", SourcePhoto, now)
	if err != nil {
		t.Fatalf("photo quota: %v", err)
	}
	if photo.Used != 1 {
		t.Fatalf("photo used = %d, want 1", photo.Used)
	}
	// And the limits differ, so the two reports are genuinely separate rather
	// than the same number twice.
	if text.Limit == photo.Limit {
		t.Fatal("both paths reported the same limit")
	}
}

func TestFailedCallsCountTowardTheQuota(t *testing.T) {
	// They cost tokens. A meter that counted only successes would let a caller
	// loop on input the model keeps declining and pay for every attempt —
	// which is the exact scenario the quota exists to bound.
	usage := usageFor(t, "est_fail")
	ctx := context.Background()

	mustRecord(t, usage, EstimateRecord{UserID: "est_fail", Source: SourceText, Succeeded: false})
	mustRecord(t, usage, EstimateRecord{UserID: "est_fail", Source: SourceText, Succeeded: false})

	q, err := usage.Quota(ctx, "est_fail", SourceText, time.Now())
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if q.Used != 2 {
		t.Fatalf("used = %d, want 2 — failures are not being counted", q.Used)
	}
}

func TestCallsOlderThanTheWindowStopCounting(t *testing.T) {
	// The window is rolling, so this is asserted by moving `now` rather than
	// by waiting a day — which is the whole reason `now` is a parameter.
	usage := usageFor(t, "est_window")
	ctx := context.Background()

	mustRecord(t, usage, EstimateRecord{UserID: "est_window", Source: SourceText, Succeeded: true})

	inWindow, err := usage.Quota(ctx, "est_window", SourceText, time.Now())
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	if inWindow.Used != 1 {
		t.Fatalf("used = %d just after recording, want 1", inWindow.Used)
	}

	later := time.Now().Add(QuotaWindow + time.Hour)
	aged, err := usage.Quota(ctx, "est_window", SourceText, later)
	if err != nil {
		t.Fatalf("quota later: %v", err)
	}
	if aged.Used != 0 {
		t.Fatalf("used = %d a day later, want 0 — the window is not rolling off", aged.Used)
	}
	if aged.ResetsAt != nil {
		t.Fatal("resets_at set with an empty window")
	}
}

func TestTheGateRefusesAtTheLimitAndReportsWhy(t *testing.T) {
	usage := usageFor(t, "est_cap")
	ctx := context.Background()
	now := time.Now()

	for i := 0; i < LimitFor(SourcePhoto); i++ {
		mustRecord(t, usage, EstimateRecord{UserID: "est_cap", Source: SourcePhoto, Succeeded: true})
	}

	q, err := CheckQuota(ctx, usage, "est_cap", SourcePhoto, now)
	if err == nil {
		t.Fatal("allowed a call at the cap")
	}
	// The quota is returned ALONGSIDE the error so the handler can say when
	// one more becomes available rather than only that the answer is no.
	if q.ResetsAt == nil {
		t.Fatal("no resets_at on an exhausted quota — the client cannot say when to try again")
	}
	// The other path is untouched: hitting the photo cap must not stop them
	// typing a meal.
	if _, err := CheckQuota(ctx, usage, "est_cap", SourceText, now); err != nil {
		t.Fatalf("the text path was blocked by photo usage: %v", err)
	}
}

func mustRecord(t *testing.T, usage *PostgresEstimateUsage, rec EstimateRecord) {
	t.Helper()
	if err := usage.Record(context.Background(), rec); err != nil {
		t.Fatalf("record: %v", err)
	}
}
