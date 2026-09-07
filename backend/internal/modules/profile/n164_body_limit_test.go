package profile

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: Create (and its three siblings — Update, SetModules,
// SetExerciseUnit — all migrated the same way) used to be a bare
// json.NewDecoder(r.Body).Decode(&req) with no size bound. Mutation-checked
// (see docs/decisions/history.md's N164 entry): reverting Create's decode
// call to that bare form makes this test fail.
func TestCreate_RejectsOversizedBody(t *testing.T) {
	body := `{"display_name":"` + strings.Repeat("x", maxProfileBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/profile", strings.NewReader(body))
	w := httptest.NewRecorder()

	NewHandler(nil, nil).Create(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}

func TestCreate_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/profile",
		strings.NewReader(`{"display_name":"a"}{"display_name":"b"}`))
	w := httptest.NewRecorder()

	NewHandler(nil, nil).Create(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}
