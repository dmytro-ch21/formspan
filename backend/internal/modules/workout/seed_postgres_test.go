package workout

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The seeder against a real database.
//
// The property below was verified by hand once — plant a user-owned workout on
// a seeded id, run the deploy, check it survived — and a property verified by
// hand is a property nothing is holding. This is the load-bearing one: if it
// regresses, a deploy silently overwrites somebody's training, and the only
// person who finds out is the athlete whose plan changed under them.
func seedPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered before anything else that needs the pool — t.Cleanup runs
	// LIFO and strictly after every defer, so a `defer pool.Close()` here would
	// close it out from under the cleanups below.
	t.Cleanup(pool.Close)
	return pool
}

func TestSeedIsIdempotent(t *testing.T) {
	pool := seedPool(t)
	ctx := context.Background()

	first, err := Seed(ctx, pool)
	if err != nil {
		t.Fatalf("first seed: %v", err)
	}
	second, err := Seed(ctx, pool)
	if err != nil {
		t.Fatalf("second seed: %v", err)
	}
	if first != second {
		t.Errorf("seed is not idempotent: wrote %d then %d", first, second)
	}

	plans, _ := SeedData()
	var rows, items int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM workouts WHERE source = 'seed'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != len(plans) {
		// A duplicate factory rather than an upsert would show up here as 32.
		t.Errorf("after two runs: %d seeded rows, want %d", rows, len(plans))
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM workout_items wi
		JOIN workouts w ON w.id = wi.workout_id WHERE w.source = 'seed'`).Scan(&items); err != nil {
		t.Fatal(err)
	}
	want := 0
	for _, p := range plans {
		want += len(p.Items)
	}
	if items != want {
		t.Errorf("after two runs: %d seeded items, want %d", items, want)
	}
}

// THE test. A deploy must not touch a workout somebody owns, even when the ids
// collide — and it must not empty it either, which is the worse failure: the
// plan keeps its name, so it reads as the athlete's own mistake.
func TestSeedNeverOverwritesAnOwnedWorkout(t *testing.T) {
	pool := seedPool(t)
	ctx := context.Background()

	plans, err := SeedData()
	if err != nil || len(plans) == 0 {
		t.Fatalf("no seeded plans to collide with: %v", err)
	}
	victim := plans[0].ID

	if _, err := pool.Exec(ctx, `DELETE FROM workouts WHERE id = $1`, victim); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO workouts (id, owner_user_id, source, name, sport, goal, notes, visibility)
		VALUES ($1, 'seed_test_user', 'user', 'MY plan', 'strength', 'general', '', 'private')`,
		victim); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO workout_items (workout_id, exercise_id, position, target_sets, target_reps)
		VALUES ($1, $2, 0, 9, 9)`, victim, plans[0].Items[0].ExerciseID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM workouts WHERE id = $1`, victim)
		// Put the seeded row back. Without this the planted collision outlives
		// the test, the next seed correctly SKIPS that id, and
		// `TestSeedIsIdempotent` fails on a row count that is short by one —
		// blaming the seeder for this test's litter. Order-dependent failures
		// in a shared-database suite are the kind that get re-run until they
		// pass rather than diagnosed.
		_, _ = Seed(ctx, pool)
	})

	if _, err := Seed(ctx, pool); err != nil {
		t.Fatalf("seed: %v", err)
	}

	var name, owner, source, visibility string
	if err := pool.QueryRow(ctx,
		`SELECT name, owner_user_id, source, visibility FROM workouts WHERE id = $1`,
		victim).Scan(&name, &owner, &source, &visibility); err != nil {
		t.Fatal(err)
	}
	if name != "MY plan" || owner != "seed_test_user" || source != "user" || visibility != "private" {
		t.Errorf("the deploy overwrote a user's workout: name=%q owner=%q source=%q visibility=%q",
			name, owner, source, visibility)
	}

	// The half that needs its own guard in the seeder. Without it the row above
	// passes every assertion and the plan is empty.
	var sets, reps int
	if err := pool.QueryRow(ctx,
		`SELECT target_sets, target_reps FROM workout_items WHERE workout_id = $1`,
		victim).Scan(&sets, &reps); err != nil {
		t.Fatalf("the deploy deleted the user's exercises: %v", err)
	}
	if sets != 9 || reps != 9 {
		t.Errorf("the deploy rewrote the user's exercises: %d x %d", sets, reps)
	}
}
