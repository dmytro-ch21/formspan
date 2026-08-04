package technique

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Handler-layer tests, which this module could not have until the constructor
// took the interface rather than *PostgresRepository. All three defects review
// found were in this layer, and none of them was reachable by a repository
// test: a full-replace PATCH, zero-valued timestamps, and an unbounded name.

type fakeContentRepo struct {
	stored    map[string]Technique
	sources   map[string]string
	positions []string
	// lastWritten is what the handler actually asked to store, which is the
	// thing the partial-update test has to inspect.
	lastWritten Technique
}

func newFakeRepo() *fakeContentRepo {
	return &fakeContentRepo{
		stored:    map[string]Technique{},
		sources:   map[string]string{},
		positions: []string{"Half Guard - Top", "Guard - Bottom"},
	}
}

func (f *fakeContentRepo) KnownPositions(context.Context) ([]string, error) {
	return f.positions, nil
}

func (f *fakeContentRepo) GetTechnique(_ context.Context, id string) (Technique, error) {
	t, ok := f.stored[id]
	if !ok {
		return Technique{}, ErrNotFound
	}
	return t, nil
}

func (f *fakeContentRepo) Source(_ context.Context, id string) (string, error) {
	s, ok := f.sources[id]
	if !ok {
		return "", ErrNotFound
	}
	return s, nil
}

func (f *fakeContentRepo) CreateTechnique(_ context.Context, t Technique) (Technique, error) {
	if _, taken := f.stored[t.ID]; taken {
		return Technique{}, ErrAlreadyExists
	}
	f.lastWritten = t
	t.Source = "admin"
	t.CreatedAt = time.Now()
	t.UpdatedAt = t.CreatedAt
	f.stored[t.ID] = t
	f.sources[t.ID] = "admin"
	return t, nil
}

func (f *fakeContentRepo) UpdateTechnique(_ context.Context, t Technique) (Technique, error) {
	if f.sources[t.ID] != "admin" {
		return Technique{}, ErrNotFound
	}
	f.lastWritten = t
	t.Source = "admin"
	t.UpdatedAt = time.Now()
	f.stored[t.ID] = t
	return t, nil
}

func post(t *testing.T, h *ContentHandler, body string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/admin/techniques", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.Create(rec, req)
	return rec.Result()
}

func patch(t *testing.T, h *ContentHandler, id, body string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPatch, "/v1/admin/techniques/"+id, strings.NewReader(body))
	req.SetPathValue("techniqueID", id)
	rec := httptest.NewRecorder()
	h.Update(rec, req)
	return rec.Result()
}

