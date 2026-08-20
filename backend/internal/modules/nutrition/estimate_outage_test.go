package nutrition

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/llm"
)

// F16 (#367): a provider outage must not spend the athlete's daily estimates.
//
// The bug these cover: the meter ran on every failure, so a 503's implicit
// "try again" ate the day's 25 one retry at a time and the athlete stayed
// locked out for up to 24 hours AFTER the provider came back. They did
// everything right, got nothing, and were charged for it.
//
// What must NOT change is the other half — a refusal is a billed answer and
// still meters, or a caller can loop on input the model keeps declining and
// spend our money doing it. Every test here that asserts an outage is free
// has a sibling asserting a refusal is not.

// errorBody is the wire shape every error response uses. Decoded rather than
// string-matched, because the CODE is the part of the contract a client is
// allowed to act on and the message explicitly is not.
type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func decodeError(t *testing.T, body []byte) errorBody {
	t.Helper()
	var out errorBody
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode error body %q: %v", body, err)
	}
	return out
}

func TestAProviderThatNeverAnsweredDoesNotSpendAnEstimate(t *testing.T) {
	est := &fakeEstimator{err: fmt.Errorf("%w: %v", ErrEstimateUnreachable, llm.ErrUnreachable)}
	usage := &memUsage{}
	h := NewEstimateHandler(est, usage)

	w := call(t, h, `{"description":"two eggs"}`)

	// The model WAS called — this is not the quota-gate path, it is a genuine
	// attempt that reached the transport and found nothing there.
	if est.calls != 1 {
		t.Fatalf("the estimator was called %d times, want 1 — this test is not exercising "+
			"the outage path at all", est.calls)
	}
	if len(usage.rows) != 0 {
		t.Fatalf("%d rows recorded for a provider that never answered — the athlete is being "+
			"charged for our supplier's outage (F16)", len(usage.rows))
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", w.Code)
	}
}

// The loop-prevention property, asserted beside the fix so neither can be
// changed without the other being looked at.
func TestARefusalStillSpendsAnEstimateWhileAnOutageDoesNot(t *testing.T) {
	for _, tc := range []struct {
		name      string
		err       error
		wantRows  int
		wantCode  int
		wantAPIID string
	}{
		{
			// Billed in full by the provider. Metering it is what stops a
			// caller sitting in a loop on input the model keeps declining.
			name: "a refusal is metered", err: ErrEstimateRefused,
			wantRows: 1, wantCode: http.StatusUnprocessableEntity, wantAPIID: "invalid_input",
		},
		{
			// Also billed: the provider answered, the answer was unusable.
			name: "an answered-but-unusable call is metered", err: ErrEstimateUnavailable,
			wantRows: 1, wantCode: http.StatusBadGateway, wantAPIID: "internal",
		},
		{
			// Nothing was spent. Nothing is charged.
			name: "an outage is NOT metered", err: ErrEstimateUnreachable,
			wantRows: 0, wantCode: http.StatusServiceUnavailable, wantAPIID: "unavailable",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			usage := &memUsage{}
			h := NewEstimateHandler(&fakeEstimator{err: tc.err}, usage)

			w := call(t, h, `{"description":"two eggs"}`)

			if len(usage.rows) != tc.wantRows {
				t.Fatalf("%d rows recorded, want %d", len(usage.rows), tc.wantRows)
			}
			if w.Code != tc.wantCode {
				t.Fatalf("status %d, want %d", w.Code, tc.wantCode)
			}
			if got := decodeError(t, w.Body.Bytes()).Error.Code; got != tc.wantAPIID {
				t.Fatalf("error code %q, want %q", got, tc.wantAPIID)
			}
		})
	}
}

// An outage and an exhausted allowance must not look the same to the app.
//
// They are opposite instructions — "try again shortly" against "come back
// tomorrow" — and before this they were separated only by the status, with
// both carrying a code (`internal` / `rate_limited`) that named the wrong
// thing on one side. A client that reads the code, which is the only part of
// the body the conventions let it read, could not tell an outage from a bug in
// the endpoint.
func TestAnOutageAndAnExhaustedAllowanceAreDistinguishableByCode(t *testing.T) {
	outage := func() (int, string) {
		h := NewEstimateHandler(&fakeEstimator{err: ErrEstimateUnreachable}, &memUsage{})
		w := call(t, h, `{"description":"two eggs"}`)
		return w.Code, decodeError(t, w.Body.Bytes()).Error.Code
	}
	exhausted := func() (int, string) {
		h := NewEstimateHandler(&fakeEstimator{out: goodEstimate()}, &memUsage{
			quotaFn: func() Quota { return NewQuota(DailyEstimates, nil) },
		})
		w := call(t, h, `{"description":"two eggs"}`)
		return w.Code, decodeError(t, w.Body.Bytes()).Error.Code
	}

	outStatus, outCode := outage()
	exStatus, exCode := exhausted()

	if outStatus == exStatus && outCode == exCode {
		t.Fatalf("an outage and an exhausted allowance are indistinguishable: both %d/%q",
			outStatus, outCode)
	}
	if outCode != "unavailable" {
		t.Errorf("an outage reports code %q — `unavailable` is the one that means "+
			"\"somebody we depend on is broken\"; `internal` means we are", outCode)
	}
	if exCode != "rate_limited" {
		t.Errorf("an exhausted allowance reports code %q, want rate_limited", exCode)
	}
}

