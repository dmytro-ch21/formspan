package apihttp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func cond(t *testing.T, method, ifNoneMatch string, h http.HandlerFunc) *http.Response {
	t.Helper()
	req := httptest.NewRequest(method, "/x", nil)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	rec := httptest.NewRecorder()
	ConditionalGet(h).ServeHTTP(rec, req)
	return rec.Result()
}

func readAll(t *testing.T, res *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(b)
}

func TestRepeatRequestGets304WithNoBody(t *testing.T) {
	const payload = `{"techniques":[{"id":"armbar"}]}`
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, payload)
	}

	first := cond(t, http.MethodGet, "", handler)
	etag := first.Header.Get("ETag")
	if etag == "" {
		t.Fatal("no ETag on the first response")
	}
	if got := readAll(t, first); got != payload {
		t.Fatalf("first response body = %q", got)
	}

	second := cond(t, http.MethodGet, etag, handler)
	if second.StatusCode != http.StatusNotModified {
		t.Fatalf("repeat request = %d, want 304", second.StatusCode)
	}
	// The entire point: no bytes.
	if got := readAll(t, second); got != "" {
		t.Errorf("304 carried a body: %q", got)
	}
	// A Content-Length with no bytes behind it makes a client hang waiting.
	if cl := second.Header.Get("Content-Length"); cl != "" && cl != "0" {
		t.Errorf("304 declared Content-Length %q", cl)
	}
}

func TestChangedBodyGetsAFreshResponse(t *testing.T) {
	first := cond(t, http.MethodGet, "", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "version one")
	})
	etag := first.Header.Get("ETag")

	// Same client, same ETag, different content — must NOT be a 304.
	second := cond(t, http.MethodGet, etag, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "version two")
	})
	if second.StatusCode != http.StatusOK {
		t.Fatalf("changed body returned %d, want 200", second.StatusCode)
	}
	if got := readAll(t, second); got != "version two" {
		t.Errorf("body = %q", got)
	}
	if second.Header.Get("ETag") == etag {
		t.Error("ETag did not change with the body")
	}
}

func TestOnlyGetAndHeadAreConditional(t *testing.T) {
	// A conditional POST is meaningless, and a 304 on one would be a silent
	// data-loss bug: the client believes its write was a no-op.
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		res := cond(t, method, "*", func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, "written")
		})
		if res.StatusCode != http.StatusOK {
			t.Errorf("%s returned %d, want 200", method, res.StatusCode)
		}
		if got := readAll(t, res); got != "written" {
			t.Errorf("%s body = %q", method, got)
		}
	}
}

