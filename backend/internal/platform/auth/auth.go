// Package auth verifies Clerk-issued session JWTs against Clerk's public
// JWKS. This is deliberately generic JOSE/JWT verification, not the Clerk Go
// SDK — keeps the auth provider swappable behind this package if it's ever
// replaced, per the "avoid vendor-specific code" practice for this project.
package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID string
}

type Verifier struct {
	keyfunc keyfunc.Keyfunc
	issuer  string
}

// NewVerifier fetches and caches the issuer's JWKS. issuer is the Clerk
// instance's Frontend API URL, e.g. https://your-instance.clerk.accounts.dev
// (decode it from NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, or read it off the
// Clerk dashboard's API Keys page).
func NewVerifier(ctx context.Context, issuer string) (*Verifier, error) {
	if issuer == "" {
		return nil, errors.New("auth: issuer must not be empty")
	}
	issuer = strings.TrimRight(issuer, "/")

	kf, err := keyfunc.NewDefaultCtx(ctx, []string{issuer + "/.well-known/jwks.json"})
	if err != nil {
		return nil, fmt.Errorf("auth: fetch jwks: %w", err)
	}
	return &Verifier{keyfunc: kf, issuer: issuer}, nil
}

// Verify checks signature, issuer, and expiry (the last via the jwt
// library's default validator) and returns the token's subject as the
// user ID.
//
// Known simplification: this does not check the `azp` (authorized party)
// claim, which Clerk recommends validating when multiple frontends share
// one Clerk instance, to rule out a token issued for a different app being
// replayed here. Fine for a single-frontend hello-world; revisit before
// there's more than one trusted origin.
func (v *Verifier) Verify(tokenString string) (*Claims, error) {
	token, err := jwt.Parse(tokenString, v.keyfunc.Keyfunc,
		jwt.WithIssuer(v.issuer),
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithLeeway(5*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("auth: verify token: %w", err)
	}
	if !token.Valid {
		return nil, errors.New("auth: invalid token")
	}

	sub, err := token.Claims.GetSubject()
	if err != nil || sub == "" {
		return nil, errors.New("auth: missing subject claim")
	}
	return &Claims{UserID: sub}, nil
}

type contextKey string

const claimsContextKey contextKey = "auth.claims"

// RequireAuth wraps a handler, rejecting requests without a valid
// `Authorization: Bearer <token>` header and otherwise injecting the
// verified Claims into the request context for the handler to read via
// ClaimsFromContext.
func (v *Verifier) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || token == "" {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}

		claims, err := v.Verify(token)
		if err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), claimsContextKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
	claims, ok := ctx.Value(claimsContextKey).(*Claims)
	return claims, ok
}
