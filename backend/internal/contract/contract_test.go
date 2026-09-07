// contract_test.go is N168/#545's actual deliverable: a representative
// sample of real HTTP handlers, called the same way cmd/api/main.go wires
// them (RequireAuth + auth.ContextWithClaims, same as every other module's
// own handler_test.go), with their JSON response checked against
// contracts/public.openapi.yaml via this package's Diff.
//
// The sample is seven GET endpoints across seven modules — not the whole
// API. Extending coverage to the rest of the wire surface is a documented
// follow-up (see docs/decisions/history.md's N168 entry), not something this
// first version claims to do:
//
//   - GET /profile              (profile)   — a flat object with many nullable fields
//   - GET /activities           (activity)  — a {activities: [...]} list wrapper
//   - GET /workouts/{workoutID} (workout)   — an object with a nested array of objects
//   - GET /sessions/{sessionID} (session)   — a {session, volume} two-object wrapper
//   - GET /trackers             (tracker)   — a list wrapper, handler also does a write-on-read
//   - GET /nutrition/entries    (nutrition) — an inline (non-$ref) response schema, allOf-composed items
//   - GET /bjj/standing         (bjj)       — allOf on a single nullable property (`current`)
//
// Each fake repository embeds its module's Repository interface (nil) and
// overrides only the method the handler under test actually calls — the
// same "stops before anything unimplemented" convention this repo's other
// handler tests already use (see e.g. tracker/handler_test.go's stubRepo),
// applied via embedding here because several of these interfaces are large
// (session.Repository alone has 22 methods) and every method beyond the one
// under test is intentionally unreachable — calling one would panic on the
// embedded nil interface, which is the point: the test fails loudly rather
// than silently exercising real logic it isn't set up to fake.
package contract

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/modules/activity"
	"github.com/dmytro-ch21/vola/backend/internal/modules/bjj"
	"github.com/dmytro-ch21/vola/backend/internal/modules/nutrition"
	"github.com/dmytro-ch21/vola/backend/internal/modules/profile"
	"github.com/dmytro-ch21/vola/backend/internal/modules/session"
	"github.com/dmytro-ch21/vola/backend/internal/modules/tracker"
	"github.com/dmytro-ch21/vola/backend/internal/modules/workout"
	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// specPath is relative to this package's own directory
// (backend/internal/contract), since `go test` runs with cwd set to the
// package under test: three levels up is the repo root.
const specPath = "../../../contracts/public.openapi.yaml"

func loadRealSpec(t *testing.T) *Spec {
	t.Helper()
	s, err := Load(specPath)
	if err != nil {
		t.Fatalf("loading %s: %v", specPath, err)
	}
	return s
}

func signedIn(req *http.Request, userID string) *http.Request {
	return req.WithContext(auth.ContextWithClaims(req.Context(), &auth.Claims{UserID: userID}))
}

// checkAgainstSpec is the one assertion every subtest below ends with: the
// real response body's field set must match what the spec declares for
// path+method+status.
func checkAgainstSpec(t *testing.T, spec *Spec, method, path, status string, rec *httptest.ResponseRecorder) {
	t.Helper()
	schema, err := spec.ResponseSchema(path, method, status)
	if err != nil {
		t.Fatalf("resolving spec schema for %s %s %s: %v", method, path, status, err)
	}
	problems, err := Diff(schema, rec.Body.Bytes())
	if err != nil {
		t.Fatalf("diffing response against spec: %v\nbody: %s", err, rec.Body.String())
	}
	if len(problems) > 0 {
		t.Fatalf("response for %s %s diverges from contracts/public.openapi.yaml:\n  %s\nbody: %s",
			method, path, strings.Join(problems, "\n  "), rec.Body.String())
	}
}

// ---------------------------------------------------------------- profile

type profileFakeRepo struct {
	profile.Repository
	p *profile.Profile
}

func (f *profileFakeRepo) Get(_ context.Context, _ string) (*profile.Profile, error) {
	return f.p, nil
}

