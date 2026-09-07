package curriculum

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: decode() used to wrap r.Body in io.LimitReader(r.Body, MaxBody),
// which silently truncates rather than signalling "too large" — a body over
// MaxBody surfaced as a plain "invalid JSON body" 400, identical to a
// genuinely malformed one. Mutation-checked (see docs/decisions/history.md's
// N164 entry): reverting decode() to the io.LimitReader form makes this test
// fail (400/invalid JSON body instead of 413).
func TestDecode_RejectsOversizedBody(t *testing.T) {
	body := `{"padding":"` + strings.Repeat("x", MaxBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/curricula", strings.NewReader(body))
	w := httptest.NewRecorder()

	var into map[string]any
	if ok := decode(w, r, &into); ok {
		t.Fatal("decode returned ok=true for a body over MaxBody")
	}
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}

func TestDecode_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/curricula", strings.NewReader(`{"a":1}{"a":2}`))
	w := httptest.NewRecorder()

	var into map[string]any
	if ok := decode(w, r, &into); ok {
		t.Fatal("decode returned ok=true for a body with two concatenated JSON documents")
	}
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