// The issue's own step 4: fail every call at the transport for a full outage,
// then confirm the athlete can use the feature the moment service returns.
//
// Twenty is the number the issue names, and it is deliberately below the cap
// of 25 while being far more than the cap once the pre-fix behaviour is
// restored — under the old code these twenty rows plus a handful of ordinary
// use would exhaust the day.
func TestAFullOutageLeavesTheAllowanceIntactWhenServiceReturns(t *testing.T) {
	est := &fakeEstimator{err: ErrEstimateUnreachable}
	usage := &memUsage{}
	h := NewEstimateHandler(est, usage)

	for i := range 20 {
		w := call(t, h, `{"description":"two eggs"}`)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("call %d: status %d, want 503", i+1, w.Code)
		}
	}
	if len(usage.rows) != 0 {
		t.Fatalf("%d of the athlete's %d estimates were spent on an outage",
			len(usage.rows), DailyEstimates)
	}

	// Service returns.
	est.err = nil
	est.out = goodEstimate()

	w := call(t, h, `{"description":"two eggs"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d after the outage ended: %s", w.Code, w.Body.String())
	}
	var got estimateResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The whole allowance minus the one call that actually produced a draft.
	if got.Quota.Remaining != DailyEstimates-1 {
		t.Fatalf("remaining = %d after an outage of 20, want %d — the outage ate the day",
			got.Quota.Remaining, DailyEstimates-1)
	}
}

// The house rule survives the new branch: no upstream text reaches the client.
func TestAnUnreachableProviderLeaksNoUpstreamText(t *testing.T) {
	secret := "request_id=req_01SECRET https://api.internal.example/v1/chat prompt=You estimate"
	h := NewEstimateHandler(&fakeEstimator{
		// WRAPPED with %w so `errors.Is` matches and the handler really takes
		// the new arm. An `errors.New` with the same text would take the
		// default arm and prove nothing about this branch — the mistake the
		// sibling leak test in this package records having made.
		err: fmt.Errorf("%w: %s", ErrEstimateUnreachable, secret),
	}, &memUsage{})

	w := call(t, h, `{"description":"two eggs"}`)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503 — this test did not reach the unreachable arm", w.Code)
	}
	for _, fragment := range []string{"req_01SECRET", "api.internal.example", "You estimate"} {
		if got := w.Body.String(); strings.Contains(got, fragment) {
			t.Fatalf("the response carries upstream detail %q: %s", fragment, got)
		}
	}
}

// The sentinel's wrapping is load-bearing and easy to "tidy" away.
//
// `ErrEstimateUnreachable` wraps `ErrEstimateUnavailable` on purpose: every
// pre-existing `errors.Is(err, ErrEstimateUnavailable)` keeps matching, so
// anywhere that has not learned about the new sentinel degrades to the old
// behaviour instead of falling through to a 500. Redeclare it as a bare
// `errors.New` and nothing else in this package fails — which is exactly why
// it needs its own test.
func TestUnreachableIsAKindOfUnavailable(t *testing.T) {
	if !errors.Is(ErrEstimateUnreachable, ErrEstimateUnavailable) {
		t.Fatal("ErrEstimateUnreachable no longer satisfies ErrEstimateUnavailable — every " +
			"caller that has not learned the new sentinel now falls through to its default arm")
	}
	if errors.Is(ErrEstimateUnavailable, ErrEstimateUnreachable) {
		t.Fatal("the wrapping is the wrong way round: a plain unavailable now reads as an " +
			"outage and stops being metered")
	}
	if errors.Is(ErrEstimateUnreachable, ErrEstimateRefused) {
		t.Fatal("an outage reads as a refusal")
	}
}

// The transport's third sentinel has to arrive as this module's third
// sentinel, and the ORDER of the arms in translateLLMError is what does it.
//
// `llm.ErrUnreachable` is checked first because ErrEstimateUnreachable wraps
// ErrEstimateUnavailable; swap the arms and every outage translates to the
// metered error while every status code stays identical, so nothing else in
// this suite notices.
func TestTranslateMapsTheTransportsThirdSentinel(t *testing.T) {
	got := translateLLMError(fmt.Errorf("%w: dial tcp 127.0.0.1:1: connect: connection refused",
		llm.ErrUnreachable))

	if !errors.Is(got, ErrEstimateUnreachable) {
		t.Fatalf("llm.ErrUnreachable translated to %v, not ErrEstimateUnreachable — the "+
			"handler will meter an outage", got)
	}
	// Still unavailable-shaped, which is what keeps the status mapping right.
	if !errors.Is(got, ErrEstimateUnavailable) {
		t.Fatal("the translated error is not unavailable-shaped")
	}
	if errors.Is(got, ErrEstimateRefused) {
		t.Fatal("an outage translated to a refusal")
	}

	// And the other direction: a refusal must NOT come out unreachable, or the
	// loop this meter closes is reopened.
	refused := translateLLMError(fmt.Errorf("%w: response was cut off", llm.ErrRefused))
	if errors.Is(refused, ErrEstimateUnreachable) {
		t.Fatal("a refusal translated to unreachable — it would stop being metered and a " +
			"caller could loop on it for free")
	}
}
