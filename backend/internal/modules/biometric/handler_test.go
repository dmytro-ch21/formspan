package biometric

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

// Validation-only tests: every case here must stop BEFORE the repository —
// the auth context key is unexported (see auth.ContextWithClaims's doc
// comment), so a nil Repository panicking is how a request that reached it
// unexpectedly would be caught. Matches profile/handler_test.go's stance.

func putSamplesResponse(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(nil) // never reached: every case here stops at validation
	req := httptest.NewRequest(http.MethodPost, "/v1/biometric/samples", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.PutSamples(rec, req)
	return rec
}

func TestPutSamples_RejectsInvalidJSON(t *testing.T) {
	rec := putSamplesResponse(t, `{not json`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestPutSamples_RejectsEmptySampleList(t *testing.T) {
	rec := putSamplesResponse(t, `{"samples":[]}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestPutSamples_RejectsBadTimestamp(t *testing.T) {
	body := `{"samples":[{"id":"s1","metric_type":"heart_rate","source":"apple_watch",` +
		`"source_platform":"healthkit","value":150,"unit":"bpm","measured_at":"not-a-date"}]}`
	rec := putSamplesResponse(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestPutSamples_RejectsUnknownMetricType(t *testing.T) {
	body := `{"samples":[{"id":"s1","metric_type":"bogus","source":"apple_watch",` +
		`"source_platform":"healthkit","value":150,"unit":"bpm","measured_at":"2026-09-01T10:00:00Z"}]}`
	rec := putSamplesResponse(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
	var out struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Error.Code != "invalid_input" {
		t.Errorf("code = %q, want invalid_input", out.Error.Code)
	}
}

func TestPutSamples_RejectsBatchOverTheLimit(t *testing.T) {
	// One well-formed sample, repeated past MaxSamplesPerRequest, as a
	// single JSON array literal built at test time.
	var b strings.Builder
	b.WriteString(`{"samples":[`)
	for i := 0; i <= MaxSamplesPerRequest; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"id":"s","metric_type":"heart_rate","source":"apple_watch",` +
			`"source_platform":"healthkit","value":150,"unit":"bpm","measured_at":"2026-09-01T10:00:00Z"}`)
	}
	b.WriteString(`]}`)

	rec := putSamplesResponse(t, b.String())
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func listSamplesResponse(t *testing.T, query string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(nil)
	req := httptest.NewRequest(http.MethodGet, "/v1/biometric/samples?"+query, nil)
	rec := httptest.NewRecorder()
	h.ListSamples(rec, req)
	return rec
}

func TestListSamples_RejectsUnknownMetricType(t *testing.T) {
	rec := listSamplesResponse(t, "metric_type=bogus&from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestListSamples_RejectsBadFrom(t *testing.T) {
	rec := listSamplesResponse(t, "metric_type=heart_rate&from=nope&to=2026-09-02T00:00:00Z")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestListSamples_RejectsToBeforeFrom(t *testing.T) {
	rec := listSamplesResponse(t, "metric_type=heart_rate&from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestListSamples_RejectsRangeOverTheLimit(t *testing.T) {
	rec := listSamplesResponse(t, "metric_type=heart_rate&from=2020-01-01T00:00:00Z&to=2026-09-01T00:00:00Z")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func listSessionLoadResponse(t *testing.T, query string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(nil)
	req := httptest.NewRequest(http.MethodGet, "/v1/biometric/sessions/load?"+query, nil)
	rec := httptest.NewRecorder()
	h.ListSessionLoad(rec, req)
	return rec
}

func TestListSessionLoad_RejectsBadFrom(t *testing.T) {
	rec := listSessionLoadResponse(t, "from=nope&to=2026-09-02T00:00:00Z")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestListSessionLoad_RejectsBadTo(t *testing.T) {
	rec := listSessionLoadResponse(t, "from=2026-09-01T00:00:00Z&to=nope")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestListSessionLoad_RejectsToBeforeFrom(t *testing.T) {
	rec := listSessionLoadResponse(t, "from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestListSessionLoad_RejectsRangeOverTheLimit(t *testing.T) {
	rec := listSessionLoadResponse(t, "from=2020-01-01T00:00:00Z&to=2026-09-01T00:00:00Z")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestListSessionLoad_ValidRangeReachesTheRepository(t *testing.T) {
	// Mirrors TestComputeMetrics_ValidBodyReachesTheRepository's technique: a
	// nil repository dereferenced past validation panics, which proves the
	// guards above (and not some unrelated bug) are what stop the invalid
	// cases.
	defer func() {
		if recover() == nil {
			t.Fatal("a valid list-session-load request should reach the repository")
		}
	}()
	req := httptest.NewRequest(http.MethodGet,
		"/v1/biometric/sessions/load?from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z", nil)
	req = req.WithContext(auth.ContextWithClaims(req.Context(), &auth.Claims{UserID: "user_x"}))
	h := NewHandler(nil)
	rec := httptest.NewRecorder()
	h.ListSessionLoad(rec, req)
}

func computeMetricsResponse(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewHandler(nil)
	req := httptest.NewRequest(http.MethodPost, "/v1/biometric/sessions/ses-1/metrics", strings.NewReader(body))
	req.SetPathValue("sessionID", "ses-1")
	rec := httptest.NewRecorder()
	h.ComputeMetrics(rec, req)
	return rec
}

func TestComputeMetrics_RejectsMissingHRMax(t *testing.T) {
	rec := computeMetricsResponse(t, `{"hr_max_source":"estimated","hr_source":"window"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestComputeMetrics_RejectsOutOfRangeHRMax(t *testing.T) {
	for _, body := range []string{
		`{"hr_max_bpm":50,"hr_max_source":"estimated","hr_source":"window"}`,  // too low to be a real HRmax
		`{"hr_max_bpm":300,"hr_max_source":"estimated","hr_source":"window"}`, // too high
	} {
		rec := computeMetricsResponse(t, body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %q: want 400, got %d", body, rec.Code)
		}
	}
}

// N483/#833: hr_max_source is required alongside hr_max_bpm — a bare number
// loses the estimated/observed distinction the design doc calls for.
func TestComputeMetrics_RejectsMissingHRMaxSource(t *testing.T) {
	rec := computeMetricsResponse(t, `{"hr_max_bpm":190,"hr_source":"window"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestComputeMetrics_RejectsUnknownHRMaxSource(t *testing.T) {
	rec := computeMetricsResponse(t, `{"hr_max_bpm":190,"hr_max_source":"bogus","hr_source":"window"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestComputeMetrics_RejectsHRSourceNoneAsAClaim(t *testing.T) {
	// 'none' is what the server derives from an empty result, never a
	// legal thing for a caller to assert while asking for a computation.
	rec := computeMetricsResponse(t, `{"hr_max_bpm":190,"hr_max_source":"estimated","hr_source":"none"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestComputeMetrics_RejectsUnknownHRSource(t *testing.T) {
	rec := computeMetricsResponse(t, `{"hr_max_bpm":190,"hr_max_source":"estimated","hr_source":"bogus"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rec.Code)
	}
}

func TestComputeMetrics_ValidBodyReachesTheRepository(t *testing.T) {
	// The inverse of every case above: proves the guards above are what's
	// stopping the request, not some unrelated bug — a nil repository
	// dereferenced here panics, which this recovers and treats as "reached
	// the repository", the same technique profile/handler_test.go uses for
	// TestUpdateTrimsBeforeValidating.
	defer func() {
		if recover() == nil {
			t.Fatal("a valid compute-metrics request should reach the repository")
		}
	}()
	req := httptest.NewRequest(http.MethodPost, "/v1/biometric/sessions/ses-1/metrics",
		strings.NewReader(`{"hr_max_bpm":190,"hr_max_source":"estimated","hr_source":"window"}`))
	req.SetPathValue("sessionID", "ses-1")
	req = req.WithContext(auth.ContextWithClaims(req.Context(), &auth.Claims{UserID: "user_x"}))
	h := NewHandler(nil)
	rec := httptest.NewRecorder()
	h.ComputeMetrics(rec, req)
}

// stubRepo lets GetMetrics/writeError be exercised end to end without a
// database.
type stubRepo struct {
	Repository
	metrics SessionMetrics
	err     error
}

func (s stubRepo) GetSessionMetrics(_ context.Context, _, _ string) (SessionMetrics, error) {
	return s.metrics, s.err
}

func TestGetMetrics_HappyPath(t *testing.T) {
	trimp := 42.5
	h := NewHandler(stubRepo{metrics: SessionMetrics{
		SessionID: "ses-1", TRIMP: &trimp, HRSource: HRSourceWindow,
		SampleCount: 5, TimeInZones: map[string]float64{"5": 8.5},
		ComputedAt: time.Now(), RuleVersion: 1,
	}})
	req := httptest.NewRequest(http.MethodGet, "/v1/biometric/sessions/ses-1/metrics", nil)
	req.SetPathValue("sessionID", "ses-1")
	req = req.WithContext(auth.ContextWithClaims(req.Context(), &auth.Claims{UserID: "user_x"}))
	rec := httptest.NewRecorder()
	h.GetMetrics(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Metrics SessionMetrics `json:"metrics"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Metrics.TRIMP == nil || *out.Metrics.TRIMP != 42.5 {
		t.Fatalf("trimp = %v, want 42.5", out.Metrics.TRIMP)
	}
}

func TestGetMetrics_NotFoundMapsTo404(t *testing.T) {
	h := NewHandler(stubRepo{err: ErrNotFound})
	req := httptest.NewRequest(http.MethodGet, "/v1/biometric/sessions/ses-1/metrics", nil)
	req.SetPathValue("sessionID", "ses-1")
	req = req.WithContext(auth.ContextWithClaims(req.Context(), &auth.Claims{UserID: "user_x"}))
	rec := httptest.NewRecorder()
	h.GetMetrics(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", rec.Code)
	}
}

func TestWriteErrorMapsEveryDomainError(t *testing.T) {
	cases := []struct {
		err  error
		want int
	}{
		{ErrNotFound, http.StatusNotFound},
		{ErrAlreadyExists, http.StatusConflict},
		{ErrInvalidInput, http.StatusBadRequest},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/v1/biometric/samples", nil)
		writeError(rec, req, c.err)
		if rec.Code != c.want {
			t.Errorf("%v: want %d, got %d", c.err, c.want, rec.Code)
		}
	}
}
