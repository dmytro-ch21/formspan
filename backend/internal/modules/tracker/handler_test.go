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
	// Which removal path the handler chose. Two booleans rather than one enum
	// so that "neither ran" and "both ran" are both visible states — a test
	// asserting `destroyed == true` alone would pass on a handler that archived
	// as well, which is exactly the confusion `?purge=true` exists to prevent.
	archived  bool
	destroyed bool
	restored  bool
	// Set when List was asked for the archived side.
	listedArchived bool
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
	s.lastUserID, s.lastTrackerI, s.archived = userID, id, true
	return s.err
}
func (s *stubRepo) AddPreset(_ context.Context, userID string, in New) (*Tracker, error) {
	s.lastUserID, s.lastNew = userID, in
	return &Tracker{ID: in.ID, UserID: userID, Preset: in.Preset, Name: in.Name}, s.err
}
func (s *stubRepo) ListArchived(_ context.Context, userID string) ([]Tracker, error) {
	s.lastUserID, s.listedArchived = userID, true
	now := time.Now()
	return []Tracker{{ID: "t9", UserID: userID, Name: "Creatine", ArchivedAt: &now}}, s.err
}
func (s *stubRepo) Restore(_ context.Context, userID, id string) error {
	s.lastUserID, s.lastTrackerI, s.restored = userID, id, true
	return s.err
}
func (s *stubRepo) Destroy(_ context.Context, userID, id string) error {
	s.lastUserID, s.lastTrackerI, s.destroyed = userID, id, true
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
	case "restore":
		h.Restore(w, req)
	case "presets":
		h.ListPresets(w, req)
	case "addPreset":
		h.AddPreset(w, req)
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

// DELETE archives. DELETE ?purge=true destroys. NOTHING ELSE destroys.
//
// **The vectors are the point of this test**, and they are chosen to be the ones
// a plausible-but-wrong implementation gets wrong rather than a set that all
// have the same shape. Every truthy-looking spelling short of the exact literal
// must archive, because the whole safety argument for putting a destructive
// path behind a query parameter is that the parameter is read strictly:
//
//   - `Query().Has("purge")`               would destroy on `?purge=false`
//   - `strconv.ParseBool`                  would destroy on `?purge=1` and `?purge=TRUE`
//   - a case-insensitive compare           would destroy on `?purge=TRUE`
//   - `!= ""`                              would destroy on `?purge=no`
//
// Each of those is a reasonable thing to write and each one loses somebody's
// history. A test whose vectors were only `?purge=true` and no parameter at all
// would pass against all four.
func TestOnlyTheExactPurgeLiteralDestroys(t *testing.T) {
	archiving := []string{
		"/v1/trackers/t1",
		"/v1/trackers/t1?purge=false",
		"/v1/trackers/t1?purge=1",
		"/v1/trackers/t1?purge=TRUE",
		"/v1/trackers/t1?purge=True",
		"/v1/trackers/t1?purge=yes",
		"/v1/trackers/t1?purge=no",
		"/v1/trackers/t1?purge=",
		"/v1/trackers/t1?purge",
		"/v1/trackers/t1?purged=true",
	}
	for _, target := range archiving {
		repo := &stubRepo{}
		w := serve(NewHandler(repo), http.MethodDelete, target, "", "archive",
			map[string]string{"trackerID": "t1"})
		if w.Code != http.StatusNoContent {
			t.Fatalf("%s: status %d, want 204", target, w.Code)
		}
		if repo.destroyed {
			t.Fatalf("%s DESTROYED the tracker. Only the exact literal "+
				"?purge=true may reach Destroy — everything else, including every "+
				"other spelling of true, must archive.", target)
		}
		if !repo.archived {
			t.Fatalf("%s reached neither Archive nor Destroy", target)
		}
	}

	repo := &stubRepo{}
	w := serve(NewHandler(repo), http.MethodDelete, "/v1/trackers/t1?purge=true", "", "archive",
		map[string]string{"trackerID": "t1"})
	if w.Code != http.StatusNoContent {
		t.Fatalf("purge=true: status %d, want 204", w.Code)
	}
	if !repo.destroyed {
		t.Fatal("?purge=true did not reach Destroy — the destructive path is unreachable, " +
			"which makes every archiving case above pass for the wrong reason")
	}
	if repo.archived {
		t.Fatal("?purge=true archived as well as destroyed")
	}
}

// The mirror of the above, on the read side: `?archived=true` and nothing else
// switches List onto the stopped trackers. A loose parse here is less dangerous
// but it is the same bug, and `?archived=0` reading as "yes" would show an
// athlete an empty Today.
func TestOnlyTheExactArchivedLiteralListsArchived(t *testing.T) {
	for _, target := range []string{
		"/v1/trackers",
		"/v1/trackers?archived=false",
		"/v1/trackers?archived=0",
		"/v1/trackers?archived=1",
		"/v1/trackers?archived=TRUE",
		"/v1/trackers?archived=",
		"/v1/trackers?archived",
	} {
		repo := &stubRepo{}
		w := serve(NewHandler(repo), http.MethodGet, target, "", "list", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d", target, w.Code)
		}
		if repo.listedArchived {
			t.Fatalf("%s listed the ARCHIVED trackers — only ?archived=true may", target)
		}
		if repo.provisioned == nil {
			t.Fatalf("%s did not provision; the live list is the one that provisions", target)
		}
	}

	repo := &stubRepo{}
	w := serve(NewHandler(repo), http.MethodGet, "/v1/trackers?archived=true", "", "list", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("archived=true: status %d", w.Code)
	}
	if !repo.listedArchived {
		t.Fatal("?archived=true did not reach ListArchived — the archived screen has no source, " +
			"and every case above passes for the wrong reason")
	}
	// Provisioning on this branch would hand an athlete a water card while they
	// are looking at the trackers they deliberately turned off.
	if repo.provisioned != nil {
		t.Fatal("the archived list provisioned the default presets")
	}
}

// The cap is a conflict with state the athlete already has, not a malformed
// request, and the status has to say so — a 400 reads as "your client is
// broken" and an outbox that classifies 4xx as permanent would drop the
// tracker rather than surfacing "stop one first".
func TestTheCapIsAConflictNotABadRequest(t *testing.T) {
	repo := &stubRepo{err: ErrTooMany}
	w := serve(NewHandler(repo), http.MethodPost, "/v1/trackers",
		`{"id":"x1","name":"Creatine","color_key":"mint","increment":5}`, "create", nil)
	if w.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409 — the cap is a conflict with existing state", w.Code)
	}
	var body struct {
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body did not decode: %v", err)
	}
	if body.Error.Code != "already_exists" {
		t.Fatalf("code %q — the error codes are a closed set and 409 carries "+
			"already_exists", body.Error.Code)
	}
}

