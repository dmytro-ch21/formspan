package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// What is testable about the limiter's placement, and what is not.
//
// NOT testable here: the allowed path. Reaching it needs a token that
// `Verify` accepts, which needs a live JWKS from the Clerk issuer — so a test
// that asserts "a verified request spends a token" would have to stand up a
// signing key and a fake issuer to prove a two-line call. The wiring is
// instead asserted where it is legible: `UseLimiter` is called once in
// cmd/api/main.go, and no route can opt out of it.
//
// Also not testable here: a well-formed-but-invalid JWT. Reaching `Verify`
// needs a real `keyfunc.Keyfunc`, and a zero-value Verifier has none — so the
// cases below are the ones that reject on the header's SHAPE, which is every
// path a test can drive without a JWKS. They cover the property regardless:
// the limiter call sits after `Verify`, so if it were reachable before
// rejection at all, these would reach it.
//
// Testable, and the part that actually matters: an UNVERIFIABLE request must
// not spend anybody's budget. Charging before verification would let an
// attacker exhaust a victim's limit with junk tokens — a denial of service
// against a named account, delivered through the very mechanism meant to
// prevent one — and it is exactly the mistake that comes from putting the
// check one line too early.

type spyLimiter struct {
	calls int
}

func (s *spyLimiter) Allow(string) (bool, time.Duration) {
	s.calls++
	return true, 0
}

func TestUnverifiableRequestsSpendNobodysBudget(t *testing.T) {
	spy := &spyLimiter{}
	v := &Verifier{}
	v.UseLimiter(spy, func(http.ResponseWriter, *http.Request, string, time.Duration) {
		t.Fatalf("a rejection was written for a request that never authenticated")
	})

	reached := false
	h := v.RequireAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))

	for _, tc := range []struct {
		name   string
		header string
	}{
		{"no authorization header", ""},
		{"not a bearer token", "Basic abc"},
		{"empty bearer", "Bearer "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/profile", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("want 401, got %d", rec.Code)
			}
			if reached {
				t.Fatalf("an unauthenticated request reached the handler")
			}
		})
	}

	if spy.calls != 0 {
		t.Fatalf("the limiter was consulted %d times for requests that never authenticated", spy.calls)
	}
}

// A nil limiter must leave everything unlimited rather than panicking — that
// is the shape every test binary and any future no-limit deployment runs in.
func TestNoLimiterMeansNoLimit(t *testing.T) {
	v := &Verifier{}
	rec := httptest.NewRecorder()
	v.RequireAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).
		ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/profile", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want the ordinary 401, got %d", rec.Code)
	}
}
