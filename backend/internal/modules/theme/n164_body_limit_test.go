package theme

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: Set already wrapped r.Body in http.MaxBytesReader by hand, but
// the bare json.Decode call it fed still silently accepted a second
// concatenated JSON document. Mutation-checked (see
// docs/decisions/history.md's N164 entry).
//
// "2026-08-31" is a real Monday — Set checks IsMonday before it ever reaches
// the decode this test exercises.
func TestSet_RejectsOversizedBody(t *testing.T) {
	body := `{"title":"` + strings.Repeat("x", 8200) + `"}`
	r := httptest.NewRequest(http.MethodPut, "/v1/theme/weeks/2026-08-31", strings.NewReader(body))
	r.SetPathValue("weekStart", "2026-08-31")
	w := httptest.NewRecorder()

	NewHandler(nil).Set(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}

func TestSet_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPut, "/v1/theme/weeks/2026-08-31",
		strings.NewReader(`{"title":"a"}{"title":"b"}`))
	r.SetPathValue("weekStart", "2026-08-31")
	w := httptest.NewRecorder()

	NewHandler(nil).Set(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
