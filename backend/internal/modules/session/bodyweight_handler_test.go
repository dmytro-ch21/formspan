package session

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// detailFakeRepo answers GetDetail and nothing else. Every other method
// reaches the nil embedded interface and panics, so a Get handler that
// quietly went back to a different read would fail here rather than pass.
type detailFakeRepo struct {
	Repository
	session *Session
	bw      *Bodyweight

	calls                 int
	gotUser, gotID, gotTZ string
}

func (f *detailFakeRepo) GetDetail(_ context.Context, userID, id, tz string) (*Session, *Bodyweight, error) {
	f.calls++
	f.gotUser, f.gotID, f.gotTZ = userID, id, tz
	if f.session == nil {
		return nil, nil, ErrNotFound
	}
	return f.session, f.bw, nil
}

func serveGetDetail(t *testing.T, repo Repository, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.SetPathValue("sessionID", "s_bw")
	req = req.WithContext(auth.ContextWithClaims(req.Context(), &auth.Claims{UserID: "user_bw"}))
	rec := httptest.NewRecorder()
	NewHandler(repo, nil, nil).Get(rec, req)
	return rec
}

// Two completed reps-only sets: the shape of 18 pull-ups.
func pullUpDetail() *Session {
	return &Session{
		ID: "s_bw", UserID: "user_bw", Sport: "strength", Name: "Pull day", Intent: IntentNormal,
		StartedAt: time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC),
		Sets: []Set{
			{ExerciseID: "pull-up", Position: 1, SetType: SetTypeWorking, Reps: ptrInt(10), Completed: true},
			{ExerciseID: "pull-up", Position: 2, SetType: SetTypeWorking, Reps: ptrInt(8), Completed: true},
		},
	}
}

func decodeRaw(t *testing.T, rec *httptest.ResponseRecorder) map[string]json.RawMessage {
	t.Helper()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return raw
}

func TestGetHandler_BodyweightTravelsBesideTheSessionAndChangesNoFigure(t *testing.T) {
	repo := &detailFakeRepo{session: pullUpDetail(), bw: &Bodyweight{WeightKg: 82.4, MeasuredOn: "2026-03-10"}}
	rec := serveGetDetail(t, repo, "/v1/sessions/s_bw")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	var body struct {
		Session struct {
			Sets []struct {
				WeightKg *float64 `json:"weight_kg"`
			} `json:"sets"`
		} `json:"session"`
		Volume               Volume   `json:"volume"`
		BodyweightKg         *float64 `json:"bodyweight_kg"`
		BodyweightMeasuredOn *string  `json:"bodyweight_measured_on"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.BodyweightKg == nil || *body.BodyweightKg != 82.4 ||
		body.BodyweightMeasuredOn == nil || *body.BodyweightMeasuredOn != "2026-03-10" {
		t.Fatalf("bodyweight = %v from %v, want 82.4 from 2026-03-10", body.BodyweightKg, body.BodyweightMeasuredOn)
	}

	// Display only: the reading must not reach a set or any figure a set feeds.
	if len(body.Session.Sets) != 2 {
		t.Fatalf("sets = %d, want 2", len(body.Session.Sets))
	}
	for i, s := range body.Session.Sets {
		if s.WeightKg != nil {
			t.Fatalf("set %d weight_kg = %v; bodyweight must never be written into a set", i, *s.WeightKg)
		}
	}
	if body.Volume.TonnageKg != 0 || body.Volume.TotalReps != 18 || body.Volume.WorkingSets != 2 {
		t.Fatalf("volume = %+v, want 0 kg tonnage over 18 reps in 2 sets", body.Volume)
	}

	// Beside the session, not inside it. Write endpoints return a `session`
	// too, and none of them derives this.
	var session map[string]json.RawMessage
	if err := json.Unmarshal(decodeRaw(t, rec)["session"], &session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if _, inside := session["bodyweight_kg"]; inside {
		t.Fatal("bodyweight_kg was put inside `session`; it belongs beside it, like `volume`")
	}
}

func TestGetHandler_NoBodyweightIsAnExplicitNull(t *testing.T) {
	repo := &detailFakeRepo{session: pullUpDetail(), bw: nil}
	rec := serveGetDetail(t, repo, "/v1/sessions/s_bw")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	raw := decodeRaw(t, rec)
	// Present and null. Absent would be indistinguishable from a server too
	// old to send it, and a zero would be an invented number.
	for _, key := range []string{"bodyweight_kg", "bodyweight_measured_on"} {
		v, ok := raw[key]
		if !ok {
			t.Fatalf("%s missing from the response; it must be present as null", key)
		}
		if string(v) != "null" {
			t.Fatalf("%s = %s, want null", key, v)
		}
	}
}

func TestGetHandler_PassesTheCallersZoneAndDefaultsToUTC(t *testing.T) {
	repo := &detailFakeRepo{session: pullUpDetail()}

	if rec := serveGetDetail(t, repo, "/v1/sessions/s_bw"); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if repo.gotTZ != "UTC" {
		t.Fatalf("absent tz reached the repository as %q, want UTC", repo.gotTZ)
	}
	// The owner comes from the verified claims and the id from the path. Never
	// from anything else in the request.
	if repo.gotUser != "user_bw" || repo.gotID != "s_bw" {
		t.Fatalf("repository asked for user %q session %q, want user_bw s_bw", repo.gotUser, repo.gotID)
	}

	if rec := serveGetDetail(t, repo, "/v1/sessions/s_bw?tz=America/Los_Angeles"); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if repo.gotTZ != "America/Los_Angeles" {
		t.Fatalf("tz reached the repository as %q, want America/Los_Angeles", repo.gotTZ)
	}
}

func TestGetHandler_RejectsAnUnusableZoneBeforeReading(t *testing.T) {
	for _, tz := range []string{"Local", "Not/AZone"} {
		repo := &detailFakeRepo{session: pullUpDetail()}
		rec := serveGetDetail(t, repo, "/v1/sessions/s_bw?tz="+tz)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("tz=%s: status = %d, want 400", tz, rec.Code)
		}
		var e struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e.Error.Code != "invalid_input" {
			t.Fatalf("tz=%s: body %s, want error code invalid_input", tz, rec.Body.String())
		}
		if repo.calls != 0 {
			t.Fatalf("tz=%s: the repository was read %d times despite the 400", tz, repo.calls)
		}
	}
}

func TestGetHandler_NotYoursIsStillNotFound(t *testing.T) {
	rec := serveGetDetail(t, &detailFakeRepo{session: nil}, "/v1/sessions/s_bw?tz=UTC")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body %s", rec.Code, rec.Body.String())
	}
}
