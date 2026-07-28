package featureflag

import (
	"context"
	"os"
	"testing"

	"github.com/dmytro-ch21/formspan/backend/internal/platform/database"
)

// Requires a real Postgres with migrations already applied — set
// TEST_DATABASE_URL to run this (see docker-compose.yml for local dev, or
// the `backend` CI job for how it's wired there). Skips otherwise so
// `go test ./...` still works without a database configured.
//
// No rows are created or deleted here (List is read-only) — this just
// verifies the migration's seeded flags come back correctly, so there's
// no cleanup ordering to worry about.
func TestPostgresRepository_List(t *testing.T) {
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
	flags, err := repo.List(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}

	byKey := make(map[string]Flag, len(flags))
	for _, f := range flags {
		byKey[f.Key] = f
	}

	seeded, ok := byKey["new_recommendation_engine"]
	if !ok {
		t.Fatalf("expected seeded flag %q, got %+v", "new_recommendation_engine", flags)
	}
	if seeded.Enabled {
		t.Fatalf("expected %q to default to disabled, got %+v", "new_recommendation_engine", seeded)
	}
	if seeded.Description == "" {
		t.Fatalf("expected %q to have a description, got %+v", "new_recommendation_engine", seeded)
	}
}
