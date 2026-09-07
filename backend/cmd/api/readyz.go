package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/migrateguard"
)

// undefinedTable is Postgres' error code for "relation does not exist" —
// schema_migrations not existing yet, i.e. a database that has never been
// migrated. Duplicated from migrateguard rather than exported from there: that
// package's ReadState opens its OWN connection from a DSN, and doing that on
// every readiness probe would grow an unbounded number of short-lived
// connections outside pool's own limits and accounting. This queries through
// the pool this process already holds instead.
const undefinedTable = "42P01"

// readinessDeadline bounds how long GET /v1/readyz will wait on the database
// before answering "not ready". Short and deliberate: Railway's own
// healthcheck has its own timeout, and a probe that hangs only delays the same
// verdict rather than avoiding it. Comfortably above a local Postgres round
// trip and comfortably under any reasonable probe interval.
const readinessDeadline = 3 * time.Second

// readyzResponse mirrors handleHealthz's JSON shape (status/service), plus a
// reason code — one of the constants below, never a raw error string — so an
// operator watching Railway's deploy logs can tell an unreachable database
// from a stale schema without this handler leaking internal error text (see
// docs/architecture/api-conventions.md: never leak raw internal error text to
// the client). The full error goes to the server log instead.
type readyzResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Reason  string `json:"reason,omitempty"`
}

// Reason codes for a not-ready response. Part of this handler's own small
// contract, not the public API's error-code enum in apihttp (this is a 503
// status body, not an {"error": ...} shape) — kept short and stable so a
// dashboard can key off them, but not documented as something a CLIENT should
// branch on: the only consumer that matters is Railway's healthcheck, which
// only looks at the status code.
const (
	reasonDBUnreachable         = "db_unreachable"
	reasonSchemaNotMigrated     = "schema_not_migrated"
	reasonSchemaDirty           = "schema_dirty"
	reasonSchemaQueryFailed     = "schema_query_failed"
	reasonSchemaVersionMismatch = "schema_version_mismatch"
)

