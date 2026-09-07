package activity

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: Create used to be a bare json.NewDecoder(r.Body).Decode(&req)
// with no size bound at all. Mutation-checked (see docs/decisions/history.md's
// N164 entry): reverting Create's decode call to that bare form makes this
// test fail (the huge body decodes into Details as valid json.RawMessage and
// the request proceeds to the repository instead of being rejected).
func TestCreate_RejectsOversizedBody(t *testing.T) {
	body := `{"padding":"` + strings.Repeat("x", maxCreateBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/activities", strings.NewReader(body))
	w := httptest.NewRecorder()

	NewHandler(nil).Create(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"invalid_input"`) {
		t.Errorf("body = %q, want the invalid_input error code", w.Body.String())
	}
}

// The ticket's other named scenario: two concatenated JSON documents must be
// refused rather than silently accepting the first and ignoring the rest.
func TestCreate_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/activities",
		strings.NewReader(`{"id":"a","kind":"k","occurred_at":"2026-01-01T00:00:00Z"}{"id":"b"}`))
	w := httptest.NewRecorder()

	NewHandler(nil).Create(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
