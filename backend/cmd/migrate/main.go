// Command migrate applies or rolls back database migrations, and refuses to do
// either against a database it cannot vouch for.
//
// Usage: migrate <up|down|status>
//
//	up      apply every migration above the recorded version
//	down    unwind EVERY migration (golang-migrate's m.Down(); there is no
//	        per-step form) — refused unless the target is a local database
//	status  read-only: print the target, its recorded version and what is
//	        pending. Safe to point at a deployed database.
//
// Reads MIGRATIONS_PATH (default "file://migrations", relative to the working
// directory the binary is run from) and DATABASE_URL.
//
// The guard exists because of issue #465: an unmerged branch's migrations were
// applied by hand to the staging Postgres, which took every deploy down for
// forty minutes. See internal/platform/migrateguard.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/dmytro-ch21/vola/backend/internal/platform/migrateguard"
)

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: migrate <up|down|status>")
	}
	command := os.Args[1]
	switch command {
	case "up", "down", "status":
	default:
		log.Fatalf("usage: migrate <up|down|status> (got %q)", command)
	}

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL must be set")
	}
	migrationsPath := os.Getenv("MIGRATIONS_PATH")
	if migrationsPath == "" {
		migrationsPath = "file://migrations"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	target := migrateguard.ParseTarget(databaseURL)
	dir, inspectable := migrateguard.DirFromPath(migrationsPath)

	// Provenance is established BEFORE anything connects, so a refusal never
	// opens a connection to a database it was never entitled to touch.
	prov := migrateguard.Provenance{}
	if inspectable {
		prov = migrateguard.Verify(ctx, dir)
	} else {
		prov.Problems = []string{fmt.Sprintf("%s is not a file:// source, so its contents cannot be compared with origin/main", migrationsPath)}
	}

	if command != "status" && !target.Local {
		if command == "down" {
			refuseRemoteDown(target)
		}
		if !prov.Verified {
			refuseUnverified(target, prov)
		}
	}

	var migs []migrateguard.Migration
	if inspectable {
		var err error
		migs, err = migrateguard.ReadMigrations(dir)
		if err != nil {
			log.Fatalf("migrate: cannot read %s: %v", dir, err)
		}
	}

	state, err := migrateguard.ReadState(ctx, databaseURL)
	if err != nil {
		log.Fatalf("migrate: cannot read schema_migrations on %s: %v", target.Display, err)
	}

	preamble(target, migrationsPath, migs, prov, state)

	if problems := migrateguard.CheckAgreement(state, migs, prov); len(problems) > 0 {
		reportDisagreement(command, problems)
	}

	switch command {
	case "status":
		log.Printf("migrate: status: no problems found")
		return
	case "up":
		runUp(migrationsPath, databaseURL, migs, state)
	case "down":
		runDown(migrationsPath, databaseURL, state)
	}
}

// preamble prints, in the same shape for every command, what this run is
// pointed at and what it is about to see. None of it was visible before #465,
// and all of it would have made that incident obvious in seconds.
func preamble(target migrateguard.Target, migrationsPath string, migs []migrateguard.Migration, prov migrateguard.Provenance, state migrateguard.State) {
	locality := "local"
	if !target.Local {
		locality = "NOT LOCAL"
	}
	log.Printf("migrate: target   %s  (%s)", target.Display, locality)

	source := fmt.Sprintf("%s — %d migration(s)", migrationsPath, len(migs))
	switch {
	case prov.Verified:
		source += ", verified against " + prov.Source
	case len(prov.Problems) == 1:
		source += ", NOT verified: " + prov.Problems[0]
	default:
		source += fmt.Sprintf(", NOT verified (%d finding(s), listed below)", len(prov.Problems))
	}
	log.Printf("migrate: source   %s", source)

	if state.Applied {
		dirty := "clean"
		if state.Dirty {
			dirty = "DIRTY"
		}
		log.Printf("migrate: current  version %d, %s", state.Version, dirty)
	} else {
		log.Printf("migrate: current  no migrations applied yet")
	}

	log.Printf("migrate: pending  %s", migrateguard.FormatPending(migrateguard.Pending(migs, state)))

	// Unconditionally, because the source line promises they are listed below.
	if !prov.Verified && len(prov.Problems) > 1 {
		for _, p := range prov.Problems {
			log.Printf("migrate:          - %s", p)
		}
	}
}