func TestNonOKResponsesAreNeverConditional(t *testing.T) {
	// 304 on an error would cache the failure: the client would treat its
	// stale copy as still valid because the server said nothing changed.
	for _, status := range []int{http.StatusNotFound, http.StatusUnauthorized, http.StatusInternalServerError} {
		res := cond(t, http.MethodGet, "*", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"error":{"code":"nope"}}`)
		})
		if res.StatusCode != status {
			t.Errorf("status %d became %d", status, res.StatusCode)
		}
		if res.Header.Get("ETag") != "" {
			t.Errorf("status %d got an ETag", status)
		}
		if got := readAll(t, res); got == "" {
			t.Errorf("status %d lost its body", status)
		}
	}
}

func TestStarMatchesAnyCurrentRepresentation(t *testing.T) {
	res := cond(t, http.MethodGet, "*", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "anything")
	})
	if res.StatusCode != http.StatusNotModified {
		t.Errorf(`If-None-Match: * returned %d, want 304`, res.StatusCode)
	}
}

func TestAcceptsAListAndAWeakPrefix(t *testing.T) {
	first := cond(t, http.MethodGet, "", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "the body")
	})
	etag := first.Header.Get("ETag")

	for _, header := range []string{
		`"other", ` + etag, // a list, ours last
		etag + `, "other"`, // a list, ours first
		"W/" + etag,        // client echoed it weakened
		`  ` + etag + `  `, // whitespace
	} {
		res := cond(t, http.MethodGet, header, func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, "the body")
		})
		if res.StatusCode != http.StatusNotModified {
			t.Errorf("If-None-Match: %s returned %d, want 304", header, res.StatusCode)
		}
	}
}

func TestAMismatchedTagIsNotA304(t *testing.T) {
	res := cond(t, http.MethodGet, `"something-else"`, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "current")
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("returned %d, want 200", res.StatusCode)
	}
	if got := readAll(t, res); got != "current" {
		t.Errorf("body = %q", got)
	}
}

func TestLeavesAHandlerSuppliedETagAlone(t *testing.T) {
	// A handler that set its own validator knows something this middleware
	// does not; overwriting it would silently replace a cheap validator with
	// an expensive one.
	const own = `"handler-owns-this"`
	res := cond(t, http.MethodGet, "", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", own)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "body")
	})
	if got := res.Header.Get("ETag"); got != own {
		t.Errorf("ETag = %q, want the handler's %q", got, own)
	}
	if got := readAll(t, res); got != "body" {
		t.Errorf("body = %q", got)
	}
}

func TestTheEtagIsStableAcrossIdenticalResponses(t *testing.T) {
	// Otherwise every request is a cache miss and the feature does nothing.
	h := func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("stable ", 500))
	}
	a := cond(t, http.MethodGet, "", h).Header.Get("ETag")
	b := cond(t, http.MethodGet, "", h).Header.Get("ETag")
	if a == "" || a != b {
		t.Errorf("ETag not stable: %q vs %q", a, b)
	}
}

func TestEmptyResponseStillGetsAnETag(t *testing.T) {
	// An empty list is a real answer and should be cacheable like any other.
	res := cond(t, http.MethodGet, "", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	if res.Header.Get("ETag") == "" {
		t.Error("no ETag on an empty 200")
	}
	if res.StatusCode != http.StatusOK {
		t.Errorf("status = %d", res.StatusCode)
	}
}

// The two middlewares have to compose, and the order is load-bearing.
//
// ConditionalGet sits INSIDE Compress, so it hashes the identity body: the
// ETag must not change when a client switches Accept-Encoding, or every
// gzip-capable client is a permanent cache miss. And the 304 it returns must
// come back out through Compress without gaining gzip framing.
func TestComposesWithCompression(t *testing.T) {
	payload := strings.Repeat(`{"technique":"armbar"},`, 3000) // well over the gzip threshold
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, payload)
	}
	stack := Compress(ConditionalGet(http.HandlerFunc(handler)))

	do := func(acceptEncoding, ifNoneMatch string) *http.Response {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		if acceptEncoding != "" {
			req.Header.Set("Accept-Encoding", acceptEncoding)
		}
		if ifNoneMatch != "" {
			req.Header.Set("If-None-Match", ifNoneMatch)
		}
		rec := httptest.NewRecorder()
		stack.ServeHTTP(rec, req)
		return rec.Result()
	}

	plain := do("", "")
	gzipped := do("gzip", "")
	if gzipped.Header.Get("Content-Encoding") != "gzip" {
		t.Fatal("expected the large body to be gzipped")
	}
	// The whole reason ConditionalGet is the inner middleware.
	if plain.Header.Get("ETag") != gzipped.Header.Get("ETag") {
		t.Errorf("ETag changed with Accept-Encoding: %q vs %q",
			plain.Header.Get("ETag"), gzipped.Header.Get("ETag"))
	}

	// A 304 through the compressor: no body, and no gzip framing on nothing.
	revalidated := do("gzip", gzipped.Header.Get("ETag"))
	if revalidated.StatusCode != http.StatusNotModified {
		t.Fatalf("revalidation returned %d, want 304", revalidated.StatusCode)
	}
	if enc := revalidated.Header.Get("Content-Encoding"); enc != "" {
		t.Errorf("304 got Content-Encoding %q", enc)
	}
	if got := readAll(t, revalidated); got != "" {
		t.Errorf("304 carried %d bytes", len(got))
	}
}
