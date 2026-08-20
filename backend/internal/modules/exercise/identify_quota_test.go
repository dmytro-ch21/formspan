package exercise

import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// The persisted daily quota on machine identification (N48).
//
// **This file is the first handler-level coverage POST /v1/exercises/identify
// has ever had.** Before it, `NewIdentifyHandler` was referenced by exactly one
// non-test file — `cmd/api/main.go` — so every existing test here covered the
// pure functions (shortlist building, validation, transport sentinels) and
// nothing exercised the handler at all.
//
// That is the gap N7's review named: its spend gate was structurally correct
// but untestable, because the gate lived in main.go and main.go has no test.
// Moving the quota into the handler is what closes it — a gate on the handler
// is exercised by every test that calls the handler, so "is the route actually
// behind the gate" stops being a question somebody has to remember to ask.
//
// The rate limiter is still in main.go and still untested by this file. That is
// honest rather than fixed: it bounds the burst, this bounds the day, and only
// the second one moved.

// onePixelPNG is a real, minimal PNG. It has to be genuine bytes because the
// handler SNIFFS the media type rather than trusting a header, so a string of
// "fake image data" is rejected before the quota is ever consulted — which
// would make every test here pass for the wrong reason.
var onePixelPNG = []byte{
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
	0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84,
	120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1, 246, 23, 56, 85, 0, 0, 0, 0,
	73, 69, 78, 68, 174, 66, 96, 130,
}

type fakeIdentifier struct {
	out   Identification
	err   error
	calls int
}

func (f *fakeIdentifier) Identify(context.Context, IdentifyInput) (Identification, error) {
	f.calls++
	return f.out, f.err
}

// memIdentifyUsage is an in-memory meter. `quotaFn` lets a test place the
// athlete anywhere in the window without writing rows.
type memIdentifyUsage struct {
	quotaFn func() IdentifyQuota
	rows    []IdentifyRecord
	err     error
}

func (m *memIdentifyUsage) Quota(context.Context, string, time.Time) (IdentifyQuota, error) {
	if m.err != nil {
		return IdentifyQuota{}, m.err
	}
	if m.quotaFn != nil {
		return m.quotaFn(), nil
	}
	return NewIdentifyQuota(len(m.rows), nil), nil
}

func (m *memIdentifyUsage) Record(_ context.Context, rec IdentifyRecord) error {
	m.rows = append(m.rows, rec)
	return nil
}

func goodIdentification() Identification {
	return Identification{
		Equipment: "machine",
		Model:     "test-model",
		Candidates: []Candidate{
			{ExerciseID: "leg-press", Name: "Leg Press", Confidence: 0.9},
			{ExerciseID: "hack-squat", Name: "Hack Squat", Confidence: 0.4},
		},
	}
}

// callIdentify sends a real multipart request as an authenticated athlete.
func callIdentify(t *testing.T, h *IdentifyHandler, userID string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("image", "machine.png")
	if err != nil {
		t.Fatalf("multipart: %v", err)
	}
	if _, err := part.Write(onePixelPNG); err != nil {
		t.Fatalf("write image: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}

	r := httptest.NewRequest(http.MethodPost, "/v1/exercises/identify", &body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	if userID != "" {
		r = r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: userID}))
	}
	rec := httptest.NewRecorder()
	h.Identify(rec, r)
	return rec
}

// THE test. Everything else here is bookkeeping; this one is the money.
func TestTheIdentifyQuotaIsCheckedBEFORETheModelIsCalled(t *testing.T) {
	// Checking after the call meters spend that has already happened, which is
	// a receipt rather than a quota. `id.calls == 0` is the assertion that
	// matters: a handler that called first and refused afterwards would still
	// answer 429 and look perfectly correct from the outside.
	id := &fakeIdentifier{out: goodIdentification()}
	usage := &memIdentifyUsage{quotaFn: func() IdentifyQuota {
		return NewIdentifyQuota(DailyIdentifications, nil) // already at the cap
	}}
	h := NewIdentifyHandler(id, usage)

	w := callIdentify(t, h, "user_capped")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d, want 429: %s", w.Code, w.Body)
	}
	if id.calls != 0 {
		t.Fatalf("the model was called %d times at the cap — the money was already spent", id.calls)
	}
}

