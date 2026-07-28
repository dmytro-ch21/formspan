package profile

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/dmytro-ch21/formspan/backend/internal/platform/database"
)

// Requires a real Postgres with migrations already applied — set
// TEST_DATABASE_URL to run this (see docker-compose.yml for local dev, or
// the `backend` CI job for how it's wired there). Skips otherwise so
// `go test ./...` still works without a database configured.
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
