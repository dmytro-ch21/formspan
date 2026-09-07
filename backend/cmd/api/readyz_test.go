package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeRow is a one-shot pgx.Row: either it scans the given version/dirty pair,
// or Scan returns err. Satisfies pgx.Row's single method.
type fakeRow struct {
	version uint64
	dirty   bool
	err     error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*dest[0].(*uint64) = r.version
	*dest[1].(*bool) = r.dirty
	return nil
}

// fakeProbe stands in for the pool in every test that isn't specifically
// about a real network failure or a real database. It lets each branch of
// check() be driven directly, including ones that are awkward or unsafe to
// provoke on a real, possibly-shared Postgres (a dirty flag, a table that
// doesn't exist).
type fakeProbe struct {
	pingErr error
	row     fakeRow
}

func (f *fakeProbe) Ping(ctx context.Context) error { return f.pingErr }
func (f *fakeProbe) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return f.row
}

func checkerWithExpected(probe dbProbe, expected uint64) *readinessChecker {
	return &readinessChecker{pool: probe, logger: testLogger(), expectedVersion: expected, haveExpectedVersion: true}
}

func TestReadyz_HealthyMatchingVersion_IsReady(t *testing.T) {
	rc := checkerWithExpected(&fakeProbe{row: fakeRow{version: 42, dirty: false}}, 42)

	ready, reason, _ := rc.check(context.Background())
	if !ready {
		t.Fatalf("ready = false, reason = %q — want ready", reason)
	}
}

func TestReadyz_PingFails_NotReady(t *testing.T) {
	rc := checkerWithExpected(&fakeProbe{pingErr: errors.New("connection refused")}, 42)

	ready, reason, detail := rc.check(context.Background())
	if ready {
		t.Fatal("ready = true against a failing ping")
	}
	if reason != reasonDBUnreachable {
		t.Fatalf("reason = %q, want %q", reason, reasonDBUnreachable)
	}
	if !strings.Contains(detail, "connection refused") {
		t.Fatalf("detail = %q, want it to name the underlying error (server-side log only)", detail)
	}
}

func TestReadyz_SchemaMigrationsEmpty_NotReady(t *testing.T) {
	// pgx.ErrNoRows: the table exists but has never had a row written to it —
	// golang-migrate's state after `down`, or before the first `up`.
	rc := checkerWithExpected(&fakeProbe{row: fakeRow{err: pgx.ErrNoRows}}, 1)

	ready, reason, _ := rc.check(context.Background())
	if ready {
		t.Fatal("ready = true with an empty schema_migrations")
	}
	if reason != reasonSchemaNotMigrated {
		t.Fatalf("reason = %q, want %q", reason, reasonSchemaNotMigrated)
	}
}

func TestReadyz_SchemaMigrationsTableMissing_NotReady(t *testing.T) {
	rc := checkerWithExpected(&fakeProbe{row: fakeRow{err: &pgconn.PgError{Code: undefinedTable}}}, 1)

	ready, reason, _ := rc.check(context.Background())
	if ready {
		t.Fatal("ready = true with schema_migrations missing entirely")
	}
	if reason != reasonSchemaNotMigrated {
		t.Fatalf("reason = %q, want %q", reason, reasonSchemaNotMigrated)
	}
}

func TestReadyz_SchemaQueryFails_NotReadyAndErrorNotLeaked(t *testing.T) {
	rc := checkerWithExpected(&fakeProbe{row: fakeRow{err: errors.New("pq: some internal detail nobody outside should see")}}, 1)

	ready, reason, detail := rc.check(context.Background())
	if ready {
		t.Fatal("ready = true when the schema_migrations query itself errors")
	}
	if reason != reasonSchemaQueryFailed {
		t.Fatalf("reason = %q, want %q", reason, reasonSchemaQueryFailed)
	}
	if !strings.Contains(detail, "some internal detail") {
		t.Fatal("detail (server-log-only) should carry the real error — it doesn't, so an operator couldn't diagnose this")
	}

	// The part that actually matters per docs/architecture/api-conventions.md
	// ("never leak raw internal error text to the client"): serialize the HTTP
	// response the same way the handler does, and confirm the raw error text
	// never reaches it.
	rec := httptest.NewRecorder()
	rc.handle(rec, httptest.NewRequest(http.MethodGet, "/v1/readyz", nil))
	if strings.Contains(rec.Body.String(), "internal detail") {
		t.Fatalf("response body leaked the raw DB error: %s", rec.Body.String())
	}
}

