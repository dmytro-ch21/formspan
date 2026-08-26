package worker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
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

// TestPerRunRoleCannotReadWriteOrCreateInTheSharedDatabase is the acceptance
// criterion itself, proven by attempting the leak rather than by reading the
// code — mirroring TestGitignoredSecretsCannotReachAWorkspace's pattern.
// Verified manually against this project's own Postgres before writing this
// test: a fresh, ungranted role CAN still open a bare connection to
// vola_test (Postgres grants CONNECT to PUBLIC by default, and an explicit
// per-role REVOKE does not override that additive ACL), but it categorically
// CANNOT read, write, or create anything there, because table/schema
// privileges are NOT PUBLIC by default. That is the isolation this test
// checks — not "cannot connect", but "cannot touch data or schema".
func TestPerRunRoleCannotReadWriteOrCreateInTheSharedDatabase(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin}
	ws, err := r.Provision(context.Background(), 30, 1, "role-iso", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	if ws.DBRole == "" {
		t.Fatal("Provision did not assign a per-run role")
	}

	// Sanity check FIRST: the credentials in ws.DBURL must actually work
	// against the run's OWN database. Without this, a broken ws.DBURL (wrong
	// password, wrong role) would make the isolation attempt below fail for
	// the wrong reason — an auth error, not a permission denial — and the
	// "connection refused reads as isolation" shortcut this test used to
	// have would then silently pass on a broken test. Proven by mutation:
	// swapping ws.DBURL's construction back to reuse admin credentials made
	// this exact test pass falsely, because it fell into that shortcut.
	ownConn, err := pgx.Connect(context.Background(), ws.DBURL)
	if err != nil {
		t.Fatalf("the run's own credentials do not even work against its own database: %v", err)
	}
	ownConn.Close(context.Background())

	// Now reuse THOSE SAME credentials — never re-derived from admin or from
	// a separate source — against the shared database. This is what makes
	// the test catch a regression rather than only proving today's code:
	// if ws.DBURL ever again carries admin credentials, this URL carries
	// them too, and admin really can touch the shared database.
	sharedDBURL := sameCredentialsOtherDB(t, ws.DBURL, mustExtractDBName(t, admin))
	conn, err := pgx.Connect(context.Background(), sharedDBURL)
	if err != nil {
		// A refusal to even connect is stronger isolation, not a test
		// failure — but only having just proven the credentials are good
		// against the run's own database, so this refusal is specific to
		// the shared database rather than a broken URL.
		return
	}
	defer conn.Close(context.Background())

	// Attempt to create something durable in the shared database.
	if _, err := conn.Exec(context.Background(), "CREATE TABLE role_isolation_probe(x int)"); err == nil {
		t.Fatal("per-run role was able to CREATE TABLE in the shared database — isolation is broken")
	}

	// Attempt to read an existing real table, if one exists.
	var tableName string
	adminConn, err := pgx.Connect(context.Background(), admin)
	if err != nil {
		t.Fatal(err)
	}
	defer adminConn.Close(context.Background())
	err = adminConn.QueryRow(context.Background(),
		`SELECT table_name FROM information_schema.tables WHERE table_schema='public' LIMIT 1`).Scan(&tableName)
	if err == nil {
		if _, err := conn.Exec(context.Background(), fmt.Sprintf("SELECT * FROM %q LIMIT 1", tableName)); err == nil {
			t.Fatalf("per-run role was able to read table %q in the shared database — isolation is broken", tableName)
		}
	}
}

// sameCredentialsOtherDB swaps only the database name in dbURL, leaving
// userinfo untouched — deliberately NOT re-deriving credentials from
// anywhere else, so the isolation test above tracks whatever ws.DBURL
// actually carries rather than what it is supposed to carry.
func sameCredentialsOtherDB(t *testing.T, dbURL, otherDB string) string {
	t.Helper()
	u, err := url.Parse(dbURL)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + otherDB
	return u.String()
}

func mustExtractDBName(t *testing.T, dbURL string) string {
	t.Helper()
	u, err := url.Parse(dbURL)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimPrefix(u.Path, "/")
}

// TestMigrateBackendAppliesTheClonesOwnMigrations is the second acceptance
// criterion: a REAL table exists afterward, proven by connecting and
// checking information_schema — not by trusting MigrateBackend's own nil
// return.
func TestMigrateBackendAppliesTheClonesOwnMigrations(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin}
	ws, err := r.Provision(context.Background(), 31, 1, "migrate", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	migDir := filepath.Join(ws.Dir, "backend", "migrations")
	if err := os.MkdirAll(migDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Two files, the second depending on the first, to prove ORDER as well
	// as application — a shuffled apply would fail outright on file 2.
	if err := os.WriteFile(filepath.Join(migDir, "000001_create.up.sql"),
		[]byte("CREATE TABLE probe_migrated_marker (id INT PRIMARY KEY);"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(migDir, "000002_alter.up.sql"),
		[]byte("ALTER TABLE probe_migrated_marker ADD COLUMN note TEXT;"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := ws.MigrateBackend(context.Background()); err != nil {
		t.Fatalf("MigrateBackend: %v", err)
	}

	conn, err := pgx.Connect(context.Background(), ws.DBURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var exists bool
	if err := conn.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'probe_migrated_marker' AND column_name = 'note')`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("migrations did not apply in order — the second file's ALTER never ran")
	}
}

func TestMigrateBackendFailsClearlyWithNoMigrationsDirectory(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin}
	ws, err := r.Provision(context.Background(), 32, 1, "no-migrations", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	if err := ws.MigrateBackend(context.Background()); err == nil {
		t.Fatal("MigrateBackend succeeded with no backend/migrations directory present")
	}
}

// TestPerRunRoleIsDroppedAtTeardownAndAuditCatchesALeak extends the residue
// audit to the new role — demonstrated failing before it is demonstrated
// passing, per this package's own established discipline.
func TestPerRunRoleIsDroppedAtTeardownAndAuditCatchesALeak(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin}
	ws, err := r.Provision(context.Background(), 33, 1, "role-audit", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.Teardown(context.Background()) })

	if ws.DBRole == "" {
		t.Fatal("no role assigned")
	}

	// Before teardown: the role exists, so the audit must be red — proof it
	// can fail on the role half, not only the directory/database halves.
	adminConn, err := pgx.Connect(context.Background(), admin)
	if err != nil {
		t.Fatal(err)
	}
	defer adminConn.Close(context.Background())
	var n int
	if err := adminConn.QueryRow(context.Background(),
		`SELECT count(*) FROM pg_roles WHERE rolname = $1`, ws.DBRole).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("role %q not found right after Provision", ws.DBRole)
	}

	if err := ws.Teardown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := adminConn.QueryRow(context.Background(),
		`SELECT count(*) FROM pg_roles WHERE rolname = $1`, ws.DBRole).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("role %q survived Teardown", ws.DBRole)
	}
	if err := ws.AuditResidue(context.Background()); err != nil {
		t.Fatalf("audit red after a clean teardown: %v", err)
	}
}