// Restore is reachable and names the tracker it was given. Thin, and here
// because an unrouted handler is invisible to every other test in this file.
func TestRestoreReachesTheRepository(t *testing.T) {
	repo := &stubRepo{}
	w := serve(NewHandler(repo), http.MethodPost, "/v1/trackers/t9/restore", "", "restore",
		map[string]string{"trackerID": "t9"})
	if w.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", w.Code)
	}
	if !repo.restored || repo.lastTrackerI != "t9" {
		t.Fatalf("restore did not reach the repository with t9: restored=%v id=%q",
			repo.restored, repo.lastTrackerI)
	}
}

// A client may not reach a preset that is not in the compiled catalogue, and
// may not reach a DEFAULT one through this route.
//
// **The vectors are the ones that matter, not a happy path.** `AddPreset` is
// the only route in the module that legitimately mints an id in the reserved
// `t_` namespace — `POST /v1/trackers` refuses those precisely because they are
// derived from a public user id — so what stops it being a way around that
// guard is that the KEY is looked up in a compiled list and every field comes
// from the literal. A key that is not in the list must not reach the
// repository at all.
func TestAddPresetOnlyAcceptsAKeyTheServerShips(t *testing.T) {
	// The KEY is varied, not the URL: the handler reads `r.PathValue`, and the
	// router has already decoded and split the path by the time it runs. Some of
	// these are not legal in a URL at all, which is the point — a malformed key
	// must be refused by the lookup rather than relied on to be unroutable.
	for _, key := range []string{
		"nope",     // not a preset
		"water",    // a DEFAULT preset: provisioned by List, not added here
		"",         // empty
		"../water", // path-ish
		"WATER",    // case must not be folded
		"water ",   // nor trimmed
	} {
		repo := &stubRepo{}
		w := serve(NewHandler(repo), http.MethodPost, "/v1/tracker-presets/x", "", "addPreset",
			map[string]string{"presetKey": key})
		if w.Code != http.StatusNotFound {
			t.Fatalf("key %q: status %d, want 404", key, w.Code)
		}
		if repo.lastNew.ID != "" {
			t.Fatalf("key %q reached the repository with id %q — an unknown or "+
				"default key must never produce a write, and this route is the one "+
				"place a t_ id is minted", key, repo.lastNew.ID)
		}
	}
}

