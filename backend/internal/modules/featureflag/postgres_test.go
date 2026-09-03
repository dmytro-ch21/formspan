package featureflag

import (
	"context"
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
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

// TestPostgresRepository_Enabled exercises the method N473/#812 added —
// session.Handler's FlagSource gate reads exactly this. Covers both the
// seeded-but-disabled case (matching List's own assertion above) and the
// "never seeded at all" case, which must read as false rather than error —
// see Enabled's own doc comment for why a missing row isn't a failure.
func TestPostgresRepository_Enabled(t *testing.T) {
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

	enabled, err := repo.Enabled(ctx, "new_recommendation_engine")
	if err != nil {
		t.Fatalf("enabled: %v", err)
	}
	if enabled {
		t.Fatalf("expected %q to default to disabled", "new_recommendation_engine")
	}

	enabled, err = repo.Enabled(ctx, "this_key_has_never_been_seeded_"+t.Name())
	if err != nil {
		t.Fatalf("enabled for an unseeded key must not error, got: %v", err)
	}
	if enabled {
		t.Fatalf("an unseeded key must read as disabled, not enabled")
	}
}
