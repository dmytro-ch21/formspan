package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"testing"
	"time"
)

// discardLogger is used throughout so a passing test run isn't buried in
// "shutdown signal received" lines.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestNewServerHasNoGlobalRequestDeadlines is the guard for this ticket's
// single highest-risk judgment call. ReadHeaderTimeout and IdleTimeout are
// safe to set unconditionally (see server.go) and this pins them so a future
// edit can't silently drop them; ReadTimeout and WriteTimeout must stay the
// Go zero value (net/http's own documented meaning of "no timeout" for
// either field) because either one, set anywhere below the mobile client's
// 45s budget (`apps/mobile/lib/authedFetch.ts`'s SLOW_REQUEST_TIMEOUT_MS),
// would silently cut off nutrition's 35s AI estimate call and every
// unbounded bjj/reflect or exercise/identify call — exactly the regression
// this ticket's acceptance criteria forbid. Mutation-verified: setting either
// to a nonzero value in server.go turns this red immediately.
func TestNewServerHasNoGlobalRequestDeadlines(t *testing.T) {
	srv := newServer(":0", http.NotFoundHandler())

	if srv.ReadHeaderTimeout != readHeaderTimeout {
		t.Errorf("ReadHeaderTimeout = %v, want %v", srv.ReadHeaderTimeout, readHeaderTimeout)
	}
	if srv.IdleTimeout != idleTimeout {
		t.Errorf("IdleTimeout = %v, want %v", srv.IdleTimeout, idleTimeout)
	}
	if srv.ReadTimeout != 0 {
		t.Errorf("ReadTimeout = %v, want 0 (unset) — a nonzero global ReadTimeout would cut off the AI routes; see server.go's central WriteTimeout/ReadTimeout reasoning", srv.ReadTimeout)
	}
	if srv.WriteTimeout != 0 {
		t.Errorf("WriteTimeout = %v, want 0 (unset) — a nonzero global WriteTimeout would cut off the AI routes; see server.go's central WriteTimeout/ReadTimeout reasoning", srv.WriteTimeout)
	}
}

// listenLocal opens an ephemeral-port TCP listener for a test server and
// returns it along with its dial address.
func listenLocal(t *testing.T) (net.Listener, string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	return ln, ln.Addr().String()
}

// TestRunUntilShutdownDrainsAnInFlightRequestBeforeReturning is the ticket's
// own explicit acceptance criterion #4 and "Steps to test" #1: a real
// *http.Server, on a real listener, serving a real in-flight request, sent a
// shutdown signal (simulated the same way main.go's signal.NotifyContext
// path would deliver one — by cancelling the context runUntilShutdown
// watches) roughly concurrently with that request being mid-handler. This is
// deliberately NOT a unit test of Shutdown in isolation: it drives the exact
// function main.go calls, over a real socket, with a real client on the
// other end.
func TestRunUntilShutdownDrainsAnInFlightRequestBeforeReturning(t *testing.T) {
	const handlerSleep = 300 * time.Millisecond

	started := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		time.Sleep(handlerSleep)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	ln, addr := listenLocal(t)
	srv := newServer(addr, handler)

	ctx, cancel := context.WithCancel(context.Background())

	// runUntilShutdown itself starts srv.Serve(ln) — it has to be running,
	// in its own goroutine, BEFORE the client below can connect to anything.
	runDone := make(chan error, 1)
	go func() {
		runDone <- runUntilShutdown(ctx, srv, ln, 5*time.Second, discardLogger())
	}()

	type result struct {
		status int
		body   string
		err    error
	}
	reqResult := make(chan result, 1)
	go func() {
		resp, err := http.Get("http://" + addr + "/")
		if err != nil {
			reqResult <- result{err: err}
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		reqResult <- result{status: resp.StatusCode, body: string(b)}
	}()

	// Wait for the handler to actually be running before triggering
	// "shutdown" — otherwise this could race shutdown against a request that
	// hasn't reached the handler yet, which would test something else.
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("handler never started")
	}

	shutdownBegin := time.Now()
	cancel() // the SIGTERM/SIGINT path, simulated

	var runErr error
	select {
	case runErr = <-runDone:
	case <-time.After(5 * time.Second):
		t.Fatal("runUntilShutdown never returned")
	}
	shutdownElapsed := time.Since(shutdownBegin)

	if runErr != nil {
		t.Fatalf("runUntilShutdown returned an error: %v", runErr)
	}

	res := <-reqResult
	if res.err != nil {
		t.Fatalf("in-flight request failed instead of completing cleanly: %v", res.err)
	}
	if res.status != http.StatusOK {
		t.Fatalf("response status = %d, want %d", res.status, http.StatusOK)
	}
	if res.body != "ok" {
		t.Fatalf("response body = %q, want %q", res.body, "ok")
	}

	// The load-bearing assertion. `Shutdown` must have actually WAITED for
	// the handler's sleep to finish rather than cutting the connection the
	// moment it was called — this is what "Steps to test" #1 calls a real
	// drain rather than a mocked one. A broken implementation that swapped
	// `srv.Shutdown` for `srv.Close()` would fail the response assertions
	// above outright (the client would see a connection error, not a 200)
	// and, independently, would return here almost instantly — so this
	// assertion alone would also catch that mutation even if the response
	// somehow still raced through.
	if shutdownElapsed < handlerSleep-20*time.Millisecond {
		t.Fatalf("runUntilShutdown returned after %s, less than the in-flight handler's %s sleep — it did not actually drain", shutdownElapsed, handlerSleep)
	}

	// And the server must be genuinely stopped once runUntilShutdown
	// returns, not merely "shutting down" — a fresh connection attempt must
	// fail.
	conn, dialErr := net.DialTimeout("tcp", addr, 200*time.Millisecond)
	if dialErr == nil {
		conn.Close()
		t.Fatal("server still accepting connections after runUntilShutdown returned")
	}
}

