package friend

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: Send already wrapped r.Body in http.MaxBytesReader by hand, but
// the bare json.Decode call it fed still silently accepted a second
// concatenated JSON document. Mutation-checked (see
// docs/decisions/history.md's N164 entry): reverting Send's decode call to
// plain json.NewDecoder(r.Body).Decode(&req) (after re-adding the manual
// MaxBytesReader wrap it replaced) makes TestSend_RejectsTrailingJSONDocument
// fail, and dropping the size bound entirely makes
// TestSend_RejectsOversizedBody fail.
func TestSend_RejectsOversizedBody(t *testing.T) {
	body := `{"username":"` + strings.Repeat("x", 2048) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/friends", strings.NewReader(body))
	w := httptest.NewRecorder()

	NewHandler(nil, nil).Send(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}

func TestSend_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/friends",
		strings.NewReader(`{"username":"a"}{"username":"b"}`))
	w := httptest.NewRecorder()

	NewHandler(nil, nil).Send(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
