package technique

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
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
	// lastActor is who the HANDLER said made the write. The audit trail's whole
	// value is that this comes from the request's claims rather than its body,
	// so a test has to be able to see what the handler passed.
	lastActor string
	revisions map[string][]Revision
}

func newFakeRepo() *fakeContentRepo {
	return &fakeContentRepo{
		stored:    map[string]Technique{},
		revisions: map[string][]Revision{},
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

func (f *fakeContentRepo) Publish(_ context.Context, id, actor string) (Technique, error) {
	t, ok := f.stored[id]
	// Mirrors the SQL's `WHERE status = 'draft'`: publishing something already
	// published is ErrNotFound, not a quiet success.
	if !ok || NormalizeStatus(t.Status) != StatusDraft {
		return Technique{}, ErrNotFound
	}
	t.Status = StatusPublished
	f.stored[id] = t
	return t, nil
}

func (f *fakeContentRepo) RetireTechnique(_ context.Context, id, actor string) (Technique, error) {
	t, ok := f.stored[id]
	// Mirrors the SQL's `WHERE status = 'published'`.
	if !ok || NormalizeStatus(t.Status) != StatusPublished {
		return Technique{}, ErrNotFound
	}
	t.Status = StatusRetired
	f.stored[id] = t
	f.record(id, actor, ActionRetire, t)
	return t, nil
}

func (f *fakeContentRepo) ReactivateTechnique(_ context.Context, id, actor string) (Technique, error) {
	t, ok := f.stored[id]
	// Mirrors the SQL's `WHERE status = 'retired'`.
	if !ok || t.Status != StatusRetired {
		return Technique{}, ErrNotFound
	}
	t.Status = StatusPublished
	f.stored[id] = t
	f.record(id, actor, ActionReactivate, t)
	return t, nil
}

func (f *fakeContentRepo) Revisions(_ context.Context, id string) ([]Revision, error) {
	return f.revisions[id], nil
}

func (f *fakeContentRepo) Restore(_ context.Context, id string, revision int, actor string) (Technique, error) {
	for _, rev := range f.revisions[id] {
		if rev.Revision == revision {
			t := rev.Payload
			// Mirrors the SQL: content only, never status.
			t.Status = f.stored[id].Status
			f.stored[id] = t
			f.record(id, actor, ActionRestore, t)
			return t, nil
		}
	}
	return Technique{}, ErrNotFound
}

// record mirrors recordRevision so the fake's history behaves like the real
// one — including that the actor is whatever the HANDLER passed.
func (f *fakeContentRepo) record(id, actor, action string, t Technique) {
	f.revisions[id] = append([]Revision{{
		Revision: len(f.revisions[id]) + 1, Actor: actor, Action: action, Payload: t,
	}}, f.revisions[id]...)
}

func (f *fakeContentRepo) SearchAll(_ context.Context, q string) ([]Technique, error) {
	out := []Technique{}
	for _, t := range f.stored {
		if strings.Contains(strings.ToLower(t.Name), strings.ToLower(q)) ||
			strings.Contains(strings.ToLower(t.ID), strings.ToLower(q)) {
			out = append(out, t)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (f *fakeContentRepo) AdminAuthored(context.Context) ([]Technique, error) {
	out := []Technique{}
	for id, t := range f.stored {
		if f.sources[id] == "admin" {
			out = append(out, t)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (f *fakeContentRepo) CreateTechnique(_ context.Context, t Technique, actor string) (Technique, error) {
	if _, taken := f.stored[t.ID]; taken {
		return Technique{}, ErrAlreadyExists
	}
	f.lastWritten = t
	f.lastActor = actor
	t.Source = "admin"
	t.CreatedAt = time.Now()
	t.UpdatedAt = t.CreatedAt
	f.stored[t.ID] = t
	f.sources[t.ID] = "admin"
	return t, nil
}

func (f *fakeContentRepo) UpdateTechnique(_ context.Context, t Technique, actor string) (Technique, error) {
	// Absent means absent — the ONLY 404 left. It used to also refuse a row
	// whose source was "seed"; the console edits any row now and the write
	// takes ownership, which is what the next line models.
	if _, ok := f.stored[t.ID]; !ok {
		return Technique{}, ErrNotFound
	}
	f.lastWritten = t
	f.lastActor = actor
	t.Source = "admin"
	t.UpdatedAt = time.Now()
	f.stored[t.ID] = t
	f.sources[t.ID] = "admin"
	return t, nil
}

func publish(t *testing.T, h *ContentHandler, id string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/admin/techniques/"+id+"/publish", nil)
	req.SetPathValue("techniqueID", id)
	rec := httptest.NewRecorder()
	h.Publish(rec, req)
	return rec.Result()
}

func retire(t *testing.T, h *ContentHandler, id string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/admin/techniques/"+id+"/retire", nil)
	req.SetPathValue("techniqueID", id)
	rec := httptest.NewRecorder()
	h.Retire(rec, req)
	return rec.Result()
}

func reactivate(t *testing.T, h *ContentHandler, id string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/admin/techniques/"+id+"/reactivate", nil)
	req.SetPathValue("techniqueID", id)
	rec := httptest.NewRecorder()
	h.Reactivate(rec, req)
	return rec.Result()
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

// A seeded technique is EDITABLE from the console now, and the write takes
// ownership of it.
//
// This replaces a test asserting a 409 with "edit techniques.json instead".
// That refusal was right while the authoring spreadsheet owned 450 of the 542
// rows; with the spreadsheet retired the console is the way to change any of
// them, so the only 404 left is an id that does not exist.
// Publishing is a route, and a stale view gets a 404 rather than a fake success.
// The audit trail's whole value is that the actor cannot be chosen by the thing
// being audited.
//
// This asserts the negative, which is the one that matters: a body field named
// `actor` must not reach the revision. It cannot assert the positive — the
// claims context key is unexported, so a test in this package cannot inject a
// signed-in caller, and `actorOf` falls back to "unknown". The integration test
// covers attribution with a real actor; this covers the attack.
func TestTheRequestBodyCannotChooseTheActor(t *testing.T) {
	repo := newFakeRepo()
	repo.stored["editable"] = Technique{
		ID: "editable", Name: "Editable", Category: "Pass",
		Position: "Half Guard - Top", GiNoGi: "Both", Source: "admin",
	}
	repo.sources["editable"] = "admin"

	res := patch(t, NewContentHandler(repo), "editable",
		`{"name":"Edited","actor":"impostor","source":"seed"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("patch = %d, want 200", res.StatusCode)
	}
	if repo.lastActor == "impostor" {
		t.Error("the request body set the actor — an audit trail the writer can " +
			"forge records nothing")
	}
	// ...and `source` is equally not the body's to set.
	if repo.stored["editable"].Source != "admin" {
		t.Errorf("source = %q — the body changed ownership", repo.stored["editable"].Source)
	}
}

func TestPublishMakesADraftLiveAndRefusesASecondTime(t *testing.T) {
	repo := newFakeRepo()
	repo.stored["half-written"] = Technique{
		ID: "half-written", Name: "Half Written", Category: "Pass",
		Position: "Half Guard - Top", GiNoGi: "Both", Source: "admin",
		Status: StatusDraft,
	}
	repo.sources["half-written"] = "admin"
	h := NewContentHandler(repo)

	res := publish(t, h, "half-written")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("publish = %d, want 200", res.StatusCode)
	}
	if got := repo.stored["half-written"].Status; got != StatusPublished {
		t.Errorf("status after publish = %q", got)
	}

	// Already published, and a second click must not report success it did not
	// cause — the operator is looking at a stale page.
	if res := publish(t, h, "half-written"); res.StatusCode != http.StatusNotFound {
		t.Errorf("re-publish = %d, want 404", res.StatusCode)
	}
	if res := publish(t, h, "no-such-id"); res.StatusCode != http.StatusNotFound {
		t.Errorf("publishing an absent id = %d, want 404", res.StatusCode)
	}
}

// TestRetireAndReactivateRoundTrip is the admin-console half of F23/#523's
// acceptance criteria: this is the HTTP-handler-level exercise of "the admin
// console is the trigger", not a bare repository call.
func TestRetireAndReactivateRoundTrip(t *testing.T) {
	repo := newFakeRepo()
	repo.stored["armbar-from-mount"] = Technique{
		ID: "armbar-from-mount", Name: "Armbar From Mount", Category: "Submission",
		Position: "Mount - Top", GiNoGi: "Both", Source: "admin",
		Status: StatusPublished,
	}
	repo.sources["armbar-from-mount"] = "admin"
	h := NewContentHandler(repo)

	// A draft cannot be retired — it was never live, so there is nothing to
	// withdraw.
	repo.stored["draft-only"] = Technique{
		ID: "draft-only", Name: "Draft Only", Category: "Pass",
		Position: "Half Guard - Top", GiNoGi: "Both", Status: StatusDraft,
	}
	if res := retire(t, h, "draft-only"); res.StatusCode != http.StatusNotFound {
		t.Errorf("retiring a draft = %d, want 404", res.StatusCode)
	}

	res := retire(t, h, "armbar-from-mount")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("retire = %d, want 200", res.StatusCode)
	}
	if got := repo.stored["armbar-from-mount"].Status; got != StatusRetired {
		t.Errorf("status after retire = %q, want retired", got)
	}

	// Retiring twice is a stale-view 404, matching Publish's own convention —
	// not a silent no-op reporting success it did not cause.
	if res := retire(t, h, "armbar-from-mount"); res.StatusCode != http.StatusNotFound {
		t.Errorf("re-retiring = %d, want 404", res.StatusCode)
	}
	if res := retire(t, h, "no-such-id"); res.StatusCode != http.StatusNotFound {
		t.Errorf("retiring an absent id = %d, want 404", res.StatusCode)
	}

	// UNLIKE publish, retiring is reversible.
	res = reactivate(t, h, "armbar-from-mount")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reactivate = %d, want 200", res.StatusCode)
	}
	if got := repo.stored["armbar-from-mount"].Status; got != StatusPublished {
		t.Errorf("status after reactivate = %q, want published", got)
	}
	if res := reactivate(t, h, "armbar-from-mount"); res.StatusCode != http.StatusNotFound {
		t.Errorf("reactivating an already-published technique = %d, want 404", res.StatusCode)
	}

	// The audit trail says which of the two verbs happened, not just "an edit".
	revs := repo.revisions["armbar-from-mount"]
	if len(revs) < 2 || revs[0].Action != ActionReactivate || revs[1].Action != ActionRetire {
		t.Fatalf("revisions = %+v, want [reactivate, retire, ...] newest first", revs)
	}
}

func TestASeededTechniqueIsEditable(t *testing.T) {
	repo := newFakeRepo()
	// A COMPLETE row. The first version of this fixture omitted
	// category/position/gi_no_gi, and the request 400'd on validation before
	// reaching the behaviour under test — which exposed a real property worth
	// knowing: the merged row is re-validated, so a stored technique that fails
	// current validation cannot be edited until its data is fixed.
	repo.stored["seeded-one"] = Technique{
		ID: "seeded-one", Name: "Seeded", Category: "Pass",
		Position: "Half Guard - Top", GiNoGi: "Both", Source: "seed",
	}
	repo.sources["seeded-one"] = "seed"
	h := NewContentHandler(repo)

	res := patch(t, h, "seeded-one", `{"name":"Edited"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("editing a seeded row = %d, want 200", res.StatusCode)
	}
	if got := repo.stored["seeded-one"].Name; got != "Edited" {
		t.Errorf("the edit did not land: %q", got)
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

// The default list is what the console AUTHORED, not the catalog — every row is
// editable now, so the reason is payload rather than actionability: 542 full
// rows is ~570 KB of prose. Search (`?q=`) is how the rest are reached.
func TestListReturnsOnlyWhatTheConsoleCanEdit(t *testing.T) {
	repo := newFakeRepo()
	repo.stored["authored-one"] = Technique{ID: "authored-one", Name: "Authored One"}
	repo.sources["authored-one"] = "admin"
	repo.stored["knee-cut-pass"] = Technique{ID: "knee-cut-pass", Name: "Knee Cut Pass"}
	repo.sources["knee-cut-pass"] = "seed"

	rec := httptest.NewRecorder()
	NewContentHandler(repo).List(rec, httptest.NewRequest(http.MethodGet, "/v1/admin/techniques", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200: %s", rec.Code, rec.Body)
	}
	var body struct {
		Techniques []Technique `json:"techniques"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Techniques) != 1 || body.Techniques[0].ID != "authored-one" {
		t.Errorf("got %d techniques (%v), want just the admin-authored one",
			len(body.Techniques), idsOf(body.Techniques))
	}
}

// An empty result is `[]`, never `null`. A console mapping over null throws
// where an empty state should render, and "you have not authored anything yet"
// is the first thing a new operator sees — plus the state every environment
// returns to after `-adopt` drains the set.
//
// The repository is deliberately made to return a NIL slice here. An earlier
// version of this test used the ordinary fake, which hardcodes `[]` exactly
// like the Postgres implementation does — so the assertion held no matter what
// the handler did, and review demonstrated it by deleting the guarantee from
// the repository and watching the suite stay green. The property is the
// handler's now, and this is what proves it.
func TestListWithNothingAuthoredIsAnEmptyArray(t *testing.T) {
	rec := httptest.NewRecorder()
	NewContentHandler(nilAuthoredRepo{newFakeRepo()}).
		List(rec, httptest.NewRequest(http.MethodGet, "/v1/admin/techniques", nil))

	got := rec.Body.String()
	if strings.Contains(got, `"techniques":null`) {
		t.Fatalf("body %s — a nil slice reached the wire as null", got)
	}
	if !strings.Contains(got, `"techniques":[]`) {
		t.Errorf("body %s, want an empty array", got)
	}
}

// nilAuthoredRepo is a repository that returns nil rather than an empty slice —
// what any implementation that forgets the convention does, and what `var out
// []Technique` produces.
type nilAuthoredRepo struct{ *fakeContentRepo }

func (nilAuthoredRepo) AdminAuthored(context.Context) ([]Technique, error) {
	return nil, nil
}

func idsOf(ts []Technique) []string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.ID)
	}
	return out
}
