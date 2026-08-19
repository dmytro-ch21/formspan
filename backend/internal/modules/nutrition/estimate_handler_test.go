package nutrition

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// fakeEstimator stands in for Claude.
//
// Every path below — refusal, upstream failure, success — is exercised against
// this rather than the real client, so the suite costs nothing to run and
// needs no API key. It also records what it was ASKED, which is how the
// billing tests below prove the right quota was charged.
type fakeEstimator struct {
	out    Estimate
	err    error
	calls  int
	lastIn EstimateInput
	// onCall fires inside the estimate, so a test can cancel the request while
	// the "model call" is in flight — which is when the spend has happened and
	// the meter has not yet run.
	onCall func()
}

func (f *fakeEstimator) Estimate(_ context.Context, in EstimateInput) (Estimate, error) {
	f.calls++
	f.lastIn = in
	if f.onCall != nil {
		f.onCall()
	}
	return f.out, f.err
}

// memUsage is an in-memory meter, so the handler tests need no database.
type memUsage struct {
	rows    []EstimateRecord
	quotaFn func(src EstimateSource) Quota
	recErr  error
	// lastCtxErr is the state of the context the meter was handed. A real
	// Postgres write would fail on a cancelled one, so recording it here is
	// how the test sees the bug without a database.
	lastCtxErr error
}

func (m *memUsage) Quota(_ context.Context, _ string, src EstimateSource, _ time.Time) (Quota, error) {
	if m.quotaFn != nil {
		return m.quotaFn(src), nil
	}
	used := 0
	for _, r := range m.rows {
		if r.Source == src {
			used++
		}
	}
	return NewQuota(src, used, nil), nil
}

func (m *memUsage) Record(ctx context.Context, rec EstimateRecord) error {
	m.lastCtxErr = ctx.Err()
	m.rows = append(m.rows, rec)
	return m.recErr
}

func goodEstimate() Estimate {
	return Estimate{
		Items: []EstimatedItem{item(nil)},
		Model: "claude-opus-5",
	}
}

// call drives the handler as an authenticated athlete.
func call(t *testing.T, h *EstimateHandler, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/v1/nutrition/estimate", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: "eater"}))
	w := httptest.NewRecorder()
	h.Estimate(w, r)
	return w
}

