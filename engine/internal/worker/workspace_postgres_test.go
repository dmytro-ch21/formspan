package worker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/engine/internal/runstate"
)

// newTestRunStore gives this test its own SCHEMA in TEST_DATABASE_URL, same
// isolation the runstate package's own tests use — this package cannot
// import runstate's unexported helper, so the pattern is copied rather than
// shared.
func newTestRunStore(t *testing.T) *runstate.Store {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()

	var raw [6]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal(err)
	}
	schema := "engine_worker_test_" + hex.EncodeToString(raw[:])

	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(),
			"DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Errorf("drop schema %s: %v", schema, err)
		}
		admin.Close()
	})

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	if err := runstate.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return runstate.NewStore(pool, 30*time.Second)
}

// TestEnforceBudgetMovesRunToBlockedWithTheReasonNamed is the acceptance
// criterion itself: a budget overrun must not just return an error nobody
// acts on — it has to land the run in BLOCKED with the budget named.
func TestEnforceBudgetMovesRunToBlockedWithTheReasonNamed(t *testing.T) {
	store := newTestRunStore(t)
	ctx := context.Background()

	run, err := store.Claim(ctx, 1141, "engine-a", "")
	if err != nil {
		t.Fatal(err)
	}

	b := Budget{MaxWall: time.Hour}
	err = EnforceBudget(ctx, store, run.ID, "engine-a", b, 3*time.Hour, 0)
	if err == nil || !strings.Contains(err.Error(), "wall-time") {
		t.Fatalf("EnforceBudget did not name the budget: %v", err)
	}

	got, err := store.Get(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != runstate.Blocked {
		t.Fatalf("state = %s, want BLOCKED", got.State)
	}

	events, err := store.Events(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e == "transition" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no transition event recorded: %v", events)
	}
}

// TestEnforceBudgetIsANoOpUnderBudget proves the wiring doesn't fire on its
// own — a run under budget must stay exactly where it was.
func TestEnforceBudgetIsANoOpUnderBudget(t *testing.T) {
	store := newTestRunStore(t)
	ctx := context.Background()

	run, err := store.Claim(ctx, 1142, "engine-a", "")
	if err != nil {
		t.Fatal(err)
	}

	b := Budget{MaxWall: time.Hour}
	if err := EnforceBudget(ctx, store, run.ID, "engine-a", b, time.Minute, 0); err != nil {
		t.Fatalf("under-budget run refused: %v", err)
	}

	got, err := store.Get(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != runstate.Queued {
		t.Fatalf("state = %s, want unchanged QUEUED", got.State)
	}
}

// The ephemeral-database half of the lifecycle, against real Postgres.
// Gated on TEST_DATABASE_URL like the runstate suite; the worker creates
// and drops its own uniquely-named database, so concurrent binaries cannot
// collide and the shared database is never a worker target.
func TestEphemeralDatabaseLifecycle(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin}
	ws, err := r.Provision(context.Background(), 10, 1, "db", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	// Belt-and-braces: if an assertion below fails before the explicit
	// Teardown call further down, this must still drop the real database it
	// created on the shared TEST_DATABASE_URL server — the residue class
	// this whole package audits for, self-inflicted by its own test. The
	// `dropped` latch makes the explicit Teardown below a safe no-op after
	// this one already ran.
	t.Cleanup(func() { ws.Teardown(context.Background()) })

	// The non-regression: the worker's database is its OWN, never the shared
	// one the admin URL points at.
	if !strings.HasPrefix(ws.DBName, "engine_run_") {
		t.Fatalf("db name %q not run-scoped", ws.DBName)
	}
	if strings.Contains(admin, "/"+ws.DBName) {
		t.Fatal("worker db equals the admin db")
	}
	joined := strings.Join(ws.Env(), "\n")
	if !strings.Contains(joined, ws.DBName) {
		t.Fatalf("worker env does not point at the run db:\n%s", joined)
	}
	if strings.Contains(joined, "vola_test\n") || strings.HasSuffix(joined, "vola_test") {
		t.Fatal("worker env points at the shared vola_test")
	}

	// Before teardown the audit must be red (db exists) — proof it can fail
	// on the database half, not only the directory half.
	if err := os.RemoveAll(ws.Dir); err != nil {
		t.Fatal(err)
	}
	if err := ws.AuditResidue(context.Background()); err == nil || !strings.Contains(err.Error(), "database still exists") {
		t.Fatalf("audit passed with the ephemeral db still present: %v", err)
	}

	if err := ws.Teardown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := ws.AuditResidue(context.Background()); err != nil {
		t.Fatalf("residue after teardown: %v", err)
	}
}

// TestProvisionRecordsBaseSHAAndBranchDurably closes the acceptance
// criterion end to end: not just an in-memory Workspace field, but a value
// readable back from the run's own durable record via a fresh Get — proof
// it would survive this process dying.
func TestProvisionRecordsBaseSHAAndBranchDurably(t *testing.T) {
	store := newTestRunStore(t)
	ctx := context.Background()
	run, err := store.Claim(ctx, 1150, "engine-a", "")
	if err != nil {
		t.Fatal(err)
	}

	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir()}
	ws, err := r.Provision(ctx, run.ID, 1150, "durable-base-sha", first, store, "engine-a")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(ctx)

	got, err := store.Get(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.BaseSHA != first {
		t.Fatalf("durable base_sha = %q, want %q", got.BaseSHA, first)
	}
	if got.Branch != ws.Branch {
		t.Fatalf("durable branch = %q, want %q", got.Branch, ws.Branch)
	}
}
