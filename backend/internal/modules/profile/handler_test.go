package profile

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"encoding/json"
)

// The username guard, tested AT THE CALL SITE.
//
// TestValidUsername covers the function; nothing covered the if-statement that
// calls it — review demonstrated that deleting the handler's guard survived
// the whole suite, and unlike unit_system or sex there is no CHECK constraint
// behind this field: the handler is the only enforcement of format and the
// reserved list. Same claims caveat as workout/handler_test.go: the auth
// context key is unexported, so these cases must stop BEFORE the repository —
// which validation failures do. Delete the guard and these requests fall
// through toward a nil repository instead of returning 400, which is loudly
// red rather than quietly green.
func updateResponse(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(nil) // never reached: every case stops at validation
	req := httptest.NewRequest(http.MethodPatch, "/v1/profile", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.Update(rec, req)
	return rec
}

func TestUpdateRejectsBadUsernamesAtTheHandler(t *testing.T) {
	cases := map[string]string{
		"uppercase": `{"username":"Dmytro"}`,
		"reserved":  `{"username":"admin"}`,
		"too short": `{"username":"ab"}`,
		"leading _": `{"username":"_dmytro"}`,
	}
	for name, body := range cases {
		rec := updateResponse(t, body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d", name, rec.Code)
		}
	}
}

func TestUpdateTrimsBeforeValidating(t *testing.T) {
	// "dmytro " must NOT 400 — the trailing space is the keyboard's, not the
	// user's. It must instead proceed past validation, which with a nil
	// repository means a panic; recovering one here is the assertion that the
	// guard let it through.
	defer func() {
		if recover() == nil {
			t.Fatal("a trimmed-valid username should pass validation and reach the repository")
		}
	}()
	updateResponse(t, `{"username":"dmytro "}`)
}

// The 409 mapping is a CONTRACT property — the code vocabulary is part of the
// wire contract — and it had no test either.
func TestWriteErrorMapsUsernameTaken(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/v1/profile", nil)
	writeError(rec, req, ErrUsernameTaken)

	if rec.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d", rec.Code)
	}
	var out struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Error.Code != "already_exists" {
		t.Errorf("code: want already_exists, got %q", out.Error.Code)
	}
	if out.Error.Message != "that username is taken" {
		t.Errorf("message: want the taken sentence, got %q", out.Error.Message)
	}
}
