// Command seed loads version-controlled reference content into the database.
//
// Usage: seed
//
// Reads DATABASE_URL. Idempotent — every writer it calls upserts, so this is
// safe to run on every deploy and safe to re-run after editing the source
// JSON. That's the point: catalog content updates are a normal deploy step,
// not a one-off someone has to remember not to repeat.
//
// Separate binary from `migrate` on purpose. Migrations change schema and
// must run exactly once in a strict order; seeding writes content and is
// meant to run repeatedly. Folding content into migrations would mean a new
// migration file every time a typo in an exercise description gets fixed.
package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/modules/curriculum"
	"github.com/dmytro-ch21/vola/backend/internal/modules/exercise"
	"github.com/dmytro-ch21/vola/backend/internal/modules/food"
	"github.com/dmytro-ch21/vola/backend/internal/modules/health"
	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
	"github.com/dmytro-ch21/vola/backend/internal/modules/workout"
	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL must be set")
	}

	// Bounded rather than context.Background(): this runs as Railway's
	// preDeployCommand, where an unreachable database would otherwise hang
	// the deploy indefinitely instead of failing it.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		log.Fatalf("seed: database: %v", err)
	}
	defer pool.Close()

	n, err := exercise.Seed(ctx, exercise.NewPostgresRepository(pool))
	if err != nil {
		log.Fatalf("seed: exercises: %v", err)
	}
	log.Printf("seed: exercises: %d upserted", n)

	// The food catalog. No ordering constraint against anything else here —
	// nothing references a food by foreign key yet, unlike workout plans into
	// exercises or curricula into techniques.
	fn, err := food.Seed(ctx, food.NewPostgresRepository(pool))
	if err != nil {
		log.Fatalf("seed: foods: %v", err)
	}
	log.Printf("seed: foods: %d upserted", fn)

	// AFTER exercises, and the order is load-bearing rather than tidy: every
	// plan item is a foreign key into the catalog, so seeding these first would
	// fail on a fresh database with an error about an exercise that is merely
	// not written yet.
	wn, err := workout.Seed(ctx, pool)
	if err != nil {
		log.Fatalf("seed: workouts: %v", err)
	}
	log.Printf("seed: public workout plans: %d upserted", wn)

	tn, err := technique.Seed(ctx, technique.NewPostgresRepository(pool))
	if err != nil {
		log.Fatalf("seed: techniques: %v", err)
	}
	log.Printf("seed: techniques: %d upserted", tn)

	pn, err := technique.SeedPositions(ctx, technique.NewPostgresRepository(pool))
	if err != nil {
		log.Fatalf("seed: positions: %v", err)
	}
	log.Printf("seed: positions: %d upserted", pn)

	// AFTER techniques, and the order is load-bearing rather than tidy: every
	// syllabus item is a foreign key into the library, so seeding these first
	// would fail on a fresh database with an error about a technique that is
	// merely not written yet.
	cn, err := curriculum.Seed(ctx, pool)
	if err != nil {
		log.Fatalf("seed curricula: %v", err)
	}
	log.Printf("seed: curricula: %d upserted", cn)

	// Bound health_events while we're here. The seed is the only thing this
	// project runs on a schedule (predeploy, every deploy), and the table had
	// no retention at all — it grew forever. Failure is logged, never fatal:
	// tidying observability must not block a deploy.
	if n, err := health.NewPostgresRepository(pool).Prune(ctx); err != nil {
		log.Printf("seed: health prune failed (non-fatal): %v", err)
	} else if n > 0 {
		log.Printf("seed: health_events pruned: %d", n)
	}
}
