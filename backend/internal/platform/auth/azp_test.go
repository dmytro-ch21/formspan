package auth

import (
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Tests for N134/#538: the `azp` (authorized-party) check. See the doc
// comment on (*Verifier).authorizedParty in auth.go for the full policy this
// exercises — four cases, matching the ticket's acceptance criteria exactly:
// allowed party, disallowed party, absent claim, malformed claim.

// signedWithClaims mints a token this Verifier will accept up to azp,
// carrying whatever extra claims the caller wants (or none, for the
// "absent" case) — signedFor in limiter_test.go can't express an azp claim
// at all, since it signs a fixed jwt.RegisteredClaims.
func signedWithClaims(t *testing.T, key *rsa.PrivateKey, sub string, extra map[string]any) string {
	t.Helper()
	claims := jwt.MapClaims{
		"iss": testIssuer,
		"sub": sub,
		"exp": jwt.NewNumericDate(time.Now().Add(time.Hour)).Unix(),
	}
	for k, v := range extra {
		claims[k] = v
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signed, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

// verifierWithParties is verifierWithKeys plus a configured
// authorizedParties allowlist — the "this deployment has it configured"
// state the ticket's first three cases assume.
func verifierWithParties(t *testing.T, parties ...string) (*Verifier, *rsa.PrivateKey) {
	t.Helper()
	v, key := verifierWithKeys(t)
	allowed := make(map[string]bool, len(parties))
	for _, p := range parties {
		allowed[p] = true
	}
	v.authorizedParties = allowed
	return v, key
}

// Case 1: an allowed party. A token whose azp is in the allowlist verifies
// normally.
func TestAuthorizedPartyAllowed(t *testing.T) {
	v, key := verifierWithParties(t, "https://app.vola.example")
	tok := signedWithClaims(t, key, "user_abc", map[string]any{"azp": "https://app.vola.example"})

	claims, err := v.Verify(tok)
	if err != nil {
		t.Fatalf("an allowlisted azp was rejected: %v", err)
	}
	if claims.UserID != "user_abc" {
		t.Fatalf("got user %q, want user_abc", claims.UserID)
	}
}

// Case 2: a disallowed party. A token whose azp names a real-looking but
// unlisted origin is rejected outright — this is the replay this whole
// ticket exists to stop: a token minted for a different frontend, presented
// here.
func TestAuthorizedPartyDisallowed(t *testing.T) {
	v, key := verifierWithParties(t, "https://app.vola.example")
	tok := signedWithClaims(t, key, "user_abc", map[string]any{"azp": "https://evil.example"})

	if _, err := v.Verify(tok); err == nil {
		t.Fatalf("a disallowed azp was accepted")
	}
}

// Case 3: an absent claim. No azp at all must be ALLOWED when an allowlist
// is configured — this is the documented mobile-token carve-out, not a bug.
func TestAuthorizedPartyAbsentIsAllowed(t *testing.T) {
	v, key := verifierWithParties(t, "https://app.vola.example")
	tok := signedWithClaims(t, key, "user_abc", nil) // no azp key at all

	claims, err := v.Verify(tok)
	if err != nil {
		t.Fatalf("a token with no azp claim was rejected: %v", err)
	}
	if claims.UserID != "user_abc" {
		t.Fatalf("got user %q, want user_abc", claims.UserID)
	}
}

// Case 4: a malformed claim. azp present but not a string (a number, here)
// must be rejected — fail closed, not treated the same as absent.
func TestAuthorizedPartyMalformedIsRejected(t *testing.T) {
	v, key := verifierWithParties(t, "https://app.vola.example")
	tok := signedWithClaims(t, key, "user_abc", map[string]any{"azp": 12345})

	if _, err := v.Verify(tok); err == nil {
		t.Fatalf("a non-string azp claim was accepted")
	}
}

// An UNCONFIGURED allowlist (the local-dev default) must not enforce
// anything — any azp, including a disallowed-looking one, passes, because
// there is nothing to allow or disallow against yet. This is what keeps
// today's "any valid Clerk token works locally" behavior unbroken.
func TestAuthorizedPartyNoAllowlistConfiguredIsANoOp(t *testing.T) {
	v, key := verifierWithKeys(t) // no authorizedParties set — nil map
	tok := signedWithClaims(t, key, "user_abc", map[string]any{"azp": "https://anything.example"})

	if _, err := v.Verify(tok); err != nil {
		t.Fatalf("azp was enforced with no allowlist configured: %v", err)
	}
}

// End-to-end: a disallowed azp rejected through the actual RequireAuth
// middleware chain gets the same generic 401/"invalid token" every other
// verification failure gets — never a message naming the allowlist or the
// rejected party. This is the "never leak which parties are/aren't allowed"
// acceptance criterion, checked at the HTTP boundary rather than just on the
// Verify function directly.
func TestRequireAuthRejectsDisallowedAzpWithoutLeakingTheAllowlist(t *testing.T) {
	v, key := verifierWithParties(t, "https://app.vola.example")
	tok := signedWithClaims(t, key, "user_abc", map[string]any{"azp": "https://evil.example"})

	reached := 0
	h := v.RequireAuth(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached++ }))

	req := httptest.NewRequest(http.MethodGet, "/v1/profile", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if reached != 0 {
		t.Fatalf("a disallowed azp reached the handler")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got status %d, want 401", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"unauthorized"`) {
		t.Fatalf("body %q doesn't carry the unauthorized code", body)
	}
	for _, leak := range []string{"evil.example", "app.vola.example", "azp"} {
		if strings.Contains(body, leak) {
			t.Fatalf("response body leaked internal detail %q: %s", leak, body)
		}
	}
}