func TestReadyz_SchemaDirty_NotReady(t *testing.T) {
	rc := checkerWithExpected(&fakeProbe{row: fakeRow{version: 7, dirty: true}}, 7)

	ready, reason, detail := rc.check(context.Background())
	if ready {
		t.Fatal("ready = true with schema_migrations marked dirty")
	}
	if reason != reasonSchemaDirty {
		t.Fatalf("reason = %q, want %q", reason, reasonSchemaDirty)
	}
	if !strings.Contains(detail, "7") {
		t.Fatalf("detail = %q, want it to name the dirty version", detail)
	}
}

func TestReadyz_SchemaVersionBehindExpected_NotReady(t *testing.T) {
	// The failure mode docs/architecture/deployment.md records: a predeploy
	// migrate step that failed or never ran leaves the database at its OLD
	// version while a binary built to expect the new one starts serving.
	rc := checkerWithExpected(&fakeProbe{row: fakeRow{version: 40, dirty: false}}, 41)

	ready, reason, _ := rc.check(context.Background())
	if ready {
		t.Fatal("ready = true with the database one migration behind this binary")
	}
	if reason != reasonSchemaVersionMismatch {
		t.Fatalf("reason = %q, want %q", reason, reasonSchemaVersionMismatch)
	}
}

func TestReadyz_SchemaVersionAheadOfExpected_NotReady(t *testing.T) {
	// The opposite direction: `!=`, not `<`, is deliberate — see check()'s
	// comment. A database ahead of this binary (the #465 failure mode) is
	// equally a reason not to trust it.
	rc := checkerWithExpected(&fakeProbe{row: fakeRow{version: 42, dirty: false}}, 41)

	ready, reason, _ := rc.check(context.Background())
	if ready {
		t.Fatal("ready = true with the database ahead of this binary")
	}
	if reason != reasonSchemaVersionMismatch {
		t.Fatalf("reason = %q, want %q", reason, reasonSchemaVersionMismatch)
	}
}

func TestReadyz_UnknownExpectedVersion_SkipsVersionCheck(t *testing.T) {
	// newReadinessChecker's graceful-degrade path: haveExpectedVersion false
	// (couldn't read the migrations directory at boot) must not turn into a
	// permanent false negative — the version check is a no-op, not a refusal.
	rc := &readinessChecker{pool: &fakeProbe{row: fakeRow{version: 999, dirty: false}}, logger: testLogger()}

	ready, reason, _ := rc.check(context.Background())
	if !ready {
		t.Fatalf("ready = false (reason %q) when the expected version is unknown — the version check should be skipped, not fail closed", reason)
	}
}

func TestReadyz_Handle_ReadyIs200WithNoStoreAndNoReason(t *testing.T) {
	rc := checkerWithExpected(&fakeProbe{row: fakeRow{version: 5, dirty: false}}, 5)

	rec := httptest.NewRecorder()
	rc.handle(rec, httptest.NewRequest(http.MethodGet, "/v1/readyz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	assertNoStore(t, rec)
	var body readyzResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Status != "ok" || body.Service != "api" {
		t.Fatalf("body = %+v, want status=ok service=api", body)
	}
	if body.Reason != "" {
		t.Fatalf("reason = %q on a ready response, want empty", body.Reason)
	}
}

func TestReadyz_Handle_NotReadyIs503WithReasonAndNoStore(t *testing.T) {
	rc := checkerWithExpected(&fakeProbe{row: fakeRow{version: 4, dirty: false}}, 5)

	rec := httptest.NewRecorder()
	rc.handle(rec, httptest.NewRequest(http.MethodGet, "/v1/readyz", nil))

	// This status code, not the body, is what Railway's healthcheck actually
	// acts on — a healthcheck consumer needs a non-2xx to treat the instance
	// as unhealthy and stop routing traffic to it.
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	assertNoStore(t, rec)
	var body readyzResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Status != "not_ready" {
		t.Fatalf("status field = %q, want not_ready", body.Status)
	}
	if body.Reason != reasonSchemaVersionMismatch {
		t.Fatalf("reason = %q, want %q", body.Reason, reasonSchemaVersionMismatch)
	}
}

func assertNoStore(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store — a cached readiness response is the same class of\n"+
			"incident this endpoint exists to prevent, just moved into the caching layer", got)
	}
}

