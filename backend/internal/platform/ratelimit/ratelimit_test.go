package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A fake clock, because the alternative is a suite that sleeps. A refill test
// against the real clock either takes as long as the window or proves nothing
// — and this project has already shipped a backoff test that passed because
// the value it waited for was shorter than the ladder it was checking.
type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }

func newClock() *clock { return &clock{t: time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)} }

func TestSpendsTheBurstThenRefuses(t *testing.T) {
	c := newClock()
	l := New(Policy{Name: "p", Burst: 3, Every: time.Second}, c.now)

	for i := range 3 {
		if ok, _ := l.Allow("u1"); !ok {
			t.Fatalf("request %d of the burst was refused", i+1)
		}
	}
	ok, retry := l.Allow("u1")
	if ok {
		t.Fatalf("a fourth request got through a burst of 3")
	}
	if retry <= 0 {
		t.Fatalf("a refusal must say when to come back, got %v", retry)
	}
}

func TestRefillsOverTimeAndIsCappedAtBurst(t *testing.T) {
	c := newClock()
	l := New(Policy{Name: "p", Burst: 2, Every: time.Second}, c.now)
	l.Allow("u1")
	l.Allow("u1")
	if ok, _ := l.Allow("u1"); ok {
		t.Fatalf("bucket should be empty")
	}

	c.add(time.Second)
	if ok, _ := l.Allow("u1"); !ok {
		t.Fatalf("one second should have returned one token")
	}

	// CAPPED. An hour idle must not bank an hour of tokens — otherwise going
	// quiet is how you buy a huge burst, which is the shape of the abuse this
	// exists to bound.
	c.add(time.Hour)
	for i := range 2 {
		if ok, _ := l.Allow("u1"); !ok {
			t.Fatalf("burst token %d missing after idling", i+1)
		}
	}
	if ok, _ := l.Allow("u1"); ok {
		t.Fatalf("an idle hour banked more than the burst")
	}
}

func TestKeysAreIndependent(t *testing.T) {
	c := newClock()
	l := New(Policy{Name: "p", Burst: 1, Every: time.Minute}, c.now)

	if ok, _ := l.Allow("alice"); !ok {
		t.Fatalf("alice's first request refused")
	}
	if ok, _ := l.Allow("alice"); ok {
		t.Fatalf("alice got a second token")
	}
	// One athlete exhausting their budget must not touch anybody else's —
	// the whole reason this keys on the account rather than on an IP.
	if ok, _ := l.Allow("bob"); !ok {
		t.Fatalf("bob was limited by alice's spending")
	}
}

// The retry hint has to be REACHABLE: rounded down it is still too early, so
// a client that obeys it exactly gets a second 429 and learns the header lies.
//
// The interval is deliberately NOT a whole number of seconds. With a 3s
// refill the wait is exactly 3s, so rounding up and rounding down give the
// same answer and the test cannot fail — which is what an earlier version of
// this did, and what mutating the rounding exposed.
func TestRetryAfterRoundsUpAndIsActuallyEnough(t *testing.T) {
	const every = 2500 * time.Millisecond

	c := newClock()
	l := New(Policy{Name: "p", Burst: 1, Every: every}, c.now)
	l.Allow("u1")

	ok, retry := l.Allow("u1")
	if ok {
		t.Fatalf("expected refusal")
	}
	// 2.5s of real wait must advertise as 3, never 2.
	if retry != 3*time.Second {
		t.Fatalf("want 3s (2.5s rounded up), got %v", retry)
	}

	// Waiting what a rounding-DOWN answer would have said is still too early.
	c.add(2 * time.Second)
	if ok, _ := l.Allow("u1"); ok {
		t.Fatalf("a token arrived at 2s, so 2s would have been an honest hint")
	}

	// Waiting the advertised time works — the hint is enough, not merely big.
	c2 := newClock()
	l2 := New(Policy{Name: "p", Burst: 1, Every: every}, c2.now)
	l2.Allow("u1")
	_, retry2 := l2.Allow("u1")
	c2.add(retry2)
	if ok, _ := l2.Allow("u1"); !ok {
		t.Fatalf("obeying Retry-After exactly still got refused")
	}
}

func TestSweepDropsOnlyFullIdleBuckets(t *testing.T) {
	c := newClock()
	l := New(Policy{Name: "p", Burst: 4, Every: time.Hour}, c.now)

	// Two buckets at deliberately different depths: one drained, one barely
	// touched. After the same idle period only the shallow one has refilled
	// to full, which is what makes this test able to tell the two cases apart
	// at all — an earlier version had both refill and proved nothing.
	for range 4 {
		l.Allow("drained")
	}
	l.Allow("shallow")
	if l.Len() != 2 {
		t.Fatalf("want 2 buckets, got %d", l.Len())
	}

	// 90 minutes: "shallow" (3 left) refills past its cap and is full;
	// "drained" (0 left) reaches 1.5 of 4 and is not.
	c.add(90 * time.Minute)
	if dropped := l.Sweep(30 * time.Minute); dropped != 1 {
		t.Fatalf("want exactly the full bucket swept, dropped %d", dropped)
	}
	if l.Len() != 1 {
		t.Fatalf("want the partly-spent bucket kept, %d remain", l.Len())
	}
	// And it really is the drained one that survived — dropping THAT would be
	// the free reset an abuser wants: go quiet, come back with a full bucket.
	if ok, _ := l.Allow("drained"); !ok {
		t.Fatalf("drained bucket should have 1.5 tokens")
	}
	if ok, _ := l.Allow("drained"); ok {
		t.Fatalf("the drained bucket was reset by the sweep")
	}

	// Once it genuinely refills, it goes too.
	c.add(5 * time.Hour)
	if dropped := l.Sweep(30 * time.Minute); dropped != 1 {
		t.Fatalf("want the refilled bucket swept, dropped %d", dropped)
	}
	if l.Len() != 0 {
		t.Fatalf("buckets left: %d", l.Len())
	}
	// A swept athlete is exactly a new one — owed a burst, and no more.
	for i := range 4 {
		if ok, _ := l.Allow("drained"); !ok {
			t.Fatalf("token %d missing after sweep", i+1)
		}
	}
	if ok, _ := l.Allow("drained"); ok {
		t.Fatalf("a swept bucket handed back more than the burst")
	}
}

