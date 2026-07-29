package exercise

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// These are Postgres integration tests. They need TEST_DATABASE_URL to run
// (see docker-compose.yml for local dev, or backend/.env.example) and skip
// gracefully without it.

func newTestRepo(t *testing.T) *PostgresRepository {
	t.Helper()

	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}

	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered before any cleanup that still needs the pool open —
	// t.Cleanup runs LIFO, so this closes last.
	t.Cleanup(pool.Close)

	return NewPostgresRepository(pool)
}

// The seed content is the product here, so a malformed entry is a real
// defect. No database needed — this guards the JSON itself.
func TestSeedData_IsValid(t *testing.T) {
	exercises, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}
	if len(exercises) == 0 {
		t.Fatal("seed catalog is empty")
	}

	// Every load type a client can render should be exercised by the starter
	// set — otherwise the first exercise of a given type ships untested.
	seenLoadTypes := map[LoadType]bool{}
	for _, e := range exercises {
		seenLoadTypes[e.LoadType] = true
	}
	for _, lt := range []LoadType{
		LoadTypeWeightReps, LoadTypeReps, LoadTypeTime,
		LoadTypeDistance, LoadTypeDistanceTime,
	} {
		if !seenLoadTypes[lt] {
			t.Errorf("no seed exercise uses load_type %q", lt)
		}
	}
}

func TestValidate_RejectsBadContent(t *testing.T) {
	cases := []struct {
		name string
		in   []Exercise
	}{
		{"duplicate id", []Exercise{
			{ID: "a", Name: "A", Sport: "strength", MovementPattern: "squat", LoadType: LoadTypeReps},
			{ID: "a", Name: "B", Sport: "strength", MovementPattern: "hinge", LoadType: LoadTypeReps},
		}},
		{"unknown load type", []Exercise{
			{ID: "a", Name: "A", Sport: "strength", MovementPattern: "squat", LoadType: "sets_and_vibes"},
		}},
		{"missing movement pattern", []Exercise{
			{ID: "a", Name: "A", Sport: "strength", LoadType: LoadTypeReps},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validate(tc.in); err == nil {
				t.Fatal("expected validation error, got nil")
			}
		})
	}
}

func TestPostgresRepository_SeedIsIdempotent(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	n1, err := Seed(ctx, repo)
	if err != nil {
		t.Fatalf("first seed: %v", err)
	}

	before, err := repo.Get(ctx, "barbell-back-squat")
	if err != nil {
		t.Fatalf("get after first seed: %v", err)
	}

	// Re-running the seed is a normal deploy step, so it must not duplicate
	// rows or reset creation timestamps.
	n2, err := Seed(ctx, repo)
	if err != nil {
		t.Fatalf("second seed: %v", err)
	}
	if n1 != n2 {
		t.Errorf("seed count changed between runs: %d then %d", n1, n2)
	}

	after, err := repo.Get(ctx, "barbell-back-squat")
	if err != nil {
		t.Fatalf("get after second seed: %v", err)
	}
	if !after.CreatedAt.Equal(before.CreatedAt) {
		t.Errorf("created_at changed on re-seed: %v then %v", before.CreatedAt, after.CreatedAt)
	}

	all, err := repo.List(ctx, Filter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != n1 {
		t.Errorf("re-seeding duplicated rows: seeded %d, listed %d", n1, len(all))
	}
}

func TestPostgresRepository_ListFilters(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	if _, err := Seed(ctx, repo); err != nil {
		t.Fatalf("seed: %v", err)
	}

	bjj, err := repo.List(ctx, Filter{Sport: "bjj"})
	if err != nil {
		t.Fatalf("list by sport: %v", err)
	}
	if len(bjj) == 0 {
		t.Fatal("expected at least one bjj exercise")
	}
	for _, e := range bjj {
		if e.Sport != "bjj" {
			t.Errorf("sport filter leaked %q (%s)", e.Sport, e.ID)
		}
	}

	// Case-insensitive substring — a catalog search that only matched exact
	// case would be useless on a phone keyboard.
	found, err := repo.List(ctx, Filter{Query: "SQUAT"})
	if err != nil {
		t.Fatalf("list by query: %v", err)
	}
	if len(found) == 0 {
		t.Fatal(`expected "SQUAT" to match Barbell Back Squat case-insensitively`)
	}

	none, err := repo.List(ctx, Filter{Query: "definitely-not-an-exercise"})
	if err != nil {
		t.Fatalf("list no match: %v", err)
	}
	if len(none) != 0 {
		t.Errorf("expected no matches, got %d", len(none))
	}
}

func TestPostgresRepository_GetNotFound(t *testing.T) {
	repo := newTestRepo(t)

	e, err := repo.Get(context.Background(), "no-such-exercise")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
	if e != nil {
		t.Errorf("expected nil exercise alongside error, got %+v", e)
	}
}
