package session

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// N164/#541: Create and ReplaceSets used to be bare
// json.NewDecoder(r.Body).Decode(&req) calls with no size bound — the two
// handlers this ticket's own evidence cited by line number. Mutation-checked
// (see docs/decisions/history.md's N164 entry): reverting Create's decode
// call to the bare form makes this test fail.
//
// This also exercises the DecodeJSONError/WriteDecodeError split those two
// handlers use to keep distanceMDecodeMessage's more specific message (see
// TestSetValidation_FractionalDistanceMIsActionableNotGeneric in
// handler_test.go) working alongside the new size bound — an oversized body
// must still fall through to WriteDecodeError, not to distanceMDecodeMessage.
func TestCreate_RejectsOversizedBody(t *testing.T) {
	body := `{"padding":"` + strings.Repeat("x", maxSessionBody+1) + `"}`
	rec := createResponse(t, body)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", rec.Code, http.StatusRequestEntityTooLarge, rec.Body.String())
	}
}

func TestReplaceSets_RejectsOversizedBody(t *testing.T) {
	body := `{"padding":"` + strings.Repeat("x", maxSessionBody+1) + `"}`
	rec := replaceSetsResponse(t, body)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d: %s", rec.Code, http.StatusRequestEntityTooLarge, rec.Body.String())
	}
}

func TestCreate_RejectsTrailingJSONDocument(t *testing.T) {
	rec := createResponse(t, `{"id":"a","sport":"strength"}{"id":"b"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

// Rename/SetIntent/Reschedule are the exact three call sites the ticket's
// design guidance names as the pre-existing http.MaxBytesReader precedent
// this generalises. They already had a size bound; what they gained here is
// the trailing-document check, exercised directly.
func TestRename_RejectsTrailingJSONDocument(t *testing.T) {
	req := httptest.NewRequest(http.MethodPatch, "/v1/sessions/ses-1/rename",
		strings.NewReader(`{"name":"a"}{"name":"b"}`))
	req.SetPathValue("sessionID", "ses-1")
	rec := httptest.NewRecorder()
	NewHandler(nil, nil, nil).Rename(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d: %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}
