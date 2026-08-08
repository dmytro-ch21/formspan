package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/MicahParks/jwkset"
	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// Tests for where the rate limit sits in the auth chain.
//
// AN EARLIER VERSION OF THIS FILE SAID THE VERIFIED PATH WAS UNTESTABLE — that
// reaching it needed a live JWKS from Clerk. That was simply wrong, and review
// caught it: `Verify` calls exactly one method of `keyfunc.Keyfunc`, so an
// in-package fake holding a test-generated key drives the whole path offline.
// The claim mattered, because everything it excused went untested: that a
// verified request spends a token, that an exhausted budget produces the 429,
// and that a nil limiter does not panic. The old "no limiter" test in
// particular could not fail — the nil guard sits AFTER Verify and the test
// never authenticated, so it only ever exercised the 401.

// fakeKeys implements keyfunc.Keyfunc against one in-memory public key. Only
// Keyfunc is ever called; the rest satisfy the interface.
type fakeKeys struct{ pub *rsa.PublicKey }

func (f fakeKeys) Keyfunc(*jwt.Token) (any, error) { return f.pub, nil }
func (f fakeKeys) KeyfuncCtx(context.Context) jwt.Keyfunc {
	return func(*jwt.Token) (any, error) { return f.pub, nil }
}
func (f fakeKeys) Storage() jwkset.Storage { return nil }
func (f fakeKeys) VerificationKeySet(context.Context) (jwt.VerificationKeySet, error) {
	return jwt.VerificationKeySet{Keys: []jwt.VerificationKey{f.pub}}, nil
}

const testIssuer = "https://test.example"

// signedFor mints a token this Verifier will accept for the given subject.
func signedFor(t *testing.T, key *rsa.PrivateKey, sub string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.RegisteredClaims{
		Issuer:    testIssuer,
		Subject:   sub,
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
	})
	signed, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

func verifierWithKeys(t *testing.T) (*Verifier, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	var kf keyfunc.Keyfunc = fakeKeys{pub: &key.PublicKey}
	return &Verifier{keyfunc: kf, issuer: testIssuer}, key
}

type countingLimiter struct {
	calls   int
	sawKeys []string
	allow   bool
}

func (c *countingLimiter) Allow(userID string) (bool, time.Duration) {
	c.calls++
	c.sawKeys = append(c.sawKeys, userID)
	return c.allow, 7 * time.Second
}

// A VERIFIED request spends exactly one token, charged to the verified
// subject — not to the raw header, and not to nobody.
func TestVerifiedRequestSpendsOneTokenForTheVerifiedUser(t *testing.T) {
	v, key := verifierWithKeys(t)
	lim := &countingLimiter{allow: true}
	v.UseLimiter(lim, func(http.ResponseWriter, *http.Request, string, time.Duration) {
		t.Fatalf("an allowed request was rejected")
	})

	reached := 0
	h := v.RequireAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached++ }))

	req := httptest.NewRequest(http.MethodGet, "/v1/profile", nil)
	req.Header.Set("Authorization", "Bearer "+signedFor(t, key, "user_abc"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || reached != 1 {
		t.Fatalf("code %d, handler reached %d times", rec.Code, reached)
	}
	if lim.calls != 1 {
		t.Fatalf("want exactly one token spent, got %d", lim.calls)
	}
	if len(lim.sawKeys) != 1 || lim.sawKeys[0] != "user_abc" {
		t.Fatalf("charged to %v, want the verified subject", lim.sawKeys)
	}
}

// An exhausted budget rejects BEFORE the handler, through the rejector, and
// the handler never runs.
func TestExhaustedBudgetRejectsBeforeTheHandler(t *testing.T) {
	v, key := verifierWithKeys(t)
	lim := &countingLimiter{allow: false}
	rejected := 0
	var sawPolicy string
	var sawRetry time.Duration
	v.UseLimiter(lim, func(w http.ResponseWriter, _ *http.Request, policy string, retry time.Duration) {
		rejected++
		sawPolicy, sawRetry = policy, retry
		w.WriteHeader(http.StatusTooManyRequests)
	})

	reached := 0
	h := v.RequireAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached++ }))

	req := httptest.NewRequest(http.MethodGet, "/v1/profile", nil)
	req.Header.Set("Authorization", "Bearer "+signedFor(t, key, "user_abc"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if reached != 0 {
		t.Fatalf("a limited request reached the handler")
	}
	if rejected != 1 || rec.Code != http.StatusTooManyRequests {
		t.Fatalf("rejected %d times, code %d", rejected, rec.Code)
	}
	if sawPolicy != "default" {
		t.Fatalf("policy %q, want default", sawPolicy)
	}
	if sawRetry != 7*time.Second {
		t.Fatalf("retry hint %v was not passed through", sawRetry)
	}
}

// A nil limiter must leave the VERIFIED path working rather than panicking —
// the shape every test binary and any no-limit deployment runs in. The old
// version of this test never authenticated, so it exercised only the 401 and
// could not fail: removing the nil guard entirely left it green.
func TestNoLimiterLeavesTheVerifiedPathWorking(t *testing.T) {
	v, key := verifierWithKeys(t)

	reached := 0
	h := v.RequireAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached++ }))

	req := httptest.NewRequest(http.MethodGet, "/v1/profile", nil)
	req.Header.Set("Authorization", "Bearer "+signedFor(t, key, "user_abc"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || reached != 1 {
		t.Fatalf("a request with no limiter configured: code %d, reached %d", rec.Code, reached)
	}
}

// An UNVERIFIABLE request must not spend anybody's budget. Charging before
// verification would let an attacker exhaust a victim's limit with junk
// tokens — a denial of service against a named account, delivered through the
// mechanism meant to prevent one.
func TestUnverifiableRequestsSpendNobodysBudget(t *testing.T) {
	v, key := verifierWithKeys(t)
	lim := &countingLimiter{allow: true}
	v.UseLimiter(lim, func(http.ResponseWriter, *http.Request, string, time.Duration) {
		t.Fatalf("a rejection was written for a request that never authenticated")
	})

	reached := 0
	h := v.RequireAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached++ }))

	// A token signed by a DIFFERENT key: well-formed, names a victim, and
	// fails verification. This is the attack the ordering exists to stop.
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	forged := signedFor(t, other, "victim")

	for _, tc := range []struct{ name, header string }{
		{"no authorization header", ""},
		{"not a bearer token", "Basic abc"},
		{"empty bearer", "Bearer "},
		{"unparseable token", "Bearer not.a.jwt"},
		{"signed by the wrong key, naming a victim", "Bearer " + forged},
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
		})
	}

	if reached != 0 {
		t.Fatalf("an unauthenticated request reached the handler")
	}
	if lim.calls != 0 {
		t.Fatalf("the limiter was consulted %d times for requests that never authenticated", lim.calls)
	}
	_ = key
}
