// Package httplog provides structured request logging with request-ID and
// W3C trace-context correlation. See docs/decisions/history.md for why this
// exists and docs/architecture/api-conventions.md for the header contract.
package httplog

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

// New returns the base structured logger (JSON to stdout), tagged with the
// service name so multi-service log aggregation can filter by it later.
func New() *slog.Logger {
	return For("api")
}

// For is New for something that is not the API. The tag is the whole point of
// New — filtering by service — so a CLI borrowing it and reporting itself as
// "api" makes the field a lie in exactly the aggregation it exists to serve.
//
// Not a `.With("service", …)` on top of New: slog appends rather than replaces,
// so that emits the key twice.
func For(service string) *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", service)
}

type ctxKey string

const (
	loggerCtxKey    ctxKey = "httplog.logger"
	requestIDCtxKey ctxKey = "httplog.request_id"
	traceIDCtxKey   ctxKey = "httplog.trace_id"
	userSlotCtxKey  ctxKey = "httplog.user_slot"
)

// userSlot is a mutable box the middleware puts in the context so that
// authentication — which runs *inside* it — can hand the user id back out.
//
// A plain context value cannot do this. `context.WithValue` returns a new
// context, and the one an inner middleware builds is visible only to handlers
// further in; by the time control returns here to write the log line, that
// value is gone. Since this middleware is outermost (it has to be, to time and
// correlate everything else), the id has to travel outward through a pointer
// rather than inward through a value.
//
// One request is served by one goroutine, so this is written once and read once
// with a happens-before edge between them.
//
// **`http.TimeoutHandler` breaks that assumption**, and it is the only thing in
// the standard library that does silently: it runs the inner chain on a second
// goroutine and can reply while that goroutine is still running, so a write
// here would race the read below. Verified with the race detector. Nothing in
// this service uses it — but "add request timeouts" is an obvious future
// change, and whoever makes it needs to see this first. A handler that spawns
// goroutines and authenticates from them has the same problem.
type userSlot struct{ id string }

// SetUserID attaches the authenticated user to this request's log line and to
// the observation handed to the recorder.
//
// Called from the auth middleware rather than from handlers: it should be true
// of every authenticated request, and something every handler must remember to
// do is something a handler will eventually forget.
func SetUserID(ctx context.Context, id string) {
	if s, ok := ctx.Value(userSlotCtxKey).(*userSlot); ok {
		s.id = id
	}
}

// Observation is one completed request, handed to the recorder so it can decide
// whether the event is worth keeping.
//
// The middleware deliberately does not decide that. Whether a 503 or an
// eight-second read matters is a product question, and answering it here would
// put policy in the transport layer and a database dependency in a logging
// package.
type Observation struct {
	Method    string
	Path      string
	Status    int
	Duration  time.Duration
	UserID    string
	RequestID string
	TraceID   string
}

// ObserveFunc receives every completed request. Nil is fine — logging works
// without a recorder, which is what local dev and CI run with.
type ObserveFunc func(ctx context.Context, o Observation)

// FromContext returns the request-scoped logger stashed by Middleware,
// already tagged with request_id/trace_id/span_id. Falls back to the
// default logger if called outside a request (shouldn't normally happen).
func FromContext(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(loggerCtxKey).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}

// RequestIDFromContext returns the current request's ID — e.g. for
// handlers that need to persist it alongside the record they're creating
// (see internal/modules/activity), not just log it. Empty outside a
// request.
func RequestIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(requestIDCtxKey).(string)
	return id
}

// TraceIDFromContext is RequestIDFromContext's trace-ID counterpart.
func TraceIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(traceIDCtxKey).(string)
	return id
}

