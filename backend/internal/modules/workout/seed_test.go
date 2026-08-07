package workout

import (
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/modules/exercise"
)

// The seeded plans have to name exercises that exist.
//
// Every item is a foreign key into the catalog, so a typo is not a cosmetic
// error — it fails the whole seed transaction, which runs as Railway's
// preDeployCommand. That turns a one-character mistake in a JSON file into a
// failed deploy. Cheap to catch here: both catalogs parse without a database.
func TestSeedWorkoutsNameRealExercises(t *testing.T) {
	plans, err := SeedData()
	if err != nil {
		t.Fatalf("parse seeded plans: %v", err)
	}
	if len(plans) == 0 {
		// Guards every assertion below: an empty file would otherwise make this
		// test pass by checking nothing.
		t.Fatal("no seeded plans — did workouts.json move?")
	}

	catalog, err := exercise.SeedData()
	if err != nil {
		t.Fatalf("parse exercise catalog: %v", err)
	}
	known := make(map[string]exercise.Exercise, len(catalog))
	for _, e := range catalog {
		known[e.ID] = e
	}

	items := 0
	for _, p := range plans {
		if len(p.Items) == 0 {
			t.Errorf("plan %q has no exercises", p.ID)
		}
		for _, it := range p.Items {
			items++
			e, ok := known[it.ExerciseID]
			if !ok {
				t.Errorf("plan %q names exercise %q, which is not in the catalog", p.ID, it.ExerciseID)
				continue
			}
			// The seeder writes rows directly and so bypasses the repository's
			// `assertSportsMatch`. Nothing in the schema enforces
			// one-discipline-per-workout, which makes this file the only place
			// a mixed plan would be caught.
			if e.Sport != p.Sport {
				t.Errorf("plan %q (%s) names %q, which is a %s exercise",
					p.ID, p.Sport, it.ExerciseID, e.Sport)
			}
		}
	}
	t.Logf("%d plans, %d items, all resolving", len(plans), items)
}

// Ids are the upsert key, so a duplicate would make one plan silently replace
// another on every deploy — and the browse list would be short by one with no
// error anywhere.
func TestSeedWorkoutIDsAreUnique(t *testing.T) {
	plans, err := SeedData()
	if err != nil {
		t.Fatalf("parse seeded plans: %v", err)
	}
	seen := map[string]bool{}
	for _, p := range plans {
		if seen[p.ID] {
			t.Errorf("duplicate plan id %q", p.ID)
		}
		seen[p.ID] = true
	}
}

// The goal is a closed vocabulary the API validates. An unknown value here
// passes the seed (the column has no CHECK) and then makes the plan invisible
// to anyone filtering by goal.
func TestSeedWorkoutGoalsAreValid(t *testing.T) {
	plans, err := SeedData()
	if err != nil {
		t.Fatalf("parse seeded plans: %v", err)
	}
	for _, p := range plans {
		// No `p.Goal != ""` escape hatch. The earlier version skipped validation
		// for an empty goal, which BLESSED the exact case that breaks the deploy:
		// `workouts_goal_valid` is `goal IS NULL OR goal IN (...)`, so `''` is a
		// constraint violation. The seeder now writes NULL for an unset goal, and
		// this asserts the values it does write.
		if p.Goal != "" && !ValidGoal(Goal(p.Goal)) {
			t.Errorf("plan %q has goal %q, which the API would reject", p.ID, p.Goal)
		}
		if !ValidSport(Sport(p.Sport)) {
			t.Errorf("plan %q has sport %q, which the API would reject", p.ID, p.Sport)
		}
	}
}