func runUp(migrationsPath, databaseURL string, migs []migrateguard.Migration, state migrateguard.State) {
	pending := migrateguard.Pending(migs, state)
	if len(pending) == 0 {
		log.Printf("migrate: up: nothing to apply")
		return
	}
	from := "nothing"
	if state.Applied {
		from = fmt.Sprintf("%d", state.Version)
	}
	log.Printf("migrate: applying %d migration(s): %s -> %d", len(pending), from, pending[len(pending)-1].Version)

	m := open(migrationsPath, databaseURL)
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		log.Fatalf("migrate: up: %v", err)
	}
	version, dirty, err := m.Version()
	if err != nil {
		log.Printf("migrate: up: done (version unreadable: %v)", err)
		return
	}
	if dirty {
		log.Fatalf("migrate: up: finished with the database marked DIRTY at version %d", version)
	}
	log.Printf("migrate: up: done — now at version %d", version)
}

func runDown(migrationsPath, databaseURL string, state migrateguard.State) {
	if !state.Applied {
		log.Printf("migrate: down: nothing to unwind")
		return
	}
	log.Printf("migrate: down: unwinding ALL %d migration(s) — golang-migrate has no per-step form", state.Version)
	m := open(migrationsPath, databaseURL)
	if err := m.Down(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		log.Fatalf("migrate: down: %v", err)
	}
	log.Printf("migrate: down: done — the schema is now empty")
}

func open(migrationsPath, databaseURL string) *migrate.Migrate {
	m, err := migrate.New(migrationsPath, databaseURL)
	if err != nil {
		log.Fatalf("migrate: open: %v", err)
	}
	return m
}

func refuseUnverified(target migrateguard.Target, prov migrateguard.Provenance) {
	fatal(fmt.Sprintf(`REFUSING to migrate a database that is not local.

  target:  %s
           %s
  reason:  these migration files are not verified against origin/main:
             - %s

A migration reaches a database that is not yours by being merged to main and
deployed, never by being pushed from a branch. Applying it here would put the
database AHEAD of main, and every subsequent deploy would then die in its
pre-deploy migrate phase — which is exactly what happened to staging (#461).

There is no environment variable that turns this off, deliberately.

  - Deploying main? Merge, and let the deploy run migrations. The deploy image
    carries a build attestation and needs nothing from you.
  - Just looking? 'migrate status' is read-only and is allowed here.
  - On a clean checkout of main and still seeing this? The most likely cause is
    the 'git fetch origin main' above; this guard will not trust a possibly
    stale origin/main.`,
		target.Display, target.Why, strings.Join(prov.Problems, "\n             - ")))
}

func refuseRemoteDown(target migrateguard.Target) {
	fatal(fmt.Sprintf(`REFUSING to run 'down' against a database that is not local.

  target:  %s
           %s

'migrate down' takes no step argument: it calls golang-migrate's m.Down(),
which unwinds EVERY migration and leaves an empty schema. No provenance
justifies that against a database somebody else is using, so there is nothing
to verify and nothing that would make this allowed.

To undo ONE migration on a shared database, apply that migration's own
.down.sql by hand in a single transaction and set schema_migrations.version
back. CLAUDE.md, "To undo one migration", has the recipe.`,
		target.Display, target.Why))
}

// reportDisagreement prints every way the database and the checkout contradict
// each other, and exits non-zero.
//
// `status` gets different framing on purpose: it has already done its whole job
// by the time this runs, so claiming to REFUSE something would be a lie. It
// still exits non-zero, so it is usable as a check.
func reportDisagreement(command string, problems []migrateguard.Disagreement) {
	var b strings.Builder
	if command == "status" {
		fmt.Fprint(&b, "status: the database and this checkout DISAGREE.\n")
	} else {
		fmt.Fprintf(&b, "REFUSING to run '%s': the database and this checkout disagree.\n", command)
	}
	for _, p := range problems {
		fmt.Fprintf(&b, "\n%s\n\n%s\n", p.Headline, indent(p.Detail))
	}
	fatal(strings.TrimRight(b.String(), "\n"))
}

func indent(s string) string {
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		if line == "" {
			continue // no trailing whitespace on blank lines
		}
		lines[i] = "  " + line
	}
	return strings.Join(lines, "\n")
}

// fatal prints a multi-line refusal and exits non-zero. Loudly on purpose:
// this whole class of bug is things that print something and exit 0.
func fatal(msg string) {
	log.Printf("migrate: %s", msg)
	os.Exit(1)
}
