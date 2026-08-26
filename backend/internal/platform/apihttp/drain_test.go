package apihttp_test

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
)

// refusedWithoutReading is the shape every gate in front of an upload has: the
// request is answered before its body was ever wanted. A 401 from RequireAuth,
// a 429 from the rate limiter, a 400 from a parse that gave up on byte one.
func refusedWithoutReading(seen *[]string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen = append(*seen, r.RemoteAddr)
		apihttp.WriteError(w, http.StatusUnauthorized, apihttp.CodeUnauthorized, "no")
	})
}

func postBody(t *testing.T, c *http.Client, url string, n int) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(bytes.Repeat([]byte{0xAB}, n)))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := c.Do(req)
	if err != nil {
		t.Fatalf("post %d bytes: %v", n, err)
	}
	defer res.Body.Close()
	// Drained by the caller too, or the client cannot reuse the connection
	// either and the test would measure its own omission.
	_, _ = io.Copy(io.Discard, res.Body)
	return res.StatusCode
}

// An upload refused before its body was read must not cost the connection.
//
// **Connection survival is the observable, and it is the right one** — not the
// status, which arrives either way in this test. Go's *client* tolerates a
// server that closes mid-upload: it had already finished writing a body this
// small, so it reads the response off the socket and reports 401 with the fix
// and without it. Asserting the status here would pass against a server that
// hangs up on every upload, which is the entire bug.
//
// What the phone cannot tolerate is the close itself. Measured live against
// staging (see drain.go), a body over 262144 bytes is cut off mid-flight and
// React Native surfaces a transport failure with no status on it — the
// "That didn't get through." of #433. Reuse of the same connection for a
// second request is the server-side statement that nothing was torn down, and
// it is what goes red when DrainRequestBody is removed from Stack.
func TestAnUploadRefusedBeforeItIsReadKeepsItsConnection(t *testing.T) {
	// Comfortably past net/http's 256 KiB maxPostHandlerReadBytes, which is
	// where an undrained body stops being tolerated. Below it this test cannot
	// fail: the server drains a small body by itself and the fix is invisible.
	const overTheCliff = 1 << 20

	var seen []string
	srv := httptest.NewServer(apihttp.Stack(refusedWithoutReading(&seen)))
	defer srv.Close()

	c := srv.Client()

	if got := postBody(t, c, srv.URL, overTheCliff); got != http.StatusUnauthorized {
		t.Fatalf("first request status = %d, want 401", got)
	}
	if got := postBody(t, c, srv.URL, overTheCliff); got != http.StatusUnauthorized {
		t.Fatalf("second request status = %d, want 401", got)
	}

	if len(seen) != 2 {
		t.Fatalf("handler saw %d requests, want 2", len(seen))
	}
	if seen[0] != seen[1] {
		t.Fatalf("connection was dropped after an upload was refused: "+
			"request 1 came from %s, request 2 from %s — the server hung up "+
			"mid-upload, which is what stops a phone ever reading the status",
			seen[0], seen[1])
	}
}

// The guard above only means anything if a body big enough to trigger it is
// actually what gets sent. This pins the cliff itself: under 256 KiB net/http
// drains on its own, so a test written with a small body would pass with the
// fix reverted and prove nothing.
func TestTheDrainOnlyMattersAboveNetHTTPsOwnLimit(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(apihttp.Stack(refusedWithoutReading(&seen)))
	defer srv.Close()

	c := srv.Client()
	// 64 KiB — well inside what the server tolerates unread.
	postBody(t, c, srv.URL, 64<<10)
	postBody(t, c, srv.URL, 64<<10)

	if len(seen) == 2 && seen[0] != seen[1] {
		t.Fatalf("a small unread body already cost the connection (%s then %s); "+
			"the assumption the drain test rests on no longer holds", seen[0], seen[1])
	}
}

// A GET is left alone. Nothing to drain, and reaching for the body of a
// request that has none would put a read on the hot path of every read.
func TestAGetIsNotDrained(t *testing.T) {
	var got string
	srv := httptest.NewServer(apihttp.Stack(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			got = r.Method
			apihttp.WriteJSON(w, http.StatusOK, map[string]string{"ok": "yes"})
		})))
	defer srv.Close()

	res, err := srv.Client().Get(srv.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK || got != http.MethodGet {
		t.Fatalf("status %d method %q, want 200 GET", res.StatusCode, got)
	}
}