func decodeTechniqueBody(t *testing.T, res *http.Response) Technique {
	t.Helper()
	var out struct {
		Technique Technique `json:"technique"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out.Technique
}

const validCreate = `{"name":"São Paulo Pass","category":"Pass",
	"position":"Half Guard - Top","gi_no_gi":"Both",
	"description":"original prose","when_to_use":"original when"}`

func TestPatchIsPartialAndDoesNotWipeOmittedFields(t *testing.T) {
	// The defect: PATCH decoded into plain strings, so a console form posting
	// only the edited field silently erased the other fourteen. Omitting
	// `description` returned "". The contract marks four fields required and
	// the method is PATCH, so a client author is told in writing the rest are
	// optional.
	repo := newFakeRepo()
	h := NewContentHandler(repo)

	if res := post(t, h, validCreate); res.StatusCode != http.StatusOK {
		t.Fatalf("create = %d", res.StatusCode)
	}

	res := patch(t, h, "sao-paulo-pass", `{"name":"Sao Paulo Pass (renamed)"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("patch = %d", res.StatusCode)
	}
	got := decodeTechniqueBody(t, res)
	if got.Name != "Sao Paulo Pass (renamed)" {
		t.Errorf("name not applied: %q", got.Name)
	}
	if got.Description != "original prose" || got.WhenToUse != "original when" {
		t.Errorf("a partial PATCH wiped omitted fields: description=%q when_to_use=%q",
			got.Description, got.WhenToUse)
	}
	// ...and the id did not move, even though the name did.
	if got.ID != "sao-paulo-pass" {
		t.Errorf("id moved to %q — it is a foreign key in training records", got.ID)
	}
}

func TestPatchCanStillClearAFieldExplicitly(t *testing.T) {
	// Present-but-empty has to differ from absent, or "partial" becomes
	// "append-only" and a wrong description can never be removed.
	repo := newFakeRepo()
	h := NewContentHandler(repo)
	post(t, h, validCreate)

	res := patch(t, h, "sao-paulo-pass", `{"description":""}`)
	got := decodeTechniqueBody(t, res)
	if got.Description != "" {
		t.Errorf("description = %q, want cleared", got.Description)
	}
	if got.WhenToUse != "original when" {
		t.Errorf("clearing one field disturbed another: %q", got.WhenToUse)
	}
}

func TestWritesReturnRealTimestamps(t *testing.T) {
	// The projection omitted created_at/updated_at, so both writes returned
	// 0001-01-01T00:00:00Z — well-formed enough to pass a schema validator and
	// render as "Created 1 Jan 0001".
	repo := newFakeRepo()
	h := NewContentHandler(repo)
	got := decodeTechniqueBody(t, post(t, h, validCreate))
	if got.CreatedAt.IsZero() || got.UpdatedAt.IsZero() {
		t.Errorf("zero timestamps on create: %v / %v", got.CreatedAt, got.UpdatedAt)
	}
}

func TestNameLengthIsBoundedBecauseTheIDIsPermanent(t *testing.T) {
	// Unbounded, a long name either 500s on Postgres's btree limit or — worse —
	// succeeds and mints a 4000-character id that is now a permanent foreign
	// key in training records.
	repo := newFakeRepo()
	h := NewContentHandler(repo)
	long := strings.Repeat("a", maxNameLen+1)
	res := post(t, h, `{"name":"`+long+`","category":"Pass",
		"position":"Half Guard - Top","gi_no_gi":"Both"}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("an over-long name returned %d, want 400", res.StatusCode)
	}
	if _, minted := repo.stored[long]; minted {
		t.Error("an over-long id was minted")
	}
}

func TestCreateDerivesTheIDAndIgnoresAnyTheClientSends(t *testing.T) {
	repo := newFakeRepo()
	h := NewContentHandler(repo)
	res := post(t, h, `{"name":"São Paulo Pass","id":"i-chose-this","source":"seed",
		"category":"Pass","position":"Half Guard - Top","gi_no_gi":"Both"}`)
	got := decodeTechniqueBody(t, res)
	if got.ID != "sao-paulo-pass" {
		t.Errorf("id = %q — a client chose its own permanent id", got.ID)
	}
	if got.Source != "admin" {
		t.Errorf("source = %q — a client handed its row to the deploy", got.Source)
	}
}

func TestEditingASeededTechniqueExplainsItselfRatherThan404ing(t *testing.T) {
	// A bare 404 at an id the console is displaying reads as a bug. The real
	// answer — "that one lives in the JSON" — is a different action entirely.
	repo := newFakeRepo()
	// A COMPLETE row. The first version of this fixture omitted
	// category/position/gi_no_gi, and the request 400'd on validation before
	// the refusal could happen — which exposed a real property worth knowing:
	// the merged row is re-validated, so a stored technique that fails current
	// validation cannot be edited until its data is fixed. Defensible, but not
	// obvious.
	repo.stored["seeded-one"] = Technique{
		ID: "seeded-one", Name: "Seeded", Category: "Pass",
		Position: "Half Guard - Top", GiNoGi: "Both", Source: "seed",
	}
	repo.sources["seeded-one"] = "seed"
	h := NewContentHandler(repo)

	res := patch(t, h, "seeded-one", `{"name":"Edited"}`)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("editing a seeded row = %d, want 409", res.StatusCode)
	}
	var body struct {
		Error struct{ Message string } `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	if !strings.Contains(body.Error.Message, "techniques.json") {
		t.Errorf("the refusal does not say where to edit it: %q", body.Error.Message)
	}

	// ...and a genuinely absent id is still a 404.
	if res := patch(t, h, "no-such-thing", `{"name":"x"}`); res.StatusCode != http.StatusNotFound {
		t.Errorf("absent id = %d, want 404", res.StatusCode)
	}
}

func TestAPositionOutsideTheCatalogIsRefusedWithTheLegalSet(t *testing.T) {
	repo := newFakeRepo()
	h := NewContentHandler(repo)
	res := post(t, h, `{"name":"Sideways Thing","category":"Pass",
		"position":"Sideways","gi_no_gi":"Both"}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown position = %d, want 400", res.StatusCode)
	}
	var body struct {
		Error struct{ Message string } `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	if !strings.Contains(body.Error.Message, "Half Guard - Top") {
		t.Errorf("the refusal does not name the legal set: %q", body.Error.Message)
	}
}

func TestANameThatSlugsToNothingIsRefusedAtTheHandler(t *testing.T) {
	repo := newFakeRepo()
	h := NewContentHandler(repo)
	res := post(t, h, `{"name":"!!!","category":"Pass",
		"position":"Half Guard - Top","gi_no_gi":"Both"}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("a name that slugs to nothing = %d, want 400 — not a NOT NULL "+
			"violation far from the cause", res.StatusCode)
	}
}
