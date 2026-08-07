package theme

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Handler-layer tests for the validation that lives only here.
//
// The rune cap is the reason this file exists. `handler.go` cites the workout
// rename endpoint's documented trap — swapping `utf8.RuneCountInString` for
// `len` left that whole suite green — and the same swap goes green here too
// unless something actually sends a multibyte title. A comment citing a trap is
// not a guard against it.
//
// No claims are injected: `auth`'s context key is unexported, and forging one
// would mean widening that package for a test. Every case below is refused
// before the handler reads claims, so 400 means "validation caught it" and
// anything else means it got further than it should have.
func setResponse(t *testing.T, week, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(nil) // never called: every case stops before the repo
	req := httptest.NewRequest(http.MethodPut, "/v1/themes/"+week, strings.NewReader(body))
	req.SetPathValue("weekStart", week)
	rec := httptest.NewRecorder()
	h.Set(rec, req)
	return rec
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body is not the error contract: %q", rec.Body.String())
	}
	return out.Error.Code
}

// THE one this file exists for.
//
// 80 Japanese runes are 240 bytes. Under `len` this is refused for the wrong
// reason, and under the correct rune count it must pass validation. An
// "over the cap is refused" test alone passes against the very bug it targets,
// which is exactly how the workout endpoint's first version was wrong.
func TestCleanTitle_AcceptsEightyMultibyteRunes(t *testing.T) {
	// Against `CleanTitle` rather than the handler: a VALID title passes
	// validation and goes on to the repository, which needs claims that
	// `auth`'s unexported context key makes impossible to forge. The accepting
	// case is the only one that catches a bytes-for-runes swap, so it had to be
	// reachable.
	title := strings.Repeat("あ", MaxTitle) // 80 runes, 240 bytes
	got, ok := CleanTitle(title)
	if !ok {
		t.Fatal("80 runes was refused — the cap is counting bytes, not code points")
	}
	if got != title {
		t.Errorf("title was altered: %q", got)
	}
}

func TestCleanTitle_RefusesOneRuneTooMany(t *testing.T) {
	if _, ok := CleanTitle(strings.Repeat("あ", MaxTitle+1)); ok {
		t.Error("81 runes should be refused")
	}
}

func TestCleanTitle_TrimsBeforeMeasuring(t *testing.T) {
	// Otherwise a title padded to the cap with spaces is refused for being too
	// long while the value that would be stored fits comfortably.
	got, ok := CleanTitle("  Deload  ")
	if !ok || got != "Deload" {
		t.Errorf("got %q ok=%v", got, ok)
	}
}

func TestValidNotes_CountsRunesToo(t *testing.T) {
	if !ValidNotes(strings.Repeat("あ", MaxNotes)) {
		t.Error("500 runes of notes should fit")
	}
	if ValidNotes(strings.Repeat("a", MaxNotes+1)) {
		t.Error("501 should not")
	}
}

func TestSetHandler_RefusesEightyOneRunes(t *testing.T) {
	body, _ := json.Marshal(setRequest{Title: strings.Repeat("a", MaxTitle+1)})
	rec := setResponse(t, "2026-08-03", string(body))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	if code := errorCode(t, rec); code != "invalid_input" {
		t.Errorf("want invalid_input, got %q", code)
	}
}

// A week that does not start on a Monday would silently overlap its
// neighbours — the one duplicate the primary key cannot catch. Caught here as
// well as by the CHECK so the caller gets the sentence rather than a constraint.
func TestSetHandler_RefusesANonMonday(t *testing.T) {
	body, _ := json.Marshal(setRequest{Title: "Deload"})
	rec := setResponse(t, "2026-08-04", string(body)) // a Tuesday
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a Tuesday should be 400, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Monday") {
		t.Errorf("the message should say what is wrong: %s", rec.Body.String())
	}
}

func TestSetHandler_RefusesABlankTitle(t *testing.T) {
	for _, title := range []string{"", "   ", "\t\n"} {
		body, _ := json.Marshal(setRequest{Title: title})
		if rec := setResponse(t, "2026-08-03", string(body)); rec.Code != http.StatusBadRequest {
			t.Errorf("title %q should be 400, got %d", title, rec.Code)
		}
	}
}

func TestSetHandler_RefusesAMalformedWeek(t *testing.T) {
	for _, week := range []string{"2026-8-3", "not-a-date", "2026-13-01", ""} {
		body, _ := json.Marshal(setRequest{Title: "x"})
		if rec := setResponse(t, week, string(body)); rec.Code != http.StatusBadRequest {
			t.Errorf("week %q should be 400, got %d", week, rec.Code)
		}
	}
}

func TestSetHandler_RefusesAMalformedBody(t *testing.T) {
	if rec := setResponse(t, "2026-08-03", "{nope"); rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

// Both bounds are required, and a backwards window is a mistake rather than an
// empty result.
func TestListHandler_RequiresASaneWindow(t *testing.T) {
	for _, q := range []string{"", "?from=2026-08-03", "?to=2026-08-10",
		"?from=nope&to=2026-08-10", "?from=2026-08-10&to=2026-08-03"} {
		h := NewHandler(nil)
		req := httptest.NewRequest(http.MethodGet, "/v1/themes"+q, nil)
		rec := httptest.NewRecorder()
		h.List(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("query %q should be 400, got %d", q, rec.Code)
		}
	}
}
