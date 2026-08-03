package apihttp

import (
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

// Compress gzips responses that are worth gzipping.
//
// WHY: the reference-content endpoints dominate a cold app open, and they
// compress by an order of magnitude — `/v1/exercises` 211.7 KB -> 12.6 KB,
// `/v1/techniques` 164.2 KB -> 17.4 KB (measured against the seeded database;
// see conditional.go for the full table). It came out of an audit that was
// arguing about whether one field's +20 KB was affordable; compression makes
// that debate almost irrelevant, and it applies to every endpoint rather than
// one column.
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

// gzipPool avoids allocating a ~788 KB window per response (measured, not
// the ~200 KB first guessed here). Writers are Reset
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
	// passthrough means the HANDLER owns the encoding — it set its own
	// Content-Encoding, so bytes stream straight through untouched.
	//
	// NOT the small-body case: a response that simply finishes under the
	// threshold is flushed by close()'s `case c.wroteHeader`, with buf still
	// holding it. Two different paths to "uncompressed", and conflating them
	// is how the buffered bytes get lost.
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
	// Re-checked here, not just at WriteHeader. Because the real WriteHeader
	// is deferred, a handler setting Content-Encoding AFTER it still lands in
	// the header map — under stdlib that write would simply be ignored, here
	// it would steer us into gzipping an already-encoded body. Also stops
	// "identity" being read as "handler owns this".
	if enc := c.Header().Get("Content-Encoding"); enc != "" && !strings.EqualFold(enc, "identity") {
		c.passthrough = true
		c.ResponseWriter.WriteHeader(c.status)
		buffered := c.buf
		c.buf = nil
		if _, err := c.ResponseWriter.Write(buffered); err != nil {
			return 0, err
		}
		return len(p), nil
	}

	c.Header().Del("Content-Length")
	c.Header().Set("Content-Encoding", "gzip")
	c.ResponseWriter.WriteHeader(c.status)

	gz, _ := gzipPool.Get().(*gzip.Writer)
	gz.Reset(c.ResponseWriter)
	c.gz = gz

	// Flush only the prefix that was buffered BEFORE this write, then hand p
	// straight to the compressor. Appending p first meant a single large
	// WriteJSON allocated a full-size throwaway copy — measured 255 KB/op vs
	// 72 KB/op on a ~175 KB body. Same bytes, same order.
	buffered := c.buf[:len(c.buf)-len(p)]
	c.buf = nil
	if len(buffered) > 0 {
		if _, err := c.gz.Write(buffered); err != nil {
			return 0, err
		}
	}
	return c.gz.Write(p)
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