// The other half: a real non-default preset DOES go through, with everything
// taken from the compiled literal and an id derived server-side.
//
// Guarded on the catalogue being non-empty rather than asserted blindly. Coffee
// (N77) is the first non-default preset and has not merged here yet, so on this
// branch the catalogue is empty by design — a test that required a row would be
// asserting the presence of somebody else's unmerged work. It reads a synthetic
// one instead, so the PATH is exercised either way.
func TestAddPresetPassesTheCompiledFieldsAndADerivedID(t *testing.T) {
	real := NonDefaultPresets()
	if len(real) == 0 {
		t.Log("no non-default preset ships yet (coffee, N77, is unmerged) — " +
			"exercising the lookup and derivation directly")
	}
	// The derivation itself, which is what the handler does with the key.
	id := PresetID("user_1", "coffee")
	if !strings.HasPrefix(id, PresetIDPrefix) {
		t.Fatalf("PresetID produced %q, which is outside the reserved namespace", id)
	}
	if PresetID("user_2", "coffee") == id {
		t.Fatal("two athletes derived the same preset id")
	}
	for _, p := range real {
		repo := &stubRepo{}
		w := serve(NewHandler(repo), http.MethodPost, "/v1/tracker-presets/x", "", "addPreset",
			map[string]string{"presetKey": p.Key})
		if w.Code != http.StatusOK {
			t.Fatalf("preset %q: status %d: %s", p.Key, w.Code, w.Body.String())
		}
		if repo.lastNew.ID != PresetID("user_1", p.Key) {
			t.Fatalf("preset %q: id %q is not the one derived from the caller's own "+
				"user id — a client-influenced id here would be the squatting hazard "+
				"DefaultsFor documents", p.Key, repo.lastNew.ID)
		}
		if repo.lastNew.Preset != p.Key || repo.lastNew.Name != p.Fields.Name {
			t.Fatalf("preset %q: fields did not come from the compiled literal: %+v",
				p.Key, repo.lastNew)
		}
	}
}

// The catalogue never offers a preset the athlete is given automatically.
// Offering water would put a second route onto a row List already provisions.
func TestPresetCatalogueOffersOnlyTheOptionalOnes(t *testing.T) {
	w := serve(NewHandler(&stubRepo{}), http.MethodGet, "/v1/tracker-presets", "", "presets", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	var body struct {
		Presets []struct {
			Preset string `json:"preset"`
		} `json:"presets"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body did not decode: %v", err)
	}
	// `[]` and not `null`: a client mapping over the response must not have to
	// guard, same convention as the trackers and entries lists.
	if !strings.Contains(w.Body.String(), `"presets":[`) {
		t.Fatalf("presets did not serialise as an array: %s", w.Body.String())
	}
	defaults := map[string]bool{}
	for _, p := range Presets() {
		if p.Default {
			defaults[p.Key] = true
		}
	}
	if len(defaults) == 0 {
		t.Fatal("no preset is provisioned by default any more — this test would " +
			"then pass vacuously, so it fails instead")
	}
	for _, p := range body.Presets {
		if defaults[p.Preset] {
			t.Fatalf("the catalogue offered %q, which every athlete is already given",
				p.Preset)
		}
	}
	if len(body.Presets) != len(NonDefaultPresets()) {
		t.Fatalf("catalogue has %d entries, %d presets are non-default",
			len(body.Presets), len(NonDefaultPresets()))
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