// dbProbe is the slice of *pgxpool.Pool the readiness check needs: a ping and
// a single-row query, both taking the caller's context (so the bounded
// deadline in check() actually bounds them).
//
// Narrowed to an interface — rather than using *pgxpool.Pool directly —
// purely for testability: it lets the unit tests in readyz_test.go exercise
// every branch of check() (the dirty flag, a not-yet-migrated database, a
// version mismatch, an error that must not leak to the client) with a fake,
// while keeping exactly one test against a REAL *pgxpool.Pool pointed at a
// connection that is genuinely unreachable — see
// TestReadyz_RealUnreachableDatabase_AnswersNotReadyFast, and this ticket's
// own "test the DB-ping-fails case for real, not just reasoned about."
type dbProbe interface {
	Ping(ctx context.Context) error
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// readinessChecker answers GET /v1/readyz.
//
// Deliberately excludes AI/LLM provider health (bjj's reflection drafter,
// nutrition's estimate provider, the exercise photo identifier). A provider
// outage degrades only the specific routes that call out to it — it says
// nothing about whether THIS API can serve the other 95% of routes that never
// touch an LLM. Ejecting the whole service from Railway's rotation over a
// dependency most requests never exercise would be strictly worse for every
// athlete not using that one feature, and would reproduce, for a different
// dependency, exactly the kind of over-broad outage this ticket exists to stop
// causing. See docs/decisions/history.md's N163 entry.
//
// DO NOT add a provider ping here. If you are tempted to, the request that
// needs it almost certainly wants its own 503 with apihttp.CodeUnavailable,
// the way exercise/identify_handler.go, bjj/reflect_handler.go,
// food/handler.go and nutrition/estimate_handler.go already do — not a whole
// deployment marked not-ready.
type readinessChecker struct {
	pool   dbProbe
	logger *slog.Logger

	// expectedVersion is the highest migration version embedded in THIS
	// binary's image (read from disk once, at boot — migration files do not
	// change while a process runs). haveExpectedVersion is false when it could
	// not be determined, in which case the version check is skipped rather
	// than the whole probe being disabled; see newReadinessChecker.
	expectedVersion     uint64
	haveExpectedVersion bool
}

// newReadinessChecker resolves the expected schema version once, from the
// same MIGRATIONS_PATH convention cmd/migrate uses (default
// "file://migrations", relative to the working directory the binary is run
// from — /app inside the deployed image, where backend/Dockerfile copies
// migrations/ to /app/migrations; backend/ locally, matching `go run
// ./cmd/api`'s cwd).
//
// Never fails boot. An environment where the migrations directory cannot be
// read is exactly the environment /readyz exists to flag as not-ready, not a
// reason to crash the process before it can say so — so this logs loudly and
// leaves haveExpectedVersion false, which makes the version check a no-op
// rather than a false negative.
func newReadinessChecker(pool *pgxpool.Pool, logger *slog.Logger) *readinessChecker {
	rc := &readinessChecker{pool: pool, logger: logger}

	migrationsPath := os.Getenv("MIGRATIONS_PATH")
	if migrationsPath == "" {
		migrationsPath = "file://migrations"
	}

	dir, ok := migrateguard.DirFromPath(migrationsPath)
	if !ok {
		logger.Warn("readyz: MIGRATIONS_PATH is not a readable file:// source; /readyz will not check the schema version",
			"migrations_path", migrationsPath)
		return rc
	}
	migs, err := migrateguard.ReadMigrations(dir)
	if err != nil {
		logger.Warn("readyz: could not read the migrations directory; /readyz will not check the schema version",
			"dir", dir, "err", err)
		return rc
	}
	highest, ok := migrateguard.Highest(migs)
	if !ok {
		logger.Warn("readyz: no migration files found; /readyz will not check the schema version", "dir", dir)
		return rc
	}
	rc.expectedVersion = highest.Version
	rc.haveExpectedVersion = true
	return rc
}

// check runs the readiness checks against a bounded deadline and reports
// whether the API should receive traffic. detail is for the server log only —
// never sent to the client.
func (rc *readinessChecker) check(ctx context.Context) (ready bool, reason, detail string) {
	ctx, cancel := context.WithTimeout(ctx, readinessDeadline)
	defer cancel()

	if err := rc.pool.Ping(ctx); err != nil {
		return false, reasonDBUnreachable, fmt.Sprintf("db ping: %v", err)
	}

	var version uint64
	var dirty bool
	err := rc.pool.QueryRow(ctx, "SELECT version, dirty FROM schema_migrations").Scan(&version, &dirty)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// The table exists but is empty — a database that has been migrated
		// down to nothing. Indistinguishable from never-migrated and treated
		// the same: not ready.
		return false, reasonSchemaNotMigrated, "schema_migrations is empty"
	case err != nil:
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == undefinedTable {
			return false, reasonSchemaNotMigrated, "schema_migrations table does not exist"
		}
		return false, reasonSchemaQueryFailed, fmt.Sprintf("schema_migrations query: %v", err)
	}

	// A migration failed part-way and golang-migrate refuses to continue until
	// somebody resolves it by hand (see migrateguard.CheckAgreement). A dirty
	// schema is never a safe one to serve against, regardless of which version
	// it is dirty at.
	if dirty {
		return false, reasonSchemaDirty, fmt.Sprintf("schema_migrations reports dirty at version %d", version)
	}

	// This is the check that actually catches the deployment.md incident: a
	// predeploy step (`migrate up`) that failed or never ran leaves the
	// database at its OLD version while the new binary — built from a commit
	// that added migrations — starts serving anyway. `!=` rather than `<`
	// deliberately: a database somehow AHEAD of this binary (the #465/#461
	// failure mode migrateguard's own guard now prevents at migrate-time, but
	// belt-and-suspenders costs nothing here) is just as much "this binary
	// should not be trusted with this schema" as one that is behind.
	if rc.haveExpectedVersion && version != rc.expectedVersion {
		return false, reasonSchemaVersionMismatch, fmt.Sprintf(
			"database is at schema version %d, this binary expects %d", version, rc.expectedVersion)
	}

	return true, "", ""
}

// handle serves GET /v1/readyz.
func (rc *readinessChecker) handle(w http.ResponseWriter, r *http.Request) {
	// Same reasoning as handleHealthz, more acutely: readiness can flip from
	// true to false between one probe and the next, and a cached 200 (or a
	// 304 answering "nothing changed" against a stale ETag) would mean Railway
	// keeps routing traffic to an instance that has already told this handler
	// it should not receive any — reproducing the exact incident this ticket
	// exists to prevent, just moved into the caching layer instead of the
	// deploy pipeline.
	w.Header().Set("Cache-Control", "no-store")

	ready, reason, detail := rc.check(r.Context())
	if !ready {
		rc.logger.Warn("readyz: not ready", "reason", reason, "detail", detail)
		apihttp.WriteJSON(w, http.StatusServiceUnavailable, readyzResponse{
			Status:  "not_ready",
			Service: "api",
			Reason:  reason,
		})
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, readyzResponse{
		Status:  "ok",
		Service: "api",
	})
}