// TestHealthz_StructurallyCannotDependOnReadiness is the "test that /healthz
// itself is unaffected" the ticket asks for, made as strong as the language
// allows: handleHealthz's signature is (http.ResponseWriter, *http.Request)
// with no pool, no readinessChecker, nothing DB-shaped in scope at all. There
// is no state this test could vary that would change its answer — which is
// the property, not just this one assertion of it.
func TestHealthz_StructurallyCannotDependOnReadiness(t *testing.T) {
	rec := httptest.NewRecorder()
	handleHealthz(rec, httptest.NewRequest(http.MethodGet, "/v1/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["status"] != "ok" || body["service"] != "api" {
		t.Fatalf("body = %+v, want status=ok service=api", body)
	}
}

// TestReadyz_RealUnreachableDatabase_AnswersNotReadyFast is the genuine
// broken-DB-connection test the ticket's "Steps to test" #1 asks for — a REAL
// *pgxpool.Pool pointed at a connection that really is refused, not a fake
// standing in for one. Nothing listens on loopback port 1 (a privileged port),
// so the kernel refuses the connection immediately rather than needing a
// black-holed address and a timeout to prove the point.
//
// No TEST_DATABASE_URL needed: the whole point is that this database is
// unreachable, by construction, everywhere this test runs.
func TestReadyz_RealUnreachableDatabase_AnswersNotReadyFast(t *testing.T) {
	pool, err := pgxpool.New(context.Background(),
		"postgres://vola:wrong@127.0.0.1:1/nonexistent?sslmode=disable&connect_timeout=1")
	if err != nil {
		// pgxpool.New only parses config; it does not dial. A failure here
		// would mean the DSN itself is malformed, not that the DB is down.
		t.Fatalf("pgxpool.New (config only, should not dial): %v", err)
	}
	defer pool.Close()

	rc := &readinessChecker{pool: pool, logger: testLogger(), expectedVersion: 1, haveExpectedVersion: true}

	start := time.Now()
	rec := httptest.NewRecorder()
	rc.handle(rec, httptest.NewRequest(http.MethodGet, "/v1/readyz", nil))
	elapsed := time.Since(start)

	// The bounded-deadline claim: this must not hang. Generous slack above
	// readinessDeadline for scheduler jitter — the point is "did not hang
	// indefinitely," not a tight timing assertion.
	if elapsed > readinessDeadline+3*time.Second {
		t.Fatalf("readyz took %s to answer against an unreachable database — the bounded deadline was not honored", elapsed)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (elapsed %s)", rec.Code, elapsed)
	}
	var body readyzResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Reason != reasonDBUnreachable {
		t.Fatalf("reason = %q, want %q", body.Reason, reasonDBUnreachable)
	}
}

// testDatabaseURL returns TEST_DATABASE_URL, or skips the calling test if it
// is unset — the same convention as every internal/modules/*/postgres_test.go.
func testDatabaseURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping")
	}
	return url
}