// TestRunUntilShutdownForcesCloseAfterDrainDeadlineExpires covers the other
// half of "Steps to test" #1's pass/fail line: the process must not hang
// forever waiting on a handler that outlives the drain window, but it must
// also not return before that window elapses (an early return would be the
// "process exits before the drain window" failure the ticket names).
func TestRunUntilShutdownForcesCloseAfterDrainDeadlineExpires(t *testing.T) {
	const handlerSleep = 2 * time.Second
	const drainTimeout = 200 * time.Millisecond

	started := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		time.Sleep(handlerSleep)
		w.WriteHeader(http.StatusOK)
	})

	ln, addr := listenLocal(t)
	srv := newServer(addr, handler)
	ctx, cancel := context.WithCancel(context.Background())

	runDone := make(chan error, 1)
	go func() {
		runDone <- runUntilShutdown(ctx, srv, ln, drainTimeout, discardLogger())
	}()

	reqDone := make(chan struct{})
	go func() {
		defer close(reqDone)
		resp, err := http.Get("http://" + addr + "/")
		if err == nil {
			resp.Body.Close()
		}
		// Deliberately no assertion on err/status: past the drain deadline
		// the connection is forcibly closed, so the client-side outcome is
		// "some kind of failure" and asserting its exact shape would be
		// asserting Go's http.Client internals, not this ticket's behavior.
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("handler never started")
	}

	begin := time.Now()
	cancel()

	var runErr error
	select {
	case runErr = <-runDone:
	case <-time.After(5 * time.Second):
		t.Fatal("runUntilShutdown never returned")
	}
	elapsed := time.Since(begin)

	if runErr != nil {
		t.Fatalf("runUntilShutdown returned an error: %v", runErr)
	}
	// Fail case 1 (this ticket's own wording): exits before the drain
	// window. Allow a small floor under drainTimeout for scheduling jitter.
	if elapsed < drainTimeout-20*time.Millisecond {
		t.Fatalf("runUntilShutdown returned after %s, before its %s drain deadline even elapsed", elapsed, drainTimeout)
	}
	// The bound this test exists to prove: it must NOT wait for the full
	// (much longer) handler sleep — that would mean the drain deadline
	// didn't force anything closed and a slow/stuck handler could hang a
	// deploy indefinitely.
	if elapsed >= handlerSleep {
		t.Fatalf("runUntilShutdown waited %s, as long as the full handler sleep (%s) — the drain deadline did not force a close", elapsed, handlerSleep)
	}

	<-reqDone
}
