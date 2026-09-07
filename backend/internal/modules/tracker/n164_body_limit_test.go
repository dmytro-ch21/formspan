package tracker

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: decode() used to be a bare json.NewDecoder(MaxBytesReader(...))
// call with no protection against a second concatenated JSON document, and
// every write handler in this package goes through it. This is the
// per-module oversized-body assertion the ticket's acceptance criteria ask
// for — mutation-checked (see docs/decisions/history.md's N164 entry): with
// the apihttp.DecodeJSON call in decode() reverted to a bare
// json.NewDecoder(r.Body).Decode(into), this test goes red (200, not 413).
func TestDecode_RejectsOversizedBody(t *testing.T) {
	// Valid JSON — an unrecognised "padding" field is simply ignored by a
	// plain json.Decode — just longer than maxBody, so this exercises
	// http.MaxBytesReader's limit rather than a syntax error.
	body := `{"padding":"` + strings.Repeat("x", maxBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/tracker/whatever", strings.NewReader(body))
	w := httptest.NewRecorder()

	var into map[string]any
	if ok := decode(w, r, &into); ok {
		t.Fatal("decode returned ok=true for a body over maxBody")
	}
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"invalid_input"`) {
		t.Errorf("body = %q, want the invalid_input error code", w.Body.String())
	}
}

// The companion case the ticket's own "steps to test" names: two concatenated
// JSON documents must be rejected, not silently truncated to the first one.
func TestDecode_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/tracker/whatever",
		strings.NewReader(`{"a":1}{"a":2}`))
	w := httptest.NewRecorder()

	var into map[string]any
	if ok := decode(w, r, &into); ok {
		t.Fatal("decode returned ok=true for a body with two concatenated JSON documents")
	}
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
