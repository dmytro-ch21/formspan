package activity

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
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
			if u.SessionCount != 0 {
				t.Fatalf("expected session_count 0 for activity-only user, got %+v", u)
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

// The modern shape of the same rule: a user with SESSIONS but no profile row.
// Since the in-app activity form was removed, `activities` takes no new rows,
// so a never-onboarded user now shows up through `sessions` or not at all —
// and the summary must report their real training, not zeroes.
//
// This is the test that fails if ListUsers goes back to `FROM profiles`, which
// is exactly what a rewrite of it did.
func TestPostgresRepository_ListUsers_CountsSessionsNotActivities(t *testing.T) {
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
	userID := "test_user_sessions_only"
	sessionID := "test_session_admin_summary"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, sessionID); err != nil {
			t.Logf("cleanup: delete session: %v", err)
		}
	})

	started := time.Now().Truncate(time.Second).UTC()
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, sport, name, started_at)
		VALUES ($1, $2, 'bjj', 'Open mat', $3)`, sessionID, userID, started); err != nil {
		t.Fatalf("insert session: %v", err)
	}

	users, err := repo.ListUsers(ctx)
	if err != nil {
		t.Fatalf("list users: %v", err)
	}
	var found *UserSummary
	for i := range users {
		if users[i].UserID == userID {
			found = &users[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("profileless user %q with a session missing from ListUsers (%d returned)", userID, len(users))
	}
	if found.SessionCount != 1 {
		t.Fatalf("expected session_count 1, got %+v", *found)
	}
	if found.LastSessionAt == nil || !found.LastSessionAt.Equal(started) {
		t.Fatalf("expected last_session_at %v, got %+v", started, *found)
	}
	// Registry defaults, not "off" — the user has no profile_modules rows at all.
	if len(found.Modules) == 0 {
		t.Fatalf("expected registry-default modules for a user with no rows, got %+v", *found)
	}

	// And the same numbers through the single-user read, which is a different
	// query — the two are shared via userSummaryCols precisely so they cannot
	// report different totals for one account.
	detail, err := repo.GetUser(ctx, userID)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if detail.User.SessionCount != found.SessionCount || detail.User.SetCount != found.SetCount {
		t.Fatalf("detail disagrees with list: %+v vs %+v", detail.User, *found)
	}
	if len(detail.RecentSessions) != 1 || detail.RecentSessions[0].ID != sessionID {
		t.Fatalf("expected the session in recent_sessions, got %+v", detail.RecentSessions)
	}
	if detail.RecentSessions[0].Sport != "bjj" || detail.RecentSessions[0].EndedAt != nil {
		t.Fatalf("session summary wrong: %+v", detail.RecentSessions[0])
	}

	// An id nobody has ever used must 404, not render a page of zeroes.
	if _, err := repo.GetUser(ctx, "test_user_definitely_not_real"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for an unknown user, got %v", err)
	}
}
