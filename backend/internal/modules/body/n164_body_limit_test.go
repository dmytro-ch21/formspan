package body

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

func withClaims(r *http.Request, userID string) *http.Request {
	return r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: userID}))
}

// N164/#541: SaveCheckin used to be a bare json.NewDecoder(r.Body).Decode(&in)
// with no size bound. Mutation-checked (see docs/decisions/history.md's N164
// entry): reverting to that bare form makes this test fail (200, not 413 —
// the oversized "notes" value decodes cleanly and the request reaches
// Validate/the repository instead of being rejected up front).
func TestSaveCheckin_RejectsOversizedBody(t *testing.T) {
	body := `{"notes":"` + strings.Repeat("x", maxBodyRequestBytes+1) + `"}`
	r := httptest.NewRequest(http.MethodPut, "/v1/body/checkins/2026-01-01", strings.NewReader(body))
	r.SetPathValue("date", "2026-01-01")
	r = withClaims(r, "user-1")
	w := httptest.NewRecorder()

	NewHandler(nil, nil).SaveCheckin(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}

func TestSaveCheckin_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPut, "/v1/body/checkins/2026-01-01",
		strings.NewReader(`{"notes":"a"}{"notes":"b"}`))
	r.SetPathValue("date", "2026-01-01")
	r = withClaims(r, "user-1")
	w := httptest.NewRecorder()

	NewHandler(nil, nil).SaveCheckin(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
