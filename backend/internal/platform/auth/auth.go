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

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

type Claims struct {
	UserID string
}

type Verifier struct {
	keyfunc      keyfunc.Keyfunc
	issuer       string
	adminUserIDs map[string]bool
}

// NewVerifier fetches and caches the issuer's JWKS. issuer is the Clerk
// instance's Frontend API URL, e.g. https://your-instance.clerk.accounts.dev
// (decode it from NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, or read it off the
// Clerk dashboard's API Keys page). adminUserIDs is the allowlist RequireAdmin
// checks against — Clerk user IDs (the JWT's `sub` claim), not emails; the
// caller (main.go) is responsible for reading it from ADMIN_USER_IDS.
func NewVerifier(ctx context.Context, issuer string, adminUserIDs []string) (*Verifier, error) {
	if issuer == "" {
		return nil, errors.New("auth: issuer must not be empty")
	}
	issuer = strings.TrimRight(issuer, "/")

	kf, err := keyfunc.NewDefaultCtx(ctx, []string{issuer + "/.well-known/jwks.json"})
	if err != nil {
		return nil, fmt.Errorf("auth: fetch jwks: %w", err)
	}

	admins := make(map[string]bool, len(adminUserIDs))
	for _, id := range adminUserIDs {
		if id = strings.TrimSpace(id); id != "" {
			admins[id] = true
		}
	}

	return &Verifier{keyfunc: kf, issuer: issuer, adminUserIDs: admins}, nil
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
			httplog.FromContext(r.Context()).Warn("auth: rejected", "reason", "missing bearer token", "path", r.URL.Path)
			apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "missing bearer token")
			return
		}

		claims, err := v.Verify(token)
		if err != nil {
			httplog.FromContext(r.Context()).Warn("auth: rejected", "reason", "invalid token", "path", r.URL.Path, "err", err)
			apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "invalid token")
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

// RequireAdmin composes RequireAuth with an admin-membership check: 401 if
// not signed in at all (same as RequireAuth), 403 if signed in but the
// caller's user ID isn't in the ADMIN_USER_IDS allowlist.
func (v *Verifier) RequireAdmin(next http.Handler) http.Handler {
	return v.RequireAuth(v.requireAdminClaims(next))
}

func (v *Verifier) requireAdminClaims(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFromContext(r.Context())
		if !ok || !v.adminUserIDs[claims.UserID] {
			httplog.FromContext(r.Context()).Warn("auth: forbidden", "reason", "not an admin", "path", r.URL.Path)
			apihttp.WriteError(w, http.StatusForbidden, apihttp.CodeForbidden, "admin access required")
			return
		}
		next.ServeHTTP(w, r)
	})
}
