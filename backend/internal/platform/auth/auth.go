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
	limiter      Limiter
	reject       Rejector
}

// Limiter is the per-athlete request budget, satisfied by
// platform/ratelimit. Declared here as a consumer-side interface so this
// package does not import that one — the same shape as share.Friends and
// notification.Counter.
type Limiter interface {
	// Allow spends a request for this user, reporting whether one was
	// available and how long until the next is.
	Allow(userID string) (bool, time.Duration)
}

// Rejector writes the 429. Passed in for the same reason as Limiter: this
// package should not learn the response shape of another one.
type Rejector func(w http.ResponseWriter, r *http.Request, policy string, retryAfter time.Duration)

// UseLimiter attaches the DEFAULT per-athlete limit to every authenticated
// request.
//
// HERE, INSIDE RequireAuth, RATHER THAN PER ROUTE, and that placement is the
// point. Sixty-odd routes call RequireAuth; a limiter wired per route is one
// somebody forgets on the sixty-first, and the forgetting is silent. Putting
// it at the single chokepoint that already exists for "every authenticated
// request" makes an unlimited authenticated route impossible to write rather
// than merely discouraged.
//
// It also has to be here for a duller reason: the key is the authenticated
// user id, which does not exist until this middleware has verified the token.
// Anything wrapped around the mux runs too early to know who is calling.
//
// Optional — a nil limiter leaves every request unlimited, which is what the
// tests and any future no-limit deployment want.
func (v *Verifier) UseLimiter(l Limiter, reject Rejector) {
	// A limiter with no rejector would panic on the FIRST refusal — long
	// after boot, on the one code path nobody exercises by hand. Refusing the
	// combination here turns that into an immediate, obvious failure.
	if l != nil && reject == nil {
		panic("auth: UseLimiter needs a rejector to write the 429")
	}
	v.limiter = l
	v.reject = reject
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

		// Hand the identity back out to the request logger. Done here rather
		// than in each handler because it should hold for every authenticated
		// request, and something every handler has to remember is something a
		// handler eventually forgets. See `httplog.SetUserID` for why this
		// can't be an ordinary context value.
		httplog.SetUserID(r.Context(), claims.UserID)

		ctx := context.WithValue(r.Context(), claimsContextKey, claims)

		// The default budget, spent AFTER the token is verified and before
		// the handler runs. After verification because an unverifiable
		// request has no athlete to charge, and charging the wrong one would
		// let an attacker spend somebody else's budget with a junk token.
		if v.limiter != nil {
			if ok, retryAfter := v.limiter.Allow(claims.UserID); !ok {
				v.reject(w, r.WithContext(ctx), "default", retryAfter)
				return
			}
		}

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
	claims, ok := ctx.Value(claimsContextKey).(*Claims)
	return claims, ok
}

// ContextWithClaims is the inverse of ClaimsFromContext, for tests.
//
// The context key is deliberately unexported, which is right — nothing outside
// this package should be able to forge an identity in production code. But it
// also means a handler test cannot reach an authenticated code path at all
// without standing up a verifier and minting a real signed token, and the
// alternative to this function is that authenticated handlers simply go
// untested. That trade is worse: the handlers are where the authorization
// decisions live.
//
// **Not a way to authenticate a request.** Only `RequireAuth` puts claims in a
// context that came from the network; this writes to a context a test already
// owns, so it cannot be reached by a caller.
func ContextWithClaims(ctx context.Context, claims *Claims) context.Context {
	return context.WithValue(ctx, claimsContextKey, claims)
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
