package workout

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Handler-layer tests for the rename validation.
//
// These exist because the two rules the endpoint publishes — a blank name is
// refused, and the 120 cap counts CODE POINTS rather than bytes — live entirely
// in the handler, and the repository tests cannot see either. A review found
// that swapping `utf8.RuneCountInString` for `len` left the whole suite green.
//
// **The accepting case is the one that catches that swap.** Under `len`, 120
// Japanese runes are 360 bytes and get refused, while 121 is still refused for
// the wrong reason — so a test that only asserts "121 → 400" passes against the
// bug it was written for. That was worth getting wrong once on paper.
//
// No claims are injected: `auth`'s context key is unexported, and forging one
// would mean widening that package for a test. The handler instead reads claims
// at the point of use and answers 401 without them, so "reached the repository"
// reads here as 401 — distinguishable from validation's 400, which is all these
// assertions need.
func renameResponse(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(nil) // never called: every case below stops before the repo
	req := httptest.NewRequest(http.MethodPatch, "/v1/workouts/w1", strings.NewReader(body))
	req.SetPathValue("workoutID", "w1")
	rec := httptest.NewRecorder()
	h.Rename(rec, req)
	return rec
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body is not the error contract: %q", rec.Body.String())
	}
	return out.Error.Code
}

func TestRenameHandler_RefusesABlankName(t *testing.T) {
	for _, body := range []string{`{"name":""}`, `{"name":"   "}`, `{"name":"\t\n"}`, `{}`} {
		rec := renameResponse(t, body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want 400", body, rec.Code)
		}
		if got := errorCode(t, rec); got != "invalid_input" {
			t.Errorf("body %s: code = %q, want invalid_input", body, got)
		}
	}
}

func TestRenameHandler_CountsRunesNotBytes(t *testing.T) {
	// "技" is three bytes in UTF-8, so 120 of them are 360 bytes — nearly triple
	// the published cap. This product's domain vocabulary is exactly this and
	// Portuguese, which is why the distinction is not academic.
	const multibyte = "技"

	atCap := strings.Repeat(multibyte, maxNameLen)
	rec := renameResponse(t, `{"name":"`+atCap+`"}`)
	// 401, not 200: it got past validation and stopped at the claims guard,
	// which is the only observable difference available without forging auth.
	// A byte-counting cap makes this 400, and that is the whole point.
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("a %d-rune name was refused: status = %d, want 401 (accepted, then no claims)",
			maxNameLen, rec.Code)
	}

	over := strings.Repeat(multibyte, maxNameLen+1)
	rec = renameResponse(t, `{"name":"`+over+`"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("a %d-rune name was accepted: status = %d, want 400", maxNameLen+1, rec.Code)
	}

	// And the same boundary in plain ASCII, so the cap is a rune count in both
	// directions rather than accidentally right for one alphabet.
	if rec := renameResponse(t, `{"name":"`+strings.Repeat("a", maxNameLen)+`"}`); rec.Code != http.StatusUnauthorized {
		t.Errorf("a %d-character ASCII name was refused: status = %d", maxNameLen, rec.Code)
	}
	if rec := renameResponse(t, `{"name":"`+strings.Repeat("a", maxNameLen+1)+`"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("a %d-character ASCII name was accepted: status = %d", maxNameLen+1, rec.Code)
	}
}

func TestRenameHandler_TrimsBeforeMeasuring(t *testing.T) {
	// Trimming happens first, so padding must not push a legal name over. The
	// server stores the trimmed value, and the client trims too — measuring the
	// untrimmed string would refuse a name it then would have stored happily.
	padded := "  " + strings.Repeat("a", maxNameLen) + "  "
	if rec := renameResponse(t, `{"name":"`+padded+`"}`); rec.Code != http.StatusUnauthorized {
		t.Errorf("padding pushed a legal name over the cap: status = %d", rec.Code)
	}
}

func TestRenameHandler_RejectsMalformedJSON(t *testing.T) {
	rec := renameResponse(t, `{"name":`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	if got := errorCode(t, rec); got != "invalid_input" {
		t.Errorf("code = %q, want invalid_input", got)
	}
}
