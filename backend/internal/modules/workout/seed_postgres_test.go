package workout

import (
	"context"
	"errors"
	"os"
	"sort"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/modules/exercise"
	"github.com/jackc/pgx/v5"
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
	seedReferencedExercises(t, pool)
	return pool
}

// seedReferencedExercises writes the catalog rows the SEEDED PLANS name, so
// these two tests can run against a freshly migrated database.
//
// This is a different dependency from the rest of the package, and it is not
// one that namespaced fixtures can replace. The tests above exercise the real
// deploy path: `Seed` writes the 17 shipped plans, whose 84 items are foreign
// keys into the catalog by design. Substituting invented ids would test a
// different thing. So the rows come from `exercise.SeedData()` — the same file
// `cmd/seed` reads, and the same one `TestSeedWorkoutsNameRealExercises`
// already checks these ids against — restricted to exactly the ids the plans
// reference. Owning what you depend on, where what you depend on is real
// content.
//
// **It removes only the rows it actually created.** The insert is
// `ON CONFLICT DO NOTHING RETURNING id`, which returns a row only when one was
// really inserted, and the cleanup deletes that set and nothing else. On an
// already-seeded database — the usual state of the shared `vola_test` — it
// inserts nothing and therefore deletes nothing, so it can never take a real
// catalog row out from under another package. Getting this wrong in the other
// direction is not hypothetical: this package's own `seedDraftExercise` records
// having leaked fixtures that had to be cleared by hand.
//
// The workout half of the cleanup needs the same care and did not have it at
// first — see the note on `preexisting` below.
func seedReferencedExercises(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	plans, err := SeedData()
	if err != nil {
		t.Fatalf("parse seeded plans: %v", err)
	}
	catalog, err := exercise.SeedData()
	if err != nil {
		t.Fatalf("parse exercise catalog: %v", err)
	}
	known := make(map[string]exercise.Exercise, len(catalog))
	for _, e := range catalog {
		known[e.ID] = e
	}

	// Distinct, and in a stable order so a failure names the same row twice.
	seen := map[string]bool{}
	wanted := []string{}
	for _, p := range plans {
		for _, it := range p.Items {
			if !seen[it.ExerciseID] {
				seen[it.ExerciseID] = true
				wanted = append(wanted, it.ExerciseID)
			}
		}
	}
	sort.Strings(wanted)

	// Workouts that already existed. The cleanup must not remove these even
	// when they reference a row it created, which is a real case rather than a
	// hypothetical one: on a catalog that is seeded but STALE — the shared
	// `vola_test` the first time a content edit adds a plan-referenced exercise
	// — `created` is the delta, the `Seed` below rewrites plan items to
	// reference it, and a delete keyed only on `created` then takes out
	// pre-existing seeded plans. Measured at 17 plans becoming 16, with the
	// tests still green: a quiet mutation of shared state, which is worse than
	// the loud foreign-key failure this replaced.
	preexisting := map[string]bool{}
	rows, err := pool.Query(ctx, `SELECT id FROM workouts`)
	if err != nil {
		t.Fatalf("read existing workouts: %v", err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			t.Fatalf("scan existing workout: %v", err)
		}
		preexisting[id] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("read existing workouts: %v", err)
	}

	var created []string
	t.Cleanup(func() {
		if len(created) == 0 {
			return
		}
		// Three steps, and all three are needed. `workout_items` is NO ACTION,
		// so the references have to go before the exercises — but only the ones
		// this run introduced.
		//
		// 1. Workouts this run created: removed whole, items cascading with
		//    them. Workouts that were here before are left alone.
		var orphans []string
		wr, err := pool.Query(ctx, `
			SELECT DISTINCT workout_id FROM workout_items WHERE exercise_id = ANY($1)`, created)
		if err != nil {
			t.Logf("find workouts referencing seeded-plan exercises: %v", err)
		} else {
			for wr.Next() {
				var id string
				if err := wr.Scan(&id); err != nil {
					t.Logf("scan workout id: %v", err)
					break
				}
				if !preexisting[id] {
					orphans = append(orphans, id)
				}
			}
			wr.Close()
		}
		if len(orphans) > 0 {
			if _, err := pool.Exec(ctx,
				`DELETE FROM workouts WHERE id = ANY($1)`, orphans); err != nil {
				t.Logf("cleanup workouts referencing seeded-plan exercises: %v", err)
			}
		}
		// 2. Items left inside PRE-EXISTING workouts that point at a row this
		//    run created. Those items are necessarily new too — the foreign key
		//    would have refused them while the exercise did not exist — so
		//    removing them restores the pre-run state exactly rather than
		//    editing somebody's plan. Skipping this step does not delete
		//    anything, it LEAKS: the exercise delete below fails the foreign key
		//    and a real-content row survives into the shared database. Measured
		//    on a stale catalog: 761 rows became 762.
		if _, err := pool.Exec(ctx,
			`DELETE FROM workout_items WHERE exercise_id = ANY($1)`, created); err != nil {
			t.Logf("cleanup workout items referencing seeded-plan exercises: %v", err)
		}
		// 3. And now the exercises themselves — reported as a FAILURE, not a
		// log line, and verified afterwards.
		//
		// These are REAL catalog ids, so a silently failed delete here leaves
		// the actual catalog partially populated in the shared database, which
		// is exactly the residue a later package can start borrowing from
		// without anything going red. That is the crutch `exercise`'s own
		// `removeCatalogAfterTest` exists to remove, and this is the one other
		// place in the suite that can put a piece of it back. A `t.Logf` is
		// invisible in a green non-verbose run, so it gets the same treatment
		// as the guard it would otherwise undermine.
		if _, err := pool.Exec(ctx, `DELETE FROM exercises WHERE id = ANY($1)`, created); err != nil {
			t.Errorf("cleanup seeded-plan exercises: %v", err)
			return
		}
		var left int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM exercises WHERE id = ANY($1)`, created).Scan(&left); err != nil {
			t.Errorf("could not confirm the seeded-plan exercises were removed: %v", err)
			return
		}
		if left != 0 {
			t.Errorf("%d of %d real catalog rows this test inserted survived cleanup; "+
				"another package could start depending on them", left, len(created))
		}
	})

	for _, id := range wanted {
		e, ok := known[id]
		if !ok {
			// TestSeedWorkoutsNameRealExercises covers this properly, without a
			// database. Failing here too would just be a worse copy of it.
			t.Fatalf("seeded plan names %q, which is not in the exercise catalog", id)
		}
		// The deploy path's own normalizers, not hand-rolled equivalents. A
		// hand-rolled `"" -> "total"` agrees with NormalizeLoadMode on the empty
		// string and diverges on an unrecognized one, which `validate()` does
		// not reject — so a typo'd load_mode would deploy fine and fail here on
		// a raw CHECK violation blaming the wrong package. Status likewise: a
		// legitimately-draft catalog entry should be seeded draft, as the real
		// seeder would, rather than silently promoted.
		var inserted string
		err := pool.QueryRow(ctx, `
			INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status, load_mode, is_unilateral)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (id) DO NOTHING
			RETURNING id`,
			e.ID, e.Name, e.Sport, e.MovementPattern, string(e.LoadType),
			exercise.NormalizeStatus(e.Status), exercise.NormalizeLoadMode(e.LoadMode), e.IsUnilateral,
		).Scan(&inserted)
		switch {
		case err == nil:
			created = append(created, inserted)
		case errors.Is(err, pgx.ErrNoRows):
			// Already present — a real catalog row. Leave it entirely alone.
		default:
			t.Fatalf("seed referenced exercise %s: %v", id, err)
		}
	}
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
