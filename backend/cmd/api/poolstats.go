package main

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
)

// dbPoolStatsResponse surfaces *pgxpool.Pool's own built-in accounting
// (Stat()) rather than a new metrics pipeline.
//
// N171/#548 asks for "pool utilization exposed as a metric" and points at
// Milestone B's SLO ticket (N172/#549) for how. N172 is still open, defines
// no metrics/alerting mechanism yet, and this backend's go.mod carries no
// prometheus/otel/expvar dependency to plug into — building real
// metrics-pipeline infrastructure here would be doing N172's design work
// under N171's number, without N172's own decisions about what's queryable,
// what's alerted, and the privacy stance the SLO ticket explicitly calls
// out. That would risk a shape N172 has to redo anyway.
//
// So the narrow, honest thing this ticket does: make pgxpool's own
// saturation numbers visible at all, via one admin-gated JSON endpoint, so
// pool exhaustion stops being completely invisible in the gap before N172
// lands a real metrics backend. Wiring this into Prometheus/whatever N172
// picks is that ticket's job, not this one's — see
// docs/decisions/history.md's N171 entry.
type dbPoolStatsResponse struct {
	MaxConns                int32 `json:"max_conns"`
	TotalConns              int32 `json:"total_conns"`
	AcquiredConns           int32 `json:"acquired_conns"`
	IdleConns               int32 `json:"idle_conns"`
	ConstructingConns       int32 `json:"constructing_conns"`
	AcquireCount            int64 `json:"acquire_count"`
	EmptyAcquireCount       int64 `json:"empty_acquire_count"`
	CanceledAcquireCount    int64 `json:"canceled_acquire_count"`
	AcquireDurationMS       int64 `json:"acquire_duration_ms"`
	NewConnsCount           int64 `json:"new_conns_count"`
	MaxLifetimeDestroyCount int64 `json:"max_lifetime_destroy_count"`
	MaxIdleDestroyCount     int64 `json:"max_idle_destroy_count"`
}

// handleDBPoolStats serves GET /v1/admin/db-pool-stats.
//
// Admin-gated the same way the content-authoring routes are
// (verifier.RequireAdmin in main.go) — this doesn't expose athlete data, but
// it is still an operational internal (how close the pool is to maxConns,
// how often acquires are queueing) that has no reason to be reachable by
// every authenticated user.
func handleDBPoolStats(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Same reasoning as /v1/readyz: this is a live snapshot, not
		// something a shared cache should ever be allowed to serve stale.
		w.Header().Set("Cache-Control", "no-store")
		stat := pool.Stat()
		apihttp.WriteJSON(w, http.StatusOK, dbPoolStatsResponse{
			MaxConns:                stat.MaxConns(),
			TotalConns:              stat.TotalConns(),
			AcquiredConns:           stat.AcquiredConns(),
			IdleConns:               stat.IdleConns(),
			ConstructingConns:       stat.ConstructingConns(),
			AcquireCount:            stat.AcquireCount(),
			EmptyAcquireCount:       stat.EmptyAcquireCount(),
			CanceledAcquireCount:    stat.CanceledAcquireCount(),
			AcquireDurationMS:       stat.AcquireDuration().Milliseconds(),
			NewConnsCount:           stat.NewConnsCount(),
			MaxLifetimeDestroyCount: stat.MaxLifetimeDestroyCount(),
			MaxIdleDestroyCount:     stat.MaxIdleDestroyCount(),
		})
	}
}
