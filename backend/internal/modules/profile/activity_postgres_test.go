package profile

import (
	"context"
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// The storage half of N93, against a real Postgres.
//
// These are integration tests rather than assertions about the query string,
// for the reason CLAUDE.md gives about SQL generally: a text assertion proves a
// clause is PRESENT, not that the database honours it. The property that
// matters here — that a PATCH omitting activity_level leaves a stored choice
// standing — is entirely a COALESCE behaviour, and no amount of grepping the
// SQL demonstrates it.
func activityRepo(t *testing.T, userID string) (*PostgresRepository, context.Context) {
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
	// Registered FIRST so it runs LAST: t.Cleanup is LIFO and strictly after
	// every defer, so a `defer pool.Close()` would shut the pool before the
	// row delete below could use it.
	t.Cleanup(pool.Close)
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM profiles WHERE user_id = $1`, userID); err != nil {
			t.Logf("cleanup: delete profile: %v", err)
		}
	})
	return NewPostgresRepository(pool), ctx
}

func TestActivityLevelStartsUnchosenRatherThanDefaulted(t *testing.T) {
	userID := "test_user_activity_unchosen"
	repo, ctx := activityRepo(t, userID)

	p, err := repo.Create(ctx, userID, NewProfile{})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// The whole reason the column is nullable. A NOT NULL DEFAULT 'light'
	// would put a value here that reads as the athlete's answer, and the
	// screen would render a filled pill for a choice nobody made.
	if p.ActivityLevel != nil {
		t.Fatalf("a brand-new profile has chosen nothing; got %q", *p.ActivityLevel)
	}
}

func TestActivityLevelSurvivesARoundTrip(t *testing.T) {
	userID := "test_user_activity_round_trip"
	repo, ctx := activityRepo(t, userID)

	if _, err := repo.Create(ctx, userID, NewProfile{}); err != nil {
		t.Fatalf("create: %v", err)
	}
	active := "active"
	updated, err := repo.Update(ctx, userID, ProfileUpdate{ActivityLevel: &active})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.ActivityLevel == nil || *updated.ActivityLevel != "active" {
		t.Fatalf("PATCH response: want active, got %v", updated.ActivityLevel)
	}

	// Re-READ, not just the write's own echo. The bug being fixed is precisely
	// that a value looked stored and was not there next time anybody asked, so
	// asserting only on the UPDATE ... RETURNING row would be asserting the
	// thing that already worked.
	got, err := repo.Get(ctx, userID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.ActivityLevel == nil || *got.ActivityLevel != "active" {
		t.Fatalf("re-read: want active, got %v", got.ActivityLevel)
	}
}

func TestActivityLevelIsLeftAloneByAPatchThatDoesNotMentionIt(t *testing.T) {
	userID := "test_user_activity_coalesce"
	repo, ctx := activityRepo(t, userID)

	if _, err := repo.Create(ctx, userID, NewProfile{}); err != nil {
		t.Fatalf("create: %v", err)
	}
	sedentary := "sedentary"
	if _, err := repo.Update(ctx, userID, ProfileUpdate{ActivityLevel: &sedentary}); err != nil {
		t.Fatalf("set level: %v", err)
	}

	// A PATCH from some other screen — Settings toggling a unit system, say —
	// must not blank it. This is the exercise module's updateWithin failure
	// mode, which has silently wiped authored data three times: the column
	// joins the SET clause without COALESCE, the write records the wipe as a
	// legitimate update, and the damage reads as history rather than a bug.
	imperial := "imperial"
	after, err := repo.Update(ctx, userID, ProfileUpdate{UnitSystem: &imperial})
	if err != nil {
		t.Fatalf("unrelated patch: %v", err)
	}
	if after.ActivityLevel == nil || *after.ActivityLevel != "sedentary" {
		t.Fatalf("an unrelated PATCH blanked the stored level; got %v", after.ActivityLevel)
	}
	if after.UnitSystem != "imperial" {
		t.Fatalf("the unrelated patch itself did not apply: got %q", after.UnitSystem)
	}
}

func TestActivityLevelCanBeChangedAgain(t *testing.T) {
	userID := "test_user_activity_rechosen"
	repo, ctx := activityRepo(t, userID)

	if _, err := repo.Create(ctx, userID, NewProfile{}); err != nil {
		t.Fatalf("create: %v", err)
	}
	for _, want := range []string{"sedentary", "active", "light"} {
		v := want
		got, err := repo.Update(ctx, userID, ProfileUpdate{ActivityLevel: &v})
		if err != nil {
			t.Fatalf("set %q: %v", want, err)
		}
		if got.ActivityLevel == nil || *got.ActivityLevel != want {
			t.Fatalf("set %q: got %v", want, got.ActivityLevel)
		}
	}
	// `light` last on purpose: it is the documented default, so a repository
	// that quietly stored nothing and let the default reappear would still
	// look correct on the first two and only differ here — where a re-read
	// must show a CHOICE of light rather than an absence.
	got, err := repo.Get(ctx, userID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.ActivityLevel == nil {
		t.Fatal("choosing the default level must still record a choice, not clear one")
	}
}
