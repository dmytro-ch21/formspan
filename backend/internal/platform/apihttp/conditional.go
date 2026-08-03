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
// changes only on deploy. Measured against the seeded database:
//
//	GET /v1/exercises            (504)   211.7 KB -> 12.6 KB gzip
//	GET /v1/techniques           (466)   164.2 KB -> 17.4 KB gzip
//	GET /v1/techniques/positions  (11)    16.6 KB ->  5.7 KB gzip
//	GET /v1/techniques/rulesets   (25)    15.8 KB ->  1.9 KB gzip
//
// Compression already took each of those down an order of magnitude; this
// takes the *repeat* fetch to a ~150-byte header exchange, which is the larger
// saving for the case that actually recurs. Note the catalog, not the
// technique library, is the biggest of them — worth knowing before optimising
// the wrong endpoint.
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
// The cost is honest, and it is two things.
//
// It saves BANDWIDTH, not database work — the query still runs and the JSON is
// still marshalled, because the hash is of the finished body. Over a phone
// connection the bytes are the dominant cost, and they are the half that can
// be fixed without touching every module. A handler that CAN compute a cheap
// validator should still set its own `ETag`; this middleware then steps aside
// and honours it (see adoptHandlerETag), so per-repository validators are the
// next step rather than something this forecloses.
//
// ONE CONSTRAINT ON THAT SEAM, because it is not obvious and the body-hash
// design is immune to it: a handler-supplied validator MUST be user-scoped.
// `Vary` is `Accept-Encoding, Origin` — not `Authorization` — and a browser
// cache keys on URL + Vary. A bare `max(updated_at)` over a shared table is
// the obvious first draft and would revalidate user B against user A's stored
// body. A hash of the bytes cannot do that, because the bytes differ.
//
// And it costs MEMORY: the identity body is held whole in order to hash it.
// Benchmarked at the size of the largest response above (BenchmarkStack…),
// gzip path: 461 KB/op with Compress alone, 806 KB/op with both — so roughly
// +344 KB per in-flight request. That is bounded by the largest response the
// API can produce, which is why an unbounded list endpoint is now a memory
// question and not only a latency one.
//
// SCOPE: GET and HEAD only, and only 200 responses. A conditional request is
// meaningless on a POST, and 304 on a 404 or 500 would cache a failure.
//
// NOT SUPPORTED, deliberately: http.Flusher, http.Hijacker, io.ReaderFrom.
// This middleware buffers in order to hash, so a mid-response Flush cannot
// mean what a caller would expect — and exposing one via Unwrap would let a
// handler push bytes past the buffer and emit the body twice. Compress makes
// the same choice for the same reason, so the two agree. The consequence to
// know: SSE or any streaming endpoint cannot live behind this stack, and
// would need to be routed around it rather than "fixed" here.
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

		cw := &conditionalWriter{
			ResponseWriter: w,
			status:         http.StatusOK,
			ifNoneMatch:    ifNoneMatch(r),
		}
		next.ServeHTTP(cw, r)

		// The handler supplied its own validator and it was honoured inside
		// WriteHeader — either 304'd there or streamed through. Nothing was
		// buffered, so there is nothing left to decide.
		if cw.passthrough {
			return
		}

		if cw.status != http.StatusOK {
			cw.flush()
			return
		}

		// `no-store` is a handler saying this response must not be held
		// anywhere, so a validator for reusing it is a contradiction. It is
		// also the opt-out: /v1/healthz uses it because a constant body would
		// otherwise get a validator that never changes, and a liveness probe
		// sending If-None-Match would be answered 304 for the life of the
		// deployment.
		if hasNoStore(cw.Header().Get("Cache-Control")) {
			cw.flush()
			return
		}

		// The third ordering: an ETag set after the handler's LAST Write never
		// reaches adoptHandlerETag, because nothing writes after it. Since
		// this middleware has not set one at this point, any tag present is
		// unambiguously the handler's — hashing over it would silently
		// replace a cheap validator with an expensive one.
		etag := cw.Header().Get("ETag")
		if etag == "" {
			etag = strongETag(cw.buf.Bytes())
			w.Header().Set("ETag", etag)
		}

		// An ETag makes a response *revalidatable*, which is an invitation to
		// intermediaries that did not exist before this middleware. Almost
		// everything here is per-user data on an authenticated route.
		//
		// RFC 9111 §3.5 already forbids a shared cache from storing a response
		// to a request carrying `Authorization`, so this is defence in depth
		// rather than a hole being closed — but "every proxy between here and
		// the athlete honours §3.5" is not a thing to rely on silently, and
		// this project's stated default is privacy by default. `no-cache` is
		// not "do not cache": it is "cache, but revalidate before reuse",
		// which is exactly the contract an ETag describes.
		//
		// Left alone if a handler set its own — a public reference endpoint
		// that wants a max-age should be able to say so.
		setDefaultCacheControl(w.Header())

		if matches(cw.ifNoneMatch, etag) {
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

func hasNoStore(cacheControl string) bool {
	for _, d := range strings.Split(cacheControl, ",") {
		if strings.EqualFold(strings.TrimSpace(d), "no-store") {
			return true
		}
	}
	return false
}

func setDefaultCacheControl(h http.Header) {
	if h.Get("Cache-Control") == "" {
		h.Set("Cache-Control", "private, no-cache")
	}
}

// ifNoneMatch joins repeated field lines. Header.Get returns only the first,
// and RFC 9110 §5.3 makes repeated lines equivalent to one comma-joined line —
// browsers send one, but proxies are entitled to split. Getting this wrong
// fails safe (a missed 304, never a wrong one), which is also why it would
// never be noticed.
func ifNoneMatch(r *http.Request) string {
	return strings.Join(r.Header.Values("If-None-Match"), ",")
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
//
// Comparison is the WEAK one (RFC 9110 §13.1.2 — If-None-Match uses weak
// comparison), which means the `W/` prefix is stripped from BOTH sides. It
// used to be stripped from the client's candidate only, so a handler that
// supplied a weak validator never revalidated: the client echoed it back
// verbatim, the strings differed by four characters, and it got a 200 every
// time. That broke the seam this middleware exists to leave open —
// `max(updated_at)` is precisely a validator that must be weak, since it
// cannot promise byte-identity (two writes inside one second, derived fields
// that move without it). It failed in the exact way the doc comment says the
// design avoids: a validator that looks like it works.
func matches(header, etag string) bool {
	if header == "" {
		return false
	}
	etag = strings.TrimPrefix(etag, "W/")
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		// `*` means "any current representation", which for a 200 always
		// matches. RFC 9110 has it sent alone; accepting it as a list member
		// costs one comparison and removes a surprise.
		if candidate == "*" {
			return true
		}
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
	// ifNoneMatch is carried so a handler-supplied ETag can be honoured at
	// WriteHeader time, before the write-through commits.
	ifNoneMatch string
	// passthrough means the handler supplied its own ETag, so this middleware
	// steps aside rather than replacing a cheap validator with an expensive
	// one.
	passthrough bool
}

func (c *conditionalWriter) WriteHeader(status int) {
	if c.wroteHeader {
		return
	}
	c.wroteHeader = true
	c.status = status
	if etag := c.Header().Get("ETag"); etag != "" {
		c.adoptHandlerETag(etag)
	}
	// Otherwise held: whether this becomes a 304 is not yet known.
}

func (c *conditionalWriter) Write(p []byte) (int, error) {
	if !c.wroteHeader {
		c.WriteHeader(http.StatusOK)
	}
	// Re-checked here, not only at WriteHeader. Because the real header write
	// is deferred, a handler that sets ETag AFTER its first Write still lands
	// in the header map in time to be honoured — stdlib would silently drop
	// it, and this middleware would silently overwrite it with a hash of the
	// body. Same class of bug compress.go carries a fix for on
	// Content-Encoding.
	if !c.passthrough {
		if etag := c.Header().Get("ETag"); etag != "" {
			c.adoptHandlerETag(etag)
		}
	}
	if !c.passthrough {
		return c.buf.Write(p)
	}
	// A 304 has no body; swallow whatever the handler still writes rather than
	// appending it to a bodiless response.
	if c.status == http.StatusNotModified {
		return len(p), nil
	}
	return c.ResponseWriter.Write(p)
}

// adoptHandlerETag steps aside for a handler that supplied its own validator —
// but HONOURS it rather than merely echoing it. Emitting a validator and then
// ignoring If-None-Match would make it decorative, and a per-repository
// `max(updated_at)` validator is exactly the thing that would land here and
// silently do nothing.
//
// This is the point of no return: it commits the status line, so everything
// after it streams straight through.
func (c *conditionalWriter) adoptHandlerETag(etag string) {
	c.passthrough = true
	// The no-store opt-out has to be honoured HERE too, not only in the
	// post-handler block — that block is unreachable once passthrough is set,
	// so a handler setting both `no-store` and its own ETag would have got a
	// 304 or not depending purely on WHERE it stamped the tag. Three orderings
	// that disagree is worse than any one of the three answers.
	if hasNoStore(c.Header().Get("Cache-Control")) {
		c.ResponseWriter.WriteHeader(c.status)
		if c.buf.Len() > 0 {
			_, _ = c.ResponseWriter.Write(c.buf.Bytes())
			c.buf.Reset()
		}
		return
	}
	// Same default as the hashed path, and it matters MORE here: this is the
	// branch a per-repository validator over user-scoped data will take, and
	// adoptHandlerETag commits the status line, so nothing downstream can add
	// it afterwards.
	setDefaultCacheControl(c.Header())
	if c.status == http.StatusOK && matches(c.ifNoneMatch, etag) {
		c.status = http.StatusNotModified
		// 304 carries no body, and must not claim a length for bytes that
		// will never arrive.
		c.Header().Del("Content-Length")
		c.Header().Del("Content-Type")
		c.ResponseWriter.WriteHeader(http.StatusNotModified)
		c.buf.Reset() // anything already written is discarded
		return
	}
	c.ResponseWriter.WriteHeader(c.status)
	if c.buf.Len() > 0 {
		_, _ = c.ResponseWriter.Write(c.buf.Bytes())
		c.buf.Reset()
	}
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

// Stack composes the response middlewares in the one order that works, so
// there is a single place to get it right and a single place to test it.
//
// ConditionalGet must be INSIDE Compress. Outside, it would hash the gzipped
// body, the ETag would change with Accept-Encoding, and every gzip-capable
// client — which is all of them — would be a permanent cache miss.
//
// This exists because the test asserting that property built its own stack
// and therefore could only ever pass: swapping the order in main.go left the
// whole suite green. Assembly belongs somewhere a test can reach.
func Stack(next http.Handler) http.Handler {
	return Compress(ConditionalGet(next))
}
