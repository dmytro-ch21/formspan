package bjj

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// memSession records exactly what the handler decoded, the same way
// memFocus does in focus_handler_test.go — no database, so it isolates the
// HTTP-decode step from the repository and the storage layer, both of which
// already have their own coverage.
type memSession struct {
	got SessionDetail
}

func (m *memSession) PutDetail(_ context.Context, _ string, d SessionDetail) (SessionDetail, error) {
	m.got = d
	return d, nil
}

func (m *memSession) GetDetail(context.Context, string, string) (SessionDetail, error) {
	return SessionDetail{}, ErrNotFound
}

func putBjjDetail(t *testing.T, repo SessionRepository, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPut, "/v1/bjj/sessions/ses-1", strings.NewReader(body))
	r = r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: "user_123"}))
	r.SetPathValue("sessionID", "ses-1")
	rec := httptest.NewRecorder()
	NewSessionHandler(repo).PutDetail(rec, r)
	return rec
}

// N119/#508, and the specific bug backend review caught: `tagRequest` had no
// `Label` field, so `encoding/json` silently dropped a `label` key on decode
// — the exact "silently dropped" failure this ticket exists to end, moved
// from the mobile screen (fixed) to the HTTP boundary (not, until this
// test). `Tag.Validate()`'s own label tests can never catch this class of
// bug: they construct a `Tag` directly and never go through `toDetail`.
func TestPutDetailCarriesAnUnmatchedTagsLabelThroughToTheRepository(t *testing.T) {
	repo := &memSession{}
	rec := putBjjDetail(t, repo, `{
		"kind": "rolling",
		"tags": [
			{"category": "sweep", "event": "scored", "count": 1, "label": "pool guards"}
		]
	}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body %s, want 200", rec.Code, rec.Body.String())
	}
	if len(repo.got.Tags) != 1 {
		t.Fatalf("repo got %d tags, want 1", len(repo.got.Tags))
	}
	if repo.got.Tags[0].Label != "pool guards" {
		t.Fatalf("repo got label %q, want %q — the wire format dropped it",
			repo.got.Tags[0].Label, "pool guards")
	}
	if repo.got.Tags[0].TechniqueID != nil {
		t.Fatalf("an unmatched tag must not have grown a technique id: %+v", repo.got.Tags[0])
	}
}

// The mirror at the HTTP boundary of `TestTagCannotCarryBothATechniqueAndAStaleLabel`
// in bjj_test.go — proves the guard is actually reachable through the
// decode path a real client uses, not only through a `Tag` built by hand in
// a unit test.
func TestPutDetailRejectsATagCarryingBothATechniqueIDAndALabel(t *testing.T) {
	repo := &memSession{}
	rec := putBjjDetail(t, repo, `{
		"kind": "rolling",
		"tags": [
			{"category": "submission", "event": "scored", "count": 1,
			 "technique_id": "armbar-from-guard", "label": "pool guards"}
		]
	}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body %s, want 400 — a resolved tag with a stale label must be rejected",
			rec.Code, rec.Body.String())
	}
	if repo.got.Tags != nil {
		t.Fatalf("repository must not be called on a validation failure, got %+v", repo.got)
	}
}
