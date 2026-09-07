// sweepephemeral is N150/#554's cleanup for a crashed engine worker's leaked
// ephemeral Postgres database and role (worker.Sweep does the actual work;
// see engine/internal/worker/sweep.go for the mechanism and why the TTL is
// encoded in the resource's own NAME rather than a side table).
//
// This is deliberately a plain, explicit command rather than something
// devengine calls on its own timer or at startup: devengine is still Phase-1
// SHADOW MODE (see cmd/devengine's own doc comment) and calls
// worker.Runner.Provision precisely nowhere yet, so there is no live
// orchestrator process to hook a "run this on startup" or "run this on a
// timer" call into. Of the three places N150/#554's design guidance names
// for the sweep to run — fleet startup, a timer, or an explicit command —
// this is the only one that is actually usable today. Run it by hand or
// from cron/a scheduled CI job against the same Postgres SERVER
// worker.Runner.AdminDBURL points workers at:
//
//	go run ./cmd/sweepephemeral --admin-db-url=$TEST_DATABASE_URL --ttl=1h
//	go run ./cmd/sweepephemeral --admin-db-url=$TEST_DATABASE_URL --ttl=1h --dry-run
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/dmytro-ch21/vola/engine/internal/worker"
)

func main() {
	adminURL := flag.String("admin-db-url", os.Getenv("ADMIN_DATABASE_URL"),
		"Postgres SERVER connection string with CREATEDB/CREATEROLE privilege — "+
			"the same server engine workers provision their ephemeral databases against")
	ttl := flag.Duration("ttl", time.Hour,
		"age past which an unreclaimed ephemeral engine database/role is considered abandoned and removed")
	dryRun := flag.Bool("dry-run", false, "report what would be removed without removing anything")
	flag.Parse()

	if *adminURL == "" {
		log.Fatal("sweepephemeral: --admin-db-url (or ADMIN_DATABASE_URL) is required")
	}

	result, err := worker.Sweep(context.Background(), *adminURL, time.Now().Add(-*ttl), *dryRun)
	if err != nil {
		log.Fatalf("sweepephemeral: %v", err)
	}

	verb := "removed"
	if *dryRun {
		verb = "would remove"
	}
	fmt.Printf("sweepephemeral: %s %d database(s), %d role(s)\n",
		verb, len(result.DroppedDatabases), len(result.DroppedRoles))
	for _, db := range result.DroppedDatabases {
		fmt.Println("  database:", db)
	}
	for _, role := range result.DroppedRoles {
		fmt.Println("  role:", role)
	}

	if len(result.Errors) > 0 {
		for _, e := range result.Errors {
			fmt.Fprintln(os.Stderr, "sweepephemeral: error:", e)
		}
		os.Exit(1)
	}
}
