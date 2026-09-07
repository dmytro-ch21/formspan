package nutrition

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

// N164/#541: SaveEntry, SaveFood and SaveTarget were all bare
// json.NewDecoder(r.Body).Decode calls with no size bound. Mutation-checked
// (see docs/decisions/history.md's N164 entry): reverting SaveEntry's decode
// call to that bare form makes this test fail.
func TestSaveEntry_RejectsOversizedBody(t *testing.T) {
	body := `{"name":"` + strings.Repeat("x", maxEntryBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPut, "/v1/nutrition/entries/e1", strings.NewReader(body))
	r.SetPathValue("id", "e1")
	r = withClaims(r, "user-1")
	w := httptest.NewRecorder()

	NewHandler(nil).SaveEntry(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}

func TestSaveEntry_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPut, "/v1/nutrition/entries/e1",
		strings.NewReader(`{"name":"a"}{"name":"b"}`))
	r.SetPathValue("id", "e1")
	r = withClaims(r, "user-1")
	w := httptest.NewRecorder()

	NewHandler(nil).SaveEntry(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}

// SaveFood carries its own, larger maxFoodBody — a different handler in the
// same module, satisfying the ticket's "at least one handler per module".
func TestSaveFood_RejectsOversizedBody(t *testing.T) {
	body := `{"name":"` + strings.Repeat("x", maxFoodBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPut, "/v1/nutrition/foods/f1", strings.NewReader(body))
	r.SetPathValue("id", "f1")
	r = withClaims(r, "user-1")
	w := httptest.NewRecorder()

	NewHandler(nil).SaveFood(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}
