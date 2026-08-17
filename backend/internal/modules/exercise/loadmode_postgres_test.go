package exercise

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestAdminAuthoredCarriesLoadMode closes a data-loss path that CI structurally
// cannot see.
//
// `cmd/exportcontent` writes `exercises.json` from `AdminAuthored`. When
// `contentReturning` omitted `load_mode`, every row came back with `""`, the
// export wrote that over the file's real value, and the next deploy —
// specifically BECAUSE this branch added `load_mode` to the seeder's
// change-detection tuple — actively rewrote `per_side` back to `total`.
// Dumbbell tonnage for that exercise then halves again: the exact bug the whole
// change exists to kill, reintroduced through the content pipeline.
//
// **A CI database never exercises it.** The path needs a row with
// `source='admin'`, and CI seeds nothing and authors nothing, so the export
// reports "nothing authored in the console; files untouched" and a green run
// proves the round trip works when it has not been run at all. Both review
// passes reproduced this only by forcing a row to admin ownership by hand,
// which is what this test does.
func TestAdminAuthoredCarriesLoadMode(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	const id = "lm_admin_db_press"
	if _, err := pool.Exec(ctx, `
		INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status, source, load_mode)
		VALUES ($1, 'Fixture Dumbbell Press', 'strength', 'push', 'weight_reps', 'published', 'admin', 'per_side')
		ON CONFLICT (id) DO UPDATE SET source = 'admin', load_mode = 'per_side'`, id); err != nil {
		t.Fatalf("seed admin exercise: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM exercises WHERE id = $1`, id)
	})

	rows, err := NewPostgresRepository(pool).AdminAuthored(ctx)
	if err != nil {
		t.Fatalf("admin authored: %v", err)
	}
	for _, e := range rows {
		if e.ID != id {
			continue
		}
		if e.LoadMode != LoadModePerSide {
			t.Fatalf("AdminAuthored returned load_mode %q for a per_side exercise — the export "+
				"writes this straight into exercises.json, so %q would become 'total' on the "+
				"next deploy and halve this exercise's tonnage", e.LoadMode, e.LoadMode)
		}
		return
	}
	t.Fatalf("%s did not come back from AdminAuthored at all", id)
}

// TestTheCatalogReadPathCarriesLoadMode covers the OTHER select — the public
// one, which every client actually reads.
//
// `AdminAuthored` has a test above because dropping `load_mode` there corrupts
// the seed file. Dropping it from `selectColumns` is quieter and reaches
// further: `GET /v1/exercises` and `GET /v1/exercises/{id}` are where the
// phone and the web session page learn that a movement is entered per hand, so
// an empty value there does not break anything — it silently stops telling the
// athlete which number to type, on all 142 of them, while every arithmetic
// test in the repository still passes because the tonnage rule reads the
// column directly in SQL and never goes near this path.
//
// The contract now lists `load_mode` in `Exercise.required`, which is the
// promise this test is the enforcement for.
func TestTheCatalogReadPathCarriesLoadMode(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	// Owned by this test rather than borrowed from the catalog: a seeded row
	// would make the assertion depend on `exercise`'s own Seed() having run,
	// which is the cross-package dependency this repository just finished
	// removing everywhere else.
	const id = "lm_read_db_press"
	if _, err := pool.Exec(ctx, `
		INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status, source, load_mode)
		VALUES ($1, 'Fixture Read Path Press', 'strength', 'push', 'weight_reps', 'published', 'seed', 'per_side')
		ON CONFLICT (id) DO UPDATE SET load_mode = 'per_side', status = 'published'`, id); err != nil {
		t.Fatalf("seed exercise: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM exercises WHERE id = $1`, id)
	})

	repo := NewPostgresRepository(pool)

	got, err := repo.Get(ctx, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.LoadMode != LoadModePerSide {
		t.Fatalf("Get returned load_mode %q, want %q — a client reading this cannot tell the "+
			"athlete to enter one dumbbell", got.LoadMode, LoadModePerSide)
	}

	// Both, because they are two different SQL statements sharing one column
	// list, and a change that reaches one can miss the other.
	list, err := repo.List(ctx, Filter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, e := range list {
		if e.ID != id {
			continue
		}
		if e.LoadMode != LoadModePerSide {
			t.Fatalf("List returned load_mode %q, want %q", e.LoadMode, LoadModePerSide)
		}
		return
	}
	t.Fatalf("%s did not come back from List at all", id)
}
