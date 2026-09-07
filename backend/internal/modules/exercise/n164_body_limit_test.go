package exercise

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: decodeExercise already wrapped r.Body in http.MaxBytesReader,
// but a bare json.Decode call still silently accepted a second concatenated
// JSON document — the ticket's own "steps to test" scenario. Mutation-checked
// (see docs/decisions/history.md's N164 entry): reverting this call to
// json.NewDecoder(http.MaxBytesReader(...)).Decode(&body) makes
// TestDecodeExercise_RejectsTrailingJSONDocument fail (nil error, ok=true).
func TestDecodeExercise_RejectsOversizedBody(t *testing.T) {
	body := `{"padding":"` + strings.Repeat("x", maxContentBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/content/exercises", strings.NewReader(body))
	w := httptest.NewRecorder()

	if _, ok := decodeExercise(w, r); ok {
		t.Fatal("decodeExercise returned ok=true for a body over maxContentBody")
	}
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}

func TestDecodeExercise_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/content/exercises",
		strings.NewReader(`{"id":"a"}{"id":"b"}`))
	w := httptest.NewRecorder()

	if _, ok := decodeExercise(w, r); ok {
		t.Fatal("decodeExercise returned ok=true for a body with two concatenated JSON documents")
	}
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
