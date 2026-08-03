package apihttp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
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
		// Set explicitly so the 304's header hygiene is actually testable: a
		// ResponseRecorder never synthesises Content-Length, so asserting it
		// is absent proves nothing unless something put it there first.
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
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
	if ct := second.Header.Get("Content-Type"); ct != "" {
		t.Errorf("304 declared Content-Type %q", ct)
	}
	// And the 200 must still carry both, or this test would pass by deleting
	// them unconditionally.
	if first.Header.Get("Content-Type") == "" || first.Header.Get("Content-Length") == "" {
		t.Error("the 200 lost headers it should have kept")
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
	// apihttp.Stack, NOT a stack assembled here. The previous version of this
	// test built Compress(ConditionalGet(...)) itself, so it could only ever
	// pass: swapping the order in cmd/api/main.go left the whole suite green.
	stack := Stack(http.HandlerFunc(handler))

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

func TestHandlerSuppliedETagIsHonouredNotJustEchoed(t *testing.T) {
	// The whole point of stepping aside for a handler's own validator is that
	// the handler has a cheaper one — a `max(updated_at)` it can compute
	// without building the body. Emitting it and then ignoring If-None-Match
	// would make it decorative: the client would send it back on every request
	// and always get the full payload anyway.
	const own = `"v-2026-08-03T10:00:00Z"`
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", own)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"expensive":"body"}`)
	}

	fresh := cond(t, http.MethodGet, "", handler)
	if got := fresh.Header.Get("ETag"); got != own {
		t.Fatalf("ETag = %q, want the handler's %q", got, own)
	}
	if got := readAll(t, fresh); got == "" {
		t.Fatal("first response lost its body")
	}

	revalidated := cond(t, http.MethodGet, own, handler)
	if revalidated.StatusCode != http.StatusNotModified {
		t.Fatalf("handler's own ETag returned %d, want 304", revalidated.StatusCode)
	}
	if got := readAll(t, revalidated); got != "" {
		t.Errorf("304 carried a body: %q", got)
	}
	if ct := revalidated.Header.Get("Content-Type"); ct != "" {
		t.Errorf("304 declared Content-Type %q", ct)
	}
}

func TestHandlerETagSetAfterTheFirstWriteStillWins(t *testing.T) {
	// Under stdlib this ETag would be silently dropped (headers are frozen at
	// the first Write). Here the header write is deferred, so it is still in
	// the map — and without an explicit re-check this middleware would quietly
	// overwrite it with a body hash. compress.go carries the same fix for
	// Content-Encoding.
	const own = `"set-late"`
	handler := func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "first chunk ")
		w.Header().Set("ETag", own)
		_, _ = io.WriteString(w, "second chunk")
	}

	res := cond(t, http.MethodGet, "", handler)
	if got := res.Header.Get("ETag"); got != own {
		t.Errorf("ETag = %q, want the handler's %q", got, own)
	}
	// Nothing written before the ETag appeared may be lost.
	if got := readAll(t, res); got != "first chunk second chunk" {
		t.Errorf("body = %q", got)
	}

	revalidated := cond(t, http.MethodGet, own, handler)
	if revalidated.StatusCode != http.StatusNotModified {
		t.Errorf("late ETag revalidation returned %d, want 304", revalidated.StatusCode)
	}
	if got := readAll(t, revalidated); got != "" {
		t.Errorf("304 carried a body: %q", got)
	}
}

func TestHandlerETagOnANonOKResponseIsNever304(t *testing.T) {
	// A 304 stands in for a 200. Standing in for a 404 would tell the client
	// its cached copy is still good when the resource is gone.
	const own = `"gone"`
	res := cond(t, http.MethodGet, own, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", own)
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":{"code":"not_found"}}`)
	})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
	if got := readAll(t, res); got == "" {
		t.Error("404 lost its body")
	}
}

// The honest cost of buffering: ConditionalGet holds the whole identity body
// in memory to hash it, so peak memory per in-flight request scales with the
// response. Run with -benchmem when the payload sizes change; the figures in
// conditional.go's doc comment come from here.
func BenchmarkStackAtRealPayloadSize(b *testing.B) {
	// ~212 KB, the size of GET /v1/exercises (504 rows), measured against the
	// seeded database.
	payload := strings.Repeat(`{"id":"barbell-back-squat","sport":"strength","name":"Barbell Back Squat"},`, 2900)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, payload)
	})

	for _, tc := range []struct {
		name   string
		h      http.Handler
		accept string
	}{
		{"bare/gzip", Compress(handler), "gzip"},
		{"stack/gzip", Stack(handler), "gzip"},
		{"stack/identity", Stack(handler), ""},
	} {
		b.Run(tc.name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				req := httptest.NewRequest(http.MethodGet, "/x", nil)
				if tc.accept != "" {
					req.Header.Set("Accept-Encoding", tc.accept)
				}
				tc.h.ServeHTTP(httptest.NewRecorder(), req)
			}
		})
	}
}

// And the payoff: a revalidation that 304s never builds a response at all.
func BenchmarkStackRevalidation(b *testing.B) {
	payload := strings.Repeat(`{"id":"barbell-back-squat","sport":"strength","name":"Barbell Back Squat"},`, 2900)
	handler := Stack(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, payload)
	}))

	warm := httptest.NewRecorder()
	handler.ServeHTTP(warm, httptest.NewRequest(http.MethodGet, "/x", nil))
	etag := warm.Result().Header.Get("ETag")
	if etag == "" {
		b.Fatal("no ETag to revalidate against")
	}

	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.Header.Set("Accept-Encoding", "gzip")
		req.Header.Set("If-None-Match", etag)
		tc := httptest.NewRecorder()
		handler.ServeHTTP(tc, req)
	}
}
