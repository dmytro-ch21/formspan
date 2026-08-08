// Package ratelimit bounds how fast one athlete can hit the API.
//
// Six features have now shipped recording "no rate limiting" as a residual:
// friend requests can be re-sent after a decline forever, a share puts content
// in somebody else's inbox, and `/v1/notifications` is polled by every client
// on every navigation. Each of those wanted the same thing, which is why this
// is one platform package rather than a counter in six modules.
//
// KEYED BY AUTHENTICATED USER, NOT BY IP. Every route that can be abused sits
// behind RequireAuth, so an abuser must hold a real account — which makes the
// account the right unit. IP is actively wrong here: a gym's wifi, a
// university, and any mobile carrier NAT put hundreds of athletes behind one
// address, so an IP limit tight enough to matter would throttle a whole gym
// because of one person in it.
//
// TOKEN BUCKET, because the traffic this must not break is bursty by design.
// The mobile outbox pushes one request per pending row in a loop with no
// batching and no cap, so an athlete returning from a week offline sends a
// long burst of entirely legitimate writes. A fixed window would reject the
// tail of that; a bucket with a deep burst lets it through and then throttles
// the sustained rate. (The outbox already treats 429 as retryable rather than
// permanent — `RETRYABLE_4XX` in apps/mobile/lib/apiError.ts — so a throttled
// row stays pending and syncs later rather than being dropped. That was true
// before this package existed; it is what makes a limiter safe to add here.)
//
// IN-MEMORY, AND THEREFORE PER-INSTANCE. The API runs as a single Railway
// service today, so one process sees every request and the limit is exact.
// The moment a second replica exists the effective limit becomes N times the
// configured one — approximate, not broken, and still bounded. Fixing that
// needs a shared store (Postgres would put a write on the hot path of the
// most-polled endpoint in the app; Redis is not in the stack). Deliberately
// not solved before there is a second instance to solve it for.
package ratelimit

import (
	"sync"
	"time"
)

// Policy is one named limit.
//
// Burst is what a caller may spend at once from cold; Every is how long one
// token takes to come back. Sustained rate is therefore one request per
// `Every`, with `Burst` of headroom for the bursty-by-design traffic above.
type Policy struct {
	// Name appears in logs and nowhere else — never in a response, since
	// which limit you tripped is not something a caller needs or should be
	// told.
	Name  string
	Burst int
	Every time.Duration
}

// Limiter hands out tokens per key, per policy.
//
// Safe for concurrent use. One mutex guards the whole map, which is the right
// trade at this scale: the map operation is a few nanoseconds and contention
// only matters at a request volume this app is nowhere near. Sharding is the
// fix if that ever changes, and it changes nothing about the semantics.
type Limiter struct {
	policy Policy
	now    func() time.Time

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	// tokens is fractional so that a refill of "one per 3 minutes" accrues
	// smoothly rather than in steps — an integer counter with a truncating
	// divide gives back nothing at all until a whole interval has passed,
	// which makes Retry-After a lie for every caller who waits less.
	tokens float64
	last   time.Time
}

// New builds a limiter for one policy.
//
// The clock is injectable because the alternative is a test suite that sleeps:
// a refill test against the real clock either takes as long as the window or
// proves nothing, and this project has already shipped one backoff test that
// passed because the value it waited for was shorter than the ladder it was
// checking.
func New(p Policy, now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	// Burst clamps quietly: 0 means "allow nothing, forever", which is never
	// what anybody meant to configure and is harmless to round up to 1.
	if p.Burst < 1 {
		p.Burst = 1
	}
	// Every PANICS, and the asymmetry is deliberate — the two bad values fail
	// in opposite directions and only one of them is survivable.
	//
	// Every == 0 divides by zero into an infinite refill, silently DISABLING
	// the policy: the limit quietly does nothing.
	//
	// Every < 0 makes the refill DRAIN the bucket as time passes, so after
	// the first burst every request 429s forever with a Retry-After that
	// waiting can never satisfy. On the default policy — which every
	// authenticated route depends on — a single sign typo is a total API
	// outage that no amount of client backoff escapes.
	//
	// Both are boot-time configuration, fixed literals at a call site nobody
	// reaches at runtime, so failing loudly at startup costs nothing and
	// turns the worse of the two from a mystery outage into a stack trace.
	if p.Every <= 0 {
		panic("ratelimit: policy " + p.Name + " has a non-positive Every; a negative one drains the bucket and 429s forever")
	}
	return &Limiter{policy: p, now: now, buckets: map[string]*bucket{}}
}

// Allow spends a token for key, reporting whether it was available and — when
// it was not — how long until one is.
//
// The retry hint is rounded UP to the next whole second. Rounding down would
// hand back a duration that is still too early, so a client that obeys it
// precisely gets a second 429 and learns that the header lies.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	b, seen := l.buckets[key]
	if !seen {
		b = &bucket{tokens: float64(l.policy.Burst), last: now}
		l.buckets[key] = b
	}

	// Refill for the elapsed time, capped at Burst. Capping is what makes an
	// idle bucket equivalent to a fresh one, so a returning athlete is not
	// owed a month of accrued tokens.
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens += elapsed.Seconds() / l.policy.Every.Seconds()
		if b.tokens > float64(l.policy.Burst) {
			b.tokens = float64(l.policy.Burst)
		}
		b.last = now
	}

	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}

	deficit := 1 - b.tokens
	wait := time.Duration(deficit * float64(l.policy.Every))
	return false, roundUpSecond(wait)
}

func roundUpSecond(d time.Duration) time.Duration {
	if d <= 0 {
		return time.Second
	}
	if r := d % time.Second; r != 0 {
		d += time.Second - r
	}
	return d
}

// Sweep drops buckets that have been full and untouched for longer than idle.
//
// Without it the map is a slow leak: one entry per athlete who has ever made a
// request, held for the life of the process. Bounded by the number of real
// accounts rather than by anything an attacker controls, so this is
// housekeeping and not a defence — but a leak whose ceiling is "every user we
// ever had" is still a leak.
//
// A bucket is only dropped once it is FULL. Dropping a partly-spent one would
// hand back a fresh burst, which is exactly the reset an abuser wants: go
// quiet for the idle period, come back with a full bucket.
func (l *Limiter) Sweep(idle time.Duration) int {
	now := l.now()
	full := float64(l.policy.Burst)

	l.mu.Lock()
	defer l.mu.Unlock()

	dropped := 0
	for key, b := range l.buckets {
		refilled := b.tokens + now.Sub(b.last).Seconds()/l.policy.Every.Seconds()
		if refilled >= full && now.Sub(b.last) >= idle {
			delete(l.buckets, key)
			dropped++
		}
	}
	return dropped
}

// PolicyName identifies which limit a log line is about — the sweeper logs
// three of these and they are indistinguishable otherwise.
func (l *Limiter) PolicyName() string { return l.policy.Name }

// Len is the number of tracked buckets, for the sweeper's log line and tests.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
