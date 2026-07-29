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

	"github.com/dmytro-ch21/vola/backend/internal/modules/exercise"
	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL must be set")
	}

	ctx := context.Background()
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
}
