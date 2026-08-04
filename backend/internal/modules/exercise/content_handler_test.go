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
}

func newFakeRepo() *fakeContentRepo {
	return &fakeContentRepo{
		stored:  map[string]Exercise{},
		sources: map[string]string{},
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

func (f *fakeContentRepo) CreateExercise(_ context.Context, e Exercise) (Exercise, error) {
	if _, taken := f.stored[e.ID]; taken {
		return Exercise{}, ErrAlreadyExists
	}
	f.lastWritten = e
	e.Source = "admin"
	e.CreatedAt, e.UpdatedAt = time.Now(), time.Now()
	f.stored[e.ID] = e
	f.sources[e.ID] = "admin"
	return e, nil
}

func (f *fakeContentRepo) UpdateExercise(_ context.Context, e Exercise) (Exercise, error) {
	if f.sources[e.ID] != "admin" {
		return Exercise{}, ErrNotFound
	}
	f.lastWritten = e
	e.Source = "admin"
	e.UpdatedAt = time.Now()
	f.stored[e.ID] = e
	return e, nil
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

// A seeded id gets an explanation, not a bare 404. The fix is completely
// different — edit the JSON and deploy — and a 404 for a row the console is
// displaying reads as a bug.
func TestPatchingASeededExerciseExplainsItself(t *testing.T) {
	repo := newFakeRepo()
	// A REALISTIC seeded row. An incomplete one is refused by validation before
	// the ownership check ever runs, so the test would pass on a 400 and prove
	// nothing about the seeded case.
	repo.stored["barbell-back-squat"] = Exercise{
		ID: "barbell-back-squat", Name: "Barbell Back Squat", Sport: "strength",
		MovementPattern: "squat", LoadType: LoadTypeWeightReps,
	}
	repo.sources["barbell-back-squat"] = "seed"

	rec := patch(t, NewContentHandler(repo), "barbell-back-squat", `{"name":"Renamed"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409: %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "exercises.json") {
		t.Errorf("the refusal does not say where to make the change: %s", rec.Body)
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
}

func TestMalformedBodyIsRefused(t *testing.T) {
	if rec := post(t, NewContentHandler(newFakeRepo()), `{"name":`); rec.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400", rec.Code)
	}
}
