package bjj

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

// fakeDrafter stands in for the model call, and counts how often it was made.
//
// The count is the assertion that matters in this file: this endpoint spends
// money, and "the gate runs first" is only true if the gate's refusal means the
// provider was never reached.
type fakeDrafter struct {
	out   Draft
	err   error
	calls int
	// onCall fires inside the draft, so a test can cancel the request while the
	// "model call" is in flight — which is exactly when the spend has happened
	// and the meter has not yet run.
	onCall func()
}

func (f *fakeDrafter) Draft(_ context.Context, _ DictationInput) (Draft, error) {
	f.calls++
	if f.onCall != nil {
		f.onCall()
	}
	return f.out, f.err
}

// memDraftUsage is an in-memory meter, so these tests need no database.
type memDraftUsage struct {
	rows    []DraftRecord
	quotaFn func() DraftQuota
	recErr  error
	// lastCtxErr is the state of the context the meter was handed. A real
	// Postgres write fails on a cancelled one, so recording it here is how the
	// test sees that bug without a database.
	lastCtxErr error
}

func (m *memDraftUsage) DraftQuota(_ context.Context, _ string, _ time.Time) (DraftQuota, error) {
	if m.quotaFn != nil {
		return m.quotaFn(), nil
	}
	return NewDraftQuota(len(m.rows), nil), nil
}

func (m *memDraftUsage) RecordDraft(ctx context.Context, rec DraftRecord) error {
	m.lastCtxErr = ctx.Err()
	m.rows = append(m.rows, rec)
	return m.recErr
}

func goodDraft() Draft {
	return Draft{
		Tags:  []DraftTag{{Category: CategorySweep, Event: EventScored, Position: "Guard", Count: 1}},
		Model: "gpt-5.6-luna",
	}
}

func callDraft(t *testing.T, h *DraftHandler, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/v1/bjj/reflect/draft", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: "grappler"}))
	w := httptest.NewRecorder()
	h.Draft(w, r)
	return w
}

// # The whole reason the gate is inside the handler
//
// A quota checked after the call is not a quota, it is a receipt: the tokens
// are already spent. This asserts the ordering the only way it can be asserted
// — by counting model calls, which is zero when the gate refuses. Nutrition has
// the identical test for the identical reason.
func TestAnExhaustedQuotaSpendsNothing(t *testing.T) {
	drafter := &fakeDrafter{out: goodDraft()}
	oldest := time.Now().Add(-2 * time.Hour)
	usage := &memDraftUsage{quotaFn: func() DraftQuota {
		return NewDraftQuota(DailyReflectionDrafts, &oldest)
	}}
	h := NewDraftHandler(drafter, usage)

	w := callDraft(t, h, `{"dictation":"rolled five rounds"}`)

	if w.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want 429", w.Code)
	}
	if drafter.calls != 0 {
		t.Errorf("the model was called %d times after the quota refused — the gate is running too late", drafter.calls)
	}
	if len(usage.rows) != 0 {
		t.Errorf("a refused request was metered: %+v", usage.rows)
	}
	// Machine-readable, because a client may not pattern-match the message.
	if w.Header().Get("Retry-After") == "" {
		t.Error("no Retry-After — the client has nothing but prose to act on")
	}
	var body struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "rate_limited" {
		t.Errorf("code = %q, want rate_limited", body.Error.Code)
	}
	if strings.Contains(body.Error.Message, "T") && strings.Contains(body.Error.Message, "Z") {
		t.Errorf("message %q looks like it carries a UTC instant; it must be relative", body.Error.Message)
	}
}

