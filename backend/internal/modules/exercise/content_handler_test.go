package exercise

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"
)

// Handler-layer tests. The technique module shipped three defects in this exact
// layer before its constructor took an interface — a full-replace PATCH,
// zero-valued timestamps, and an unbounded name — and none of them was reachable
// by a repository test. This file exists so the same three cannot happen here.

type fakeContentRepo struct {
	stored  map[string]Exercise
	sources map[string]string
	// lastWritten is what the handler actually asked to store, which is the
	// thing the partial-update test has to inspect.
	lastWritten Exercise
	adopted     []string
	// lastActor is who the HANDLER said made the write — from the request's
	// claims, never its body.
	lastActor string
	revisions map[string][]Revision
}

func newFakeRepo() *fakeContentRepo {
	return &fakeContentRepo{
		revisions: map[string][]Revision{},
		stored:    map[string]Exercise{},
		sources:   map[string]string{},
	}
}

func (f *fakeContentRepo) GetExercise(_ context.Context, id string) (Exercise, error) {
	e, ok := f.stored[id]
	if !ok {
		return Exercise{}, ErrNotFound
	}
	return e, nil
}

func (f *fakeContentRepo) Source(_ context.Context, id string) (string, error) {
	s, ok := f.sources[id]
	if !ok {
		return "", ErrNotFound
	}
	return s, nil
}

func (f *fakeContentRepo) CreateExercise(_ context.Context, e Exercise, actor string) (Exercise, error) {
	if _, taken := f.stored[e.ID]; taken {
		return Exercise{}, ErrAlreadyExists
	}
	f.lastWritten = e
	f.lastActor = actor
	e.Source = "admin"
	e.CreatedAt, e.UpdatedAt = time.Now(), time.Now()
	f.stored[e.ID] = e
	f.sources[e.ID] = "admin"
	return e, nil
}

func (f *fakeContentRepo) UpdateExercise(_ context.Context, e Exercise, actor string) (Exercise, error) {
	// Absent means absent — the ONLY 404 left. It used to also refuse a row
	// whose source was "seed"; the console edits any row now and the write
	// takes ownership, which is what the next line models.
	if _, ok := f.stored[e.ID]; !ok {
		return Exercise{}, ErrNotFound
	}
	f.lastWritten = e
	f.lastActor = actor
	e.Source = "admin"
	e.UpdatedAt = time.Now()
	f.stored[e.ID] = e
	f.sources[e.ID] = "admin"
	return e, nil
}

func (f *fakeContentRepo) Publish(_ context.Context, id, actor string) (Exercise, error) {
	e, ok := f.stored[id]
	// Mirrors `WHERE status = 'draft'`: publishing something already published
	// is ErrNotFound, not a quiet success.
	if !ok || NormalizeStatus(e.Status) != StatusDraft {
		return Exercise{}, ErrNotFound
	}
	e.Status = StatusPublished
	f.stored[id] = e
	f.record(id, actor, ActionPublish, e)
	return e, nil
}