// liveSchemaVersion reads schema_migrations directly, bypassing
// readinessChecker entirely, so these tests aren't validating the code under
// test against itself.
func liveSchemaVersion(t *testing.T, pool *pgxpool.Pool) uint64 {
	t.Helper()
	var version uint64
	var dirty bool
	err := pool.QueryRow(context.Background(), "SELECT version, dirty FROM schema_migrations").Scan(&version, &dirty)
	if err != nil {
		t.Fatalf("reading live schema_migrations: %v", err)
	}
	if dirty {
		t.Skip("TEST_DATABASE_URL's schema_migrations is marked dirty; skipping rather than asserting against an already-broken fixture")
	}
	return version
}

// TestReadyz_LiveDatabase_ReportsReady exercises the full happy path against a
// real, migrated Postgres — not a stub. It reads the live version from the
// database itself (rather than the migrations directory on disk, whose
// relative path differs between `go run ./cmd/api` from backend/ and `go test
// ./cmd/api` from backend/cmd/api/) purely to make the "expected" version
// deterministic for the test; newReadinessChecker's own directory-reading
// codepath is exercised by TestNewReadinessChecker_ResolvesExpectedVersion
// below.
func TestReadyz_LiveDatabase_ReportsReady(t *testing.T) {
	dsn := testDatabaseURL(t)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	version := liveSchemaVersion(t, pool)
	rc := checkerWithExpected(pool, version)

	rec := httptest.NewRecorder()
	rc.handle(rec, httptest.NewRequest(http.MethodGet, "/v1/readyz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
}

// TestReadyz_LiveDatabase_ReportsSchemaVersionMismatch is the same real
// database, deliberately told to expect a version it is not at — proving the
// mismatch check fires against a genuine Postgres connection, not only
// against the fake in TestReadyz_SchemaVersionBehindExpected_NotReady.
func TestReadyz_LiveDatabase_ReportsSchemaVersionMismatch(t *testing.T) {
	dsn := testDatabaseURL(t)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	version := liveSchemaVersion(t, pool)
	rc := checkerWithExpected(pool, version+1) // guaranteed wrong

	rec := httptest.NewRecorder()
	rc.handle(rec, httptest.NewRequest(http.MethodGet, "/v1/readyz", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body: %s)", rec.Code, rec.Body.String())
	}
	var body readyzResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Reason != reasonSchemaVersionMismatch {
		t.Fatalf("reason = %q, want %q", body.Reason, reasonSchemaVersionMismatch)
	}
}

// TestNewReadinessChecker_ResolvesExpectedVersion exercises the real
// directory-reading path in newReadinessChecker (migrateguard.ReadMigrations
// + Highest), pointed at this repo's actual migrations directory relative to
// this package (backend/cmd/api/../../migrations = backend/migrations) rather
// than a fixture, so it also incidentally proves the file count on disk is
// what it looks like from this binary's own perspective.
func TestNewReadinessChecker_ResolvesExpectedVersion(t *testing.T) {
	t.Setenv("MIGRATIONS_PATH", "file://../../migrations")
	pool, err := pgxpool.New(context.Background(), "postgres://vola:wrong@127.0.0.1:1/nonexistent?sslmode=disable")
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	rc := newReadinessChecker(pool, testLogger())
	if !rc.haveExpectedVersion {
		t.Fatal("haveExpectedVersion = false; expected the real migrations directory to resolve")
	}
	if rc.expectedVersion == 0 {
		t.Fatal("expectedVersion = 0; the migrations directory looks empty, which would be surprising for this repo")
	}
}

// TestNewReadinessChecker_UnreadableDirectory_DegradesGracefully is the other
// half: a MIGRATIONS_PATH that cannot be read must not crash boot or panic —
// it must leave the version check off, per newReadinessChecker's doc comment.
func TestNewReadinessChecker_UnreadableDirectory_DegradesGracefully(t *testing.T) {
	t.Setenv("MIGRATIONS_PATH", "file:///does/not/exist/anywhere")
	pool, err := pgxpool.New(context.Background(), "postgres://vola:wrong@127.0.0.1:1/nonexistent?sslmode=disable")
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	rc := newReadinessChecker(pool, testLogger())
	if rc.haveExpectedVersion {
		t.Fatal("haveExpectedVersion = true against a directory that does not exist")
	}
}
