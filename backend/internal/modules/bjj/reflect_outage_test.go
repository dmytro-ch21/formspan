package bjj

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/llm"
)

// F16 (#367): a provider outage must not spend the athlete's daily drafts.
//
// The handler comment this replaces said the opposite in so many words — that
// charging for a transport failure "is still the right default" and that the
// consequence was filed for later. It is later. Ten drafts a day is a small
// allowance, so an outage emptied it faster here than on nutrition's 25.
//
// The property that must survive unchanged: a REFUSAL still meters. That is
// what stops a caller looping on a dictation the model keeps declining.

type draftErrorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func decodeDraftError(t *testing.T, body []byte) draftErrorBody {
	t.Helper()
	var out draftErrorBody
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode error body %q: %v", body, err)
	}
	return out
}

const aDictation = `{"dictation":"rolled with the big guy, hit a scissor sweep from closed guard"}`

func TestAProviderThatNeverAnsweredDoesNotSpendADraft(t *testing.T) {
	drafter := &fakeDrafter{err: fmt.Errorf("%w: %v", ErrDraftUnreachable, llm.ErrUnreachable)}
	usage := &memDraftUsage{}
	h := NewDraftHandler(drafter, usage)

	w := callDraft(t, h, aDictation)

	// The drafter WAS called: this is a real attempt that found nothing at the
	// other end, not the quota gate refusing before the call.
	if drafter.calls != 1 {
		t.Fatalf("the drafter was called %d times, want 1 — this test is not exercising "+
			"the outage path", drafter.calls)
	}
	if len(usage.rows) != 0 {
		t.Fatalf("%d rows recorded for a provider that never answered — the athlete is "+
			"charged for our supplier's outage (F16)", len(usage.rows))
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", w.Code)
	}
}

func TestARefusalStillSpendsADraftWhileAnOutageDoesNot(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		wantRows int
		wantCode int
		wantAPI  string
	}{
		{
			// A billed 200. Metering it is the loop-prevention property.
			name: "a refusal is metered", err: ErrDraftRefused,
			wantRows: 1, wantCode: http.StatusUnprocessableEntity, wantAPI: "invalid_input",
		},
		{
			// Also billed: the provider answered and the answer was unusable.
			name: "an answered-but-unusable call is metered", err: ErrDraftUnavailable,
			wantRows: 1, wantCode: http.StatusServiceUnavailable, wantAPI: "internal",
		},
		{
			name: "an outage is NOT metered", err: ErrDraftUnreachable,
			wantRows: 0, wantCode: http.StatusServiceUnavailable, wantAPI: "unavailable",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			usage := &memDraftUsage{}
			h := NewDraftHandler(&fakeDrafter{err: tc.err}, usage)

			w := callDraft(t, h, aDictation)

			if len(usage.rows) != tc.wantRows {
				t.Fatalf("%d rows recorded, want %d", len(usage.rows), tc.wantRows)
			}
			if w.Code != tc.wantCode {
				t.Fatalf("status %d, want %d", w.Code, tc.wantCode)
			}
			// The two 503s are the reason the CODE is asserted and not just the
			// status: an outage and an unusable answer share a status here, so
			// the code is the only thing that separates them on the wire.
			if got := decodeDraftError(t, w.Body.Bytes()).Error.Code; got != tc.wantAPI {
				t.Fatalf("error code %q, want %q", got, tc.wantAPI)
			}
		})
	}
}

// An outage and an exhausted allowance are opposite instructions — "shortly"
// against "tomorrow" — and a client may only act on the code.
func TestADraftOutageAndAnExhaustedAllowanceAreDistinguishableByCode(t *testing.T) {
	h := NewDraftHandler(&fakeDrafter{err: ErrDraftUnreachable}, &memDraftUsage{})
	outage := callDraft(t, h, aDictation)

	full := NewDraftHandler(&fakeDrafter{out: goodDraft()}, &memDraftUsage{
		quotaFn: func() DraftQuota { return NewDraftQuota(DailyReflectionDrafts, nil) },
	})
	exhausted := callDraft(t, full, aDictation)

	outCode := decodeDraftError(t, outage.Body.Bytes()).Error.Code
	exCode := decodeDraftError(t, exhausted.Body.Bytes()).Error.Code

	if outage.Code == exhausted.Code && outCode == exCode {
		t.Fatalf("an outage and an exhausted allowance are indistinguishable: both %d/%q",
			outage.Code, outCode)
	}
	if outCode != "unavailable" {
		t.Errorf("an outage reports %q — `internal` means we are broken, `unavailable` means "+
			"our provider is, and only the second tells the client to retry", outCode)
	}
	if exCode != "rate_limited" {
		t.Errorf("an exhausted allowance reports %q, want rate_limited", exCode)
	}
}

