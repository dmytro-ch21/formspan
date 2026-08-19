package nutrition

import (
	"context"
	"fmt"
	"time"
)

// The daily caps, per athlete, per path.
//
// # Why two numbers and not one
//
// **MEASURED, after an earlier version of this comment claimed a photo cost
// ~50x a description and was wrong by nearly two orders of magnitude.** With
// `count_tokens` against the real schema: text-only is 1,537 input tokens and a
// 1080px photo is 2,645 — the image adds ~1,108. At Sonnet 5's introductory
// rate that is 0.73c against 0.95c, a ratio of **1.3x**.
//
// The mistake was costing the image and ignoring the floor: the JSON schema
// plus system prompt are ~1,500 tokens on EVERY call, so they dominate and the
// picture is an addition rather than a multiplier.
//
// Two counters are still right, for a reason that survives the correction: a
// photo is the more expensive path and the one a runaway client would hammer,
// and splitting them means the cheap path cannot be exhausted by the dear one.
// But the split is now a mild precaution rather than the load-bearing cost
// control the first version claimed, and the caps should be read that way.
//
// # Why these numbers
//
// 20 text covers heavy logging with room to correct — five or six meals plus
// re-describing the ones that came back wrong. 5 photo covers the genuinely
// unfamiliar meals, which is what the photo path is for; the text path is the
// feature and the camera is the fallback.
//
// They are deliberately generous rather than defensive. A cap an athlete hits
// during ordinary use teaches them not to rely on the feature, which is the
// opposite of what this release is trying to find out — whether describing a
// meal works well enough that a food database is redundant. That question
// cannot be answered by a quota that stops people using it.
const (
	DailyTextEstimates  = 20
	DailyPhotoEstimates = 5
)

// QuotaWindow is how far back the count reaches.
//
// A rolling 24 hours rather than a calendar day, because a calendar day needs
// a timezone, and the athlete's timezone is a thing this endpoint would
// otherwise have to know for no other reason. Rolling also cannot be gamed by
// logging at 23:59 and again at 00:01.
const QuotaWindow = 24 * time.Hour

// LimitFor is the cap for a source.
func LimitFor(src EstimateSource) int {
	if src == SourcePhoto {
		return DailyPhotoEstimates
	}
	return DailyTextEstimates
}

// Quota is what the athlete has left, for reporting back rather than for
// deciding — the decision is `Allowed` below, computed in one place so a
// client cannot reach a different answer by comparing the numbers itself.
type Quota struct {
	Source    EstimateSource `json:"source"`
	Used      int            `json:"used"`
	Limit     int            `json:"limit"`
	Remaining int            `json:"remaining"`
	// ResetsAt is when the OLDEST call in the window ages out, which is the
	// moment one more becomes available. Null when nothing is used, since
	// there is nothing waiting to expire.
	ResetsAt *time.Time `json:"resets_at"`
}

// Allowed reports whether one more call may be made.
func (q Quota) Allowed() bool { return q.Remaining > 0 }

// NewQuota builds the report from a count and the oldest call in the window.
//
// Remaining is clamped at zero: a count above the limit is possible after the
// caps are lowered in a deploy, and a negative "remaining" rendered in a client
// would read as a bug in the app rather than as a cap that moved.
func NewQuota(src EstimateSource, used int, oldest *time.Time) Quota {
	limit := LimitFor(src)
	remaining := limit - used
	if remaining < 0 {
		remaining = 0
	}
	q := Quota{Source: src, Used: used, Limit: limit, Remaining: remaining}
	if oldest != nil {
		resets := oldest.Add(QuotaWindow)
		q.ResetsAt = &resets
	}
	return q
}

// EstimateRecord is one call, written whether or not it produced a draft.
type EstimateRecord struct {
	UserID    string
	Source    EstimateSource
	Succeeded bool
	Model     string
	ItemCount int
}

// EstimateUsageRepository counts and records estimate calls.
//
// Separate from the nutrition Repository because it has nothing to do with
// what the athlete ate — it is metering, and folding it into the food-log
// repository would put a spend concern inside the type every food read goes
// through.
type EstimateUsageRepository interface {
	// Quota reports usage for one athlete and source within the window ending
	// at `now`. `now` is a parameter rather than read from the clock so the
	// window boundary is testable without waiting a day.
	Quota(ctx context.Context, userID string, src EstimateSource, now time.Time) (Quota, error)
	// Record writes one call.
	Record(ctx context.Context, rec EstimateRecord) error
}

// CheckQuota is the gate, in one function so every caller reaches the same
// answer.
func CheckQuota(ctx context.Context, repo EstimateUsageRepository, userID string, src EstimateSource, now time.Time) (Quota, error) {
	q, err := repo.Quota(ctx, userID, src, now)
	if err != nil {
		return Quota{}, err
	}
	if !q.Allowed() {
		return q, fmt.Errorf("%w: %d %s estimates in the last day", ErrQuotaExhausted, q.Used, src)
	}
	return q, nil
}