func TestProfileGet_MatchesSpec(t *testing.T) {
	spec := loadRealSpec(t)

	username, displayName, dob, sex, activityLevel := "grappler", "Ada Athlete", "1995-05-01", "female", "active"
	heightCM := 170.0
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	repo := &profileFakeRepo{p: &profile.Profile{
		UserID:                   "user_1",
		Username:                 &username,
		DisplayName:              &displayName,
		DateOfBirth:              &dob,
		Sex:                      &sex,
		HeightCM:                 &heightCM,
		UnitSystem:               "metric",
		TrackEffort:              true,
		ShareTrainingWithFriends: false,
		ShareTrainingDetails:     false,
		ActivityLevel:            &activityLevel,
		CreatedAt:                now,
		UpdatedAt:                now,
	}}
	h := profile.NewHandler(repo, nil)

	req := httptest.NewRequest(http.MethodGet, "/v1/profile", nil)
	req = signedIn(req, "user_1")
	rec := httptest.NewRecorder()
	h.Get(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	checkAgainstSpec(t, spec, "GET", "/profile", "200", rec)
}

// ---------------------------------------------------------------- activity

type activityFakeRepo struct {
	activity.Repository
	items []activity.Activity
}

func (f *activityFakeRepo) ListByUser(_ context.Context, _ string) ([]activity.Activity, error) {
	return f.items, nil
}

func TestActivitiesList_MatchesSpec(t *testing.T) {
	spec := loadRealSpec(t)

	now := time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)
	notes := "Felt strong today"
	repo := &activityFakeRepo{items: []activity.Activity{
		{
			ID:         "a1b2c3d4e5f6a7b8",
			UserID:     "user_1",
			Kind:       "bjj_session",
			OccurredAt: now,
			Notes:      &notes,
			RequestID:  "req_1",
			TraceID:    "trace_1",
			CreatedAt:  now,
		},
	}}
	h := activity.NewHandler(repo)

	req := httptest.NewRequest(http.MethodGet, "/v1/activities", nil)
	req = signedIn(req, "user_1")
	rec := httptest.NewRecorder()
	h.List(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	checkAgainstSpec(t, spec, "GET", "/activities", "200", rec)
}

// ---------------------------------------------------------------- workout

type workoutFakeRepo struct {
	workout.Repository
	w *workout.Workout
}

func (f *workoutFakeRepo) Get(_ context.Context, _, _ string) (*workout.Workout, error) {
	return f.w, nil
}

func TestWorkoutGet_MatchesSpec(t *testing.T) {
	spec := loadRealSpec(t)

	now := time.Date(2026, 9, 1, 9, 0, 0, 0, time.UTC)
	owner := "user_1"
	goal := workout.Goal("hypertrophy")
	repo := &workoutFakeRepo{w: &workout.Workout{
		ID:          "wk1",
		OwnerUserID: &owner,
		Name:        "Push Day A",
		Sport:       workout.Sport("strength"),
		Goal:        &goal,
		Notes:       "",
		Visibility:  workout.Visibility("private"),
		Items: []workout.Item{
			{
				ExerciseID: "barbell-bench-press",
				Position:   0,
				Notes:      "",
			},
		},
		CreatedAt: now,
		UpdatedAt: now,
	}}
	h := workout.NewHandler(repo)

	req := httptest.NewRequest(http.MethodGet, "/v1/workouts/wk1", nil)
	req.SetPathValue("workoutID", "wk1")
	req = signedIn(req, "user_1")
	rec := httptest.NewRecorder()
	h.Get(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	checkAgainstSpec(t, spec, "GET", "/workouts/{workoutID}", "200", rec)
}

// ---------------------------------------------------------------- session

type sessionFakeRepo struct {
	session.Repository
	s *session.Session
}

func (f *sessionFakeRepo) Get(_ context.Context, _, _ string) (*session.Session, error) {
	return f.s, nil
}

func TestSessionGet_MatchesSpec(t *testing.T) {
	spec := loadRealSpec(t)

	now := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	repo := &sessionFakeRepo{s: &session.Session{
		ID:        "s1",
		UserID:    "user_1",
		Sport:     "strength",
		Name:      "Push Day A",
		Intent:    "normal",
		StartedAt: now,
		Notes:     "",
		Sets:      []session.Set{},
		CreatedAt: now,
		UpdatedAt: now,
	}}
	h := session.NewHandler(repo, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/v1/sessions/s1", nil)
	req.SetPathValue("sessionID", "s1")
	req = signedIn(req, "user_1")
	rec := httptest.NewRecorder()
	h.Get(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	checkAgainstSpec(t, spec, "GET", "/sessions/{sessionID}", "200", rec)
}

// ---------------------------------------------------------------- tracker

type trackerFakeRepo struct {
	tracker.Repository
	items []tracker.Tracker
}

func (f *trackerFakeRepo) EnsureDefaults(_ context.Context, _ string, _ []tracker.New) error {
	return nil
}

func (f *trackerFakeRepo) List(_ context.Context, _ string) ([]tracker.Tracker, error) {
	return f.items, nil
}

func TestTrackersList_MatchesSpec(t *testing.T) {
	spec := loadRealSpec(t)

	now := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
	target := 2000.0
	repo := &trackerFakeRepo{items: []tracker.Tracker{
		{
			ID:          "t1",
			UserID:      "user_1",
			Preset:      "water",
			Name:        "Water",
			Icon:        "\U0001F4A7",
			ColorKey:    "blue",
			Unit:        "ml",
			Increment:   250,
			Target:      &target,
			RenderStyle: "bar",
			SortOrder:   0,
			CountNoun:   "cup",
			Provisioned: true,
			CreatedAt:   now,
			UpdatedAt:   now,
		},
	}}
	h := tracker.NewHandler(repo)

	req := httptest.NewRequest(http.MethodGet, "/v1/trackers", nil)
	req = signedIn(req, "user_1")
	rec := httptest.NewRecorder()
	h.List(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	checkAgainstSpec(t, spec, "GET", "/trackers", "200", rec)
}

// ---------------------------------------------------------------- nutrition

type nutritionFakeRepo struct {
	nutrition.Repository
	entries []nutrition.Entry
}

func (f *nutritionFakeRepo) ListEntries(_ context.Context, _, _, _ string, _ int) ([]nutrition.Entry, error) {
	return f.entries, nil
}

func TestNutritionEntriesList_MatchesSpec(t *testing.T) {
	spec := loadRealSpec(t)

	now := time.Date(2026, 9, 1, 12, 30, 0, 0, time.UTC)
	repo := &nutritionFakeRepo{entries: []nutrition.Entry{
		{
			ID:           "e1",
			UserID:       "user_1",
			EatenOn:      "2026-09-01",
			Meal:         "lunch",
			Name:         "Chicken and rice",
			Servings:     1.5,
			ServingLabel: "100 g",
			Macros: nutrition.Macros{
				Kcal:     450,
				ProteinG: 40,
				CarbG:    50,
				FatG:     8,
			},
			Notes:     "",
			CreatedAt: now,
			UpdatedAt: now,
		},
	}}
	h := nutrition.NewHandler(repo)

	req := httptest.NewRequest(http.MethodGet, "/v1/nutrition/entries?from=2026-09-01&to=2026-09-01", nil)
	req = signedIn(req, "user_1")
	rec := httptest.NewRecorder()
	h.ListEntries(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	checkAgainstSpec(t, spec, "GET", "/nutrition/entries", "200", rec)
}

// ---------------------------------------------------------------- bjj

type bjjFakeRepo struct {
	bjj.Repository
	promotions []bjj.Promotion
}

func (f *bjjFakeRepo) ListPromotions(_ context.Context, _ string) ([]bjj.Promotion, error) {
	return f.promotions, nil
}

func TestBjjStanding_MatchesSpec(t *testing.T) {
	spec := loadRealSpec(t)

	// Empty promotions is a real, common state (a brand-new account) and
	// exercises BjjStanding's nullable `current`/`time_at_current_days` —
	// see BjjStanding's allOf-on-a-nullable-property shape in the spec.
	repo := &bjjFakeRepo{promotions: nil}
	h := bjj.NewHandler(repo, nil)

	req := httptest.NewRequest(http.MethodGet, "/v1/bjj/standing", nil)
	req = signedIn(req, "user_1")
	rec := httptest.NewRecorder()
	h.GetStanding(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	checkAgainstSpec(t, spec, "GET", "/bjj/standing", "200", rec)
}
