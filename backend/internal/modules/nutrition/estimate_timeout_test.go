package nutrition

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// N92 (#433): this endpoint must always answer with a status.
//
// The reported failure was a phone saying "can't reach server" while
// photographing a product label. Every status this handler can produce carries
// a sentence written for that screen — a 503 says estimation is unavailable, a
// 429 says the allowance is spent and when it returns — so the ONE thing that
// can make a client fall back to talking about connectivity is receiving no
// status at all. Before `estimateTimeout` that was reachable: no deadline
// existed on the request context, on the provider's client, or on the server,
// so a slow provider ran until the phone's own request timeout fired and the
// athlete was told to go find signal.
//
// What these pin, and each fails on a different mutation:
//
//   - the provider call is bounded, and the bound produces 504 rather than
//     silence;
//   - a timed-out call is STILL METERED, unlike the F16 outage beside it in
//     estimate_outage_test.go — the tokens were very likely bought, and
//     `llm.ErrUnreachable` is explicit that a timed-out call is not the
//     exemption;
//   - a caller who hangs up is not reported as our deadline firing, which is
//     the half that distinguishes the two contexts rather than reading one.

// blockingEstimator waits for its context and reports what killed it, the way
// a real provider call does — the SDK surfaces the context error rather than
// inventing one of its own.
//
// It records the deadline it was handed, because "was a bound applied" and
// "did an error come back" are different questions and only the first one is
// about the change under test.
type blockingEstimator struct {
	calls       int
	hadDeadline bool
	// released is closed once the call has been entered, so a test that needs
	// to act WHILE the model call is in flight has something to wait on rather
	// than a sleep.
	released chan struct{}
}

func (b *blockingEstimator) Estimate(ctx context.Context, _ EstimateInput) (Estimate, CallMeta, error) {
	b.calls++
	_, b.hadDeadline = ctx.Deadline()
	if b.released != nil {
		close(b.released)
	}
	<-ctx.Done()
	// Metered usage on the error path, mirroring the real estimator: a call
	// that reached the provider is billed whether or not we stayed to read the
	// answer, and a fake that zeroed this would let the metering assertion
	// below pass against a handler that never meters anything.
	meta := CallMeta{Model: "test-model", Usage: Usage{InputTokens: 900, OutputTokens: 12}}
	return Estimate{}, meta, fmt.Errorf("%w: %v", ErrEstimateUnavailable, ctx.Err())
}

// handlerWithTimeout is the shipped constructor with only the deadline moved,
// so nothing else about the handler differs from production.
func handlerWithTimeout(est Estimator, usage EstimateUsageRepository, d time.Duration) *EstimateHandler {
	h := NewEstimateHandler(est, usage)
	h.timeout = d
	return h
}

func TestTheShippedTimeoutIsTheOneCallersGet(t *testing.T) {
	// The seam exists for the suite, so it has to be pinned that the suite is
	// the only thing using it. Without this, `h.timeout` could default to zero
	// — every call instantly timing out — and every other test here would
	// still pass, because they all set it themselves.
	h := NewEstimateHandler(&fakeEstimator{out: goodEstimate()}, &memUsage{})
	if h.timeout != estimateTimeout {
		t.Fatalf("constructed handler has timeout %s, want %s", h.timeout, estimateTimeout)
	}
	if estimateTimeout <= 0 {
		t.Fatalf("estimateTimeout is %s — a non-positive deadline fires immediately", estimateTimeout)
	}
}

func TestAProviderThatOverrunsOurDeadlineAnswers504RatherThanNothing(t *testing.T) {
	est := &blockingEstimator{}
	usage := &memUsage{}
	h := handlerWithTimeout(est, usage, 20*time.Millisecond)

	w := call(t, h, `{"description":"two eggs"}`)

	if est.calls != 1 {
		t.Fatalf("the estimator was called %d times, want 1 — this test is not exercising "+
			"the provider path at all", est.calls)
	}
	if !est.hadDeadline {
		t.Fatal("the estimator was handed a context with NO deadline — the provider call is " +
			"unbounded, which is the condition N92 was reported from")
	}
	if w.Code != http.StatusGatewayTimeout {
		t.Fatalf("status %d, want 504 — a deadline we imposed has to read as a timeout, not "+
			"as a generic upstream fault", w.Code)
	}
	body := decodeError(t, w.Body.Bytes())
	if body.Error.Code != "unavailable" {
		t.Fatalf("code %q, want %q — `internal` would say WE are broken, and the client's "+
			"correct move here is to retry the identical request", body.Error.Code, "unavailable")
	}
	// The whole point of the ticket: whatever this says, it must not send an
	// athlete on a working connection to go and check their signal.
	for _, banned := range []string{"signal", "connection", "offline", "reach"} {
		if strings.Contains(strings.ToLower(body.Error.Message), banned) {
			t.Fatalf("the 504 message %q talks about %q — N92 is that a timeout was reported "+
				"as a connectivity problem", body.Error.Message, banned)
		}
	}
}

