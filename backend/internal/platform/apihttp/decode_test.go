package apihttp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type decodeTestBody struct {
	A string `json:"a"`
}

func TestDecodeJSON_HappyPath(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"a":"x"}`))
	w := httptest.NewRecorder()

	var dst decodeTestBody
	if err := DecodeJSON(w, r, 1<<10, &dst); err != nil {
		t.Fatalf("DecodeJSON returned %v, want nil", err)
	}
	if dst.A != "x" {
		t.Errorf("dst.A = %q, want %q", dst.A, "x")
	}
	if w.Code != 200 {
		t.Errorf("a successful decode must not touch the response — code = %d", w.Code)
	}
	if w.Body.Len() != 0 {
		t.Errorf("a successful decode must not touch the response — body = %q", w.Body.String())
	}
}

// A trailing newline (or other whitespace) after the one document is not a
// second document — every well-behaved client's encoder appends one, and
// refusing it would break every legitimate caller for no security benefit.
func TestDecodeJSON_TrailingWhitespaceIsFine(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{\"a\":\"x\"}   \n"))
	w := httptest.NewRecorder()

	var dst decodeTestBody
	if err := DecodeJSON(w, r, 1<<10, &dst); err != nil {
		t.Fatalf("DecodeJSON returned %v, want nil (trailing whitespace only)", err)
	}
}

func TestDecodeJSON_RejectsMalformedJSON(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"a":`))
	w := httptest.NewRecorder()

	var dst decodeTestBody
	if err := DecodeJSON(w, r, 1<<10, &dst); err == nil {
		t.Fatal("DecodeJSON returned nil, want an error for truncated JSON")
	}
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
	assertErrorBody(t, w, CodeInvalidInput, "invalid JSON body")
}

// The scenario the ticket's own "steps to test" names explicitly: two
// concatenated JSON documents. A bare json.Decoder.Decode call — what every
// migrated site used before this helper — silently accepts the first and
// ignores the rest, which is exactly the "first document wins, the rest is
// unexamined" gap this test exists to close.
func TestDecodeJSON_RejectsTrailingJSONDocument(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"a":"x"}{"a":"y"}`))
	w := httptest.NewRecorder()

	var dst decodeTestBody
	err := DecodeJSON(w, r, 1<<10, &dst)
	if err == nil {
		t.Fatal("DecodeJSON returned nil, want an error for a second concatenated document")
	}
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
	assertErrorBody(t, w, CodeInvalidInput, "invalid JSON body")
}

// Trailing GARBAGE (not a second valid document) must be rejected the same
// way — the check must not accidentally only catch well-formed second values.
func TestDecodeJSON_RejectsTrailingGarbage(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"a":"x"}not json`))
	w := httptest.NewRecorder()

	var dst decodeTestBody
	if err := DecodeJSON(w, r, 1<<10, &dst); err == nil {
		t.Fatal("DecodeJSON returned nil, want an error for trailing garbage")
	}
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// The other half of the ticket's "steps to test": an oversized body must be
// rejected — with a DISTINCT, actionable shape (413), not folded into the
// generic 400 malformed-JSON response — and, just as importantly, the body
// must never be fully materialised: http.MaxBytesReader aborts the read
// partway through, which is the property this whole ticket exists for.
func TestDecodeJSON_RejectsOversizedBody(t *testing.T) {
	huge := `{"a":"` + strings.Repeat("x", 10_000) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(huge))
	w := httptest.NewRecorder()

	var dst decodeTestBody
	err := DecodeJSON(w, r, 100, &dst)
	if err == nil {
		t.Fatal("DecodeJSON returned nil, want an error for a body over maxBytes")
	}
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d", w.Code, http.StatusRequestEntityTooLarge)
	}
	assertErrorBody(t, w, CodeInvalidInput, "")
	// The message must not be the generic malformed-JSON one — a caller
	// needs to be able to tell "shrink your payload" from "your JSON is
	// broken", which is the whole reason WriteDecodeError branches at all.
	var body errorBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not the error contract: %v", err)
	}
	if body.Error.Message == "invalid JSON body" {
		t.Errorf("oversized body got the generic malformed-JSON message %q, want a distinct one",
			body.Error.Message)
	}
	if dst.A != "" {
		t.Errorf("dst.A = %q, want zero value — the destination must not be partially populated", dst.A)
	}
}

