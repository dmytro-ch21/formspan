package nutrition

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The day-window rail, pinned at its exact boundary.
//
// `window` is pure — a request in, a 400 or a pair of dates out — so this needs
// no database and runs on every CI pass rather than only where
// TEST_DATABASE_URL is set.
//
// **Why the boundary specifically.** The rail is `daysBetween(from, to) >=
// maxDayWindowDays` with the constant at 366, so the largest DIFFERENCE
// actually served is 365 — one less than the constant's name suggests, because
// 366 is the inclusive calendar-day count. A client that wants the widest
// possible history therefore sits exactly on the limit with no slack, and
// `apps/mobile/lib/targetHistory.ts` now does: its window is 335 days back plus
// 30 forward, which is 365 to the day.
//
// One day wider is an `invalid_input`, which that screen can only render as
// "we could not read your history" — so the whole target record would go
// missing for every athlete, permanently, while every fixture test of the list
// logic stayed green. Tightening this `>=` to `>`, or renaming the constant to
// match its own label, moves a limit somebody is standing on.
//
// So both sides are asserted. A test on only the accepted side passes against a
// rail that has been loosened; a test on only the refused side passes against
// one that has been tightened.
func TestDayWindowServesExactlyMaxDayWindowDaysMinusOne(t *testing.T) {
	const widest = maxDayWindowDays - 1 // 365, the largest difference served

	for _, tc := range []struct {
		name string
		span int
		ok   bool
	}{
		{"a single day", 0, true},
		{"a fortnight", 14, true},
		{"one day inside the limit", widest - 1, true},
		{"exactly the limit", widest, true},
		{"one day past the limit", widest + 1, false},
		{"far past the limit", widest + 400, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			from := time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC)
			to := from.AddDate(0, 0, tc.span)

			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodGet, "/v1/nutrition/targets?from="+
				from.Format("2006-01-02")+"&to="+to.Format("2006-01-02"), nil)

			gotFrom, gotTo, ok := window(w, r, maxDayWindowDays)
			if ok != tc.ok {
				t.Fatalf("span of %d days: accepted = %v, want %v (status %d)", tc.span, ok, tc.ok, w.Code)
			}
			if !tc.ok {
				if w.Code != http.StatusBadRequest {
					t.Fatalf("span of %d days: status = %d, want 400", tc.span, w.Code)
				}
				// The CODE is the contract; the message is not. A refusal that
				// arrived as `internal` would be a 500 to every client that
				// pattern-matches on the code, and the whole point of
				// validating the span here rather than in Postgres is to keep
				// bad input out of that arm.
				if code := errorCode(t, w); code != "invalid_input" {
					t.Fatalf("span of %d days: error code = %q, want invalid_input", tc.span, code)
				}
				return
			}
			if gotFrom != from.Format("2006-01-02") || gotTo != to.Format("2006-01-02") {
				t.Fatalf("span of %d days: got (%q, %q), want (%q, %q)",
					tc.span, gotFrom, gotTo, from.Format("2006-01-02"), to.Format("2006-01-02"))
			}
		})
	}
}

// The two rejections that are NOT about length, so a mutation to the span rail
// cannot be mistaken for these still passing.
func TestDayWindowRefusesMalformedAndInvertedRanges(t *testing.T) {
	for _, tc := range []struct{ name, from, to string }{
		{"a missing from", "", "2026-08-21"},
		{"a missing to", "2026-08-21", ""},
		{"a timestamp rather than a date", "2026-08-21T00:00:00Z", "2026-08-22"},
		{"a month that does not exist", "2026-13-01", "2026-13-02"},
		{"to before from", "2026-08-21", "2026-08-20"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodGet, "/v1/nutrition/targets?from="+tc.from+"&to="+tc.to, nil)
			if _, _, ok := window(w, r, maxDayWindowDays); ok {
				t.Fatal("accepted a range it should have refused")
			}
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", w.Code)
			}
			if code := errorCode(t, w); code != "invalid_input" {
				t.Fatalf("error code = %q, want invalid_input", code)
			}
		})
	}
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response body is not the documented error shape: %v (%q)", err, w.Body.String())
	}
	return body.Error.Code
}
