package database

import (
	"context"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"
)

// TestNewPool_ConfiguresExplicitPoolValues is the "assert the config is
// actually used" half of N171/#548's mutation-checkable acceptance
// criteria: it doesn't just reason about what pgxpool.NewWithConfig was
// handed, it reads the values back off the constructed pool. Needs a real
// reachable Postgres (testPool, from copytx_test.go, skips gracefully
// without TEST_DATABASE_URL) because pgxpool.NewWithConfig only reports a
// config it was actually able to construct a pool from.
func TestNewPool_ConfiguresExplicitPoolValues(t *testing.T) {
	pool := testPool(t)
	cfg := pool.Config()

	if cfg.MaxConns != maxConns {
		t.Errorf("MaxConns = %d, want %d", cfg.MaxConns, maxConns)
	}
	if cfg.MinConns != minConns {
		t.Errorf("MinConns = %d, want %d", cfg.MinConns, minConns)
	}
	if cfg.MaxConnLifetime != maxConnLifetime {
		t.Errorf("MaxConnLifetime = %s, want %s", cfg.MaxConnLifetime, maxConnLifetime)
	}
	if cfg.MaxConnIdleTime != maxConnIdleTime {
		t.Errorf("MaxConnIdleTime = %s, want %s", cfg.MaxConnIdleTime, maxConnIdleTime)
	}
	if cfg.HealthCheckPeriod != healthCheckPeriod {
		t.Errorf("HealthCheckPeriod = %s, want %s", cfg.HealthCheckPeriod, healthCheckPeriod)
	}
}

// TestNewPool_RealUnreachableDatabase_FailsFast is this ticket's own "Steps
// to test #1", against a REAL *pgxpool.Pool attempt, not a fake standing in
// for one — no TEST_DATABASE_URL needed, since the point is that this
// address is unreachable everywhere this test runs.
//
// Mirrors backend/cmd/api/readyz_test.go's
// TestReadyz_RealUnreachableDatabase_AnswersNotReadyFast (N163): port 1 is
// privileged and unbound, so the kernel refuses the connection immediately
// rather than needing a black hole and a timeout to prove the point. This
// covers the "not accidentally instant because nothing was attempted"
// question a different way — see
// TestNewPool_BootstrapPing_HonorsBoundedTimeout below for the case that
// actually exercises the bound itself.
func TestNewPool_RealUnreachableDatabase_FailsFast(t *testing.T) {
	start := time.Now()
	pool, err := NewPool(context.Background(),
		"postgres://vola:wrong@127.0.0.1:1/nonexistent?sslmode=disable&connect_timeout=1")
	elapsed := time.Since(start)
	if pool != nil {
		pool.Close()
	}
	if err == nil {
		t.Fatal("NewPool succeeded against 127.0.0.1:1, which nothing listens on")
	}
	if elapsed > bootstrapPingTimeout+5*time.Second {
		t.Fatalf("NewPool took %s against a refused connection — a refusal should fail fast, not ride the bound out", elapsed)
	}
}

// TestNewPool_BootstrapPing_HonorsBoundedTimeout is the test that can
// actually fail if the bounded-timeout guard is removed or broken.
//
// A REFUSED connection (127.0.0.1:1, above) fails near-instantly regardless
// of whether any timeout exists at all — the OS returns ECONNREFUSED before
// context.WithTimeout ever gets a chance to matter, so that test alone
// cannot distinguish "we bounded this" from "we never needed to." This test
// instead points NewPool at a listener that accepts the TCP connection and
// then goes silent forever — never sending the bytes pgx's handshake is
// waiting on — so without a bounded context the call would hang
// indefinitely. Mutate bootstrapPingTimeout's use away (e.g. pass
// context.Background() straight to Ping) and this is the test that goes
// red, by hanging past its own test timeout rather than merely reporting a
// wrong duration.
func TestNewPool_BootstrapPing_HonorsBoundedTimeout(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	var mu sync.Mutex
	var conns []net.Conn
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, conn)
			mu.Unlock()
			// Deliberately never write anything back — pgx's connection
			// handshake blocks waiting for Postgres' initial response,
			// which never arrives.
		}
	}()
	defer func() {
		mu.Lock()
		defer mu.Unlock()
		for _, c := range conns {
			c.Close()
		}
	}()

	dsn := fmt.Sprintf("postgres://vola:wrong@%s/nonexistent?sslmode=disable", ln.Addr().String())

	start := time.Now()
	pool, err := NewPool(context.Background(), dsn)
	elapsed := time.Since(start)
	if pool != nil {
		pool.Close()
	}
	if err == nil {
		t.Fatal("NewPool succeeded against a listener that never completes the Postgres handshake")
	}

	// Must not return near-instantly: a listener that never responds can
	// only fail this fast if something short-circuited before actually
	// waiting on the bound (or the bound is far shorter than intended).
	if elapsed < 1*time.Second {
		t.Fatalf("NewPool returned in %s — too fast for a connection that never gets a response; the bounded wait may not be happening at all", elapsed)
	}
	// Must not exceed the bound by more than generous scheduler slack —
	// this is the actual "not indefinitely" assertion.
	if elapsed > bootstrapPingTimeout+5*time.Second {
		t.Fatalf("NewPool took %s against an unresponsive database — bootstrapPingTimeout (%s) was not honored", elapsed, bootstrapPingTimeout)
	}
}
