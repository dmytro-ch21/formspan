package bjj

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: CreatePromotion used to be a bare
// json.NewDecoder(r.Body).Decode(&req) with no size bound. Mutation-checked
// (see docs/decisions/history.md's N164 entry): reverting to that bare form
// makes this test fail.
func TestCreatePromotion_RejectsOversizedBody(t *testing.T) {
	body := `{"note":"` + strings.Repeat("x", maxPromotionBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/bjj/promotions", strings.NewReader(body))
	w := httptest.NewRecorder()

	NewHandler(newMemRepo(), nil).CreatePromotion(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}

func TestCreatePromotion_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/bjj/promotions",
		strings.NewReader(`{"belt":"blue"}{"belt":"purple"}`))
	w := httptest.NewRecorder()

	NewHandler(newMemRepo(), nil).CreatePromotion(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}

// The FocusHandler.Set path — a different handler in the same module, since
// the ticket's acceptance criteria ask for "at least one handler per
// module" and this one carries its own maxFocusBody rather than
// maxPromotionBody.
func TestFocusHandlerSet_RejectsOversizedBody(t *testing.T) {
	body := `{"padding":"` + strings.Repeat("x", maxFocusBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPut, "/v1/bjj/focus", strings.NewReader(body))
	w := httptest.NewRecorder()

	NewFocusHandler(nil).Set(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}
