package exercise

import (
	"context"
	"testing"
)

// The three exercises a real athlete reported as missing from this catalog.
//
// **Every one of them was already there.** The search returned nothing because
// it was a single contiguous `ILIKE '%term%'`, so a query had to be a substring
// of the stored name — right words, wrong order, no result; right movement,
// different word, no result. That reads exactly like "the app does not have
// this exercise", which is what was reported.
//
// These fixtures are the report, turned into assertions. They are also owned by
// this test rather than borrowed from the seeded catalog, per the rule the rest
// of this package follows: `exercise`'s own seeding tests delete the 762 rows
// afterwards, so a test that leaned on them would pass locally and fail in CI.
func TestFindsTheExercisesAnAthleteCouldNotFind(t *testing.T) {
	repo, ctx := searchFixture(t)

	// Asserted on the NAME, not the id, and that is deliberate. These fixtures
	// carry the real catalog's names on purpose — they are the reported rows —
	// so on a developer database that has been seeded, the genuine row and this
	// one are both present and equally good answers. Pinning the id would make
	// the test pass only on the unseeded database CI uses, which is the
	// environment-dependent green this package has been bitten by before.
	for _, c := range []struct{ typed, want string }{
		// Word order and a plural. Every word is present and in order; the
		// hyphen and the "s" are what defeated a substring match.
		{"ez bar curls", "EZ-Bar Curl"},
		// Vocabulary. "Bench" appears nowhere in the name — a bench press is
		// usually just called a press in the catalog — so no fuzzy matching
		// reaches this row. Only a synonym does.
		{"incline dumbbell bench", "Incline Dumbbell Press"},
		// Vocabulary again, the other way: the athlete says overhead, the
		// catalog says shoulder.
		{"dumbbell overhead press", "Seated Dumbbell Shoulder Press"},
	} {
		got, err := repo.List(ctx, Filter{Query: c.typed})
		if err != nil {
			t.Fatalf("%q: %v", c.typed, err)
		}
		if len(got) == 0 {
			t.Errorf("%q returned NOTHING — this is the bug being fixed, and the "+
				"exercise is in the catalog", c.typed)
			continue
		}
		if got[0].Name != c.want {
			t.Errorf("%q ranked %q first, want %q", c.typed, got[0].Name, c.want)
		}
	}
}

// Ranking has to speak the same vocabulary as matching, and this is the case
// that proves it.
//
// "incline dumbbell bench" MATCHES both rows — the row contains all three typed
// words literally, the press matches through the bench->press synonym. Ranked
// against the raw query the row wins (it is the closer string); ranked against
// the expanded one the press wins, which is what the athlete meant. Shipping
// the first version is easy and the failure is invisible: results appear, they
// are simply the wrong ones first.
func TestTheSynonymThatMatchesAlsoRanks(t *testing.T) {
	repo, ctx := searchFixture(t)

	got, err := repo.List(ctx, Filter{Query: "incline dumbbell bench"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var sawRow bool
	for _, e := range got {
		if e.Name == "Incline Bench Dumbbell Row" {
			sawRow = true
		}
	}
	if !sawRow {
		t.Fatal("the decoy row is not in the results, so this test cannot prove " +
			"anything about ordering — the fixture has drifted")
	}
	if got[0].Name != "Incline Dumbbell Press" {
		t.Fatalf("ranked %q first, want the press — a row that happens to contain "+
			"every typed word must not outrank the movement actually meant", got[0].Name)
	}
}

// A drafted exercise stays invisible however it is searched for. The search
// composes into the WHERE alongside the status filter, and a new clause that
// accidentally replaced it rather than joining it would publish drafts.
func TestSearchCannotSurfaceADraft(t *testing.T) {
	repo, ctx := searchFixture(t)

	got, err := repo.List(ctx, Filter{Query: "secret prototype"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, e := range got {
		if e.Name == "Secret Prototype Machine" {
			t.Fatal("a draft came back from a search — the status filter is no " +
				"longer ANDed with the query")
		}
	}
}

// searchFixture owns every row it needs, and removes them afterwards.
func searchFixture(t *testing.T) (*PostgresRepository, context.Context) {
	t.Helper()
	repo := newTestRepo(t)
	ctx := context.Background()

	rows := []struct{ id, name, status string }{
		{"sf_ez_bar_curl", "EZ-Bar Curl", "published"},
		{"sf_incline_dumbbell_press", "Incline Dumbbell Press", "published"},
		// The decoy: contains every word of "incline dumbbell bench" literally.
		{"sf_incline_bench_dumbbell_row", "Incline Bench Dumbbell Row", "published"},
		{"sf_seated_dumbbell_shoulder_press", "Seated Dumbbell Shoulder Press", "published"},
		{"sf_secret_prototype", "Secret Prototype Machine", "draft"},
	}
	for _, r := range rows {
		if _, err := repo.pool.Exec(ctx, `
			INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status, source, load_mode)
			VALUES ($1, $2, 'strength', 'horizontal_push', 'weight_reps', $3, 'seed', 'total')
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name, status = EXCLUDED.status,
				sport = EXCLUDED.sport, movement_pattern = EXCLUDED.movement_pattern,
				load_type = EXCLUDED.load_type, source = EXCLUDED.source,
				load_mode = EXCLUDED.load_mode`, r.id, r.name, r.status); err != nil {
			t.Fatalf("seed %s: %v", r.id, err)
		}
	}
	t.Cleanup(func() {
		for _, r := range rows {
			if _, err := repo.pool.Exec(context.Background(),
				`DELETE FROM exercises WHERE id = $1`, r.id); err != nil {
				// Errorf, not Logf: these are `published`, `source='seed'` rows
				// in a database every worktree shares, so a cleanup that fails
				// quietly leaves five fake exercises in the catalog for
				// everybody else.
				t.Errorf("cleanup %s: %v", r.id, err)
			}
		}
	})
	return repo, ctx
}
