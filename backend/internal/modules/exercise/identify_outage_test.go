package exercise

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/llm"
)

// F16 (#367) on the identify route.
//
// **This endpoint was outside the issue's stated scope, and the exclusion was
// out of date.** The issue says "the identify route uses an in-memory limiter,
// so it recovers on restart" — true when it was filed, and no longer true
// since N48 gave this route a PERSISTED daily quota with the same rolling
// 24-hour window as the other two. The in-memory limiter is still there, but
// it is the burst gate; the thing that locks an athlete out for a day is
// `exercise_identifications`, which is a Postgres table. So this route had the same bug
// with none of the stated mitigation, and it is fixed here rather than filed
// again.
//
// 20 a day, and an athlete reaches for this in an unfamiliar gym — bursty,
// front-loaded, a dozen in one session. An outage during that session emptied
// the allowance and the athlete had no way to get it back.

type identifyErrorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func decodeIdentifyError(t *testing.T, body []byte) identifyErrorBody {
	t.Helper()
	var out identifyErrorBody
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode error body %q: %v", body, err)
	}
	return out
}

func TestAProviderThatNeverAnsweredDoesNotSpendAnIdentification(t *testing.T) {
	id := &fakeIdentifier{err: fmt.Errorf("%w: %v", ErrIdentifyUnreachable, llm.ErrUnreachable)}
	usage := &memIdentifyUsage{}
	h := NewIdentifyHandler(id, usage)

	w := callIdentify(t, h, "lifter")

	// The identifier WAS called: a real attempt that found nothing, not the
	// quota gate refusing beforehand.
	if id.calls != 1 {
		t.Fatalf("the identifier was called %d times, want 1 — this test is not exercising "+
			"the outage path", id.calls)
	}
	if len(usage.rows) != 0 {
		t.Fatalf("%d rows recorded for a provider that never answered — the athlete is "+
			"charged for our supplier's outage (F16)", len(usage.rows))
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", w.Code)
	}
}

func TestARefusalStillSpendsAnIdentificationWhileAnOutageDoesNot(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		wantRows int
		wantCode int
		wantAPI  string
	}{
		{
			// A billed 200 — "I cannot tell what that is" is an answer. This
			// is the loop-prevention property: without metering it, a caller
			// could re-send the same unreadable photo indefinitely.
			name: "a refusal is metered", err: ErrIdentifyRefused,
			wantRows: 1, wantCode: http.StatusUnprocessableEntity, wantAPI: "invalid_input",
		},
		{
			name: "an answered-but-unusable call is metered", err: ErrIdentifyUnavailable,
			wantRows: 1, wantCode: http.StatusServiceUnavailable, wantAPI: "internal",
		},
		{
			name: "an outage is NOT metered", err: ErrIdentifyUnreachable,
			wantRows: 0, wantCode: http.StatusServiceUnavailable, wantAPI: "unavailable",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			usage := &memIdentifyUsage{}
			h := NewIdentifyHandler(&fakeIdentifier{err: tc.err}, usage)

			w := callIdentify(t, h, "lifter")

			if len(usage.rows) != tc.wantRows {
				t.Fatalf("%d rows recorded, want %d", len(usage.rows), tc.wantRows)
			}
			if w.Code != tc.wantCode {
				t.Fatalf("status %d, want %d", w.Code, tc.wantCode)
			}
			// Two of the three share a status, so the code is the only thing
			// separating them on the wire.
			if got := decodeIdentifyError(t, w.Body.Bytes()).Error.Code; got != tc.wantAPI {
				t.Fatalf("error code %q, want %q", got, tc.wantAPI)
			}
		})
	}
}

func TestAnIdentifyOutageAndAnExhaustedAllowanceAreDistinguishableByCode(t *testing.T) {
	h := NewIdentifyHandler(&fakeIdentifier{err: ErrIdentifyUnreachable}, &memIdentifyUsage{})
	outage := callIdentify(t, h, "lifter")

	full := NewIdentifyHandler(&fakeIdentifier{out: goodIdentification()}, &memIdentifyUsage{
		quotaFn: func() IdentifyQuota { return NewIdentifyQuota(DailyIdentifications, nil) },
	})
	exhausted := callIdentify(t, full, "lifter")

	outCode := decodeIdentifyError(t, outage.Body.Bytes()).Error.Code
	exCode := decodeIdentifyError(t, exhausted.Body.Bytes()).Error.Code

	if outage.Code == exhausted.Code && outCode == exCode {
		t.Fatalf("an outage and an exhausted allowance are indistinguishable: both %d/%q",
			outage.Code, outCode)
	}
	if outCode != "unavailable" {
		t.Errorf("an outage reports %q — only `unavailable` tells the client our provider "+
			"is the broken one and the same request will work later", outCode)
	}
	if exCode != "rate_limited" {
		t.Errorf("an exhausted allowance reports %q, want rate_limited", exCode)
	}
}

// The issue's step 4 on this route: twenty transport failures — the whole
// allowance and half again — then service returns.
func TestAFullIdentifyOutageLeavesTheAllowanceIntactWhenServiceReturns(t *testing.T) {
	id := &fakeIdentifier{err: ErrIdentifyUnreachable}
	usage := &memIdentifyUsage{}
	h := NewIdentifyHandler(id, usage)

	for i := range 20 {
		if w := callIdentify(t, h, "lifter"); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("call %d: status %d, want 503", i+1, w.Code)
		}
	}
	if len(usage.rows) != 0 {
		t.Fatalf("%d of the athlete's %d identifications were spent on an outage",
			len(usage.rows), DailyIdentifications)
	}

	id.err = nil
	id.out = goodIdentification()

	w := callIdentify(t, h, "lifter")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d after the outage ended: %s", w.Code, w.Body.String())
	}
	if len(usage.rows) != 1 {
		t.Fatalf("%d rows after one real call, want 1", len(usage.rows))
	}
}

// The wrapping is what makes an overlooked call site degrade to the old
// behaviour instead of to a 500.
func TestIdentifyUnreachableIsAKindOfUnavailable(t *testing.T) {
	if !errors.Is(ErrIdentifyUnreachable, ErrIdentifyUnavailable) {
		t.Fatal("ErrIdentifyUnreachable no longer satisfies ErrIdentifyUnavailable")
	}
	if errors.Is(ErrIdentifyUnavailable, ErrIdentifyUnreachable) {
		t.Fatal("the wrapping is inverted: a plain unavailable now reads as an outage and " +
			"stops being metered")
	}
	if errors.Is(ErrIdentifyUnreachable, ErrIdentifyRefused) {
		t.Fatal("an outage reads as a refusal")
	}
}

func TestTranslateIdentifyMapsTheTransportsThirdSentinel(t *testing.T) {
	got := translateIdentifyError(fmt.Errorf("%w: dial tcp: connect: connection refused",
		llm.ErrUnreachable))

	if !errors.Is(got, ErrIdentifyUnreachable) {
		t.Fatalf("llm.ErrUnreachable translated to %v, not ErrIdentifyUnreachable — the "+
			"handler will meter an outage", got)
	}
	if !errors.Is(got, ErrIdentifyUnavailable) {
		t.Fatal("the translated error is not unavailable-shaped, so the status mapping breaks")
	}

	if refused := translateIdentifyError(fmt.Errorf("%w: nothing matched", llm.ErrRefused)); errors.Is(refused, ErrIdentifyUnreachable) {
		t.Fatal("a refusal translated to unreachable — it would stop being metered and a " +
			"caller could loop on it for free")
	}
}
