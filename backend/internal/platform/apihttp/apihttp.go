// Package apihttp provides the shared JSON response and error conventions
// used by every HTTP handler. See docs/architecture/api-conventions.md for
// the full contract this implements.
package apihttp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

// Error codes are part of the public API contract (mirrored in
// contracts/public.openapi.yaml) — renaming one is a breaking change.
// Error messages are not: they're for humans and may reword between
// releases, so clients must not pattern-match on them.
const (
	CodeInvalidInput  = "invalid_input"
	CodeUnauthorized  = "unauthorized"
	CodeForbidden     = "forbidden"
	CodeNotFound      = "not_found"
	CodeAlreadyExists = "already_exists"
	CodeInternal      = "internal"
	// CodeRateLimited accompanies 429. New with the rate limiter — the enum
	// is closed and part of the contract, so adding one is a deliberate
	// contract change rather than an implementation detail.
	CodeRateLimited = "rate_limited"

	// CodeInvalidGrip accompanies 400 when a set names a grip the server does
	// not know. It is a SEPARATE code rather than another `invalid_input`
	// because a client cannot act on the difference otherwise: an unknown grip
	// is the one rejection a phone can repair by itself (drop the value, retry),
	// and the alternative is matching on the message — which the conventions in
	// docs/architecture/api-conventions.md forbid, precisely so a reworded
	// string cannot break a client.
	CodeInvalidGrip = "invalid_grip"

	// CodeUnavailable accompanies 503 when the request was fine and WE could
	// not answer it — an upstream lookup that timed out, refused, or is not
	// configured on this deploy.
	//
	// A SEPARATE code rather than reusing `not_found`, and the food catalog is
	// why. "This barcode is not in the database" and "I could not reach the
	// database" look identical to a client that only sees an empty result, and
	// they are opposite instructions: the first means offer manual entry, the
	// second means try again shortly. Collapsing them is this repo's
	// most-repeated bug — absence reading as an answer — in the one place it is
	// most expensive, because the athlete is standing in a shop.
	//
	// Distinct from `internal` too: `internal` means we are broken, this means
	// somebody we depend on is.
	CodeUnavailable = "unavailable"
)

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// StatusClientClosed is nginx's 499 — the caller hung up before the response
// was written. Not an official RFC code, but it's the de-facto one, and every
// log pipeline and dashboard already understands it as "client gone" rather
// than "server broke".
const StatusClientClosed = 499

// ClientGone reports whether an error means the caller disconnected rather
// than anything failing.
//
// A cancelled request context is not a server error. Nothing went wrong, the
// response has nowhere to go, and the caller already knows — the browser
// aborted it. Reporting it as 500 with an ERROR line puts false failures in
// the logs and would page whoever owns the error-rate alert. The web history
// page aborts a fetch on every filter change, so this fires constantly.
//
// DeadlineExceeded is deliberately excluded: that's usually *our* timeout
// elapsing, which is a real problem worth seeing.
func ClientGone(err error) bool {
	return errors.Is(err, context.Canceled)
}

// WriteJSON writes v as the JSON response body with the given status code.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// WriteError writes the standard {"error": {"code", "message"}} shape every
// error response uses.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	WriteJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: message}})
}

// WriteInternal is the one place an unexpected error becomes a response.
//
// It exists so the client-gone check can't be forgotten. That check used to be
// absent, so every aborted fetch — and the web history page aborts one on
// every filter change — logged an ERROR and returned 500 to a caller that had
// already hung up. Nine call sites each had their own copy of the two lines
// this replaces; twelve places to forget it.
//
// `module` prefixes the log line, matching what each handler wrote before.
func WriteInternal(w http.ResponseWriter, r *http.Request, module string, err error) {
	// The request's own context has to agree. A context.Canceled arising
	// internally — a pool shutting down, some future errgroup — would
	// otherwise vanish from the logs entirely with nothing recording why.
	if ClientGone(err) && r.Context().Err() != nil {
		// Nothing failed and nobody is listening. Recorded as 499 so it stays
		// visible in the request log without counting as a server error.
		w.WriteHeader(StatusClientClosed)
		return
	}
	httplog.FromContext(r.Context()).Error(module+": internal error", "err", err)
	WriteError(w, http.StatusInternalServerError, CodeInternal, "internal error")
}