func TestAnExhaustedIdentifyQuotaSaysWhenAndSetsRetryAfter(t *testing.T) {
	// The message is prose a client renders as written; Retry-After is the
	// machine-readable half, because conventions forbid pattern-matching a
	// message and a client otherwise cannot act on the reset at all.
	oldest := time.Now().Add(-23 * time.Hour)
	usage := &memIdentifyUsage{quotaFn: func() IdentifyQuota {
		return NewIdentifyQuota(DailyIdentifications, &oldest)
	}}
	h := NewIdentifyHandler(&fakeIdentifier{out: goodIdentification()}, usage)

	w := callIdentify(t, h, "user_capped")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d, want 429", w.Code)
	}
	ra := w.Header().Get("Retry-After")
	if ra == "" {
		t.Fatal("no Retry-After on a 429 — a client cannot tell when to come back")
	}
	secs, err := strconv.Atoi(ra)
	if err != nil || secs < 1 {
		t.Fatalf("Retry-After %q is not a positive whole number of seconds", ra)
	}
	// An hour left, give or take rounding. A Retry-After of a whole day would
	// mean the window was measured from the wrong end.
	if secs > int((70 * time.Minute).Seconds()) {
		t.Errorf("Retry-After %ds — the reset looks measured from the wrong end of the window", secs)
	}
	if body := w.Body.String(); !bytes.Contains([]byte(body), []byte("one more in")) {
		t.Errorf("body %s does not say when — a bare refusal gives the athlete nothing to do", body)
	}
	// RELATIVE, never an instant: a UTC timestamp is the wrong wall-clock time
	// for everyone outside UTC and the wrong DAY west of Greenwich.
	if bytes.Contains(w.Body.Bytes(), []byte("T")) && bytes.Contains(w.Body.Bytes(), []byte("Z")) {
		t.Errorf("body %s looks like it carries an RFC3339 instant", w.Body)
	}
}

// **Retry-After is rounded UP**, which api-conventions.md states as a promise:
// obeying it exactly has to succeed. Truncating is not a rounding preference —
// this quota's window is `created_at > since`, so a client that waits the
// advertised whole seconds is still inside it by the fraction that was dropped,
// gets a second 429, and learns that obeying the header does not work. (F15,
// which fixed the same truncation here, in `nutrition` and in `bjj`.)
func TestIdentifyRetryAfterRoundsUpSoObeyingItWorks(t *testing.T) {
	// **Every case has to be one where flooring and ceiling DIFFER, or it is not
	// testing the fix.** A whole number of seconds — "wait 30" — gives the same
	// answer under both roundings, so a table of round numbers passes against
	// the bug. The exact-second cases are here for the opposite reason: the
	// ceiling must not push a client a second further out than the window needs.
	//
	// Wanted values are written out rather than computed, so this cannot become
	// a check on arithmetic the function just performed itself.
	for _, tc := range []struct {
		d    time.Duration
		want int
	}{
		{100 * time.Millisecond, 1},
		{900 * time.Millisecond, 1},
		{time.Second, 1},                   // exact: not carried to 2
		{time.Second + time.Nanosecond, 2}, // the tightest discriminating case
		{30 * time.Second, 30},             // exact
		{30*time.Second + time.Millisecond, 31},
		{59*time.Second + 400*time.Millisecond, 60},
		{time.Hour + 200*time.Millisecond, 3601},
	} {
		if got := identifyRetryAfterSeconds(tc.d); got != tc.want {
			t.Errorf("identifyRetryAfterSeconds(%s) = %d, want %d", tc.d, got, tc.want)
		}
	}

	// Never zero: a Retry-After of 0 invites the immediate retry just refused.
	//
	// Both boundaries, because only one discriminates. A NEGATIVE duration is
	// below zero under any comparison, so it passes whether the guard reads
	// `> 0` or `>= 0`. The case that separates them is a positive duration under
	// one second, which truncates to exactly 0.
	for _, d := range []time.Duration{-time.Hour, 0, 500 * time.Millisecond} {
		if got := identifyRetryAfterSeconds(d); got < 1 {
			t.Errorf("identifyRetryAfterSeconds(%s) = %d, want at least 1", d, got)
		}
	}
}

func TestASuccessfulIdentificationIsMetered(t *testing.T) {
	id := &fakeIdentifier{out: goodIdentification()}
	usage := &memIdentifyUsage{}
	h := NewIdentifyHandler(id, usage)

	if w := callIdentify(t, h, "user_ok"); w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200: %s", w.Code, w.Body)
	}
	if len(usage.rows) != 1 {
		t.Fatalf("%d rows recorded, want 1", len(usage.rows))
	}
	got := usage.rows[0]
	if got.UserID != "user_ok" {
		t.Errorf("metered to %q, want user_ok — a quota billed to the wrong athlete is worse than none", got.UserID)
	}
	if !got.Succeeded {
		t.Error("a successful call was recorded as a failure")
	}
	if got.Model != "test-model" {
		t.Errorf("model %q, want test-model", got.Model)
	}
	if got.CandidateCount != 2 {
		t.Errorf("candidate_count %d, want 2", got.CandidateCount)
	}
}

