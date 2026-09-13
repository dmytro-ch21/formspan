package narration

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// usageFixture builds the meter and removes its own rows. The pool close is
// registered BEFORE the delete, because t.Cleanup runs LIFO and the delete needs
// the pool open.
func usageFixture(t *testing.T, userIDs ...string) *PostgresUsage {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	ctx := context.Background()
	pool, err := database.NewPool(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	t.Cleanup(func() {
		for _, u := range userIDs {
			if _, err := pool.Exec(ctx, `DELETE FROM day_narration_generations WHERE user_id = $1`, u); err != nil {
				t.Errorf("cleanup %s: %v", u, err)
			}
		}
	})
	return NewPostgresUsage(pool)
}

// TWO ATHLETES: a single-user test passes against a missing user_id filter.
func TestQuotaCountsOnlyTheCaller(t *testing.T) {
	a, b := "test_user_narration_a", "test_user_narration_b"
	usage := usageFixture(t, a, b)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := usage.Record(ctx, Record{UserID: a, Succeeded: true, Model: "m"}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 4; i++ {
		if err := usage.Record(ctx, Record{UserID: b, Succeeded: false, Model: "m"}); err != nil {
			t.Fatal(err)
		}
	}
	q, err := usage.Quota(ctx, a, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if q.Used != 2 || q.Remaining != DailyNarrations-2 || q.ResetsAt == nil {
		t.Fatalf("quota for a: %+v", q)
	}
}

func TestRecordStoresNullTokensForNoUsageAndNumbersForABilledCall(t *testing.T) {
	user := "test_user_narration_tokens"
	usage := usageFixture(t, user)
	ctx := context.Background()
	if err := usage.Record(ctx, Record{UserID: user, Succeeded: false}); err != nil {
		t.Fatal(err)
	}
	if err := usage.Record(ctx, Record{UserID: user, Succeeded: false, Model: "m", Usage: Usage{InputTokens: 900, OutputTokens: 40}}); err != nil {
		t.Fatal(err)
	}
	rows, err := usage.pool.Query(ctx, `SELECT input_tokens, output_tokens FROM day_narration_generations WHERE user_id = $1 ORDER BY created_at`, user)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got [][2]*int64
	for rows.Next() {
		var in, out *int64
		if err := rows.Scan(&in, &out); err != nil {
			t.Fatal(err)
		}
		got = append(got, [2]*int64{in, out})
	}
	if len(got) != 2 || got[0][0] != nil || got[0][1] != nil || got[1][0] == nil || *got[1][0] != 900 || *got[1][1] != 40 {
		t.Fatalf("rows: %v", got)
	}
}