func TestMiddlewareRejectsWithRetryAfterAndTheContractCode(t *testing.T) {
	c := newClock()
	l := New(Policy{Name: "p", Burst: 1, Every: 5 * time.Second}, c.now)
	key := func(*http.Request) (string, bool) { return "u1", true }

	served := 0
	h := Middleware(l, key)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { served++ }))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/anything", nil))
	if rec.Code != http.StatusOK || served != 1 {
		t.Fatalf("first request: code %d, served %d", rec.Code, served)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/anything", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429, got %d", rec.Code)
	}
	if served != 1 {
		t.Fatalf("a limited request still reached the handler")
	}
	if got := rec.Header().Get("Retry-After"); got != "5" {
		t.Fatalf(`want Retry-After "5", got %q`, got)
	}
	if body := rec.Body.String(); !contains(body, `"code":"rate_limited"`) {
		t.Fatalf("body missing the contract code: %s", body)
	}
	// The policy name is for the log, never the response — which limit you
	// tripped is free reconnaissance.
	if body := rec.Body.String(); contains(body, `"p"`) {
		t.Fatalf("the policy name leaked into the response: %s", body)
	}
}

// **`Reject` rounds up on its own, so the invariant is local.** (F15.)
//
// Every caller today reaches it through `Allow`, which already returns a
// whole-second duration — so this can only be tested by calling `Reject`
// DIRECTLY with a fractional one, which is exactly the future caller the guard
// exists for. Through the middleware the two roundings agree and the assertion
// would pass with the ceiling deleted.
func TestRejectRoundsUpAFractionalWaitItIsHandedDirectly(t *testing.T) {
	for _, tc := range []struct {
		d    time.Duration
		want string
	}{
		{1500 * time.Millisecond, "2"},
		{100 * time.Millisecond, "1"},
		{5 * time.Second, "5"}, // exact: not carried to 6
		{0, "1"},               // never 0 — that invites the retry just refused
		{-time.Hour, "1"},
	} {
		rec := httptest.NewRecorder()
		Reject(rec, httptest.NewRequest(http.MethodGet, "/v1/anything", nil), "p", tc.d)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("Reject(%s) wrote status %d, want 429", tc.d, rec.Code)
		}
		if got := rec.Header().Get("Retry-After"); got != tc.want {
			t.Errorf("Reject(%s) set Retry-After %q, want %q", tc.d, got, tc.want)
		}
	}
}

// FAILS OPEN with no key. A limiter that rejects what it cannot attribute
// turns a momentary identity gap into an outage.
func TestMiddlewareLetsUnidentifiedRequestsThrough(t *testing.T) {
	c := newClock()
	l := New(Policy{Name: "p", Burst: 0, Every: time.Hour}, c.now)
	none := func(*http.Request) (string, bool) { return "", false }

	served := 0
	h := Middleware(l, none)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { served++ }))
	for range 3 {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/healthz", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("unidentified request refused: %d", rec.Code)
		}
	}
	if served != 3 {
		t.Fatalf("served %d of 3", served)
	}
}

// The Burst clamp is load-bearing and had NO failing test: review deleted it
// and the whole suite stayed green, because the only Burst-0 fixture was the
// fail-open test, whose key func returns false so Allow never runs. Without
// the clamp a Burst-0 policy rejects 100% of its traffic forever.
func TestABurstOfZeroIsClampedRatherThanBlockingEverything(t *testing.T) {
	c := newClock()
	l := New(Policy{Name: "p", Burst: 0, Every: time.Second}, c.now)
	if ok, _ := l.Allow("u1"); !ok {
		t.Fatalf("a Burst-0 policy refused its very first request")
	}
}

// A non-positive Every is refused at construction, loudly.
//
// The two bad values fail in opposite directions and only one is survivable:
// zero divides into an infinite refill and silently DISABLES the limit, while
// negative makes the refill DRAIN the bucket, so after the first burst every
// request 429s forever with a Retry-After that waiting can never satisfy. On
// the default policy that is a total authenticated-API outage from a sign
// typo — which is why this panics at boot rather than clamping quietly.
func TestNonPositiveEveryIsRefusedAtConstruction(t *testing.T) {
	for _, every := range []time.Duration{0, -time.Second} {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatalf("New accepted Every=%v", every)
				}
			}()
			New(Policy{Name: "p", Burst: 5, Every: every}, nil)
		}()
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
