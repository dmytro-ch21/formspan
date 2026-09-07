package plan

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: Create and Update already wrapped r.Body in http.MaxBytesReader
// by hand, but the bare json.Decode call they fed still silently accepted a
// second concatenated JSON document. Mutation-checked (see
// docs/decisions/history.md's N164 entry).
func TestCreate_RejectsOversizedBody(t *testing.T) {
	body := `{"notes":"` + strings.Repeat("x", maxBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/plans", strings.NewReader(body))
	w := httptest.NewRecorder()

	NewHandler(nil).Create(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}

func TestCreate_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/plans",
		strings.NewReader(`{"id":"a"}{"id":"b"}`))
	w := httptest.NewRecorder()

	NewHandler(nil).Create(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
