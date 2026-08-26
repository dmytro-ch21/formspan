package httplog_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

// A deadline set under this middleware must actually reach the socket.
//
// **This is a guard that could not fire, found by measuring rather than by
// reading.** `statusRecorder` embeds `http.ResponseWriter`, which satisfies the
// interface but not the unwrap contract Go 1.20 introduced — so
// `http.NewResponseController` stopped at it and every call returned `feature
// not supported`. Measured before the fix: nil on a bare handler, "feature not
// supported" through `Middleware`.
//
// What it silently disarmed: `apihttp.DrainRequestBody` bounds its drain at ten
// seconds precisely so a client that dribbles its body cannot hold a goroutine
// open — and this server runs `http.ListenAndServe` with no `ReadTimeout`, so
// that bound is the only one there is. It was doing nothing.
//
// The failure mode is the reason this test exists rather than a comment:
// `SetReadDeadline` reports refusal as a RETURN VALUE, and `drain` discards it
// deliberately (a recorder in a unit test legitimately cannot set one). So
// nothing anywhere would ever have said this was broken.
func TestAResponseControllerReachesTheRealWriter(t *testing.T) {
	var throughMiddleware, bare error

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		err := http.NewResponseController(w).SetReadDeadline(time.Now().Add(time.Minute))
		if r.Header.Get("X-Case") == "bare" {
			bare = err
		} else {
			throughMiddleware = err
		}
		w.WriteHeader(http.StatusOK)
	})

	call := func(h http.Handler, kase string) {
		t.Helper()
		srv := httptest.NewServer(h)
		defer srv.Close()
		req, err := http.NewRequest(http.MethodGet, srv.URL, nil)
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

	// The control. If this ever fails, the runtime changed and the assertion
	// below is measuring something else — without it, a Go release that broke
	// ResponseController everywhere would read as this middleware's fault.
	call(handler, "bare")
	if bare != nil {
		t.Fatalf("SetReadDeadline failed on a BARE handler (%v); the control is "+
			"broken, so this test proves nothing about the middleware", bare)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	call(httplog.Middleware(logger, nil)(handler), "middleware")
	if throughMiddleware != nil {
		t.Fatalf("SetReadDeadline through Middleware = %v, want nil. "+
			"statusRecorder needs Unwrap() http.ResponseWriter, or every "+
			"ResponseController call under this middleware — including "+
			"apihttp.DrainRequestBody's only bound on a slow client — is a "+
			"silent no-op", throughMiddleware)
	}
}
