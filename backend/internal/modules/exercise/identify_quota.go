package exercise

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// The daily cap on machine identification, per athlete.
//
// # Why a quota at all, when there is already a rate limiter
//
// `identifyLimiter` in cmd/api is `Burst: 20, Every: 30m` — roughly 48 calls a
// day sustained, and **in-memory**, so it resets on process restart. Every
// deploy handed every athlete a fresh burst of 20, which means the ceiling
// stopped being a ceiling on exactly the days we ship most.
//
// The limiter is KEPT. A quota bounds the day, a rate limit bounds the burst,
// and they answer different questions: without the limiter a client bug spends
// the whole day's allowance in one second; without the quota the day has no
// ceiling at all. Neither substitutes for the other.
//
// # Why 20
//
// **This is a judgment, not a measurement, and it should be read as weaker than
// the nutrition caps it sits beside** — those now have live per-call costs
// behind them, and this has none. Nothing has measured what an identify call
// costs on the shipped model.
//
// The shape of the usage is what the number is picked from. Identification is
// the unfamiliar-gym case: an athlete walks into a gym they have not used and
// meets a wall of machines they cannot name. That is bursty and front-loaded —
// a dozen in one session on the first visit, then almost none, because the
// machines stop being unfamiliar. A cap of 5 would fail exactly the session the
// feature exists for.
//
// 20 is also strictly tighter than what shipped (48/day sustained, refilled by
// every deploy), so this cannot loosen anything.
//
// The nutrition module's reasoning applies unchanged and is worth restating: a
// cap an athlete hits during ordinary use teaches them not to rely on the
// feature, which is the opposite of what a release trying to find out whether
// the feature works wants. Generous rather than defensive, with the rate
// limiter underneath catching anything pathological.
const DailyIdentifications = 20

// IdentifyQuotaWindow is how far back the count reaches.
//
// A rolling 24 hours rather than a calendar day, for the reason the nutrition
// window gives: a calendar day needs a timezone this endpoint has no other
// reason to know, and rolling cannot be gamed by calling at 23:59 and again at
// 00:01.
const IdentifyQuotaWindow = 24 * time.Hour

// ErrIdentifyQuotaExhausted means the athlete has used the day's allowance.
//
// Its own sentinel rather than reusing ErrIdentifyRefused: a refusal means "I
// cannot tell what that is, retake the photo", and a quota means "come back
// tomorrow". Collapsing them would have the client tell the athlete to retake a
// photo that was never going to be looked at.
var ErrIdentifyQuotaExhausted = errors.New("exercise: identify quota exhausted")

// IdentifyQuota is what the athlete has left, for reporting rather than for
// deciding — the decision is Allowed, computed in one place so a client cannot
// reach a different answer by comparing the numbers itself.
type IdentifyQuota struct {
	Used      int `json:"used"`
	Limit     int `json:"limit"`
	Remaining int `json:"remaining"`
	// ResetsAt is when the OLDEST call in the window ages out, which is the
	// moment one more becomes available. Null when nothing is used, since
	// there is nothing waiting to expire.
	ResetsAt *time.Time `json:"resets_at"`
}

// Allowed reports whether one more call may be made.
func (q IdentifyQuota) Allowed() bool { return q.Remaining > 0 }

// NewIdentifyQuota builds the report from a count and the oldest call in the
// window.
//
// Remaining is clamped at zero: a count above the limit is reachable after the
// cap is LOWERED in a deploy, and a negative "remaining" rendered in a client
// reads as a bug in the app rather than as a cap that moved.
func NewIdentifyQuota(used int, oldest *time.Time) IdentifyQuota {
	remaining := DailyIdentifications - used
	if remaining < 0 {
		remaining = 0
	}
	q := IdentifyQuota{Used: used, Limit: DailyIdentifications, Remaining: remaining}
	if oldest != nil {
		resets := oldest.Add(IdentifyQuotaWindow)
		q.ResetsAt = &resets
	}
	return q
}

// IdentifyRecord is one call, written whether or not it produced a shortlist.
type IdentifyRecord struct {
	UserID         string
	Succeeded      bool
	Model          string
	CandidateCount int
}

// IdentifyUsageRepository counts and records identification calls.
//
// Separate from the exercise Repository and from ContentRepository because it
// has nothing to do with the catalog — it is spend metering, and folding it
// into the type every exercise read goes through would put a billing concern
// in the middle of the catalog.
type IdentifyUsageRepository interface {
	// Quota reports usage for one athlete within the window ending at `now`.
	// `now` is a parameter rather than read from the clock so the window
	// boundary is testable without waiting a day.
	Quota(ctx context.Context, userID string, now time.Time) (IdentifyQuota, error)
	// Record writes one call.
	Record(ctx context.Context, rec IdentifyRecord) error
}

// CheckIdentifyQuota is the gate, in one function so every caller reaches the
// same answer.
func CheckIdentifyQuota(ctx context.Context, repo IdentifyUsageRepository, userID string, now time.Time) (IdentifyQuota, error) {
	q, err := repo.Quota(ctx, userID, now)
	if err != nil {
		return IdentifyQuota{}, err
	}
	if !q.Allowed() {
		return q, fmt.Errorf("%w: %d identifications in the last day", ErrIdentifyQuotaExhausted, q.Used)
	}
	return q, nil
}
