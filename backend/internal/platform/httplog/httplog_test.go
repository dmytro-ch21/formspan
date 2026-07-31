package httplog

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
)

// The user-id slot is the one piece of this package that is not obviously
// correct: it hands a value *outward* through a pointer, against the grain of
// how contexts normally work, because this middleware is outermost and
// authentication happens inside it.
//
// These tests exist so `go test -race` actually exercises that. Without a test
// file in this package the race detector never runs this code at all, and
// "-race passes" would be a claim about nothing.
func quietLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

func TestSetUserIDReachesTheLogLine(t *testing.T) {
	var observed Observation
	mw := Middleware(quietLogger(), func(_ context.Context, o Observation) { observed = o })

	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Stands in for RequireAuth.
		SetUserID(r.Context(), "user_abc")
		w.WriteHeader(http.StatusOK)
	}))

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/me", nil))

	if observed.UserID != "user_abc" {
		t.Errorf("user id did not travel back out: got %q", observed.UserID)
	}
}

// An unauthenticated request must report an empty user, not inherit whoever
// went before it. The slot is per-request; a package-level variable would pass
// the test above and fail this one.
func TestUnauthenticatedRequestHasNoUser(t *testing.T) {
	var observed Observation
	mw := Middleware(quietLogger(), func(_ context.Context, o Observation) { observed = o })

	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/healthz", nil))

	if observed.UserID != "" {
		t.Errorf("expected no user, got %q", observed.UserID)
	}
}

// Concurrent requests must not see each other's identity. Run under -race,
// this is what proves the slot is per-request rather than shared — and that
// attributing an error to the wrong athlete is impossible.
func TestConcurrentRequestsDoNotBleedUsers(t *testing.T) {
	var (
		mu   sync.Mutex
		seen = map[string]string{}
	)
	mw := Middleware(quietLogger(), func(_ context.Context, o Observation) {
		mu.Lock()
		defer mu.Unlock()
		seen[o.Path] = o.UserID
	})

	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		SetUserID(r.Context(), "user"+r.URL.Path)
		w.WriteHeader(http.StatusOK)
	}))

	var wg sync.WaitGroup
	for i := range 100 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			path := "/" + strconv.Itoa(i)
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
		}(i)
	}
	wg.Wait()

	for path, user := range seen {
		if want := "user" + path; user != want {
			t.Errorf("path %s reported user %q, want %q", path, user, want)
		}
	}
	if len(seen) != 100 {
		t.Errorf("expected 100 observations, got %d", len(seen))
	}
}

// SetUserID outside a request must not panic. Handlers reached in tests, or any
// future code path that runs without the middleware, would otherwise crash on
// a missing slot.
func TestSetUserIDWithoutMiddlewareIsSafe(t *testing.T) {
	SetUserID(context.Background(), "user_abc")
}
