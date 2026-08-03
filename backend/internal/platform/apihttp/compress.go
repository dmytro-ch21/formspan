package apihttp

import (
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

// Compress gzips responses that are worth gzipping.
//
// WHY: the technique library's list endpoint is ~175 KB of JSON and **17 KB
// gzipped** — a 10x saving on the single largest thing this API serves, paid
// on every cold app open. It came out of an audit that was arguing about
// whether one field's +20 KB was affordable; compression makes that debate
// almost irrelevant, and it applies to every endpoint rather than one column.
//
// # WHY A SIZE THRESHOLD, AND WHY IT IS DEFERRED
//
// Most responses here are tiny — `{"error":{"code":"not_found",...}}` is
// ~60 bytes, and gzip's header alone is 18. Compressing those makes them
// BIGGER, costs CPU, and defeats any conditional-request handling later.
//
// The size cannot be known up front: handlers stream through WriteJSON and
// almost never set Content-Length. So the decision is deferred — the first
// writes are buffered, and gzip only starts once the response is provably
// past the threshold. A response that finishes under it is written through
// verbatim, with no Content-Encoding and no gzip framing. That is the whole
// reason this is not four lines.
//
// NOT COMPRESSED: a response that already set Content-Encoding (nothing does
// today, but double-encoding is silent and unrecoverable), and any client
// that did not ask for gzip. Both are checked before anything is buffered.
const compressMinBytes = 1024

// gzipPool avoids allocating a ~200 KB window per response. Writers are Reset
// onto each new target, which is what makes reuse safe.
var gzipPool = sync.Pool{
	New: func() any { return gzip.NewWriter(nil) },
}

func Compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Vary regardless of what this request does, because a cache keying
		// on the URL alone would otherwise serve a gzipped body to a client
		// that cannot read it. ADD, not Set: withCORS also varies on Origin,
		// and Vary is a list — Set would silently drop whichever ran first.
		w.Header().Add("Vary", "Accept-Encoding")

		if !acceptsGzip(r.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(w, r)
			return
		}

		cw := &compressWriter{ResponseWriter: w}
		defer cw.close()
		next.ServeHTTP(cw, r)
	})
}

// acceptsGzip is deliberately not a substring check: "notgzip" contains
// "gzip", and `gzip;q=0` means the client explicitly refuses it.
func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			continue
		}
		for _, p := range fields[1:] {
			if strings.EqualFold(strings.TrimSpace(p), "q=0") {
				return false
			}
		}
		return true
	}
	return false
}

type compressWriter struct {
	http.ResponseWriter

	status      int
	wroteHeader bool
	// buf holds the response until it is clear whether it beats the
	// threshold. Nil once the decision is made either way.
	buf []byte
	gz  *gzip.Writer
	// passthrough means "decided: send this uncompressed", either because the
	// handler set its own Content-Encoding or because the body is small.
	passthrough bool
}

func (c *compressWriter) WriteHeader(status int) {
	if c.wroteHeader {
		return
	}
	c.status = status
	c.wroteHeader = true
	// A handler that encoded its own body owns the encoding; wrapping it
	// again produces a body no client can read and nothing reports it.
	if c.Header().Get("Content-Encoding") != "" {
		c.passthrough = true
		c.ResponseWriter.WriteHeader(status)
	}
	// Otherwise the header is held back: Content-Encoding and the fate of
	// Content-Length both depend on a decision not yet made.
}

func (c *compressWriter) Write(p []byte) (int, error) {
	if !c.wroteHeader {
		c.WriteHeader(http.StatusOK)
	}
	if c.passthrough {
		return c.ResponseWriter.Write(p)
	}
	if c.gz != nil {
		return c.gz.Write(p)
	}

	c.buf = append(c.buf, p...)
	if len(c.buf) < compressMinBytes {
		// Still undecided. Report the full length: as far as the handler is
		// concerned the bytes are written, and they are — just not yet flushed.
		return len(p), nil
	}

	// Past the threshold: commit to gzip and flush what was buffered.
	//
	// Content-Length must go. It describes the uncompressed body, and leaving
	// it produces a response whose declared length disagrees with its bytes —
	// which clients handle by truncating or hanging, not by erroring.
	c.Header().Del("Content-Length")
	c.Header().Set("Content-Encoding", "gzip")
	c.ResponseWriter.WriteHeader(c.status)

	gz, _ := gzipPool.Get().(*gzip.Writer)
	gz.Reset(c.ResponseWriter)
	c.gz = gz

	buffered := c.buf
	c.buf = nil
	if _, err := c.gz.Write(buffered); err != nil {
		return 0, err
	}
	return len(p), nil
}

// close settles whichever state the response ended in. Always runs, including
// when a handler writes no body at all (204, or a bare WriteHeader).
func (c *compressWriter) close() {
	switch {
	case c.gz != nil:
		_ = c.gz.Close()
		c.gz.Reset(nil) // drop the reference before pooling
		gzipPool.Put(c.gz)
		c.gz = nil
	case c.passthrough:
		// Already streamed through untouched.
	case c.wroteHeader:
		// Finished under the threshold: send it plain, exactly as written.
		c.ResponseWriter.WriteHeader(c.status)
		if len(c.buf) > 0 {
			_, _ = c.ResponseWriter.Write(c.buf)
		}
		c.buf = nil
	}
}
