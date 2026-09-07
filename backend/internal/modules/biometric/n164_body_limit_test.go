package biometric

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: ComputeMetrics already wrapped r.Body in http.MaxBytesReader by
// hand, but the bare json.Decode call it fed still silently accepted a
// second concatenated JSON document — PutSamples (this module's other write
// path) already had both properties via its own ReadAll+Unmarshal pattern
// (N502/#873), so this is the sibling that needed the fix. Mutation-checked
// (see docs/decisions/history.md's N164 entry).
func TestComputeMetrics_RejectsOversizedBody(t *testing.T) {
	body := `{"hr_max_source":"` + strings.Repeat("x", 2048) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/biometrics/sessions/s1/metrics", strings.NewReader(body))
	r.SetPathValue("sessionID", "s1")
	w := httptest.NewRecorder()

	NewHandler(nil).ComputeMetrics(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}

func TestComputeMetrics_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/biometrics/sessions/s1/metrics",
		strings.NewReader(`{"hr_max_bpm":180}{"hr_max_bpm":190}`))
	r.SetPathValue("sessionID", "s1")
	w := httptest.NewRecorder()

	NewHandler(nil).ComputeMetrics(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