// A refusal costs tokens, so it costs a draft. A meter that counted only
// successes would let a caller loop on input the model keeps declining and pay
// for every attempt.
func TestAFailedCallIsStillMetered(t *testing.T) {
	for name, tc := range map[string]struct {
		err        error
		wantStatus int
	}{
		"refused":     {ErrDraftRefused, http.StatusUnprocessableEntity},
		"unavailable": {ErrDraftUnavailable, http.StatusServiceUnavailable},
	} {
		usage := &memDraftUsage{}
		h := NewDraftHandler(&fakeDrafter{err: tc.err}, usage)

		w := callDraft(t, h, `{"dictation":"rolled five rounds"}`)

		if w.Code != tc.wantStatus {
			t.Errorf("%s: status = %d, want %d", name, w.Code, tc.wantStatus)
		}
		if len(usage.rows) != 1 {
			t.Fatalf("%s: metered %d calls, want 1 — a failure still spent tokens", name, len(usage.rows))
		}
		if usage.rows[0].Succeeded {
			t.Errorf("%s: the row says the call succeeded", name)
		}
	}
}

// The tokens are spent by the time the meter runs, so a caller who hangs up
// mid-call must not escape it — a cancel-loop is exactly the
// spend-somebody-else's-money shape the quota exists to bound.
func TestACancelledRequestIsStillMetered(t *testing.T) {
	usage := &memDraftUsage{}
	ctx, cancel := context.WithCancel(context.Background())
	drafter := &fakeDrafter{out: goodDraft(), onCall: cancel}
	h := NewDraftHandler(drafter, usage)

	r := httptest.NewRequest(http.MethodPost, "/v1/bjj/reflect/draft", strings.NewReader(`{"dictation":"rolled five"}`))
	r = r.WithContext(auth.ContextWithClaims(ctx, &auth.Claims{UserID: "grappler"}))
	h.Draft(httptest.NewRecorder(), r)

	if len(usage.rows) != 1 {
		t.Fatalf("metered %d calls, want 1", len(usage.rows))
	}
	if usage.lastCtxErr != nil {
		t.Errorf("the meter was handed a cancelled context (%v) — a real write would have failed and the call would be free",
			usage.lastCtxErr)
	}
}

