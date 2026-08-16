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
