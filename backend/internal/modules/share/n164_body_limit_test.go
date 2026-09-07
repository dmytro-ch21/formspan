package share

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: Create already wrapped r.Body in http.MaxBytesReader by hand
// (4 KiB), but the bare json.Decode call it fed still silently accepted a
// second concatenated JSON document. Mutation-checked (see
// docs/decisions/history.md's N164 entry).
func TestCreate_RejectsOversizedBody(t *testing.T) {
	body := `{"to_username":"` + strings.Repeat("x", 8192) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/share", strings.NewReader(body))
	w := httptest.NewRecorder()

	NewHandler(nil, nil).Create(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}

func TestCreate_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/share",
		strings.NewReader(`{"to_username":"a"}{"to_username":"b"}`))
	w := httptest.NewRecorder()

	NewHandler(nil, nil).Create(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
