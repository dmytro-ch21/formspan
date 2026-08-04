package apihttp

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A compression middleware is mostly edge cases: the happy path is four
// lines, and every real bug lives in what it does to small bodies, absent
// bodies, already-encoded bodies, and Content-Length.

func serve(t *testing.T, acceptEncoding string, h http.HandlerFunc) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	rec := httptest.NewRecorder()
	Compress(h).ServeHTTP(rec, req)
	return rec.Result()
}

func body(t *testing.T, res *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if res.Header.Get("Content-Encoding") != "gzip" {
		return string(b)
	}
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("gunzip: %v (body claims gzip but is not)", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip read: %v", err)
	}
	return string(out)
}

func TestCompressesALargeBodyAndItRoundTrips(t *testing.T) {
	want := strings.Repeat("technique library payload ", 4000) // ~100 KB
	res := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, want)
	})

	if got := res.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if body(t, res) != want {
		t.Error("round trip lost or corrupted the body")
	}
	// The point of the exercise: it has to be meaningfully smaller.
	raw := res.ContentLength
	if raw > 0 && int(raw) > len(want)/4 {
		t.Errorf("compressed to %d bytes from %d — barely a saving", raw, len(want))
	}
}

func TestLeavesASmallBodyAlone(t *testing.T) {
	// Gzip's header alone is 18 bytes; a 60-byte error response gets BIGGER.
	const want = `{"error":{"code":"not_found","message":"session not found"}}`
	res := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, want)
	})

	if enc := res.Header.Get("Content-Encoding"); enc != "" {
		t.Errorf("Content-Encoding = %q on a %d-byte body, want none", enc, len(want))
	}
	if got := body(t, res); got != want {
		t.Errorf("small body was altered: %q", got)
	}
}

func TestLeavesTheBodyAloneWhenTheClientDidNotAskForGzip(t *testing.T) {
	want := strings.Repeat("x", 50_000)
	for _, ae := range []string{"", "deflate, br", "notgzip", "gzip;q=0"} {
		t.Run("accept-encoding="+ae, func(t *testing.T) {
			res := serve(t, ae, func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, want)
			})
			if enc := res.Header.Get("Content-Encoding"); enc != "" {
				t.Errorf("Content-Encoding = %q, want none", enc)
			}
			if body(t, res) != want {
				t.Error("body altered")
			}
		})
	}
}

func TestDoesNotDoubleEncode(t *testing.T) {
	// A handler that encoded its own body owns the encoding. Wrapping it
	// again produces something no client can read, and nothing reports it.
	//
	// The payload MUST be incompressible. The first version of this test used
	// repeated text, which gzipped to 289 bytes — under the threshold — so the
	// small-body path handled it and the guard was never reached. Deleting the
	// guard left the whole suite green. Random bytes keep the pre-encoded body
	// over 1 KB so the passthrough branch is the one under test.
	payload := make([]byte, 8192)
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("rand: %v", err)
	}

	res := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		w.WriteHeader(http.StatusOK)
		zw := gzip.NewWriter(w)
		_, _ = zw.Write(payload)
		_ = zw.Close()
	})

	// Exactly one layer: one gunzip returns the original bytes.
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(raw) <= compressMinBytes {
		t.Fatalf("pre-encoded body is %d bytes — under the threshold, so this "+
			"test would pass without the guard", len(raw))
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip read: %v — body was encoded twice", err)
	}
	if !bytes.Equal(got, payload) {
		t.Error("one gunzip did not recover the original — encoded twice")
	}
}

func TestDropsContentLengthWhenItCompresses(t *testing.T) {
	// The header describes the UNCOMPRESSED body. Left in place, the declared
	// length disagrees with the bytes — clients truncate or hang rather than
	// erroring, which is the worst failure mode available.
	want := strings.Repeat("y", 40_000)
	res := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "40000")
		_, _ = io.WriteString(w, want)
	})

	if res.Header.Get("Content-Encoding") != "gzip" {
		t.Fatal("expected gzip")
	}
	if cl := res.Header.Get("Content-Length"); cl == "40000" {
		t.Error("Content-Length still describes the uncompressed body")
	}
	if body(t, res) != want {
		t.Error("round trip failed")
	}
}

func TestPreservesTheStatusCode(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusNotFound, http.StatusInternalServerError} {
		res := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, strings.Repeat("z", 5000))
		})
		if res.StatusCode != status {
			t.Errorf("status %d became %d", status, res.StatusCode)
		}
	}
}

func TestHandlesAResponseWithNoBody(t *testing.T) {
	// 204 and bare WriteHeader must not hang, panic, or gain gzip framing —
	// the deferred close() has to cope with a decision that was never made.
	res := serve(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	if res.StatusCode != http.StatusNoContent {
		t.Errorf("status = %d", res.StatusCode)
	}
	if enc := res.Header.Get("Content-Encoding"); enc != "" {
		t.Errorf("empty response got Content-Encoding %q", enc)
	}
	if got := body(t, res); got != "" {
		t.Errorf("empty response has body %q", got)
	}
}

func TestAlwaysVariesOnAcceptEncoding(t *testing.T) {
	// Even when it does not compress. A cache keying on the URL alone would
	// otherwise hand a gzipped body to a client that cannot read it.
	for _, ae := range []string{"gzip", "", "identity"} {
		res := serve(t, ae, func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, "small")
		})
		if !strings.Contains(res.Header.Get("Vary"), "Accept-Encoding") {
			t.Errorf("Accept-Encoding=%q: Vary = %q", ae, res.Header.Get("Vary"))
		}
	}
}