func TestASuccessfulDraftReportsWhatIsLeft(t *testing.T) {
	usage := &memDraftUsage{}
	h := NewDraftHandler(&fakeDrafter{out: goodDraft()}, usage)

	w := callDraft(t, h, `{"dictation":"swept him from guard"}`)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var body struct {
		Draft Draft      `json:"draft"`
		Quota DraftQuota `json:"quota"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Draft.Tags) != 1 {
		t.Errorf("draft = %+v, want the tag", body.Draft)
	}
	// The quota is RE-READ after the call, so it already counts this one.
	if body.Quota.Used != 1 || body.Quota.Remaining != DailyReflectionDrafts-1 {
		t.Errorf("quota = %+v, want the call just made to be counted", body.Quota)
	}
	if len(usage.rows) != 1 || !usage.rows[0].Succeeded || usage.rows[0].Model != "gpt-5.6-luna" {
		t.Errorf("metered %+v, want one successful row naming the model", usage.rows)
	}
}

// A meter write that loses a race must not cost the athlete the draft they have
// already paid for.
func TestAMeterFailureDoesNotFailTheRequest(t *testing.T) {
	usage := &memDraftUsage{recErr: context.DeadlineExceeded}
	h := NewDraftHandler(&fakeDrafter{out: goodDraft()}, usage)

	if w := callDraft(t, h, `{"dictation":"swept him"}`); w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 — the draft was already paid for", w.Code)
	}
}

// Nothing this endpoint does writes a session, and the response says so by
// shape: no session id, no tag ids, nothing that could be mistaken for stored.
func TestTheResponseIsADraftAndNotASession(t *testing.T) {
	h := NewDraftHandler(&fakeDrafter{out: goodDraft()}, &memDraftUsage{})

	w := callDraft(t, h, `{"dictation":"swept him"}`)

	body := w.Body.String()
	if !strings.Contains(body, `"draft"`) {
		t.Errorf("response is not named as a draft: %s", body)
	}
	for _, forbidden := range []string{`"session_id"`, `"id":`} {
		if strings.Contains(body, forbidden) {
			t.Errorf("response carries %s, which reads as something that was stored: %s", forbidden, body)
		}
	}
}

// An input that cannot succeed is refused before the quota is touched, so a
// typo never costs an athlete one of their ten.
func TestABadRequestCostsNothing(t *testing.T) {
	for name, body := range map[string]string{
		"not JSON":        `{"dictation":`,
		"empty dictation": `{"dictation":"   "}`,
		"missing field":   `{}`,
		"far too long":    `{"dictation":"` + strings.Repeat("a", MaxDictationRunes+1) + `"}`,
	} {
		drafter := &fakeDrafter{out: goodDraft()}
		usage := &memDraftUsage{}
		h := NewDraftHandler(drafter, usage)

		w := callDraft(t, h, body)

		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, w.Code)
		}
		if drafter.calls != 0 || len(usage.rows) != 0 {
			t.Errorf("%s: a malformed request reached the model (%d calls) or the meter (%d rows)",
				name, drafter.calls, len(usage.rows))
		}
	}
}

// A deploy with no API key runs every other bjj route normally rather than
// refusing to start, and this one says so with a 503 — the request was fine.
func TestAnUnconfiguredDeployIsUnavailableRatherThanBroken(t *testing.T) {
	h := NewDraftHandler(nil, &memDraftUsage{})

	w := callDraft(t, h, `{"dictation":"swept him"}`)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", w.Code)
	}
}

func TestAnUnauthenticatedCallerIsRefusedBeforeAnythingElse(t *testing.T) {
	drafter := &fakeDrafter{out: goodDraft()}
	h := NewDraftHandler(drafter, &memDraftUsage{})

	r := httptest.NewRequest(http.MethodPost, "/v1/bjj/reflect/draft", strings.NewReader(`{"dictation":"swept him"}`))
	w := httptest.NewRecorder()
	h.Draft(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
	if drafter.calls != 0 {
		t.Error("an unauthenticated request reached the model — that is somebody else's money")
	}
}

// The quota is per athlete. Nothing here is shared, and the meter is keyed on
// the caller's own id rather than on anything in the request.
func TestTheQuotaIsChargedToTheCaller(t *testing.T) {
	usage := &memDraftUsage{}
	h := NewDraftHandler(&fakeDrafter{out: goodDraft()}, usage)

	callDraft(t, h, `{"dictation":"swept him"}`)

	if len(usage.rows) != 1 || usage.rows[0].UserID != "grappler" {
		t.Errorf("metered %+v, want the row charged to the caller", usage.rows)
	}
}

// A well-formed answer with nothing in it is a 200 carrying `empty`, not an
// error — the identical shape is the CORRECT answer to "reminder to buy a
// mouthguard", so refusing it would break the honest case to catch the
// dishonest one. It is still metered, because it still cost tokens.
func TestAnEmptyAnswerIsAReportedOutcomeRatherThanAnError(t *testing.T) {
	usage := &memDraftUsage{}
	empty := ResolveDraft(Draft{Note: "the whole sentence ended up in here"}, fixtureCatalog(), "whatever was said")
	h := NewDraftHandler(&fakeDrafter{out: empty}, usage)

	w := callDraft(t, h, `{"dictation":"whatever was said"}`)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var body struct {
		Draft Draft `json:"draft"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Draft.Empty {
		t.Error("empty = false — the client cannot tell this from a successful reading")
	}
	if len(usage.rows) != 1 || usage.rows[0].TagCount != 0 {
		t.Errorf("metered %+v, want one row recording zero tags", usage.rows)
	}
}

// The quota's own arithmetic, including the trap nutrition recorded: deriving a
// reset from an already-derived reset pushes it a further window out.
func TestTheQuotaReportsWhatIsLeftAndWhenItReturns(t *testing.T) {
	oldest := time.Now().Add(-6 * time.Hour)
	q := NewDraftQuota(3, &oldest)

	if q.Used != 3 || q.Remaining != DailyReflectionDrafts-3 || !q.Allowed() {
		t.Errorf("quota = %+v", q)
	}
	if q.ResetsAt == nil || !q.ResetsAt.Equal(oldest.Add(DraftQuotaWindow)) {
		t.Errorf("resets_at = %v, want the oldest call plus the window", q.ResetsAt)
	}
	// Nothing used means nothing waiting to expire.
	if NewDraftQuota(0, nil).ResetsAt != nil {
		t.Error("resets_at is set with nothing used")
	}
	// A cap lowered in a deploy leaves athletes above it; a negative remaining
	// would read as a bug in the app rather than as a cap that moved.
	if got := NewDraftQuota(DailyReflectionDrafts+5, nil); got.Remaining != 0 || got.Allowed() {
		t.Errorf("over-limit quota = %+v, want remaining 0 and not allowed", got)
	}
}

func TestHumaniseDraftWaitReadsLikeSomebodySayingIt(t *testing.T) {
	for _, tc := range []struct {
		d    time.Duration
		want string
	}{
		{30 * time.Second, "under a minute"},
		{time.Minute, "a minute"},
		{25 * time.Minute, "25 minutes"},
		// Rounding carries a shade under an hour up to a flat 60, and
		// "60 minutes" is not how anybody says it.
		{59*time.Minute + 45*time.Second, "about an hour"},
		{7 * time.Hour, "about 7 hours"},
	} {
		if got := humaniseDraftWait(tc.d); got != tc.want {
			t.Errorf("humaniseDraftWait(%v) = %q, want %q", tc.d, got, tc.want)
		}
	}
	// Never zero: a Retry-After of 0 invites the immediate retry the quota just
	// refused.
	if got := draftRetryAfterSeconds(-time.Hour); got != 1 {
		t.Errorf("draftRetryAfterSeconds(negative) = %d, want 1", got)
	}
}

// **Retry-After is rounded UP**, which api-conventions.md states as a promise:
// obeying it exactly has to succeed. Truncating is not a rounding preference —
// the window is `created_at > since`, so a client that waits the advertised
// whole seconds is still inside it by the fraction that was dropped, and gets a
// second 429 for doing exactly what it was told.
func TestRetryAfterRoundsUpSoObeyingItWorks(t *testing.T) {
	for _, tc := range []struct {
		d    time.Duration
		want int
	}{
		{30 * time.Second, 30},
		{30*time.Second + time.Millisecond, 31},
		{500 * time.Millisecond, 1},
		{time.Hour + 200*time.Millisecond, 3601},
	} {
		if got := draftRetryAfterSeconds(tc.d); got != tc.want {
			t.Errorf("draftRetryAfterSeconds(%v) = %d, want %d", tc.d, got, tc.want)
		}
	}
}

// The degraded path, when the post-call quota re-read fails. The response still
// has to obey the field's own contract — `resets_at` is null only when nothing
// is used, and this call has just used one.
func TestADegradedQuotaStillReportsWhenOneComesBack(t *testing.T) {
	usage := &memDraftUsage{quotaFn: func() DraftQuota { return NewDraftQuota(0, nil) }}
	h := NewDraftHandler(&fakeDrafter{out: goodDraft()}, usage)
	// The re-read fails by returning an error the second time; the fake has one
	// answer, so the failure is simulated by making the re-read error directly.
	h.usage = &failOnSecondRead{inner: usage}

	w := callDraft(t, h, `{"dictation":"swept him"}`)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var body struct {
		Quota DraftQuota `json:"quota"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Quota.Used != 1 || body.Quota.Remaining != DailyReflectionDrafts-1 {
		t.Errorf("quota = %+v, want the call just made counted by hand", body.Quota)
	}
	if body.Quota.ResetsAt == nil {
		t.Error("resets_at is null while one draft is used — the client is told nothing ever comes back")
	}
}

// failOnSecondRead answers the gate and then fails the re-read, which is the
// only ordering in which the handler's fallback arithmetic runs.
type failOnSecondRead struct {
	inner *memDraftUsage
	reads int
}

func (f *failOnSecondRead) DraftQuota(ctx context.Context, u string, now time.Time) (DraftQuota, error) {
	f.reads++
	if f.reads > 1 {
		return DraftQuota{}, context.DeadlineExceeded
	}
	return f.inner.DraftQuota(ctx, u, now)
}

func (f *failOnSecondRead) RecordDraft(ctx context.Context, rec DraftRecord) error {
	return f.inner.RecordDraft(ctx, rec)
}