func (f *fakeContentRepo) SearchAll(_ context.Context, q string) ([]Exercise, error) {
	out := []Exercise{}
	for _, e := range f.stored {
		if strings.Contains(strings.ToLower(e.Name), strings.ToLower(q)) ||
			strings.Contains(strings.ToLower(e.ID), strings.ToLower(q)) {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (f *fakeContentRepo) Revisions(_ context.Context, id string) ([]Revision, error) {
	return f.revisions[id], nil
}

func (f *fakeContentRepo) Restore(_ context.Context, id string, revision int, actor string) (Exercise, error) {
	for _, rev := range f.revisions[id] {
		if rev.Revision == revision {
			e := rev.Payload
			// Mirrors the SQL: content only, never status.
			e.Status = f.stored[id].Status
			// And mirrors its absent-key rule for load_mode. A revision written
			// before the column existed carries no value; letting "" through
			// here would make this fake disagree with the repository about
			// whether restore halves a dumbbell exercise.
			if e.LoadMode == "" {
				e.LoadMode = f.stored[id].LoadMode
			}
			f.stored[id] = e
			f.record(id, actor, ActionRestore, e)
			return e, nil
		}
	}
	return Exercise{}, ErrNotFound
}

// record mirrors recordRevision so the fake's history behaves like the real
// one — including that the actor is whatever the HANDLER passed.
func (f *fakeContentRepo) record(id, actor, action string, e Exercise) {
	f.revisions[id] = append([]Revision{{
		Revision: len(f.revisions[id]) + 1, Actor: actor, Action: action, Payload: e,
	}}, f.revisions[id]...)
}

func (f *fakeContentRepo) AdminAuthored(context.Context) ([]Exercise, error) {
	out := []Exercise{}
	for id, e := range f.stored {
		if f.sources[id] == "admin" {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (f *fakeContentRepo) AdoptAsSeeded(_ context.Context, ids []string) error {
	f.adopted = append(f.adopted, ids...)
	return nil
}

func post(t *testing.T, h *ContentHandler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.Create(rec, httptest.NewRequest(http.MethodPost, "/v1/admin/exercises", strings.NewReader(body)))
	return rec
}

func publish(t *testing.T, h *ContentHandler, id string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/admin/exercises/"+id+"/publish", nil)
	r.SetPathValue("exerciseID", id)
	h.Publish(rec, r)
	return rec
}

func patch(t *testing.T, h *ContentHandler, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPatch, "/v1/admin/exercises/"+id, strings.NewReader(body))
	r.SetPathValue("exerciseID", id)
	h.Update(rec, r)
	return rec
}

// A valid create body, so each test can vary one thing and stay readable.
const validCreate = `{
	"name": "Zercher Squat",
	"sport": "strength",
	"movement_pattern": "squat",
	"load_type": "weight_reps",
	"primary_muscles": ["quadriceps"],
	"instructions": "Bar in the crook of the elbows."
}`

func TestCreateDerivesTheIDFromTheName(t *testing.T) {
	rec := post(t, NewContentHandler(newFakeRepo()), validCreate)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var body struct {
		Exercise Exercise `json:"exercise"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Exercise.ID != "zercher-squat" {
		t.Errorf("id %q, want zercher-squat", body.Exercise.ID)
	}
	if body.Exercise.Source != "admin" {
		t.Errorf("source %q, want admin — the deploy must not own a console row", body.Exercise.Source)
	}
	// The timestamps are the repository's. The technique module shipped these
	// as zero values because the handler built the response itself.
	if body.Exercise.CreatedAt.IsZero() || body.Exercise.UpdatedAt.IsZero() {
		t.Errorf("zero timestamps: created=%v updated=%v",
			body.Exercise.CreatedAt, body.Exercise.UpdatedAt)
	}
}

// PATCH is a PARTIAL update. This is the defect that shipped in the technique
// module: the request decoded into plain values, so a console form posting only
// the edited field wiped every other column.
//
// `is_unilateral` is the one a plain-value decode cannot express at all — false
// and absent are the same value — so it is asserted specifically.
func TestPatchLeavesAbsentFieldsAlone(t *testing.T) {
	repo := newFakeRepo()
	h := NewContentHandler(repo)
	if rec := post(t, h, `{
		"name": "Bulgarian Split Squat",
		"sport": "strength",
		"movement_pattern": "lunge",
		"load_type": "weight_reps",
		"primary_muscles": ["quadriceps", "glutes"],
		"equipment": ["dumbbell"],
		"is_unilateral": true,
		"instructions": "Rear foot elevated."
	}`); rec.Code != http.StatusOK {
		t.Fatalf("seed create: %d %s", rec.Code, rec.Body)
	}

	// Edit ONE field.
	if rec := patch(t, h, "bulgarian-split-squat", `{"movement_pattern":"squat"}`); rec.Code != http.StatusOK {
		t.Fatalf("patch: %d %s", rec.Code, rec.Body)
	}

	got := repo.lastWritten
	if got.MovementPattern != "squat" {
		t.Errorf("movement_pattern %q, want squat", got.MovementPattern)
	}
	if got.Name != "Bulgarian Split Squat" {
		t.Errorf("name was wiped: %q", got.Name)
	}
	if got.Instructions != "Rear foot elevated." {
		t.Errorf("instructions were wiped: %q", got.Instructions)
	}
	if !got.IsUnilateral {
		t.Error("is_unilateral flipped to false — absent must not read as false")
	}
	if len(got.PrimaryMuscles) != 2 || len(got.Equipment) != 1 {
		t.Errorf("lists were wiped: muscles=%v equipment=%v", got.PrimaryMuscles, got.Equipment)
	}
}

// ...and present-but-empty still clears, or a field could never be emptied.
func TestPatchCanClearAList(t *testing.T) {
	repo := newFakeRepo()
	h := NewContentHandler(repo)
	post(t, h, `{"name":"Face Pull","sport":"strength","movement_pattern":"horizontal_pull",
		"load_type":"weight_reps","equipment":["cable","rope"]}`)

	if rec := patch(t, h, "face-pull", `{"equipment":[]}`); rec.Code != http.StatusOK {
		t.Fatalf("patch: %d %s", rec.Code, rec.Body)
	}
	if len(repo.lastWritten.Equipment) != 0 {
		t.Errorf("equipment %v, want cleared", repo.lastWritten.Equipment)
	}
}

func TestCreateRejectsAnUnknownVocabulary(t *testing.T) {
	for _, c := range []struct{ name, body, wants string }{
		{"sport", `{"name":"X","sport":"quidditch","movement_pattern":"squat","load_type":"reps"}`, "quidditch"},
		{"movement_pattern", `{"name":"X","sport":"strength","movement_pattern":"jumping","load_type":"reps"}`, "jumping"},
		{"load_type", `{"name":"X","sport":"strength","movement_pattern":"squat","load_type":"vibes"}`, "vibes"},
	} {
		t.Run(c.name, func(t *testing.T) {
			rec := post(t, NewContentHandler(newFakeRepo()), c.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status %d, want 400: %s", rec.Code, rec.Body)
			}
			// The message must name the offending value. With eleven fields,
			// "invalid input" alone means guessing which one.
			if !strings.Contains(rec.Body.String(), c.wants) {
				t.Errorf("body %s does not name %q", rec.Body, c.wants)
			}
		})
	}
}

// A movement_pattern outside the coarse vocabulary is the worst kind of bad
// data here: it seeds, it renders, and it drops the exercise out of every
// cross-sport rule silently. The message therefore lists the legal set.
func TestTheMovementPatternRefusalListsTheVocabulary(t *testing.T) {
	rec := post(t, NewContentHandler(newFakeRepo()),
		`{"name":"X","sport":"strength","movement_pattern":"jumping","load_type":"reps"}`)
	for _, want := range []string{"squat", "hinge", "isolation"} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("refusal does not offer %q: %s", want, rec.Body)
		}
	}
}

func TestCreateNeedsANameThatSlugs(t *testing.T) {
	for _, c := range []struct{ name, body string }{
		{"absent", `{"sport":"strength","movement_pattern":"squat","load_type":"reps"}`},
		{"punctuation only", `{"name":"!!! ???","sport":"strength","movement_pattern":"squat","load_type":"reps"}`},
	} {
		t.Run(c.name, func(t *testing.T) {
			if rec := post(t, NewContentHandler(newFakeRepo()), c.body); rec.Code != http.StatusBadRequest {
				t.Errorf("status %d, want 400: %s", rec.Code, rec.Body)
			}
		})
	}
}

func TestCreateRefusesADuplicateID(t *testing.T) {
	h := NewContentHandler(newFakeRepo())
	post(t, h, validCreate)
	rec := post(t, h, validCreate)
	if rec.Code != http.StatusConflict {
		t.Errorf("status %d, want 409: %s", rec.Code, rec.Body)
	}
}

// A seeded exercise is EDITABLE from the console now.
//
// Replaces a test asserting a 409 with "edit exercises.json and deploy". That
// was right while the authoring spreadsheet owned the catalog; it was retired
// in 2026-08, so the console is the way to change any row and the write takes
// ownership of it.
func TestASeededExerciseIsEditable(t *testing.T) {
	repo := newFakeRepo()
	// A REALISTIC seeded row. An incomplete one is refused by validation before
	// the behaviour under test runs, so the test would pass on a 400 and prove
	// nothing.
	repo.stored["barbell-back-squat"] = Exercise{
		ID: "barbell-back-squat", Name: "Barbell Back Squat", Sport: "strength",
		MovementPattern: "squat", LoadType: LoadTypeWeightReps,
	}
	repo.sources["barbell-back-squat"] = "seed"

	rec := patch(t, NewContentHandler(repo), "barbell-back-squat", `{"name":"Renamed"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200: %s", rec.Code, rec.Body)
	}
	if got := repo.stored["barbell-back-squat"].Name; got != "Renamed" {
		t.Errorf("the edit did not land: %q", got)
	}
}

func TestPatchingSomethingThatDoesNotExistIs404(t *testing.T) {
	rec := patch(t, NewContentHandler(newFakeRepo()), "no-such-exercise", `{"name":"X"}`)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404: %s", rec.Code, rec.Body)
	}
}

// Renaming must not move the id: it is already a foreign key in workout items
// and logged sets, so a move would orphan them or silently repoint them.
func TestRenamingKeepsTheID(t *testing.T) {
	repo := newFakeRepo()
	h := NewContentHandler(repo)
	post(t, h, validCreate)

	if rec := patch(t, h, "zercher-squat", `{"name":"Front-Rack Squat"}`); rec.Code != http.StatusOK {
		t.Fatalf("patch: %d %s", rec.Code, rec.Body)
	}
	if repo.lastWritten.ID != "zercher-squat" {
		t.Errorf("id moved to %q — training records point at the old one", repo.lastWritten.ID)
	}
	if repo.lastWritten.Name != "Front-Rack Squat" {
		t.Errorf("name did not change: %q", repo.lastWritten.Name)
	}
}

func TestListReturnsOnlyWhatTheConsoleCanEdit(t *testing.T) {
	repo := newFakeRepo()
	repo.stored["authored"] = Exercise{ID: "authored", Name: "Authored"}
	repo.sources["authored"] = "admin"
	repo.stored["barbell-back-squat"] = Exercise{ID: "barbell-back-squat", Name: "Seeded"}
	repo.sources["barbell-back-squat"] = "seed"

	rec := httptest.NewRecorder()
	NewContentHandler(repo).List(rec, httptest.NewRequest(http.MethodGet, "/v1/admin/exercises", nil))

	var body struct {
		Exercises []Exercise `json:"exercises"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Exercises) != 1 || body.Exercises[0].ID != "authored" {
		t.Errorf("got %d exercises, want just the admin-authored one", len(body.Exercises))
	}
}

// `[]`, never `null` — a console mapping over null throws where an empty state
// should render. Driven through a repository that actually returns nil: the
// ordinary fake hardcodes `[]`, so with it the assertion would hold no matter
// what the handler did. That is precisely how the technique module's version of
// this test failed to cover its own property.
func TestListWithNothingAuthoredIsAnEmptyArray(t *testing.T) {
	rec := httptest.NewRecorder()
	NewContentHandler(nilAuthoredRepo{newFakeRepo()}).
		List(rec, httptest.NewRequest(http.MethodGet, "/v1/admin/exercises", nil))

	if got := rec.Body.String(); strings.Contains(got, `"exercises":null`) {
		t.Fatalf("body %s — a nil slice reached the wire as null", got)
	} else if !strings.Contains(got, `"exercises":[]`) {
		t.Errorf("body %s, want an empty array", got)
	}
}

type nilAuthoredRepo struct{ *fakeContentRepo }

func (nilAuthoredRepo) AdminAuthored(context.Context) ([]Exercise, error) { return nil, nil }

// The dropdowns come from the same maps the seeder validates against. A second
// list in the console is how a vocabulary drifts, and the drift is invisible:
// the exercise renders and is silently absent from every rule.
func TestVocabulariesAreTheOnesValidationUses(t *testing.T) {
	rec := httptest.NewRecorder()
	NewContentHandler(newFakeRepo()).
		Vocabularies(rec, httptest.NewRequest(http.MethodGet, "/v1/admin/exercises/vocabularies", nil))

	var body struct {
		Sports           []string `json:"sports"`
		MovementPatterns []string `json:"movement_patterns"`
		LoadTypes        []string `json:"load_types"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.MovementPatterns) != len(validMovementPatterns) {
		t.Errorf("offered %d movement patterns, validator knows %d",
			len(body.MovementPatterns), len(validMovementPatterns))
	}
	if len(body.LoadTypes) != len(validLoadTypes) {
		t.Errorf("offered %d load types, validator knows %d", len(body.LoadTypes), len(validLoadTypes))
	}
	// Every offered value must actually pass validation — the point of serving
	// them at all is that picking one cannot be refused.
	for _, p := range body.MovementPatterns {
		if !validMovementPatterns[p] {
			t.Errorf("offered movement_pattern %q that the validator rejects", p)
		}
	}
	for _, lt := range body.LoadTypes {
		if !validLoadTypes[LoadType(lt)] {
			t.Errorf("offered load_type %q that the validator rejects", lt)
		}
	}
	if len(body.Sports) == 0 {
		t.Error("no sports offered")
	}
	for _, sp := range body.Sports {
		if !discipline.ValidSport(sp) {
			t.Errorf("offered sport %q that the validator rejects", sp)
		}
	}
	if len(body.Sports) != len(discipline.SportKeys()) {
		t.Errorf("offered %d sports, the registry has %d",
			len(body.Sports), len(discipline.SportKeys()))
	}
}

func TestMalformedBodyIsRefused(t *testing.T) {
	if rec := post(t, NewContentHandler(newFakeRepo()), `{"name":`); rec.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400", rec.Code)
	}
}

// The third of the three defects this file exists to prevent. The id is DERIVED
// from the name and permanent — a foreign key in workout items and logged sets —
// so unbounded, a long name either fails on Postgres's btree limit or, worse,
// succeeds and mints an id nobody can take back.
func TestAnUnboundedNameIsRefused(t *testing.T) {
	long := strings.Repeat("a", maxNameLen+1)
	rec := post(t, NewContentHandler(newFakeRepo()),
		`{"name":"`+long+`","sport":"strength","movement_pattern":"squat","load_type":"reps"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400 for a %d-character name: %s", rec.Code, len(long), rec.Body)
	}
	// ...and a name at the bound is fine, so the check is not off by one in the
	// direction that rejects real content. The longest shipped name is 63 chars.
	ok := strings.Repeat("a", maxNameLen)
	if rec := post(t, NewContentHandler(newFakeRepo()),
		`{"name":"`+ok+`","sport":"strength","movement_pattern":"squat","load_type":"reps"}`); rec.Code != http.StatusOK {
		t.Errorf("a name exactly at the bound was refused: %d %s", rec.Code, rec.Body)
	}
}

// The audit trail's whole value is that the writer cannot choose the actor.
//
// This has a twin in the technique package, and the twin is the reason it is
// here: `actorOf` is duplicated per module, so nothing in the suite noticed
// that only one of the two copies was covered. A body field named `actor` must
// reach nothing.
func TestTheRequestBodyCannotChooseTheActor(t *testing.T) {
	repo := newFakeRepo()
	repo.stored["editable"] = Exercise{
		ID: "editable", Name: "Editable", Sport: "strength",
		MovementPattern: "squat", LoadType: LoadTypeReps, Source: "admin",
	}
	repo.sources["editable"] = "admin"

	rec := patch(t, NewContentHandler(repo), "editable",
		`{"name":"Edited","actor":"impostor","source":"seed"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("patch = %d, want 200: %s", rec.Code, rec.Body)
	}
	if repo.lastActor == "impostor" {
		t.Error("the request body set the actor — an audit trail the writer can " +
			"forge records nothing")
	}
	// And it is the documented fallback, not an empty string: these requests
	// carry no claims, so `actorOf` must say so rather than guess.
	if repo.lastActor != "unknown" {
		t.Errorf("actor = %q, want %q — it did not come from the claims path",
			repo.lastActor, "unknown")
	}
	// `source` is equally not the body's to set.
	if repo.stored["editable"].Source != "admin" {
		t.Errorf("source = %q — the body changed ownership", repo.stored["editable"].Source)
	}
}

func TestPublishMakesADraftLiveAndRefusesASecondTime(t *testing.T) {
	repo := newFakeRepo()
	repo.stored["half-written"] = Exercise{
		ID: "half-written", Name: "Half Written", Sport: "strength",
		MovementPattern: "squat", LoadType: LoadTypeReps, Source: "admin",
		Status: StatusDraft,
	}
	repo.sources["half-written"] = "admin"
	h := NewContentHandler(repo)

	if rec := publish(t, h, "half-written"); rec.Code != http.StatusOK {
		t.Fatalf("publish = %d, want 200: %s", rec.Code, rec.Body)
	}
	if got := repo.stored["half-written"].Status; got != StatusPublished {
		t.Errorf("status after publish = %q", got)
	}

	// Already published: a second click must not report success it did not
	// cause. The operator is looking at a stale page, and "done" would tell
	// them the state changed when it did not.
	if rec := publish(t, h, "half-written"); rec.Code != http.StatusNotFound {
		t.Errorf("re-publish = %d, want 404", rec.Code)
	}
	if rec := publish(t, h, "no-such-id"); rec.Code != http.StatusNotFound {
		t.Errorf("publishing an absent id = %d, want 404", rec.Code)
	}
}
