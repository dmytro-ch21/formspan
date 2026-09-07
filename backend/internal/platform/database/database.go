// Package database provides the shared Postgres connection pool.
package database

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Pool sizing and lifecycle values. N171/#548: these used to be entirely
// pgxpool.New's undocumented defaults; the values below are picked and
// justified against this app's actual deploy shape rather than left implicit.
// If any of the assumptions below (max_connections, service topology) are
// ever confirmed to be different in the real Railway environment, revisit
// these together — they were sized as one budget, not independently.
const (
	// maxConns is the ceiling for THIS pool instance (one per process).
	//
	// Arithmetic: Postgres' own default max_connections is 100.
	// docs/architecture/deployment.md and railway/*.toml record no
	// Railway-specific Postgres plan/tier or connection-limit override for
	// the real `staging` Postgres, so this assumes the common unconfigured
	// default rather than a measured one — that assumption is the one thing
	// here most worth re-checking if it's ever confirmed otherwise.
	//
	// Off that 100, reserve headroom for connections this pool does not
	// account for: Postgres itself reserves a handful for superuser access
	// (superuser_reserved_connections defaults to 3), `cmd/migrate` opens its
	// own short-lived connection during every deploy's pre-deploy step, and
	// staging is reachable by hand via `DATABASE_URL_PUBLIC` for incident
	// response (docs/architecture/deployment.md). Call that reserve 10,
	// leaving ~90 usable across every long-lived pool that can exist at once.
	//
	// Today exactly one service (`api`) holds a pool against this Postgres —
	// `worker`/`admin-api` are planned but not deployed
	// (docs/architecture/deployment.md, "Staging & production" section) — but
	// a rolling Railway deploy briefly runs the OLD and NEW `api` containers
	// side by side, and the planned services will add pools of their own.
	// Budgeting for up to 4 concurrent pool-holding processes (2 overlapping
	// `api` instances mid-deploy, plus `worker` and `admin-api` once they
	// exist) against ~90 usable connections gives ~22 each; 20 is a clean
	// number with a small margin under that. If the real topology ever grows
	// past 4 concurrent pools, or a confirmed Postgres plan sets
	// max_connections to something else, redo this arithmetic rather than
	// bumping the number on instinct.
	maxConns = 20

	// minConns keeps a small number of connections warm so a request arriving
	// after a quiet period doesn't pay a fresh connect+auth round trip on the
	// pool's first acquire. Kept deliberately small: this is an early-stage
	// product with low steady-state traffic, and holding connections open
	// with nothing to do is exactly what maxConnIdleTime below exists to
	// avoid. 2 absorbs a couple of concurrent requests without a cold
	// connect and is a rounding error against the 20-connection ceiling.
	minConns = 2

	// maxConnLifetime recycles every connection after 30 minutes regardless
	// of use, bounding how long any single server-side resource — a stale
	// query plan pinned to old table statistics, a subtly leaked prepared
	// statement or temp object — can live on one backend. 30-60 minutes is
	// the commonly recommended range; 30 (the shorter end) was picked because
	// this pool is small (20 conns) and recycling one is cheap at this scale,
	// so there's no reason to lean toward the longer end.
	maxConnLifetime = 30 * time.Minute

	// maxConnIdleTime closes an idle connection after 5 minutes so the pool
	// shrinks back toward minConns once a burst of traffic has passed,
	// instead of holding maxConns open indefinitely on the strength of one
	// busy moment.
	maxConnIdleTime = 5 * time.Minute

	// healthCheckPeriod is pgxpool's own documented default (1 minute) for
	// its periodic background liveness check of idle connections — distinct
	// from the bootstrapPingTimeout below, which only covers the one-time
	// startup check. No evidence yet that this app's traffic pattern needs a
	// tighter or looser interval, so this states the default explicitly
	// rather than leaving it implicit.
	healthCheckPeriod = 1 * time.Minute

	// bootstrapPingTimeout bounds the one-time connectivity check NewPool
	// performs at process startup — this is the literal "a dead database
	// blocks boot for a bounded time" acceptance criterion.
	//
	// Deliberately longer than /v1/readyz's own 3-second runtime deadline
	// (backend/cmd/api/readyz.go's readinessDeadline): that check runs
	// repeatedly against a database that is normally already up, so it can
	// afford to be tight. This one runs exactly once, at boot, and has to
	// tolerate a real but slow Postgres cold start (Railway resuming a
	// paused instance, or general cold-start latency during a deploy)
	// without mistaking it for a dead database. 10 seconds is comfortably
	// above a slow-but-real cold start and comfortably below the point where
	// a hung boot becomes indistinguishable from a deploy that is simply
	// still building.
	bootstrapPingTimeout = 10 * time.Second
)

// NewPool opens a connection pool — explicitly configured per the constants
// above rather than left to pgxpool.New's undocumented defaults — and
// confirms the database is actually reachable (Ping) under a bounded
// timeout before returning, so callers fail fast at startup (within
// bootstrapPingTimeout) rather than hanging indefinitely against a dead
// database.
//
// pgxpool.NewWithConfig itself, not just Ping, is called with the bounded
// context — and that is load-bearing, not a style choice. With minConns > 0,
// NewWithConfig spawns a background goroutine that pre-fills minConns idle
// connections using EXACTLY the context passed to it; against an
// unreachable database that goroutine hangs for as long as that context
// stays alive. Passing the caller's original (often unbounded) ctx straight
// through — as an earlier version of this function did — meant that on the
// error path pool.Close() would then deadlock inside its own
// destructWG.Wait(), waiting forever for that same unbounded pre-fill
// attempt to give up. Mutation-caught: database_test.go's
// TestNewPool_BootstrapPing_HonorsBoundedTimeout hung well past
// bootstrapPingTimeout against a listener that accepts but never answers,
// until both calls below were bound to the same deadline. Sharing one
// context for both means the idle pre-fill and the readiness ping are
// cancelled together, so a dead database can no longer wedge shutdown as
// well as startup.
func NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("database: parse config: %w", err)
	}
	config.MaxConns = maxConns
	config.MinConns = minConns
	config.MaxConnLifetime = maxConnLifetime
	config.MaxConnIdleTime = maxConnIdleTime
	config.HealthCheckPeriod = healthCheckPeriod

	bootCtx, cancel := context.WithTimeout(ctx, bootstrapPingTimeout)
	defer cancel()

	pool, err := pgxpool.NewWithConfig(bootCtx, config)
	if err != nil {
		return nil, fmt.Errorf("database: create pool: %w", err)
	}

	if err := pool.Ping(bootCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("database: bootstrap ping (%s timeout): %w", bootstrapPingTimeout, err)
	}
	return pool, nil
}