func TestATimedOutCallIsStillMetered(t *testing.T) {
	// The sibling of estimate_outage_test.go's "an outage is NOT metered", and
	// they have to be read together. An outage spends nothing, so charging for
	// it is F16. A call we abandoned mid-flight almost certainly spent tokens,
	// and exempting it would open the free-cancellation bypass `llm.go` spells
	// out: fire a request, drop it, repeat, and the row count never moves.
	est := &blockingEstimator{}
	usage := &memUsage{}
	h := handlerWithTimeout(est, usage, 20*time.Millisecond)

	call(t, h, `{"description":"two eggs"}`)

	if len(usage.rows) != 1 {
		t.Fatalf("%d rows recorded for a call that reached the provider and overran our "+
			"deadline, want 1 — a free path around the quota is not a quota", len(usage.rows))
	}
	if usage.rows[0].Succeeded {
		t.Fatal("the metered row claims the call succeeded")
	}
	if usage.rows[0].Usage.InputTokens == 0 {
		t.Fatal("the metered row carries no token usage, so the spend this table exists to " +
			"bound is not in it")
	}
}

func TestACallerWhoHangsUpIsNotReportedAsOurDeadline(t *testing.T) {
	// The discriminator. Both a client disconnect and our own deadline reach
	// the estimator as a context error, and `translateLLMError` maps both to
	// the generic unavailable case — so the handler tells them apart by
	// reading the CONTEXT rather than the error.
	//
	// **The mutation that kills this is weakening the check to
	// `callCtx.Err() != nil`** — verified, it goes red here with this message.
	// An earlier draft of this comment named a `r.Context().Err() == nil` half
	// that the shipped handler does not contain, which is worse than no comment:
	// it is a written claim about what makes the suite go red, naming a mutation
	// nobody can apply. Found in review.
	est := &blockingEstimator{released: make(chan struct{})}
	usage := &memUsage{}
	// A deadline far longer than the test, so the only thing that can end the
	// call is the cancellation below.
	h := handlerWithTimeout(est, usage, time.Minute)

	ctx, cancel := context.WithCancel(auth.ContextWithClaims(context.Background(), &auth.Claims{UserID: "eater"}))
	r := httptest.NewRequest(http.MethodPost, "/v1/nutrition/estimate",
		strings.NewReader(`{"description":"two eggs"}`)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	go func() {
		<-est.released
		cancel()
	}()
	h.Estimate(w, r)

	if w.Code == http.StatusGatewayTimeout {
		t.Fatal("a caller that disconnected was answered 504 — that status asserts WE gave up " +
			"waiting, which is a different fact and the one an operator would act on")
	}
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502 — a cancelled call keeps the existing generic "+
			"upstream-failure path", w.Code)
	}
	if len(usage.rows) != 1 {
		t.Fatalf("%d rows recorded for a cancelled call, want 1 — cancellation has been "+
			"metered since review, precisely so it cannot be used to spend for free",
			len(usage.rows))
	}
}

// racingEstimator returns an UNREACHABLE failure while the deadline is already
// blown — the race the rewrap guard exists for.
//
// It waits for the context to be done and then answers as though the provider
// had refused the connection a moment earlier, which is what a real outage
// landing at ~34.99s looks like from here: the error says nothing was spent,
// and the clock says we stopped waiting.
type racingEstimator struct{ calls int }

func (e *racingEstimator) Estimate(ctx context.Context, _ EstimateInput) (Estimate, CallMeta, error) {
	e.calls++
	<-ctx.Done()
	// Zero usage, because nothing was billed. A fake that returned tokens here
	// would be describing a different failure and would make the assertion
	// below pass for the wrong reason.
	return Estimate{}, CallMeta{}, fmt.Errorf("%w: connection refused", ErrEstimateUnreachable)
}

func TestAnOutageThatRacesTheDeadlineIsStillNotMetered(t *testing.T) {
	// F16 (#367) says a call the provider never answered spends none of the
	// athlete's 25 — their allowance must not pay for our supplier's outage.
	//
	// The rewrap uses `%v`, which flattens what it wraps, so without the
	// `!errors.Is(estErr, ErrEstimateUnreachable)` guard an outage that arrives
	// in the same instant as our deadline loses its unreachable match, gets
	// relabelled a timeout, and is metered. Nothing on the ordinary path can
	// produce this — `llm.neverReachedProvider` checks the context errors first
	// — which is exactly why removing the guard survives a suite that lacks
	// this case.
	est := &racingEstimator{}
	usage := &memUsage{}
	h := handlerWithTimeout(est, usage, 20*time.Millisecond)

	w := call(t, h, `{"description":"two eggs"}`)

	if est.calls != 1 {
		t.Fatalf("the estimator was called %d times, want 1", est.calls)
	}
	if len(usage.rows) != 0 {
		t.Fatalf("%d rows recorded for a provider that never answered, want 0 — the athlete "+
			"is paying for our supplier's outage because it happened to race our deadline (F16)",
			len(usage.rows))
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503 — an outage stays an outage even when the deadline "+
			"fires in the same instant, and only the 503 promises the allowance is intact",
			w.Code)
	}
}

func TestTheTimeoutSentinelStaysOutsideTheF16Exemption(t *testing.T) {
	// Placement IS the meaning here, and it is one wrapping away from silently
	// undoing F16 in the other direction. If `ErrEstimateTimeout` ever wrapped
	// `ErrEstimateUnreachable`, the handler's early return would skip the meter
	// on every timed-out call — the free-cancellation bypass, arrived at by
	// accident rather than by decision.
	if !errors.Is(ErrEstimateTimeout, ErrEstimateUnavailable) {
		t.Fatal("ErrEstimateTimeout no longer matches ErrEstimateUnavailable, so every caller " +
			"testing for the general case stops seeing it")
	}
	if errors.Is(ErrEstimateTimeout, ErrEstimateUnreachable) {
		t.Fatal("ErrEstimateTimeout matches ErrEstimateUnreachable, which is the F16 " +
			"not-metered exemption — a timed-out call very likely spent tokens")
	}
}
