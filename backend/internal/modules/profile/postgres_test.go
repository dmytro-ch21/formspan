package profile

import (
	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"

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
	// Module toggles are no longer profile columns — see TestProfileModules.

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

	imperial := "imperial"
	updated, err := repo.Update(ctx, userID, ProfileUpdate{UnitSystem: &imperial})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.UnitSystem != imperial {
		t.Fatalf("expected unit_system imperial after update, got %+v", updated)
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

// TestProfileModules covers the behaviour that replaced four boolean columns.
//
// The properties worth protecting are not "a row round-trips" but the two that
// make adding a discipline free: an absent row means the REGISTRY's default,
// and a sparse PATCH leaves other modules alone.
func TestProfileModules(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	userID := "user_modules_test"

	cleanupProfile(t, pool, userID)
	if _, err := repo.Create(ctx, userID, NewProfile{}); err != nil {
		t.Fatalf("create: %v", err)
	}

	// A brand-new profile stores NOTHING. That is the point: defaults live in
	// the registry, so a discipline added later needs no backfill.
	stored, err := repo.ListModules(ctx, userID)
	if err != nil {
		t.Fatalf("list modules: %v", err)
	}
	if len(stored) != 0 {
		t.Errorf("a new profile stored %d module rows; defaults belong to the registry, not the database", len(stored))
	}

	// ...and the merged view still answers for every module.
	mods := ModulesFor(stored)
	if len(mods) != len(discipline.All()) {
		t.Fatalf("ModulesFor returned %d modules, registry has %d", len(mods), len(discipline.All()))
	}
	for _, m := range mods {
		if m.Enabled != m.DefaultOn {
			t.Errorf("%s: enabled=%v with nothing stored, want the registry default %v", m.Key, m.Enabled, m.DefaultOn)
		}
	}

	// A sparse PATCH must not disturb anything it didn't name.
	if err := repo.SetModules(ctx, userID, map[string]bool{"bjj": false}); err != nil {
		t.Fatalf("set modules: %v", err)
	}
	stored, err = repo.ListModules(ctx, userID)
	if err != nil {
		t.Fatalf("list modules after set: %v", err)
	}
	if len(stored) != 1 || stored["bjj"] != false {
		t.Fatalf("expected exactly one stored row bjj=false, got %+v", stored)
	}
	for _, m := range ModulesFor(stored) {
		want := m.DefaultOn
		if m.Key == "bjj" {
			want = false
		}
		if m.Enabled != want {
			t.Errorf("%s: enabled=%v, want %v (a one-key PATCH must leave the rest alone)", m.Key, m.Enabled, want)
		}
	}

	// Toggling back is an update, not a second row.
	if err := repo.SetModules(ctx, userID, map[string]bool{"bjj": true, "running": true}); err != nil {
		t.Fatalf("set modules again: %v", err)
	}
	stored, _ = repo.ListModules(ctx, userID)
	if len(stored) != 2 || !stored["bjj"] || !stored["running"] {
		t.Fatalf("expected bjj and running true, got %+v", stored)
	}

	// An empty PATCH is a no-op rather than an error or a wipe.
	if err := repo.SetModules(ctx, userID, map[string]bool{}); err != nil {
		t.Errorf("empty set should be a no-op, got %v", err)
	}
	after, _ := repo.ListModules(ctx, userID)
	if len(after) != 2 {
		t.Errorf("empty set changed stored rows: %+v", after)
	}

	// A user with no profile row cannot have modules — the FK is the guard.
	if err := repo.SetModules(ctx, "user_no_profile_xyz", map[string]bool{"bjj": true}); err == nil {
		t.Error("expected an error setting modules for a user with no profile")
	}
}

func cleanupProfile(t *testing.T, pool *pgxpool.Pool, userID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`DELETE FROM profiles WHERE user_id = $1`, userID); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
}
