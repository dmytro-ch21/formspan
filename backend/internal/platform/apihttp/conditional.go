package apihttp

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strings"
)

// ConditionalGet answers a repeat request with 304 when the body has not
// changed.
//
// WHY: most of what this API serves on a cold open is reference content that
// changes only on deploy — the 466-technique library, the position glossary,
// the exercise catalog, the IBJJF rulesets. Compression already took the
// technique list from ~175 KB to ~17 KB; this takes the *repeat* fetch to a
// ~150-byte header exchange, which is the larger saving for the case that
// actually recurs.
//
// WHY A BODY HASH RATHER THAN max(updated_at)
//
// The cheaper design computes a validator from the data BEFORE running the
// query, and skips the query too. It is also wrong here, for two reasons:
// it needs a per-module `LastModified` on every repository that wants it, and
// `updated_at` does not cover the parts of a response that are not rows —
// the derived volume summary, the embedded ruleset object, a filter applied
// in SQL. A hash of the bytes that are actually about to be sent cannot
// disagree with what it describes.
//
// The cost is honest: this saves BANDWIDTH, not database work. The query
// still runs. For a 175 KB payload over a phone connection that is the
// dominant cost, and it is the half that can be fixed without touching every
// module. Per-repository validators are the next step, not a replacement.
//
// SCOPE: GET and HEAD only, and only 200 responses. A conditional request is
// meaningless on a POST, and 304 on a 404 or 500 would cache a failure.
//
// ORDER: this must sit INSIDE Compress. It hashes the identity body, so the
// ETag does not change when a client switches Accept-Encoding — and a 304 it
// returns has no body for Compress to consider.
func ConditionalGet(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}

		cw := &conditionalWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(cw, r)

		// A handler that hijacked, streamed, or set its own ETag owns the
		// response; nothing was buffered and there is nothing to do.
		if cw.passthrough {
			return
		}

		if cw.status != http.StatusOK {
			cw.flush()
			return
		}

		etag := strongETag(cw.buf.Bytes())
		w.Header().Set("ETag", etag)

		if matches(r.Header.Get("If-None-Match"), etag) {
			// 304 carries no body, and RFC 9110 says it must not carry
			// Content-Length either — a length with no bytes is what makes a
			// client hang waiting for them.
			w.Header().Del("Content-Length")
			w.Header().Del("Content-Type")
			w.WriteHeader(http.StatusNotModified)
			return
		}
		cw.flush()
	})
}

// strongETag is a strong validator: it is a hash of the exact bytes, so two
// responses share one only if they are byte-identical. Weak (`W/`) would
// invite a client to reuse a body that is merely "equivalent", which is not
// a judgement anything here is in a position to make.
func strongETag(body []byte) string {
	sum := sha256.Sum256(body)
	// 128 bits is far past collision-resistance for a cache validator, and
	// keeps the header short.
	return `"` + base64.RawURLEncoding.EncodeToString(sum[:16]) + `"`
}

// matches implements If-None-Match. `*` means "any current representation",
// which for a 200 is always a match.
func matches(header, etag string) bool {
	if header == "" {
		return false
	}
	if strings.TrimSpace(header) == "*" {
		return true
	}
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		// A client may echo back a weak tag for a strong one; comparison for
		// If-None-Match is explicitly weak, so the W/ prefix is stripped
		// rather than treated as a mismatch.
		candidate = strings.TrimPrefix(candidate, "W/")
		if candidate == etag {
			return true
		}
	}
	return false
}

type conditionalWriter struct {
	http.ResponseWriter

	status      int
	wroteHeader bool
	buf         bytes.Buffer
	// passthrough means the handler took over: it set its own ETag, so
	// second-guessing it would be wrong.
	passthrough bool
}

func (c *conditionalWriter) WriteHeader(status int) {
	if c.wroteHeader {
		return
	}
	c.wroteHeader = true
	c.status = status
	if c.Header().Get("ETag") != "" {
		c.passthrough = true
		c.ResponseWriter.WriteHeader(status)
	}
	// Otherwise held: whether this becomes a 304 is not yet known.
}

func (c *conditionalWriter) Write(p []byte) (int, error) {
	if !c.wroteHeader {
		c.WriteHeader(http.StatusOK)
	}
	if c.passthrough {
		return c.ResponseWriter.Write(p)
	}
	return c.buf.Write(p)
}

// flush sends what was buffered, unchanged.
func (c *conditionalWriter) flush() {
	if c.passthrough {
		return
	}
	c.ResponseWriter.WriteHeader(c.status)
	if c.buf.Len() > 0 {
		_, _ = c.ResponseWriter.Write(c.buf.Bytes())
	}
}
