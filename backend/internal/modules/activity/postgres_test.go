package activity

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/dmytro-ch21/formspan/backend/internal/platform/database"
)

// Requires a real Postgres with migrations already applied — set
// TEST_DATABASE_URL to run this (see docker-compose.yml for local dev, or
// the `backend` CI job for how it's wired there). Skips otherwise so
// `go test ./...` still works without a database configured.
func TestPostgresRepository_CreateIdempotentAndList(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}

	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered before the delete-row cleanup below so it runs *after* it —
	// same t.Cleanup-before-defer ordering this project has been bitten by
	// before (see profile/postgres_test.go).
	t.Cleanup(func() { pool.Close() })

	repo := NewPostgresRepository(pool)
	userID := "test_user_activity_create_list"
	activityID := "test_activity_idempotent_create"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM activities WHERE id = $1`, activityID); err != nil {
			t.Logf("cleanup: delete activity: %v", err)
		}
	})

	notes := "felt good, worked half guard retention"
	occurredAt := time.Now().Add(-time.Hour).Truncate(time.Second).UTC()

	first, err := repo.Create(ctx, NewActivity{
		ID:         activityID,
		UserID:     userID,
		Kind:       "bjj_session",
		OccurredAt: occurredAt,
		Notes:      &notes,
		RequestID:  "req_first_attempt",
		TraceID:    "trace_first_attempt",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if first.ID != activityID || first.UserID != userID || first.Kind != "bjj_session" {
		t.Fatalf("unexpected created activity: %+v", first)
	}
	if !first.OccurredAt.Equal(occurredAt) {
		t.Fatalf("occurred_at mismatch: got %v, want %v", first.OccurredAt, occurredAt)
	}

	// Idempotent retry: same ID, different request/trace IDs (as a real
	// offline-sync retry would send, since it's a fresh HTTP request) —
	// must return the *original* row, not a duplicate or an error.
	retry, err := repo.Create(ctx, NewActivity{
		ID:         activityID,
		UserID:     userID,
		Kind:       "bjj_session",
		OccurredAt: occurredAt,
		Notes:      &notes,
		RequestID:  "req_retry_attempt",
		TraceID:    "trace_retry_attempt",
	})
	if err != nil {
		t.Fatalf("idempotent retry create: %v", err)
	}
	if retry.RequestID != "req_first_attempt" {
		t.Fatalf("expected retry to return the original row's request_id, got %+v", retry)
	}

	activities, err := repo.ListByUser(ctx, userID)
	if err != nil {
		t.Fatalf("list by user: %v", err)
	}
	if len(activities) != 1 {
		t.Fatalf("expected exactly 1 activity for %s (idempotent create shouldn't duplicate), got %d: %+v", userID, len(activities), activities)
	}
}

// A user who logged activities but never completed onboarding (no profiles
// row) must still be findable by an admin — they're precisely the user most
// likely to need support. Regression test for ListUsers previously starting
// FROM profiles, which hid them entirely.
func TestPostgresRepository_ListUsers_IncludesProfilelessUsers(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}

	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	repo := NewPostgresRepository(pool)
	userID := "test_user_no_profile"
	activityID := "test_activity_no_profile"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM activities WHERE id = $1`, activityID); err != nil {
			t.Logf("cleanup: delete activity: %v", err)
		}
	})

	if _, err := repo.Create(ctx, NewActivity{
		ID:         activityID,
		UserID:     userID,
		Kind:       "bjj_session",
		OccurredAt: time.Now().Truncate(time.Second).UTC(),
		RequestID:  "req_no_profile",
		TraceID:    "trace_no_profile",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	users, err := repo.ListUsers(ctx)
	if err != nil {
		t.Fatalf("list users: %v", err)
	}

	for _, u := range users {
		if u.UserID == userID {
			if u.ActivityCount != 1 {
				t.Fatalf("expected activity_count 1 for profileless user, got %+v", u)
			}
			if u.DisplayName != nil {
				t.Fatalf("expected nil display_name for profileless user, got %+v", u)
			}
			return
		}
	}
	t.Fatalf("profileless user %q missing from ListUsers (%d users returned)", userID, len(users))
}

// A client-generated ID colliding with a *different* user's activity must
// not return that user's row (an IDOR: activity IDs are client-chosen, so
// they're guessable/replayable) and must not silently swallow this user's
// activity. Regression test for Create's conflict path previously falling
// back to an unscoped lookup by ID.
func TestPostgresRepository_Create_RejectsAnotherUsersID(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}

	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	repo := NewPostgresRepository(pool)
	activityID := "test_activity_cross_user"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM activities WHERE id = $1`, activityID); err != nil {
			t.Logf("cleanup: delete activity: %v", err)
		}
	})

	secret := "victim's private notes"
	if _, err := repo.Create(ctx, NewActivity{
		ID:         activityID,
		UserID:     "test_user_victim",
		Kind:       "bjj_session",
		OccurredAt: time.Now().Truncate(time.Second).UTC(),
		Notes:      &secret,
		RequestID:  "req_victim",
		TraceID:    "trace_victim",
	}); err != nil {
		t.Fatalf("seed victim activity: %v", err)
	}

	got, err := repo.Create(ctx, NewActivity{
		ID:         activityID, // same ID, different user
		UserID:     "test_user_attacker",
		Kind:       "bjj_session",
		OccurredAt: time.Now().Truncate(time.Second).UTC(),
		RequestID:  "req_attacker",
		TraceID:    "trace_attacker",
	})
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("expected ErrAlreadyExists for another user's id, got err=%v activity=%+v", err, got)
	}
	if got != nil {
		t.Fatalf("expected no activity returned on cross-user conflict, got %+v", got)
	}
}