func TestASuccessfulEstimateWritesNoEntryAndReturnsADraft(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	usage := &memUsage{}
	h := NewEstimateHandler(est, usage)

	w := call(t, h, `{"description":"two eggs"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var got estimateResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Estimate.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(got.Estimate.Items))
	}
	// The response is a DRAFT. There is deliberately no repository on this
	// handler at all, so it could not write an entry if it tried — which is
	// the structural version of the rule rather than a promise in a comment.
	if got.Quota.Remaining != LimitFor(SourceText)-1 {
		t.Fatalf("remaining = %d, want %d", got.Quota.Remaining, LimitFor(SourceText)-1)
	}
}

func TestTheQuotaIsCheckedBEFORETheModelIsCalled(t *testing.T) {
	// Checking after the call would meter spend that has already happened,
	// which is a receipt rather than a quota. The assertion that matters is
	// `est.calls == 0` — a handler that called first and refused afterwards
	// would still return 429 and look correct from the outside.
	est := &fakeEstimator{out: goodEstimate()}
	usage := &memUsage{quotaFn: func(src EstimateSource) Quota {
		return NewQuota(src, LimitFor(src), nil) // already at the cap
	}}
	h := NewEstimateHandler(est, usage)

	w := call(t, h, `{"description":"two eggs"}`)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d, want 429", w.Code)
	}
	if est.calls != 0 {
		t.Fatalf("the model was called %d times at the cap — the money was already spent", est.calls)
	}
}

func TestAFailedCallIsStillMetered(t *testing.T) {
	// A refusal costs tokens. Recording only successes would let a caller loop
	// on input the model keeps declining and pay for every attempt.
	est := &fakeEstimator{err: ErrEstimateRefused}
	usage := &memUsage{}
	h := NewEstimateHandler(est, usage)

	w := call(t, h, `{"description":"a photo of my desk"}`)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status %d, want 422", w.Code)
	}
	if len(usage.rows) != 1 {
		t.Fatalf("%d rows recorded, want 1 — a refusal was not metered", len(usage.rows))
	}
	if usage.rows[0].Succeeded {
		t.Fatal("a refusal was recorded as a success")
	}
}

func TestARefusalIs422AndAnOutageIs502(t *testing.T) {
	// Different remedies, so different codes: a refusal means send a better
	// photo, an outage means try again later. Collapsing them into one status
	// would make the client tell the athlete the wrong thing.
	cases := map[string]struct {
		err  error
		want int
	}{
		"refusal":     {ErrEstimateRefused, http.StatusUnprocessableEntity},
		"unavailable": {ErrEstimateUnavailable, http.StatusBadGateway},
		"bad output":  {ErrInvalidInput, http.StatusBadRequest},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h := NewEstimateHandler(&fakeEstimator{err: tc.err}, &memUsage{})
			w := call(t, h, `{"description":"two eggs"}`)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d", w.Code, tc.want)
			}
		})
	}
}

func TestUpstreamErrorTextNeverReachesTheClient(t *testing.T) {
	// The house rule: no raw internal error escapes. An upstream message can
	// carry request ids and prompt fragments.
	secret := "request_id=req_01SECRET model=internal-preview prompt=You estimate"
	// WRAPPED with %w, not errors.New with matching text. The first version of
	// this test used errors.New, so `errors.Is` was false, the handler took the
	// default branch, and the test never reached the code it was written to
	// cover — it passed with the leak deliberately reintroduced. Mutation
	// testing is the only thing that found that.
	h := NewEstimateHandler(&fakeEstimator{
		err: fmt.Errorf("%w: %s", ErrEstimateUnavailable, secret),
	}, &memUsage{})

	w := call(t, h, `{"description":"two eggs"}`)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502 — this test is not reaching the unavailable branch", w.Code)
	}
	if strings.Contains(w.Body.String(), "req_01SECRET") || strings.Contains(w.Body.String(), "prompt=") {
		t.Fatalf("upstream error text leaked: %s", w.Body.String())
	}
}

func TestAnUnconfiguredDeployFailsOnlyThisRoute(t *testing.T) {
	// CONSTRUCTED THE WAY main.go DOES IT, not with an untyped nil literal.
	//
	// The first version passed `nil` directly, which is a different thing
	// entirely: a nil `*AnthropicEstimator` assigned into an `Estimator`
	// produces a NON-nil interface, so `h.estimator == nil` read false, the 503
	// branch was skipped, and a real request panicked on a nil receiver. The
	// test passed throughout. Review found it; this shape is what would have
	// caught it, and the constructor now returns the interface so the nil is
	// genuine.
	est, err := NewEstimator(EstimatorConfig{APIKey: ""})
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	h := NewEstimateHandler(est, &memUsage{})
	w := call(t, h, `{"description":"two eggs"}`)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", w.Code)
	}
}

func TestSpendIsMeteredEvenWhenTheCallerDisconnects(t *testing.T) {
	// The tokens are already gone by the time the meter runs, so a caller who
	// cancels mid-call must not escape it — a cancel-loop is exactly the
	// spend-somebody-else's-money shape the quota exists to bound.
	est := &fakeEstimator{out: goodEstimate()}
	usage := &memUsage{}
	h := NewEstimateHandler(est, usage)

	ctx, cancel := context.WithCancel(
		auth.ContextWithClaims(context.Background(), &auth.Claims{UserID: "eater"}))
	r := httptest.NewRequest(http.MethodPost, "/v1/nutrition/estimate",
		strings.NewReader(`{"description":"two eggs"}`)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	// Cancelled while the model call is in flight — the request context is
	// already done by the time the handler reaches the meter write.
	est.onCall = cancel

	h.Estimate(httptest.NewRecorder(), r)

	if len(usage.rows) != 1 {
		t.Fatalf("%d rows recorded, want 1 — a cancelled request escaped the meter", len(usage.rows))
	}
	if usage.lastCtxErr != nil {
		t.Fatalf("the meter was handed a cancelled context: %v", usage.lastCtxErr)
	}
}

func TestAnEmptyRequestNeverReachesTheModel(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	h := NewEstimateHandler(est, &memUsage{})
	w := call(t, h, `{}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", w.Code)
	}
	if est.calls != 0 {
		t.Fatal("an empty request was sent upstream")
	}
}

func TestAPhotoIsBilledToThePhotoQuota(t *testing.T) {
	// The media type is SNIFFED from the bytes, not read from the part header,
	// so this uses a real PNG magic number rather than a declared type.
	png := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("description", "the sauce is peanut")
	part, err := mw.CreateFormFile("image", "meal.png")
	if err != nil {
		t.Fatalf("form file: %v", err)
	}
	_, _ = part.Write(png)
	_ = mw.Close()

	est := &fakeEstimator{out: goodEstimate()}
	usage := &memUsage{}
	h := NewEstimateHandler(est, usage)

	r := httptest.NewRequest(http.MethodPost, "/v1/nutrition/estimate", &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r = r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: "eater"}))
	w := httptest.NewRecorder()
	h.Estimate(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if len(usage.rows) != 1 || usage.rows[0].Source != SourcePhoto {
		t.Fatalf("recorded %+v, want one photo row — a photo billed as text is a 50x undercharge", usage.rows)
	}
	// The description rides along with the image rather than being dropped:
	// a photo plus "the sauce is peanut" is the strongest input there is.
	if est.lastIn.Description == "" {
		t.Fatal("the description was dropped from a multipart request")
	}
	if est.lastIn.ImageMediaType != "image/png" {
		t.Fatalf("sniffed %q, want image/png", est.lastIn.ImageMediaType)
	}
}

func TestAMeterWriteFailureDoesNotCostTheAthleteTheirDraft(t *testing.T) {
	// They have already paid for it. Failing the request here would charge
	// them and give them nothing.
	est := &fakeEstimator{out: goodEstimate()}
	h := NewEstimateHandler(est, &memUsage{recErr: errors.New("meter is down")})
	w := call(t, h, `{"description":"two eggs"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 — a meter failure lost a paid-for draft", w.Code)
	}
}
