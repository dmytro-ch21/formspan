package apihttp

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The drain's time bound must survive the chain `cmd/api` actually runs.
//
// **An internal test, and that is the point rather than a convenience.** It
// stands exactly where `DrainRequestBody` stands — `outerChain(...)(probe)` —
// which is reachable only from inside the package. Composing the whole of
// `Assemble` would put the probe *inside* `Stack`, below `Compress` and
// `ConditionalGet`, whose writers deliberately have no `Unwrap`; it would fail
// for a reason that says nothing about the drain. An earlier draft did exactly
// that and failed correctly for the wrong reason.
//
// # What it is guarding
//
// `DrainRequestBody` bounds its drain at ten seconds via
// `http.NewResponseController(w).SetReadDeadline`, and a ResponseController
// walks `Unwrap() http.ResponseWriter`, stopping at the first wrapper without
// one. `httplog.statusRecorder` had no `Unwrap`, so that call returned
// `feature not supported` on every real request — and since this server sets no
// `ReadTimeout`, those ten seconds were the only bound on a client trickling
// 8 MB. Measured: nil bare, `feature not supported` through the real chain.
//
// Nothing reported it, because `SetReadDeadline` refuses by RETURN VALUE and
// `drain` discards that on purpose (a `httptest` recorder legitimately cannot
// set one). So the guarantee has to live in a test, and the test has to be
// built from the same definition production uses — otherwise it guards a chain
// nobody serves. `Stack`'s own doc comment records that exact failure one layer
// in: a test that built its own stack and could only ever pass.
func TestTheDrainsDeadlineSurvivesTheProductionMiddlewareChain(t *testing.T) {
	var bare, assembled error
	probe := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		err := http.NewResponseController(w).SetReadDeadline(time.Now().Add(time.Minute))
		if r.Header.Get("X-Case") == "bare" {
			bare = err
		} else {
			assembled = err
		}
		WriteJSON(w, http.StatusOK, map[string]string{"ok": "yes"})
	})

	call := func(h http.Handler, kase string) {
		t.Helper()
		srv := httptest.NewServer(h)
		defer srv.Close()
		req, err := http.NewRequest(http.MethodPost, srv.URL, bytes.NewReader([]byte("{}")))
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		req.Header.Set("X-Case", kase)
		res, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("%s: %v", kase, err)
		}
		defer res.Body.Close()
		_, _ = io.Copy(io.Discard, res.Body)
	}

	// The control arm. Without it, a Go release that broke ResponseController
	// everywhere would read as this chain's fault.
	call(probe, "bare")
	if bare != nil {
		t.Fatalf("SetReadDeadline failed on a BARE handler (%v) — the control is "+
			"broken, so the assertion below measures nothing", bare)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	call(outerChain(logger, nil)(probe), "assembled")
	if assembled != nil {
		t.Fatalf("SetReadDeadline at DrainRequestBody's position in the production "+
			"chain = %v, want nil. A layer in outerChain lacks "+
			"Unwrap() http.ResponseWriter, so the drain's 10s bound — the only "+
			"limit on a client trickling its body, since this server sets no "+
			"ReadTimeout — is a silent no-op", assembled)
	}
}

// Assemble must actually be outerChain wrapped around Stack.
//
// Cheap, and it closes the one seam the test above cannot see: `outerChain` is
// what that test measures, `Assemble` is what `main()` calls, and nothing
// otherwise forces them to stay the same chain. Split them and the deadline
// guarantee silently stops describing production.
func TestAssembleIsOuterChainAroundStack(t *testing.T) {
	var order []string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set by Stack's ConditionalGet on a GET; its presence proves Stack ran.
		order = append(order, "handler")
		WriteJSON(w, http.StatusOK, map[string]string{"ok": "yes"})
	})

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(Assemble(logger, nil, inner))
	defer srv.Close()

	res, err := srv.Client().Get(srv.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)

	// httplog is the outer layer: it stamps these on every response.
	if res.Header.Get("X-Request-ID") == "" {
		t.Fatal("no X-Request-ID — outerChain (httplog) is not in Assemble")
	}
	// ConditionalGet is inside Stack and sets an ETag on a 200 GET.
	if res.Header.Get("ETag") == "" {
		t.Fatal("no ETag — Stack is not in Assemble")
	}
	if len(order) != 1 {
		t.Fatalf("handler ran %d times, want 1", len(order))
	}
}
