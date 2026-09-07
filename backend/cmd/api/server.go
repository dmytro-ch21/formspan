package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// N162/#539 — graceful shutdown and explicit server timeouts.
//
// Before this, cmd/api ran bare `http.ListenAndServe`: no `*http.Server`
// lifecycle, no SIGTERM/SIGINT handling, no header/idle timeouts. A deploy
// killed the process outright, tearing down whatever request happened to be
// in flight, and a client that opened a connection and trickled bytes in one
// at a time held a goroutine (and, worse, a slow-loris-style listener slot)
// for as long as it liked.

// readHeaderTimeout bounds only the time to read a request's headers — never
// the body, never the handler. This is the classic slow-loris defense: a
// client that opens a connection and sends headers one byte at a time is cut
// off here rather than held indefinitely. It has zero interaction with any
// request's processing time, so it is safe to set tightly.
const readHeaderTimeout = 10 * time.Second

// idleTimeout bounds how long a keep-alive connection may sit idle *between*
// requests. Also independent of any single request's duration — a connection
// only goes idle once a response has already been fully written — so this is
// safe to set independently of the AI routes' budgets too.
const idleTimeout = 120 * time.Second

// Deliberately NO ReadTimeout and NO WriteTimeout on this server.
//
// Both are whole-request deadlines applied from the moment the connection is
// accepted (ReadTimeout) or from the first byte of the response header
// (WriteTimeout), and neither can be scoped per-route — an http.Server-level
// value applies to every request the mux serves. This repo already has a
// route whose legitimate duration is measured in tens of seconds:
// nutrition's POST /v1/nutrition/estimate deliberately runs a model call for
// up to `estimateTimeout` (35s, see estimate_handler.go), chosen to answer
// BEFORE the mobile client's own 45s deadline
// (`apps/mobile/lib/authedFetch.ts`'s `SLOW_REQUEST_TIMEOUT_MS`) —
// `scripts/check-timeout-parity.py` fails the build if that ordering is ever
// lost. A global WriteTimeout set anywhere below 45s (with margin) would cut
// that exact response off mid-write, which is precisely what N92 (#433) was
// about and precisely what this ticket's acceptance criteria forbid touching.
//
// Two more routes call the same model platform with NO explicit per-request
// deadline at all (bjj's reflect/draft and exercise's identify) — they run
// only as long as `r.Context()` stays alive, which today means "until the
// client gives up or the response is written". Bounding a request duration
// that already varies this much with one process-wide number is exactly the
// hazard the ticket names: get the number wrong, or have a future change
// lengthen a budget without remembering this constant, and every AI request
// in production breaks silently.
//
// So this deliberately takes the ticket's first, preferred option: no global
// WriteTimeout/ReadTimeout at all. Slow-loris on the REQUEST side is covered
// by ReadHeaderTimeout above (headers) and, once a handler has run,
// `apihttp.DrainRequestBody`'s own `drainDeadline` (an explicit
// `SetReadDeadline` on the response controller — see drain.go, which already
// documents "There is no ReadTimeout on this server" as a load-bearing fact,
// not an oversight). Slow-loris on the RESPONSE side — a client that opens a
// connection and reads the response back one byte at a minute — is a real gap
// this leaves open; it is the same gap that already existed under bare
// `http.ListenAndServe` (which also carries no WriteTimeout), so this change
// is not a regression on that axis, and closing it needs a route-scoped
// mechanism (`http.TimeoutHandler` or a per-route context deadline), not a
// server-wide one. Not attempted here — out of this ticket's scope, which is
// shutdown lifecycle plus the two timeouts that cannot interact with request
// duration.
//
// shutdownTimeout bounds how long a SIGTERM/SIGINT drain waits for in-flight
// requests before forcing the remaining connections closed.
//
// Chosen against the LONGEST client-enforced deadline in the system today,
// not against the server's own (nutrition's 35s already self-terminates
// well inside this): the mobile app's `SLOW_REQUEST_TIMEOUT_MS` is 45s, and
// an in-flight bjj/reflect or exercise/identify call from a phone can
// legitimately still be running at that mark. 60s gives that a full ~15s of
// margin — the same kind of margin `check-timeout-parity.py`'s 10s enforces
// between the two client/server AI deadlines, widened slightly here because
// this number sits downstream of BOTH known deadlines (35s and 45s) rather
// than one. A web-originated call carries no client-side abort at all
// (`apps/web/src/lib/api.ts`'s `request` helper takes an optional
// `AbortSignal` a caller may never pass), so it is not bounded by this
// reasoning — a slow web-originated AI call still gets force-closed at 60s
// during a deploy, which is a clean cutoff (the acceptance criteria's
// explicitly allowed outcome), not a silent drop, and is no worse than the
// previous behavior of the whole process dying underneath it instantly.
const shutdownTimeout = 60 * time.Second

// newServer builds the explicit *http.Server this ticket exists to add, in
// place of the bare http.ListenAndServe call this package used to make.
func newServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
	}
}

// runUntilShutdown serves srv on ln until either the server exits on its own
// (e.g. a listener error) or ctx is cancelled (the SIGTERM/SIGINT path via
// signal.NotifyContext in main). On cancellation it performs a graceful
// `Shutdown` bounded by shutdownTimeout — draining in-flight requests — and
// forces the remaining connections closed if that deadline is reached.
//
// It returns only after every in-flight request has actually finished —
// `srv.Shutdown` blocks until every active connection has gone idle (its
// handler returned and its response was written) or the drain deadline
// expires — which is what lets the caller close shared resources like the DB
// pool immediately afterward and know no in-flight handler can still be
// touching them.
//
// A non-nil error means the server failed to serve at all (a listener
// problem); the graceful-shutdown path always returns nil, since a shutdown
// signal is expected operation, not a failure.
//
// drainTimeout is passed explicitly (rather than reading the package-level
// shutdownTimeout constant directly) so the graceful-shutdown integration
// tests can exercise both a generous and a near-instant drain window without
// touching the production constant.
func runUntilShutdown(ctx context.Context, srv *http.Server, ln net.Listener, drainTimeout time.Duration, logger *slog.Logger) error {
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.Serve(ln)
	}()

	select {
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
		logger.Info("shutdown signal received, draining in-flight requests",
			"drain_timeout", drainTimeout.String())
		shutdownCtx, cancel := context.WithTimeout(context.Background(), drainTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			// Shutdown's context expired before every connection went idle.
			// Force the rest closed rather than let the process hang forever
			// — a bounded, clean cutoff is the acceptance criteria's allowed
			// failure mode; an unbounded wait is not.
			logger.Warn("graceful shutdown deadline exceeded, forcing remaining connections closed", "err", err)
			_ = srv.Close()
		}
		// The actual drain guarantee is `Shutdown` itself: it blocks until
		// every active connection has gone idle (i.e. its handler returned
		// and the response was written) or shutdownCtx expires, so by the
		// time the call above returns, no in-flight request is still
		// running. `Serve`'s own goroutine returns near-immediately once
		// Shutdown closes the listener — well before Shutdown itself
		// returns — so this receive is a formality (draining the buffered
		// channel so nothing is left unread) rather than where the wait
		// happens; it costs nothing and removes any doubt that Serve has
		// also, separately, returned.
		<-serveErr
		return nil
	}
}
