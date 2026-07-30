package profile

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Requires a real Postgres with migrations already applied — set
// TEST_DATABASE_URL to run this (see docker-compose.yml for local dev, or
// the `backend` CI job for how it's wired there). Skips otherwise so
// `go test ./...` still works without a database configured.
// newTestRepo matches the session module's helper. pool.Close is registered
// first so it runs *last* under LIFO cleanup — registering it later would
// close the pool before the per-test row cleanups could use it.
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
	t.Cleanup(pool.Close)
	return NewPostgresRepository(pool), pool
}

func TestPostgresRepository_CreateGetUpdate(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}

	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered before the delete-row cleanup below so it runs *after* it:
	// t.Cleanup runs LIFO, and a plain `defer pool.Close()` here would run
	// before any t.Cleanup callback (defers run when the test function
	// returns; t.Cleanup runs afterward), closing the pool before the
	// delete could use it and silently leaking the row every run.
	t.Cleanup(func() { pool.Close() })

	repo := NewPostgresRepository(pool)
	userID := "test_user_create_get_update"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM profiles WHERE user_id = $1`, userID); err != nil {
			t.Logf("cleanup: delete profile: %v", err)
		}
	})

	name := "Test User"
	dob := "1990-01-01"
	sex := "male"
	created, err := repo.Create(ctx, userID, NewProfile{DisplayName: &name, DateOfBirth: &dob, Sex: &sex})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.UserID != userID || *created.DisplayName != name {
		t.Fatalf("unexpected created profile: %+v", created)
	}
	if !created.BJJEnabled || !created.StrengthEnabled || !created.NutritionEnabled || created.RunningEnabled {
		t.Fatalf("unexpected default module toggles: %+v", created)
	}

	if _, err := repo.Create(ctx, userID, NewProfile{}); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("expected ErrAlreadyExists on duplicate create, got %v", err)
	}

	fetched, err := repo.Get(ctx, userID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if fetched.UserID != userID || *fetched.DateOfBirth != dob {
		t.Fatalf("unexpected fetched profile: %+v", fetched)
	}

	runningOn := true
	updated, err := repo.Update(ctx, userID, ProfileUpdate{RunningEnabled: &runningOn})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !updated.RunningEnabled {
		t.Fatalf("expected running_enabled true after update, got %+v", updated)
	}
	if *updated.DisplayName != name {
		t.Fatalf("update should leave untouched fields alone, got %+v", updated)
	}

	if _, err := repo.Get(ctx, "nonexistent_user_xyz"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for unknown user, got %v", err)
	}
}

// Per-exercise unit overrides. A lifter who thinks in kilograms still faces a
// leg press marked in pounds; the override is per user *and* per exercise
// because it describes the equipment, not the person.
func TestExerciseUnits_SetClearAndScope(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	const me, other = "user_units_a", "user_units_b"
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM exercise_unit_prefs WHERE user_id IN ($1, $2)`, me, other)
	})

	// Absence means "use the profile default" — no third state.
	got, err := repo.ListExerciseUnits(ctx, me)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no overrides, got %v", got)
	}

	if err := repo.SetExerciseUnit(ctx, me, "bench-press", "imperial"); err != nil {
		t.Fatalf("set: %v", err)
	}
	// Upsert rather than a duplicate-key error.
	if err := repo.SetExerciseUnit(ctx, me, "bench-press", "metric"); err != nil {
		t.Fatalf("re-set: %v", err)
	}
	got, _ = repo.ListExerciseUnits(ctx, me)
	if got["bench-press"] != "metric" {
		t.Fatalf("want metric after re-set, got %q", got["bench-press"])
	}

	// Another user's override must never appear in mine.
	if err := repo.SetExerciseUnit(ctx, other, "back-squat", "imperial"); err != nil {
		t.Fatalf("set other: %v", err)
	}
	got, _ = repo.ListExerciseUnits(ctx, me)
	if _, leaked := got["back-squat"]; leaked {
		t.Fatal("another user's override leaked into this user's map")
	}

	// Clearing is a delete, so the key disappears rather than holding a
	// sentinel value.
	if err := repo.SetExerciseUnit(ctx, me, "bench-press", ""); err != nil {
		t.Fatalf("clear: %v", err)
	}
	got, _ = repo.ListExerciseUnits(ctx, me)
	if _, still := got["bench-press"]; still {
		t.Fatal("cleared override is still present")
	}
}

// An unknown exercise is bad input, not an internal error — the FK must be
// translated rather than escaping as a 500.
func TestExerciseUnits_RejectsUnknownExercise(t *testing.T) {
	repo, _ := newTestRepo(t)
	err := repo.SetExerciseUnit(context.Background(), "user_units_c", "no-such-exercise", "imperial")
	if err == nil {
		t.Fatal("expected an error for an unknown exercise")
	}
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
}
