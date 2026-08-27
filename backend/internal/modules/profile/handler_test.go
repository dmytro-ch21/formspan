package profile

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"encoding/json"
)

// The username guard, tested AT THE CALL SITE.
//
// TestValidUsername covers the function; nothing covered the if-statement that
// calls it — review demonstrated that deleting the handler's guard survived
// the whole suite, and unlike unit_system or sex there is no CHECK constraint
// behind this field: the handler is the only enforcement of format and the
// reserved list. Same claims caveat as workout/handler_test.go: the auth
// context key is unexported, so these cases must stop BEFORE the repository —
// which validation failures do. Delete the guard and these requests fall
// through toward a nil repository instead of returning 400, which is loudly
// red rather than quietly green.
func updateResponse(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(nil, nil) // never reached: every case stops at validation
	req := httptest.NewRequest(http.MethodPatch, "/v1/profile", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.Update(rec, req)
	return rec
}

func TestUpdateRejectsBadUsernamesAtTheHandler(t *testing.T) {
	cases := map[string]string{
		"uppercase": `{"username":"Dmytro"}`,
		"reserved":  `{"username":"admin"}`,
		"too short": `{"username":"ab"}`,
		"leading _": `{"username":"_dmytro"}`,
	}
	for name, body := range cases {
		rec := updateResponse(t, body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d", name, rec.Code)
		}
	}
}

func TestUpdateTrimsBeforeValidating(t *testing.T) {
	// "dmytro " must NOT 400 — the trailing space is the keyboard's, not the
	// user's. It must instead proceed past validation, which with a nil
	// repository means a panic; recovering one here is the assertion that the
	// guard let it through.
	defer func() {
		if recover() == nil {
			t.Fatal("a trimmed-valid username should pass validation and reach the repository")
		}
	}()
	updateResponse(t, `{"username":"dmytro "}`)
}

// The 409 mapping is a CONTRACT property — the code vocabulary is part of the
// wire contract — and it had no test either.
func TestWriteErrorMapsUsernameTaken(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/v1/profile", nil)
	writeError(rec, req, ErrUsernameTaken)

	if rec.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d", rec.Code)
	}
	var out struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Error.Code != "already_exists" {
		t.Errorf("code: want already_exists, got %q", out.Error.Code)
	}
	if out.Error.Message != "that username is taken" {
		t.Errorf("message: want the taken sentence, got %q", out.Error.Message)
	}
}

// lookupRepo is the narrowest possible stub: GetByUsername real, everything
// else unreachable. Lookup never reads claims, so unlike the validation-only
// tests above this one can exercise the FULL handler path.
type lookupRepo struct{ Repository }

func (lookupRepo) GetByUsername(_ context.Context, u string) (*PublicProfile, error) {
	// "vola_official" EXISTS in this stub, deliberately — it simulates a
	// grandfathered row claimed before the shape rule. Review proved the
	// one-404 test could not detect deletion of the handler's pre-DB guard,
	// because the stub 404'd everything anyway: the guard's only observable
	// effect is hiding a STORED violating handle, so the stub must store one.
	if u == "found_user" || u == "vola_official" {
		dn := "Found User"
		return &PublicProfile{Username: u, DisplayName: &dn}, nil
	}
	return nil, ErrNotFound
}

func lookupResponse(t *testing.T, segment string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(lookupRepo{}, nil) // nil store: presentPublic is a no-op with no AvatarKey set anyway
	req := httptest.NewRequest(http.MethodGet, "/v1/users/"+segment, nil)
	req.SetPathValue("username", segment)
	rec := httptest.NewRecorder()
	h.Lookup(rec, req)
	return rec
}

func TestLookupReturnsOnlyThePublicCard(t *testing.T) {
	rec := lookupResponse(t, "found_user")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	// THE test on this endpoint. The first athlete-to-athlete read must ship
	// exactly two keys — asserting on the raw JSON keys, not the struct,
	// because the struct cannot see what an accidental type swap serialises.
	var raw map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, forbidden := range []string{"user_id", "date_of_birth", "sex", "track_effort", "unit_system"} {
		if _, ok := raw[forbidden]; ok {
			t.Errorf("public card leaks %q", forbidden)
		}
	}
	if len(raw) != 2 {
		t.Errorf("public card should be exactly {username, display_name}, got keys %v", raw)
	}
}

func TestLookupNormalisesCase(t *testing.T) {
	// GET /v1/users/FOUND_USER must find found_user — handles are canonical
	// lowercase, humans are not.
	if rec := lookupResponse(t, "FOUND_USER"); rec.Code != http.StatusOK {
		t.Fatalf("case-variant lookup: want 200, got %d", rec.Code)
	}
}

func TestLookupAnswersOne404ForEveryKindOfNothing(t *testing.T) {
	// Absent, malformed and reserved are indistinguishable on purpose: none
	// can be a person, and different answers teach a prober the format and
	// the reserved list one probe at a time.
	for name, seg := range map[string]string{
		"absent":    "nobody_here",
		"malformed": "1_starts_with_digit",
		"reserved":  "admin",
		// The stub RETURNS a card for this one — a grandfathered stored row.
		// The 404 therefore proves the handler's guard, not the repo's miss;
		// delete the guard and this case serves the impersonator.
		"impersonating": "vola_official",
	} {
		if rec := lookupResponse(t, seg); rec.Code != http.StatusNotFound {
			t.Errorf("%s (%q): want 404, got %d", name, seg, rec.Code)
		}
	}
}

func TestImpersonationShapeRule(t *testing.T) {
	refused := []string{"vola_official", "official_vola", "admin2", "vola_1", "dmytro_support", "mod_team1", "admins", "the_mods"}
	for _, u := range refused {
		if ValidUsername(u) {
			t.Errorf("%q should be refused by the shape rule", u)
		}
	}
	// Whole-segment comparison, not substring: these all CONTAIN a token.
	allowed := []string{"modest", "supporter", "adminton_fan", "systemic", "dmytro_bjj"}
	for _, u := range allowed {
		if !ValidUsername(u) {
			t.Errorf("%q should be claimable", u)
		}
	}
}
