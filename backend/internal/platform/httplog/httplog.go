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
	return slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "api")
}

type ctxKey string

const (
	loggerCtxKey    ctxKey = "httplog.logger"
	requestIDCtxKey ctxKey = "httplog.request_id"
	traceIDCtxKey   ctxKey = "httplog.trace_id"
)

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
func Middleware(base *slog.Logger) func(http.Handler) http.Handler {
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
			ctx := context.WithValue(r.Context(), loggerCtxKey, logger)
			ctx = context.WithValue(ctx, requestIDCtxKey, requestID)
			ctx = context.WithValue(ctx, traceIDCtxKey, traceID)

			w.Header().Set("X-Request-ID", requestID)
			w.Header().Set("traceparent", fmt.Sprintf("00-%s-%s-01", traceID, spanID))

			rw := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			start := time.Now()
			next.ServeHTTP(rw, r.WithContext(ctx))

			logger.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rw.status,
				"duration_ms", time.Since(start).Milliseconds(),
			)
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
