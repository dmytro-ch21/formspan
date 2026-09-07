package technique

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: see exercise's TestDecodeExercise_* — decodeTechnique is the
// same pattern in this module's content handler. Mutation-checked (see
// docs/decisions/history.md's N164 entry).
func TestDecodeTechnique_RejectsOversizedBody(t *testing.T) {
	body := `{"padding":"` + strings.Repeat("x", maxContentBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/content/techniques", strings.NewReader(body))
	w := httptest.NewRecorder()

	if _, ok := decodeTechnique(w, r); ok {
		t.Fatal("decodeTechnique returned ok=true for a body over maxContentBody")
	}
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}

func TestDecodeTechnique_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/content/techniques",
		strings.NewReader(`{"id":"a"}{"id":"b"}`))
	w := httptest.NewRecorder()

	if _, ok := decodeTechnique(w, r); ok {
		t.Fatal("decodeTechnique returned ok=true for a body with two concatenated JSON documents")
	}
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
