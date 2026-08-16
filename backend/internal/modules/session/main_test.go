package session

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

// catalogFixtureIDs are the real catalog ids this package's fixtures borrow.
// Listed here so the guard below and the tests cannot drift apart: a new
// fixture id that is not in this list is simply unguarded, not silently wrong.
var catalogFixtureIDs = []string{exBench, exSquat, exOHP, exRun, exDBBench}

// TestMain fails the package fast when the exercise catalog is missing, rather
// than letting 22 tests each report `unknown exercise "back-squat"`.
//
// This package does not seed the rows it depends on — see the note at the top
// of postgres_test.go. In a full `go test -p 1 ./...` that is invisible, because
// `internal/modules/exercise` seeds the whole catalog and sorts before
// `session`; CI relies on exactly that. Run this package alone against a freshly
// migrated database and it collapses, with an error that reads like a broken
// checkout. The guard exists to say which it is.
//
// It is a diagnostic, not a fixture: it deliberately does NOT seed. These rows
// belong to `cmd/seed`, and a test package writing 762 rows it does not own into
// the shared database is the problem, not the fix.
//
// **Known trade, chosen deliberately.** `TestMain` cannot see `-run` selection,
// so against a reachable-but-unseeded database this also stops the package's
// pure-logic tests (`onerm_test.go`, `basis_test.go`, `summarise_load_test.go`
// and friends), which need no catalog and pass today. The alternative — a
// `sync.Once` check inside `newTestRepo` — has the mirror flaw: it fires for
// tests that call the helper but never insert a set, and it repeats the message
// once per test instead of once per package. One clear failure was judged worth
// more than either, for a guard whose replacement (session's fixtures owning
// their rows) is already queued.
func TestMain(m *testing.M) {
	if url := os.Getenv("TEST_DATABASE_URL"); url != "" {
		if msg := catalogDiagnostic(url); msg != "" {
			fmt.Fprintln(os.Stderr, msg)
			os.Exit(1)
		}
	}
	os.Exit(m.Run())
}

// catalogDiagnostic returns a non-empty message only when it can PROVE the
// fixture ids have no published row. A database it cannot reach is not that
// proof, and is left to the individual tests to report — otherwise a stale
// TEST_DATABASE_URL would stop the package's pure-logic tests from running,
// which today they do. Every error path here degrades to silence.
func catalogDiagnostic(url string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := database.NewPool(ctx, url)
	if err != nil {
		return ""
	}
	defer pool.Close()

	// Same predicate assertSportsMatch checks by, so a draft row counts as
	// missing here exactly as it does there.
	rows, err := pool.Query(ctx,
		`SELECT id FROM exercises WHERE id = ANY($1) AND status = 'published'`,
		catalogFixtureIDs)
	if err != nil {
		return ""
	}
	defer rows.Close()

	found := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return ""
		}
		found[id] = true
	}
	if rows.Err() != nil {
		return ""
	}

	var missing []string
	for _, id := range catalogFixtureIDs {
		if !found[id] {
			missing = append(missing, id)
		}
	}
	if len(missing) == 0 {
		return ""
	}

	return fmt.Sprintf(`
session: fixture exercise ids have no published row in TEST_DATABASE_URL.

Missing: %s

%s`, strings.Join(missing, ", "), remedy(ctx, pool))
}

// remedy separates the two states that produce a missing fixture id, because
// only one of them is fixed by seeding — and a message that says "not seeded"
// when the catalog is full sends the reader down the wrong path for a round.
func remedy(ctx context.Context, pool *pgxpool.Pool) string {
	var total int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM exercises`).Scan(&total); err != nil {
		// Size unknown, so claim nothing about which state this is.
		return `Either the catalog was never seeded into this database, or these
specific ids have drifted from it. Try seeding first, then reconcile the
fixture constants in postgres_test.go against the catalog:

    cd backend && DATABASE_URL="$TEST_DATABASE_URL" go run ./cmd/seed`
	}

	if total == 0 {
		return `The exercises table is EMPTY — the catalog was never seeded into this
database. This package's fixtures reference real catalog ids and do not seed
them, so every Postgres test here would fail with ` + "`unknown exercise \"...\"`" + `.
That is not your change. Seed it once:

    cd backend && DATABASE_URL="$TEST_DATABASE_URL" go run ./cmd/seed

A full ` + "`go test -p 1 ./...`" + ` hides this: internal/modules/exercise seeds the
catalog and sorts before session. See CLAUDE.md, "Local dev setup".`
	}

	return fmt.Sprintf(`The catalog is NOT empty — it holds %d rows — so this is not the usual
"never seeded" case: these particular ids are absent or unpublished. Re-seed
first, since the seeder rewrites status on rows it owns:

    cd backend && DATABASE_URL="$TEST_DATABASE_URL" go run ./cmd/seed

If that does not clear it, seeding cannot: either the id is gone from the seed
data (renamed or removed), or the row is admin-owned, which the seeder skips by
`+"`WHERE exercises.source = 'seed'`"+`. Then reconcile catalogFixtureIDs in this
file, and the exBench/exSquat/exOHP/exRun/exDBBench constants in
postgres_test.go, against what the catalog actually ships.`, total)
}