// Middleware generates/extracts a request ID and W3C trace context for
// every request, injects a logger carrying both into the request context,
// echoes both back as response headers, and logs one structured line per
// request on completion.
func Middleware(base *slog.Logger, observe ObserveFunc) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestID := r.Header.Get("X-Request-ID")
			if requestID == "" {
				requestID = newHexID(8)
			}

			traceID, _ := parseTraceparent(r.Header.Get("traceparent"))
			if traceID == "" {
				traceID = newHexID(16)
			}
			spanID := newHexID(8)

			logger := base.With("request_id", requestID, "trace_id", traceID, "span_id", spanID)
			slot := &userSlot{}
			ctx := context.WithValue(r.Context(), loggerCtxKey, logger)
			ctx = context.WithValue(ctx, requestIDCtxKey, requestID)
			ctx = context.WithValue(ctx, traceIDCtxKey, traceID)
			ctx = context.WithValue(ctx, userSlotCtxKey, slot)

			w.Header().Set("X-Request-ID", requestID)
			w.Header().Set("traceparent", fmt.Sprintf("00-%s-%s-01", traceID, spanID))

			rw := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			start := time.Now()
			next.ServeHTTP(rw, r.WithContext(ctx))
			elapsed := time.Since(start)

			// `user_id` is the field that turns the log from a traffic record
			// into something you can investigate with. Without it, "this
			// athlete says syncing is broken" had no query — you could see
			// that *someone* got a 500, never who. Empty for unauthenticated
			// requests, which is a fact rather than a gap.
			logger.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rw.status,
				"duration_ms", elapsed.Milliseconds(),
				"user_id", slot.id,
			)

			if observe != nil {
				observe(ctx, Observation{
					Method:    r.Method,
					Path:      r.URL.Path,
					Status:    rw.status,
					Duration:  elapsed,
					UserID:    slot.id,
					RequestID: requestID,
					TraceID:   traceID,
				})
			}
		})
	}
}

// statusRecorder captures the status code written by the wrapped handler
// so the access-log line can report it (http.ResponseWriter alone doesn't
// expose what was written).
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// Unwrap lets `http.NewResponseController` reach the real ResponseWriter.
//
// **Without this, every ResponseController call under this middleware returns
// `feature not supported` — silently, since the API reports it as an error
// value nobody is obliged to read.** Embedding `http.ResponseWriter` satisfies
// the interface but NOT the unwrap contract Go 1.20 introduced; a controller
// walks `Unwrap() http.ResponseWriter` and stops at the first type that does
// not have one.
//
// Measured, because reasoning about it is how it stays broken:
// `SetReadDeadline` on a bare handler returns nil, and through
// `Middleware` returned `feature not supported`. `apihttp.DrainRequestBody`'s
// 10-second bound was therefore doing nothing at all in production — a
// deadline that cannot fire, on the one middleware whose job is to keep a slow
// client from holding a goroutine open.
//
// **`Compress` and `ConditionalGet` deliberately do NOT get one**, and that is
// not an oversight to be tidied up later. Both BUFFER the response in order to
// gzip or hash it, and their doc comments say in as many words that Flusher,
// Hijacker and ReaderFrom are unsupported for that reason. An Unwrap there
// would hand a handler the real writer and let it push bytes past the buffer,
// emitting the body twice. This recorder is safe precisely because it buffers
// nothing — it notes the status and passes every write straight through.
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func newHexID(bytes int) string {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand.Read only fails if the OS entropy source is broken,
		// which is a fatal environment problem, not something to recover
		// from with a weaker fallback ID.
		panic(fmt.Sprintf("httplog: read random bytes: %v", err))
	}
	return hex.EncodeToString(b)
}

// parseTraceparent extracts the trace ID and parent span ID from a W3C
// traceparent header (https://www.w3.org/TR/trace-context/):
// "version-traceid-spanid-flags", e.g. "00-<32 hex>-<16 hex>-01". Returns
// empty strings on any malformed input — a bad incoming header should
// never fail the request, it just means a fresh trace starts here.
func parseTraceparent(header string) (traceID, spanID string) {
	parts := strings.Split(header, "-")
	if len(parts) != 4 {
		return "", ""
	}
	version, tid, sid, flags := parts[0], parts[1], parts[2], parts[3]
	if len(version) != 2 || len(tid) != 32 || len(sid) != 16 || len(flags) != 2 {
		return "", ""
	}
	if !isHex(tid) || !isHex(sid) {
		return "", ""
	}
	return tid, sid
}

func isHex(s string) bool {
	if s == "" {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
