package contest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Same claims caveat as profile/handler_test.go and workout/handler_test.go:
// `auth`'s context key is unexported, so a test cannot forge a signed-in
// caller. Every case here must therefore stop BEFORE the repository — which
// decode failures and validation failures do.
//
// That constraint is what makes these tests meaningful rather than a limitation
// to work around: delete the validation call in `toInput` and these requests
// fall through and panic, which is loudly red rather than quietly green.
//
// **The panic comes from the nil `*Claims`, not the nil repository** —
// `ClaimsFromContext` finds nothing on an unauthenticated test request, and
// `claims.UserID` is evaluated as the repository call's argument, so it fires
// one expression earlier than it looks. Recorded precisely because the
// difference is invisible from the test output: if a future change makes the
// claims handling nil-safe, the accept-path test below stops proving anything
// until it is given a non-nil sentinel repository instead.

func post(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(nil) // never reached: every case below stops at validation
	req := httptest.NewRequest(http.MethodPost, "/v1/contests", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.Create(rec, req)
	return rec
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) (code, message string) {
	t.Helper()
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not the standard error shape: %v (%s)", err, rec.Body.String())
	}
	return body.Error.Code, body.Error.Message
}

func TestCreateRejectsInvalidBodies(t *testing.T) {
	cases := map[string]string{
		"malformed JSON":       `{`,
		"no sport":             `{"name":"Pan Ams"}`,
		"unknown sport":        `{"sport":"quidditch","name":"Pan Ams"}`,
		"no name":              `{"sport":"bjj"}`,
		"name of spaces":       `{"sport":"bjj","name":"   "}`,
		"bad date":             `{"sport":"bjj","name":"Pan Ams","held_on":"14/03/2026"}`,
		"unknown format":       `{"sport":"bjj","name":"Pan Ams","format":"ibjjf"}`,
		"second of one":        `{"sport":"bjj","name":"Pan Ams","placement":2,"entrants":1}`,
		"zero placement":       `{"sport":"bjj","name":"Pan Ams","placement":0}`,
		"unknown match result": `{"sport":"bjj","name":"Pan Ams","matches":[{"result":"drew"}]}`,
		"unknown match method": `{"sport":"bjj","name":"Pan Ams","matches":[{"result":"won","method":"heel hook"}]}`,
		"technique on points":  `{"sport":"bjj","name":"Pan Ams","matches":[{"result":"won","method":"points","technique_id":"armbar"}]}`,
	}
	for name, body := range cases {
		rec := post(t, body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d (%s)", name, rec.Code, rec.Body.String())
			continue
		}
		code, msg := decodeError(t, rec)
		if code != "invalid_input" {
			t.Errorf("%s: want code invalid_input, got %q", name, code)
		}
		if msg == "" {
			t.Errorf("%s: an empty message tells the client nothing", name)
		}
	}
}

// The error message must NAME the field, because a client sending fifteen
// fields cannot act on "invalid input". This is why the module wraps a message
// into the sentinel rather than writing one flat string per endpoint.
func TestValidationMessagesNameTheOffendingField(t *testing.T) {
	cases := map[string]string{
		`{"sport":"bjj","name":"Pan Ams","placement":0}`:                                  "placement",
		`{"sport":"bjj","name":"Pan Ams","held_on":"nope"}`:                               "held_on",
		`{"sport":"bjj","name":"Pan Ams","matches":[{"result":"drew"}]}`:                  "result",
		`{"sport":"bjj","name":"Pan Ams","matches":[{"result":"won"},{"result":"nope"}]}`: "match 2",
	}
	for body, want := range cases {
		_, msg := decodeError(t, post(t, body))
		if !strings.Contains(msg, want) {
			t.Errorf("message %q should mention %q", msg, want)
		}
	}
}

// A body over the limit is refused, not streamed into memory. `MaxBytesReader`
// surfaces as a decode error, which is the same 400 a malformed body gets —
// deliberately, since the size of the limit is not something a client can act
// on.
func TestCreateRefusesAnOversizedBody(t *testing.T) {
	huge := `{"sport":"bjj","name":"Pan Ams","note":"` + strings.Repeat("a", maxBody+1) + `"}`
	rec := post(t, huge)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

// N164/#541: `decode` used to call json.NewDecoder(...).Decode(&req) directly,
// which stops reading after the first JSON value and silently ignores
// anything after it — a second, concatenated document would pass straight
// through unnoticed. Switching to apihttp.DecodeJSONBody (see decode's own
// comment on why not the response-writing variants) closes that without
// touching this handler's 400-for-everything status-code choice.
//
// Mutation-checked: reverting `decode` to a bare json.NewDecoder(...).Decode
// makes this test fail — the trailing `{"sport":"judo"}` is silently dropped,
// the first (valid) document reaches toInput/Validate, and the request falls
// through to the nil-repository panic TestAValidBodyReachesTheRepository
// relies on above, rather than being rejected here. Restored afterward,
// confirmed green again by re-running the test, not by re-reading the diff.
func TestCreateRejectsATrailingJSONDocument(t *testing.T) {
	body := `{"sport":"bjj","name":"Pan Ams"}{"sport":"judo"}`
	rec := post(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d (%s)", rec.Code, rec.Body.String())
	}
	code, _ := decodeError(t, rec)
	if code != "invalid_input" {
		t.Errorf("want code invalid_input, got %q", code)
	}
}

// The accepting case, asserted the only way it can be from here: a valid body
// must pass validation and reach the repository, which is nil, so it panics.
// Recovering that panic IS the assertion — without it, a `toInput` that
// rejected everything would leave every test above passing.
func TestAValidBodyReachesTheRepository(t *testing.T) {
	defer func() {
		// See the note at the top: this panic is the nil *Claims, reached only
		// because validation let the request through. A rejection would have
		// written a 400 and returned, so recovering here cannot happen for any
		// other reason.
		if recover() == nil {
			t.Fatal("a valid contest should pass validation and reach the repository")
		}
	}()
	post(t, `{"sport":"bjj","name":"Pan Ams","held_on":"2026-03-14","placement":3,"entrants":32,
		"matches":[{"result":"won","method":"submission"},{"result":"lost","method":"advantage"}]}`)
}

func TestUpdateValidatesTheSameWay(t *testing.T) {
	// The two endpoints share `decode`, and this is what pins that: if Update
	// ever grows its own path, a rejection here stops matching Create's.
	h := NewHandler(nil)
	req := httptest.NewRequest(http.MethodPut, "/v1/contests/abc", strings.NewReader(`{"sport":"bjj"}`))
	req.SetPathValue("contestID", "abc")
	rec := httptest.NewRecorder()
	h.Update(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	if code, _ := decodeError(t, rec); code != "invalid_input" {
		t.Errorf("want invalid_input, got %q", code)
	}
}
