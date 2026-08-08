package ratelimit

import (
	"net/http"
	"strconv"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

// KeyFunc extracts the limiting key from a request, returning ok=false when
// there is nobody to limit — an unauthenticated request that got this far, in
// practice. Those are NOT limited here: this package keys on identity, and
// inventing one from an IP would be the shared-NAT mistake the package doc
// rejects.
type KeyFunc func(*http.Request) (string, bool)

// Middleware applies a policy to whatever KeyFunc identifies.
//
// FAILS OPEN when there is no key. A limiter that rejects requests it cannot
// attribute would turn "identity is momentarily unavailable" into an outage,
// and the routes worth protecting are all behind RequireAuth anyway — which
// means the no-key path is unreachable in the wiring rather than merely
// unlikely.
func Middleware(l *Limiter, key KeyFunc) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			k, ok := key(r)
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			if allowed, retryAfter := l.Allow(k); !allowed {
				Reject(w, r, l.policy.Name, retryAfter)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Reject writes the 429.
//
// LOGGED AT WARN, EVERY TIME, and that is not incidental. A limit nobody can
// see is a limit nobody can tune: the numbers here are an opening position,
// and the only way to learn that one of them is wrong is evidence that real
// athletes are hitting it. The policy name goes in the log and never in the
// response — which limit you tripped is not something a caller needs, and
// telling them is free reconnaissance.
func Reject(w http.ResponseWriter, r *http.Request, policy string, retryAfter time.Duration) {
	httplog.FromContext(r.Context()).Warn("ratelimit: rejected",
		"policy", policy,
		"path", r.URL.Path,
		"retry_after_s", int(retryAfter.Seconds()),
	)
	// Set BEFORE WriteError: it writes the status line, and headers added
	// after that are silently dropped.
	w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())))
	apihttp.WriteError(w, http.StatusTooManyRequests, apihttp.CodeRateLimited,
		"Too many requests just now. Try again in a moment.")
}
