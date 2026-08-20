package bjj

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// memFocus records what the handler passed down, so these tests need no
// database. What matters is the ATTRIBUTION — which ids the repository was told
// belong to the roadmap — because that is what decides, weeks later, whether
// deactivating it deletes an athlete's own choice.
type memFocus struct {
	gotIDs    []string
	gotSource *FocusSource
	calls     int
}

func (m *memFocus) Focus(context.Context, string) ([]Focus, error) { return []Focus{}, nil }

func (m *memFocus) SetFocus(_ context.Context, _ string, ids []string, src *FocusSource) error {
	m.calls++
	m.gotIDs = ids
	m.gotSource = src
	return nil
}

func (m *memFocus) ReleaseFocusSource(context.Context, string, string) error { return nil }

func putFocus(t *testing.T, repo FocusRepository, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPut, "/v1/bjj/focus", strings.NewReader(body))
	r = r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: "user_123"}))
	rec := httptest.NewRecorder()
	NewFocusHandler(repo).Set(rec, r)
	return rec
}

func TestAHandEditAttributesNothingToAnyRoadmap(t *testing.T) {
	// The default, and the one that makes hand-picked entries sovereign. No
	// `roadmap` key means the repository is handed a nil source, which is what
	// records the new entries as the athlete's own.
	repo := &memFocus{}
	rec := putFocus(t, repo, `{"technique_ids":["a","b"]}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body %s, want 200", rec.Code, rec.Body.String())
	}
	if repo.gotSource != nil {
		t.Errorf("a hand edit attributed %+v to a roadmap — those entries would become "+
			"deletable by a deactivation the athlete never asked for", repo.gotSource)
	}
}

func TestARoadmapWriteAttributesOnlyTheIDsItNames(t *testing.T) {
	repo := &memFocus{}
	rec := putFocus(t, repo,
		`{"technique_ids":["a","b","x"],"roadmap":{"curriculum_id":"c1","technique_ids":["a","b"]}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body %s, want 200", rec.Code, rec.Body.String())
	}
	if repo.gotSource == nil {
		t.Fatal("roadmap block was dropped; nothing would be attributable and the bug returns")
	}
	if repo.gotSource.CurriculumID != "c1" {
		t.Errorf("curriculum_id = %q, want c1", repo.gotSource.CurriculumID)
	}
	if len(repo.gotSource.TechniqueIDs) != 2 ||
		repo.gotSource.TechniqueIDs[0] != "a" || repo.gotSource.TechniqueIDs[1] != "b" {
		t.Errorf("attributed %v, want [a b] — x is the athlete's and must not be claimed",
			repo.gotSource.TechniqueIDs)
	}
	// And the list itself is still the full one. Sending only the attributed ids
	// would silently delete the athlete's entries via the wholesale replace.
	if len(repo.gotIDs) != 3 {
		t.Errorf("stored list = %v, want all three", repo.gotIDs)
	}
}

func TestARoadmapMayNotClaimATechniqueTheWriteDoesNotContain(t *testing.T) {
	// Attribution is what makes a row deletable, so an id claimed but not written
	// is either a client bug or a client claiming something it is not sending.
	// A 400 rather than a silently ignored element: the repository would drop it
	// anyway, and a caller told 200 would believe an attribution that never
	// happened.
	repo := &memFocus{}
	rec := putFocus(t, repo,
		`{"technique_ids":["a"],"roadmap":{"curriculum_id":"c1","technique_ids":["a","ghost"]}}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if repo.calls != 0 {
		t.Error("the write went through despite an out-of-range attribution")
	}
	assertInvalidInput(t, rec)
}

func TestARoadmapBlockWithoutACurriculumIDIsRefused(t *testing.T) {
	// Without an id there is nothing to attribute TO, so the entries would be
	// marked roadmap-owned with no roadmap able to release them — permanently
	// stuck, which is worse than the bug being fixed.
	repo := &memFocus{}
	rec := putFocus(t, repo, `{"technique_ids":["a"],"roadmap":{"technique_ids":["a"]}}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if repo.calls != 0 {
		t.Error("the write went through with no curriculum to attribute to")
	}
	assertInvalidInput(t, rec)
}

func TestAnEmptyRoadmapClaimIsAcceptedRatherThanRefused(t *testing.T) {
	// A roadmap whose every technique is already mastered proposes a list made
	// entirely of the athlete's own entries. That is a legitimate write, not an
	// error — refusing it would make "apply" fail at exactly the moment the
	// roadmap is finished.
	repo := &memFocus{}
	rec := putFocus(t, repo,
		`{"technique_ids":["x"],"roadmap":{"curriculum_id":"c1","technique_ids":[]}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body %s, want 200", rec.Code, rec.Body.String())
	}
	if repo.gotSource == nil || len(repo.gotSource.TechniqueIDs) != 0 {
		t.Errorf("source = %+v, want a curriculum claiming nothing", repo.gotSource)
	}
}

func assertInvalidInput(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body %q: %v", rec.Body.String(), err)
	}
	// The CODE is the contract; the message is not.
	if body.Error.Code != "invalid_input" {
		t.Errorf("error code = %q, want invalid_input", body.Error.Code)
	}
}
