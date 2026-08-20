package tracker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// A stub that records what it was asked to do. Deliberately not a mock of the
// database: what these tests are about is the translation between one HTTP body
// and one Patch, which is where "the phone sent {target: 2500}" becomes "one
// column moves".
type stubRepo struct {
	lastPatch    Patch
	lastNew      New
	lastEntry    NewEntry
	lastTrackerI string
	lastUserID   string
	provisioned  []New
	err          error
}

func (s *stubRepo) EnsureDefaults(_ context.Context, userID string, presets []New) error {
	s.lastUserID = userID
	s.provisioned = presets
	return s.err
}
func (s *stubRepo) List(_ context.Context, userID string) ([]Tracker, error) {
	s.lastUserID = userID
	return []Tracker{{ID: "t1", UserID: userID, Name: "Water"}}, s.err
}
func (s *stubRepo) Create(_ context.Context, userID string, in New) (*Tracker, error) {
	s.lastUserID, s.lastNew = userID, in
	return &Tracker{ID: in.ID, UserID: userID, Preset: in.Preset, Name: in.Name}, s.err
}
func (s *stubRepo) Update(_ context.Context, userID, id string, p Patch) (*Tracker, error) {
	s.lastUserID, s.lastTrackerI, s.lastPatch = userID, id, p
	return &Tracker{ID: id, UserID: userID}, s.err
}
func (s *stubRepo) Archive(_ context.Context, userID, id string) error {
	s.lastUserID, s.lastTrackerI = userID, id
	return s.err
}
func (s *stubRepo) Entries(_ context.Context, userID, _, _ string) ([]Entry, error) {
	s.lastUserID = userID
	return []Entry{}, s.err
}
func (s *stubRepo) LogEntry(_ context.Context, userID, trackerID string, in NewEntry) (*Entry, error) {
	s.lastUserID, s.lastTrackerI, s.lastEntry = userID, trackerID, in
	return &Entry{ID: in.ID, TrackerID: trackerID, UserID: userID,
		LoggedOn: in.LoggedOn, LoggedAt: in.LoggedAt, Amount: in.Amount}, s.err
}
func (s *stubRepo) DeleteEntry(_ context.Context, userID, trackerID, _ string) error {
	s.lastUserID, s.lastTrackerI = userID, trackerID
	return s.err
}

func signedIn(r *http.Request, userID string) *http.Request {
	return r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: userID}))
}

func serve(h *Handler, method, target, body string, route string, vars map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range vars {
		req.SetPathValue(k, v)
	}
	req = signedIn(req, "user_1")
	w := httptest.NewRecorder()
	switch route {
	case "list":
		h.List(w, req)
	case "create":
		h.Create(w, req)
	case "update":
		h.Update(w, req)
	case "archive":
		h.Archive(w, req)
	case "entries":
		h.ListEntries(w, req)
	case "log":
		h.LogEntry(w, req)
	case "delEntry":
		h.DeleteEntry(w, req)
	}
	return w
}