// The issue's step 4, on this endpoint: twenty transport failures, then service
// returns and the athlete can still draft.
//
// Twenty is DOUBLE the cap here, which is the point — under the old behaviour
// the athlete would be locked out with ten to spare and would stay locked out
// for the rest of the rolling day.
func TestAFullDraftOutageLeavesTheAllowanceIntactWhenServiceReturns(t *testing.T) {
	drafter := &fakeDrafter{err: ErrDraftUnreachable}
	usage := &memDraftUsage{}
	h := NewDraftHandler(drafter, usage)

	for i := range 20 {
		if w := callDraft(t, h, aDictation); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("call %d: status %d, want 503", i+1, w.Code)
		}
	}
	if len(usage.rows) != 0 {
		t.Fatalf("%d of the athlete's %d drafts were spent on an outage",
			len(usage.rows), DailyReflectionDrafts)
	}

	drafter.err = nil
	drafter.out = goodDraft()

	w := callDraft(t, h, aDictation)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d after the outage ended: %s", w.Code, w.Body.String())
	}
	var got draftResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Quota.Remaining != DailyReflectionDrafts-1 {
		t.Fatalf("remaining = %d after an outage of 20, want %d — the outage ate the day",
			got.Quota.Remaining, DailyReflectionDrafts-1)
	}
}

// No upstream text on the new branch either.
//
// This endpoint has a second, sharper reason to care: the request body is the
// athlete's own speech about their training and sometimes their body. The
// handler already refuses to log the dictation on any path; the response must
// not carry provider detail out either.
func TestAnUnreachableProviderLeaksNoUpstreamTextOnTheDraftPath(t *testing.T) {
	secret := "request_id=req_01SECRET https://api.internal.example/v1/messages"
	h := NewDraftHandler(&fakeDrafter{
		err: fmt.Errorf("%w: %s", ErrDraftUnreachable, secret),
	}, &memDraftUsage{})

	w := callDraft(t, h, aDictation)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503 — this test did not reach the unreachable arm", w.Code)
	}
	for _, fragment := range []string{"req_01SECRET", "api.internal.example"} {
		if strings.Contains(w.Body.String(), fragment) {
			t.Fatalf("the response carries upstream detail %q: %s", fragment, w.Body.String())
		}
	}
}

// The wrapping is load-bearing: it is what makes "forgot about the new
// sentinel" degrade to the old behaviour rather than to a 500.
func TestDraftUnreachableIsAKindOfUnavailable(t *testing.T) {
	if !errors.Is(ErrDraftUnreachable, ErrDraftUnavailable) {
		t.Fatal("ErrDraftUnreachable no longer satisfies ErrDraftUnavailable")
	}
	if errors.Is(ErrDraftUnavailable, ErrDraftUnreachable) {
		t.Fatal("the wrapping is inverted: a plain unavailable now reads as an outage and " +
			"stops being metered")
	}
	if errors.Is(ErrDraftUnreachable, ErrDraftRefused) {
		t.Fatal("an outage reads as a refusal")
	}
}

// The arm ORDER in translateDraftError is the thing that can silently regress:
// move the unreachable case below anything matching ErrDraftUnavailable and
// every status in this file stays identical while the meter starts charging
// again.
func TestTranslateDraftMapsTheTransportsThirdSentinel(t *testing.T) {
	got := translateDraftError(fmt.Errorf("%w: dial tcp: connect: connection refused",
		llm.ErrUnreachable))

	if !errors.Is(got, ErrDraftUnreachable) {
		t.Fatalf("llm.ErrUnreachable translated to %v, not ErrDraftUnreachable — the handler "+
			"will meter an outage", got)
	}
	if !errors.Is(got, ErrDraftUnavailable) {
		t.Fatal("the translated error is not unavailable-shaped, so the status mapping breaks")
	}

	if refused := translateDraftError(fmt.Errorf("%w: response was cut off", llm.ErrRefused)); errors.Is(refused, ErrDraftUnreachable) {
		t.Fatal("a refusal translated to unreachable — it would stop being metered and a " +
			"caller could loop on it for free")
	}
}
