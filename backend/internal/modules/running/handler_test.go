package running

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Validation-only tests: every case here must stop BEFORE the repository —
// a nil Repository panicking is how a request that reached it unexpectedly
// would be caught. Matches biometric/handler_test.go's stance.

func putDetailResponse(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(nil) // never reached: every case here stops at validation
	req := httptest.NewRequest(http.MethodPut, "/v1/running/sessions/s1", strings.NewReader(body))
	req.SetPathValue("sessionID", "s1")
	rec := httptest.NewRecorder()
	h.PutDetail(rec, req)
	return rec
}

func TestPutDetail_RejectsInvalidJSON(t *testing.T) {
	rec := putDetailResponse(t, `{not json`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestPutDetail_RejectsUnknownSource(t *testing.T) {
	rec := putDetailResponse(t, `{"source":"bogus"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestPutDetail_RejectsBadRoutePointTimestamp(t *testing.T) {
	body := `{"source":"phone_gps","route_points":[{"lat":1,"lng":2,"recorded_at":"not-a-date"}]}`
	rec := putDetailResponse(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

// N507/#884: `distance_m` is `*float64` on THIS module's own detail (unlike
// `session.Set.DistanceM`, which is `*int` — see session/handler_test.go's
// mirror of this test), so a fractional value here was never the bug. Proven
// by pairing it with an UNRELATED validation failure (a bad route-point
// timestamp) later in the same request: if the fractional distance_m had
// failed to decode, the handler would never reach that later check and would
// report the generic "invalid JSON body" instead of the specific timestamp
// message this asserts. Written this way, rather than a bare "not 400",
// because a request that decodes cleanly and then fails ITS OWN validation
// is also a 400 — the message is what tells the two apart, and asserting
// only the status code would pass even if `distance_m` had regressed to an
// `int` and been silently rejected at decode time.
func TestPutDetail_FractionalDistanceDecodesCleanly(t *testing.T) {
	body := `{"source":"phone_gps","distance_m":2011.4523,` +
		`"route_points":[{"lat":1,"lng":2,"recorded_at":"not-a-date"}]}`
	rec := putDetailResponse(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	var out struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Error.Message == "invalid JSON body" {
		t.Errorf("message = %q — the fractional distance_m failed to decode instead of "+
			"reaching the route_points timestamp check", out.Error.Message)
	}
	want := "route_points[].recorded_at must be RFC3339"
	if out.Error.Message != want {
		t.Errorf("message = %q, want %q", out.Error.Message, want)
	}
}

// N502/#873's exact conflation, mirrored to this handler (ticket item 3): a
// request body over maxDetailBody used to come back as the same
// "invalid JSON body" a genuinely malformed body gets. Told apart now: a
// too-large body is 413, distinguishable from 400 on the wire.
func TestPutDetail_OversizedBodyIs413NotAConfusing400(t *testing.T) {
	body := `{"source":"phone_gps","healthkit_uuid":"` + strings.Repeat("x", maxDetailBody+1) + `"}`
	rec := putDetailResponse(t, body)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	var out struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Error.Message == "invalid JSON body" {
		t.Errorf("message = %q, want a distinct oversized-body message, not the malformed-JSON one", out.Error.Message)
	}
}