// MUTATION CHECK for the size limit: this is the exact scenario a maxBytes
// of 0 (or a helper that forgot to wrap MaxBytesReader at all) would let
// through silently. Recorded here rather than only in "Verify that a check
// can fail" prose, because this is the property #541 exists to guarantee —
// see the manual mutation performed and reverted during development,
// documented in docs/decisions/history.md's N164 entry.
func TestDecodeJSON_ExactlyAtTheLimitSucceeds(t *testing.T) {
	// `{"a":"xx"}` is exactly 10 bytes.
	body := `{"a":"xx"}`
	if len(body) != 10 {
		t.Fatalf("test body is %d bytes, want exactly 10 — fix the literal", len(body))
	}
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	w := httptest.NewRecorder()
	var dst decodeTestBody
	if err := DecodeJSON(w, r, 10, &dst); err != nil {
		t.Fatalf("a body exactly at maxBytes must decode; got %v", err)
	}

	r2 := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body+" "))
	w2 := httptest.NewRecorder()
	var dst2 decodeTestBody
	if err := DecodeJSON(w2, r2, 10, &dst2); err == nil {
		t.Fatal("a body one byte OVER maxBytes must be rejected, got nil error")
	}
	if w2.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("one byte over the limit: status = %d, want %d", w2.Code, http.StatusRequestEntityTooLarge)
	}
}

func TestDecodeJSONError_DoesNotWriteAResponse(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`not json`))
	w := httptest.NewRecorder()

	var dst decodeTestBody
	if err := DecodeJSONError(w, r, 1<<10, &dst); err == nil {
		t.Fatal("DecodeJSONError returned nil, want an error for malformed JSON")
	}
	if w.Code != http.StatusOK || w.Body.Len() != 0 {
		t.Errorf("DecodeJSONError must never write to the response itself — code=%d body=%q",
			w.Code, w.Body.String())
	}
}

// WriteDecodeError is the fallback callers of DecodeJSONError reach for once
// they've checked their own more-specific error shapes — it must still
// distinguish the two cases DecodeJSON does internally.
func TestWriteDecodeError_DistinguishesOversizedFromMalformed(t *testing.T) {
	// Valid JSON, just longer than the 100-byte cap below — a body of
	// syntactically invalid garbage past the cap would surface as a
	// SyntaxError instead (json.Decoder fails on the first bad byte, which
	// arrives before MaxBytesReader's own limit does), so this has to be
	// well-formed to actually exercise the MaxBytesError branch.
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"a":"`+strings.Repeat("x", 200)+`"}`))
	w := httptest.NewRecorder()
	var dst decodeTestBody
	err := DecodeJSONError(w, r, 100, &dst)
	if err == nil {
		t.Fatal("want an error")
	}
	rec := httptest.NewRecorder()
	WriteDecodeError(rec, err)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
	}

	rec2 := httptest.NewRecorder()
	WriteDecodeError(rec2, errTrailingJSON)
	if rec2.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec2.Code, http.StatusBadRequest)
	}
	assertErrorBody(t, rec2, CodeInvalidInput, "invalid JSON body")
}

func TestDecodeJSONBody_UnboundedButStillRejectsTrailingData(t *testing.T) {
	var dst decodeTestBody
	err := DecodeJSONBody(strings.NewReader(`{"a":"x"}{"a":"y"}`), &dst)
	if err == nil {
		t.Fatal("want an error for a second concatenated document")
	}
	if dst.A != "x" {
		t.Errorf("dst.A = %q, want %q (the first document should still decode)", dst.A, "x")
	}
}

func assertErrorBody(t *testing.T, w *httptest.ResponseRecorder, wantCode, wantMessage string) {
	t.Helper()
	var body errorBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not the error contract {\"error\":{...}}: %v (body: %q)", err, w.Body.String())
	}
	if body.Error.Code != wantCode {
		t.Errorf("error.code = %q, want %q", body.Error.Code, wantCode)
	}
	if wantMessage != "" && body.Error.Message != wantMessage {
		t.Errorf("error.message = %q, want %q", body.Error.Message, wantMessage)
	}
}
