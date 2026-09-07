package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestHandleDBPoolStats_ReturnsPoolStatShape doesn't need a reachable
// database — pgxpool.NewWithConfig doesn't block on connectivity (see
// database.go's own doc comment on that), and pool.Stat() reports the
// pool's configuration and in-process bookkeeping regardless of whether any
// connection has ever succeeded. MinConns=0 here specifically so there's no
// background pre-fill goroutine racing this test's Stat() read.
//
// Asserting MaxConns == 7 (not the real maxConns constant) is deliberate:
// it proves the handler reads the pool's ACTUAL configured value rather
// than a hardcoded one — a mutation that swapped stat.MaxConns() for the
// package constant would still happen to pass with the real value, but
// fails here.
func TestHandleDBPoolStats_ReturnsPoolStatShape(t *testing.T) {
	config, err := pgxpool.ParseConfig("postgres://vola:wrong@127.0.0.1:1/nonexistent?sslmode=disable")
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}
	config.MaxConns = 7
	config.MinConns = 0
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatalf("NewWithConfig: %v", err)
	}
	defer pool.Close()

	rec := httptest.NewRecorder()
	handleDBPoolStats(pool)(rec, httptest.NewRequest(http.MethodGet, "/v1/admin/db-pool-stats", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}

	var body dbPoolStatsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.MaxConns != 7 {
		t.Fatalf("max_conns = %d, want 7 (the pool's actual configured ceiling)", body.MaxConns)
	}
	// TotalConns/AcquiredConns/IdleConns are all legitimately 0 for a pool
	// that has never dialed anything — nothing further to assert about them
	// without a real connection, which this test deliberately avoids.
}
