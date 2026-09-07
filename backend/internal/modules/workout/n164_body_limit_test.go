package workout

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: Create and ReplaceItems used to be bare
// json.NewDecoder(r.Body).Decode(&req) calls with no size bound — the two
// handlers this ticket's own evidence cited by line number. Mutation-checked
// (see docs/decisions/history.md's N164 entry): reverting Create's decode
// call to the bare form makes this test fail.
func TestCreate_RejectsOversizedBody(t *testing.T) {
	body := `{"padding":"` + strings.Repeat("x", maxWorkoutBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/v1/workouts", strings.NewReader(body))
	w := httptest.NewRecorder()

	NewHandler(nil).Create(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}

func TestCreate_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/workouts",
		strings.NewReader(`{"id":"a","name":"a"}{"id":"b"}`))
	w := httptest.NewRecorder()

	NewHandler(nil).Create(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}

func TestReplaceItems_RejectsOversizedBody(t *testing.T) {
	body := `{"padding":"` + strings.Repeat("x", maxWorkoutBody+1) + `"}`
	r := httptest.NewRequest(http.MethodPut, "/v1/workouts/w1/items", strings.NewReader(body))
	r.SetPathValue("workoutID", "w1")
	w := httptest.NewRecorder()

	NewHandler(nil).ReplaceItems(w, r)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", w.Code, http.StatusRequestEntityTooLarge, w.Body.String())
	}
}
