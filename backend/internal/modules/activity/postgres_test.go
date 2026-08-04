package activity

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"
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

// An explicitly stored toggle must beat the registry default, in both
// directions.
//
// Without this, only the no-rows path was covered — so a regression in the
// `key:bool` string parse (say `== "t"`, which is what Postgres would render
// under a different cast) would leave every user's toggles reading as
// defaults, and the suite would stay green while the admin console quietly
// showed the wrong disciplines for everyone who had ever changed one.
func TestPostgresRepository_ListUsers_StoredTogglesBeatDefaults(t *testing.T) {
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
	userID := "test_user_toggles"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM profiles WHERE user_id = $1`, userID); err != nil {
			t.Logf("cleanup: delete profile: %v", err)
		}
	})

	// profile_modules has an FK to profiles, so the row has to exist first.
	if _, err := pool.Exec(ctx,
		`INSERT INTO profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, userID); err != nil {
		t.Fatalf("insert profile: %v", err)
	}

	// Pick one default-on and one default-off sport straight from the
	// registry, then invert both — hardcoding keys here would make the test
	// wrong the moment a discipline's default changes.
	var on, off string
	var onLabel, offLabel string
	for _, m := range discipline.All() {
		if m.DefaultOn && on == "" {
			on, onLabel = m.Key, m.Label
		}
		if !m.DefaultOn && off == "" {
			off, offLabel = m.Key, m.Label
		}
	}
	if on == "" || off == "" {
		t.Skip("registry has no default-on/default-off pair to invert")
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO profile_modules (user_id, module_key, enabled)
		VALUES ($1, $2, false), ($1, $3, true)`, userID, on, off); err != nil {
		t.Fatalf("insert modules: %v", err)
	}

	detail, err := repo.GetUser(ctx, userID)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	got := map[string]bool{}
	for _, label := range detail.User.Modules {
		got[label] = true
	}
	if got[onLabel] {
		t.Fatalf("module %q was switched OFF but still reported enabled: %v", on, detail.User.Modules)
	}
	if !got[offLabel] {
		t.Fatalf("module %q was switched ON but is missing: %v", off, detail.User.Modules)
	}
}

// ListByUser is reachable by both a user (self-scoped) and an admin, and until
// this bound existed it returned every row an account had ever accumulated.
// apihttp.ConditionalGet now buffers the whole response body to hash it, so an
// unbounded row count is an unbounded allocation per in-flight request.
//
// Deliberately a real-database test, not a regex over the query string: a text
// assertion proves the clause is present, not that Postgres honours it, and
// "ORDER BY ... LIMIT" has a correctness half — the ceiling has to keep the
// NEWEST rows, or an audit log silently starts answering with its own
// prehistory.
func TestListByUserIsBoundedAndKeepsTheNewest(t *testing.T) {
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

	userID := "test_user_activity_limit"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM activities WHERE user_id = $1`, userID); err != nil {
			t.Logf("cleanup: delete activities: %v", err)
		}
	})

	// One past the ceiling, so the boundary itself is what's under test.
	const total = maxUserActivities + 1
	base := time.Now().Add(-time.Duration(total) * time.Hour).Truncate(time.Second).UTC()
	repo := NewPostgresRepository(pool)

	// Rows 0 and 1 SHARE an occurred_at, and they straddle the cut: with 501
	// rows and a ceiling of 500, exactly one of the two must be dropped. That
	// is the case the first version of this test could not reach — it spaced
	// every row an hour apart, so the ordering was total and the tiebreak was
	// never exercised. `occurred_at` is client-supplied, so ties are realistic.
	occurredAt := func(i int) time.Time {
		if i == 0 || i == 1 {
			return base
		}
		return base.Add(time.Duration(i) * time.Hour)
	}
	for i := 0; i < total; i++ {
		if _, err := repo.Create(ctx, NewActivity{
			ID:         fmt.Sprintf("test_activity_limit_%04d", i),
			UserID:     userID,
			Kind:       "bjj_session",
			OccurredAt: occurredAt(i),
			RequestID:  "req_limit",
			TraceID:    "trace_limit",
		}); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}

	activities, err := repo.ListByUser(ctx, userID)
	if err != nil {
		t.Fatalf("list by user: %v", err)
	}
	if len(activities) != maxUserActivities {
		t.Fatalf("got %d activities, want the ceiling of %d", len(activities), maxUserActivities)
	}
	// The newest row must be in; the tied pair at the far end is where the cap
	// falls, so exactly one of rows 0/1 survives.
	if activities[0].ID != fmt.Sprintf("test_activity_limit_%04d", total-1) {
		t.Errorf("newest row missing: first is %s", activities[0].ID)
	}
	tied := 0
	for _, a := range activities {
		if a.ID == "test_activity_limit_0000" || a.ID == "test_activity_limit_0001" {
			tied++
		}
	}
	if tied != 1 {
		t.Fatalf("expected exactly 1 of the tied pair to survive the cap, got %d", tied)
	}

	// Pin the EXACT order, tie included: occurred_at DESC, then id DESC. Row
	// 0001 outranks row 0000 on the tiebreak alone, so 0000 is the row the cap
	// drops.
	want := make([]string, 0, maxUserActivities)
	for i := total - 1; i >= 2; i-- {
		want = append(want, fmt.Sprintf("test_activity_limit_%04d", i))
	}
	want = append(want, "test_activity_limit_0001")
	if got := ids(activities); got != strings.Join(want, ",") {
		t.Fatalf("order is not (occurred_at DESC, id DESC)\n got  ...%s\n want ...%s",
			tail(got), tail(strings.Join(want, ",")))
	}

	// Honest limit of this test, stated because the alternative is a guard
	// that only looks covered: deleting `, id DESC` from the query does NOT
	// turn this red. The composite index added in migration 000030 carries
	// `id DESC` as its third column, so an index scan hands back that order
	// whether or not the SQL asks for it.
	//
	// The tiebreak is still load-bearing rather than decorative — it is what
	// keeps the order total if the plan changes to a seq scan, or if the index
	// is ever altered. Measured on an index WITHOUT the id column: a plain
	// UPDATE to one row of a tied pair flipped which of the two survived the
	// cap. Both halves are needed; neither is redundant with the other.
}

func ids(activities []Activity) string {
	out := make([]string, len(activities))
	for i, a := range activities {
		out[i] = a.ID
	}
	return strings.Join(out, ",")
}

// tail keeps the failure message readable — the divergence is at the boundary,
// which is the end of the list.
func tail(s string) string {
	if len(s) > 80 {
		return s[len(s)-80:]
	}
	return s
}