// Failures cost tokens too, so they have to count — otherwise a caller loops on
// a photo the model keeps declining and pays for every attempt.
func TestAFailedIdentificationIsStillMetered(t *testing.T) {
	for _, c := range []struct {
		name string
		err  error
		want int
	}{
		{"refusal", ErrIdentifyRefused, http.StatusUnprocessableEntity},
		{"outage", ErrIdentifyUnavailable, http.StatusServiceUnavailable},
	} {
		t.Run(c.name, func(t *testing.T) {
			usage := &memIdentifyUsage{}
			h := NewIdentifyHandler(&fakeIdentifier{err: c.err}, usage)

			w := callIdentify(t, h, "user_fail")
			if w.Code != c.want {
				t.Fatalf("status %d, want %d: %s", w.Code, c.want, w.Body)
			}
			if len(usage.rows) != 1 {
				t.Fatalf("%d rows recorded, want 1 — a %s was not metered", len(usage.rows), c.name)
			}
			if usage.rows[0].Succeeded {
				t.Errorf("a %s was recorded as a success", c.name)
			}
		})
	}
}

// An unauthenticated call must not reach the model, and must not be metered —
// a quota keyed on an empty user id meters every athlete into one bucket.
func TestIdentifyWithoutClaimsSpendsNothing(t *testing.T) {
	id := &fakeIdentifier{out: goodIdentification()}
	usage := &memIdentifyUsage{}
	h := NewIdentifyHandler(id, usage)

	w := callIdentify(t, h, "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401: %s", w.Code, w.Body)
	}
	if id.calls != 0 {
		t.Errorf("the model was called %d times for an unauthenticated request", id.calls)
	}
	if len(usage.rows) != 0 {
		t.Errorf("%d rows metered with no athlete to bill", len(usage.rows))
	}
}

// A meter that cannot be read must not be assumed empty. Failing open here
// would make a database blip an unmetered spending window.
func TestAnUnreadableQuotaRefusesRatherThanSpends(t *testing.T) {
	id := &fakeIdentifier{out: goodIdentification()}
	usage := &memIdentifyUsage{err: errors.New("database is down")}
	h := NewIdentifyHandler(id, usage)

	w := callIdentify(t, h, "user_x")
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500: %s", w.Code, w.Body)
	}
	if id.calls != 0 {
		t.Fatalf("the model was called though the quota could not be read — a database blip is now a spending window")
	}
	// The raw error must not reach the client.
	if bytes.Contains(w.Body.Bytes(), []byte("database is down")) {
		t.Errorf("the internal error leaked to the client: %s", w.Body)
	}
}

// An unconfigured deploy refuses before the quota is touched: there is nothing
// to meter if no call can be made.
func TestIdentifyWithNoProviderIsNotMetered(t *testing.T) {
	usage := &memIdentifyUsage{}
	h := NewIdentifyHandler(nil, usage)

	w := callIdentify(t, h, "user_x")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503: %s", w.Code, w.Body)
	}
	if len(usage.rows) != 0 {
		t.Errorf("%d rows metered on a deploy that cannot identify anything", len(usage.rows))
	}
}

func TestIdentifyQuotaArithmetic(t *testing.T) {
	if q := NewIdentifyQuota(0, nil); q.Remaining != DailyIdentifications || !q.Allowed() {
		t.Errorf("fresh quota: %+v", q)
	}
	if q := NewIdentifyQuota(DailyIdentifications, nil); q.Remaining != 0 || q.Allowed() {
		t.Errorf("exhausted quota should not be allowed: %+v", q)
	}
	// Reachable after the cap is LOWERED in a deploy. A negative "remaining"
	// rendered in a client reads as a bug in the app rather than a moved cap.
	if q := NewIdentifyQuota(DailyIdentifications+5, nil); q.Remaining != 0 {
		t.Errorf("remaining %d, want clamped to 0", q.Remaining)
	}
	// ResetsAt is derived from the OLDEST call, which is the next to age out.
	oldest := time.Now().Add(-2 * time.Hour)
	q := NewIdentifyQuota(3, &oldest)
	if q.ResetsAt == nil || !q.ResetsAt.Equal(oldest.Add(IdentifyQuotaWindow)) {
		t.Errorf("resets_at %v, want oldest+window", q.ResetsAt)
	}
	// Nothing used means nothing waiting to expire.
	if q := NewIdentifyQuota(0, nil); q.ResetsAt != nil {
		t.Errorf("resets_at %v on an unused quota", q.ResetsAt)
	}
}

// The gate is tighter than what shipped. If someone raises this above the rate
// limiter's sustained rate the quota stops binding and silently does nothing.
func TestTheDailyCapIsTighterThanTheRateLimiterItBacksUp(t *testing.T) {
	// identifyLimiter is Burst 20, Every 30m — 48/day sustained.
	const limiterSustainedPerDay = 48
	if DailyIdentifications >= limiterSustainedPerDay {
		t.Fatalf("DailyIdentifications is %d against the limiter's ~%d/day — "+
			"a quota at or above the burst rate never binds and is decoration",
			DailyIdentifications, limiterSustainedPerDay)
	}
}