// The phone's "change my target" screen sends exactly this body. Everything
// else about the tracker must be absent from the patch that reaches storage —
// not present-as-zero, absent.
func TestPatchTargetReachesTheRepositoryNamingOnlyTarget(t *testing.T) {
	repo := &stubRepo{}
	h := NewHandler(repo)
	w := serve(h, http.MethodPatch, "/v1/trackers/t1", `{"target":2500}`, "update",
		map[string]string{"trackerID": "t1"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	cols := patchColumns(repo.lastPatch)
	if len(cols) != 1 || cols[0].name != "target" {
		t.Fatalf(`{"target":2500} produced %v — a body naming one field must touch one column`,
			names(cols))
	}
	if repo.lastPatch.Target.Value == nil || *repo.lastPatch.Target.Value != 2500 {
		t.Fatalf("target did not survive the handler: %+v", repo.lastPatch.Target)
	}
}

// A PATCH whose body names nothing we recognise is a client bug, and answering
// 200 to it hides that until somebody looks at the screen.
func TestPatchWithNoKnownFieldIsRejected(t *testing.T) {
	repo := &stubRepo{}
	h := NewHandler(repo)
	for _, body := range []string{`{}`, `{"nope":1}`} {
		w := serve(h, http.MethodPatch, "/v1/trackers/t1", body, "update",
			map[string]string{"trackerID": "t1"})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status %d, want 400", body, w.Code)
		}
	}
}

// A caller must not be able to claim a preset key: doing so would collide with
// provisioning and make somebody's water card unreachable.
func TestCreateIgnoresAClientSuppliedPreset(t *testing.T) {
	repo := &stubRepo{}
	h := NewHandler(repo)
	body := `{"id":"c1","preset":"water","name":"Creatine","color_key":"water",
	          "unit":"g","increment":5,"target":5,"render_style":"dose"}`
	w := serve(h, http.MethodPost, "/v1/trackers", body, "create", nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if repo.lastNew.Preset != "" {
		t.Fatalf("a client claimed preset %q — provisioning would then collide "+
			"with an athlete-authored row", repo.lastNew.Preset)
	}
}

func TestCreateDefaultsRenderStyleToAuto(t *testing.T) {
	repo := &stubRepo{}
	h := NewHandler(repo)
	body := `{"id":"c1","name":"Creatine","color_key":"water","unit":"g","increment":5}`
	if w := serve(h, http.MethodPost, "/v1/trackers", body, "create", nil); w.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if repo.lastNew.RenderStyle != RenderAuto {
		t.Fatalf("render_style = %q, want %q — a tracker with no style must pick "+
			"one from its shape rather than be rejected", repo.lastNew.RenderStyle, RenderAuto)
	}
}

// Listing provisions, and it provisions for the CALLER — never for an id from
// the request.
func TestListProvisionsForTheAuthenticatedAthlete(t *testing.T) {
	repo := &stubRepo{}
	h := NewHandler(repo)
	w := serve(h, http.MethodGet, "/v1/trackers", "", "list", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if repo.lastUserID != "user_1" {
		t.Fatalf("provisioned for %q", repo.lastUserID)
	}
	if len(repo.provisioned) == 0 {
		t.Fatal("nothing provisioned — a new athlete would open Today to an empty list")
	}
	for _, p := range repo.provisioned {
		if p.ID != PresetID("user_1", p.Preset) {
			t.Fatalf("preset %q provisioned with a non-derived id %q — two devices "+
				"would each believe a different id is the water tracker", p.Preset, p.ID)
		}
	}
	var body struct {
		Trackers []Tracker `json:"trackers"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not the {trackers: [...]} envelope: %v", err)
	}
}

// Every route refuses an unauthenticated request. Written as a table so a route
// added later is one line rather than a forgotten one.
func TestEveryRouteRequiresAuth(t *testing.T) {
	h := NewHandler(&stubRepo{})
	routes := []struct {
		name string
		call func(w http.ResponseWriter, r *http.Request)
	}{
		{"list", h.List},
		{"create", h.Create},
		{"update", h.Update},
		{"archive", h.Archive},
		{"entries", h.ListEntries},
		{"log", h.LogEntry},
		{"deleteEntry", h.DeleteEntry},
	}
	for _, rt := range routes {
		t.Run(rt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/trackers", strings.NewReader(`{}`))
			w := httptest.NewRecorder()
			rt.call(w, req) // no claims on the context
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status %d, want 401", w.Code)
			}
		})
	}
}

func TestListEntriesRequiresAWindowAndBoundsIt(t *testing.T) {
	h := NewHandler(&stubRepo{})
	cases := []struct {
		query string
		want  int
	}{
		{"", http.StatusBadRequest},
		{"?from=2026-08-20", http.StatusBadRequest},
		{"?from=2026-8-1&to=2026-08-20", http.StatusBadRequest},
		{"?from=2026-08-21&to=2026-08-20", http.StatusBadRequest},
		{"?from=2020-01-01&to=2026-08-20", http.StatusBadRequest}, // wider than the cap
		// The boundary itself, both sides. The cap counts DATES and both ends
		// are inclusive, so 400 dates is a 399-day span — which is exactly the
		// distinction an off-by-one here moves, and why the pair is asserted
		// rather than one arbitrary wide window.
		{"?from=2025-07-17&to=2026-08-21", http.StatusBadRequest}, // 401 dates
		{"?from=2025-07-18&to=2026-08-21", http.StatusOK},         // 400 dates
		{"?from=2026-08-20&to=2026-08-20", http.StatusOK},
	}
	for _, c := range cases {
		w := serve(h, http.MethodGet, "/v1/trackers/entries"+c.query, "", "entries", nil)
		if w.Code != c.want {
			t.Errorf("%q: status %d, want %d (%s)", c.query, w.Code, c.want, w.Body.String())
		}
	}
}

// The day comes from the client. The timestamp may be defaulted; the day never
// can, because the server does not know the athlete's timezone.
func TestLogEntryNeverInventsTheDay(t *testing.T) {
	repo := &stubRepo{}
	h := NewHandler(repo)

	// No logged_on at all: refused, rather than filled in with a UTC date that
	// is wrong for most of the planet for part of every day.
	w := serve(h, http.MethodPut, "/v1/trackers/t1/entries/e1", `{"amount":250}`, "log",
		map[string]string{"trackerID": "t1", "entryID": "e1"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("a tap with no local day was accepted (%d) — the server would have "+
			"had to guess a timezone", w.Code)
	}

	// With a day and no timestamp: accepted, timestamp defaulted.
	before := time.Now().UTC().Add(-time.Second)
	w = serve(h, http.MethodPut, "/v1/trackers/t1/entries/e1",
		`{"logged_on":"2026-08-20","amount":250}`, "log",
		map[string]string{"trackerID": "t1", "entryID": "e1"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if repo.lastEntry.LoggedOn != "2026-08-20" {
		t.Fatalf("logged_on = %q", repo.lastEntry.LoggedOn)
	}
	if repo.lastEntry.LoggedAt.Before(before) {
		t.Fatalf("logged_at was not defaulted to now: %v", repo.lastEntry.LoggedAt)
	}
	// The id comes from the path, not the body — the path is what the PUT is
	// keyed on, so a body that disagreed would make the request non-idempotent.
	if repo.lastEntry.ID != "e1" {
		t.Fatalf("entry id = %q, want the path value", repo.lastEntry.ID)
	}
}

func TestLogEntryIDComesFromThePathNotTheBody(t *testing.T) {
	repo := &stubRepo{}
	h := NewHandler(repo)
	w := serve(h, http.MethodPut, "/v1/trackers/t1/entries/e1",
		`{"id":"somebody-elses","logged_on":"2026-08-20","amount":250}`, "log",
		map[string]string{"trackerID": "t1", "entryID": "e1"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if repo.lastEntry.ID != "e1" {
		t.Fatalf("a body id overrode the path id: %q", repo.lastEntry.ID)
	}
}

func TestErrorsMapToContractCodes(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{ErrNotFound, http.StatusNotFound, "not_found"},
		{ErrAlreadyExists, http.StatusConflict, "already_exists"},
		{ErrInvalidInput, http.StatusBadRequest, "invalid_input"},
	}
	for _, c := range cases {
		repo := &stubRepo{err: c.err}
		h := NewHandler(repo)
		w := serve(h, http.MethodPatch, "/v1/trackers/t1", `{"target":2500}`, "update",
			map[string]string{"trackerID": "t1"})
		if w.Code != c.status {
			t.Errorf("%v: status %d, want %d", c.err, w.Code, c.status)
		}
		var body struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("%v: response is not the error envelope: %v", c.err, err)
		}
		if body.Error.Code != c.code {
			t.Errorf("%v: code %q, want %q", c.err, body.Error.Code, c.code)
		}
	}
}
