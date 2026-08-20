package bjj

import (
	"context"
	"fmt"
	"time"
)

// DailyReflectionDrafts is the per-athlete cap, and it is sized against a
// measurement rather than a feeling.
//
// # What a draft actually costs
//
// From N37's own run file (evals/bjj-dictation/results/gpt-5.6-luna.json, 33
// live calls):
//
//	input      350,786 tokens total — 10,630 per call
//	  cached   350,687 of those, i.e. everything after the first call
//	output       5,633 tokens total —    171 per call
//
// The input is enormous and almost free, which is the whole shape of this
// feature: the 542-technique catalog is 10,600 of those tokens, it is BYTE
// IDENTICAL for every athlete and every call, and it therefore lands in the
// provider's prompt cache at roughly a tenth of the price. What is left to pay
// for is 171 output tokens.
//
// Against `nutrition`'s own measured numbers on the same provider (1,337 in /
// 726 out, ~0.11c a call) and the per-token prices those imply, a dictation
// draft comes to roughly **0.04c** — about a THIRD of a meal estimate, despite
// asking eight times as much prompt, because the prompt is cached and the
// answer is short. A cold call — the first after a deploy moves the catalog, or
// after the cache window lapses — pays the full 10,630 uncached, roughly 0.21c.
//
// Ten a day is therefore between 0.4c and 2.1c per athlete at the absolute
// ceiling, and nothing like the ceiling in practice.
//
// # Why ten
//
// A reflection happens once per session. Two sessions in a day is a lot, and a
// re-draft after fixing what the keyboard did to "omoplata" is the ordinary
// second attempt. Ten leaves room for both and for a bad night of transcription
// on top, which matters because a cap an athlete hits during honest use teaches
// them not to use the feature — and this release's open question is whether
// dictating a reflection is better than tapping one out, which a cap that stops
// people dictating cannot answer.
//
// # Why the number is stated with its measurement attached
//
// N26 sized its first caps against a claimed photo-to-text cost ratio of ~50x
// that measured at ~1.1x, because the estimate costed the image and ignored the
// floor. The lesson taken here is not "be careful with ratios" but "publish the
// tokens": the figures above are copied from a run file anyone can re-read, so
// the next person to move this number can check whether the arithmetic behind
// it still holds instead of inheriting a claim.
const DailyReflectionDrafts = 10

// DraftQuotaWindow is how far back the count reaches.
//
// A rolling 24 hours rather than a calendar day, matching nutrition's: a
// calendar day needs a timezone this endpoint would otherwise have no reason to
// know, and a rolling window cannot be gamed by drafting at 23:59 and again at
// 00:01.
const DraftQuotaWindow = 24 * time.Hour

// DraftQuota is what the athlete has left.
//
// Reported for the client to render; the DECISION is `Allowed`, computed in one
// place so a client cannot reach a different answer by comparing the numbers
// itself.
type DraftQuota struct {
	Used      int `json:"used"`
	Limit     int `json:"limit"`
	Remaining int `json:"remaining"`
	// ResetsAt is when the OLDEST call in the window ages out, which is the
	// moment one more becomes available. Null when nothing is used, since there
	// is nothing waiting to expire.
	ResetsAt *time.Time `json:"resets_at"`
}

// Allowed reports whether one more call may be made.
func (q DraftQuota) Allowed() bool { return q.Remaining > 0 }

// NewDraftQuota builds the report from a count and the oldest call in the
// window.
//
// Remaining is clamped at zero: a count above the limit is possible after the
// cap is lowered in a deploy, and a negative "remaining" rendered in a client
// would read as a bug in the app rather than as a cap that moved.
func NewDraftQuota(used int, oldest *time.Time) DraftQuota {
	remaining := DailyReflectionDrafts - used
	if remaining < 0 {
		remaining = 0
	}
	q := DraftQuota{Used: used, Limit: DailyReflectionDrafts, Remaining: remaining}
	if oldest != nil {
		resets := oldest.Add(DraftQuotaWindow)
		q.ResetsAt = &resets
	}
	return q
}

// DraftRecord is one call, written whether or not it produced a draft.
type DraftRecord struct {
	UserID    string
	Succeeded bool
	Model     string
	TagCount  int
}

// DraftUsageRepository counts and records reflection-draft calls.
//
// Separate from `SessionRepository` because it has nothing to do with what
// happened on the mat — it is spend metering, and folding it into the type every
// session read goes through would put a billing concern inside jiu-jitsu.
type DraftUsageRepository interface {
	// DraftQuota reports usage for one athlete within the window ending at
	// `now`. `now` is a parameter rather than read from the clock so the window
	// boundary is testable without waiting a day.
	DraftQuota(ctx context.Context, userID string, now time.Time) (DraftQuota, error)
	// RecordDraft writes one call.
	RecordDraft(ctx context.Context, rec DraftRecord) error
}

// CheckDraftQuota is the gate, in one function so every caller reaches the same
// answer.
//
// **It runs before the model call, never after.** A check afterwards meters
// spend that has already happened, which is not a quota but a receipt — and the
// handler test asserts the completer was called zero times when this refuses,
// because that is the only way to know the ordering did not quietly invert.
//
// # It is advisory under concurrency, deliberately
//
// Count-then-act with no lock and no transaction, so N simultaneous requests
// from one athlete at `used = 9` all pass and the cap overshoots by up to the
// number in flight. That is a decision rather than an oversight: the exposure is
// bounded by concurrency and priced in fractions of a cent, and the alternatives
// — a serialisable transaction or an advisory lock — put a write-path lock in
// front of a call that already carries a model round-trip.
//
// `NewDraftQuota` clamps `Remaining` at zero, so an overshoot reports as
// exhausted rather than as a negative count. Written down because a future
// reviewer will find it, and an unstated trade-off reads as a bug.
func CheckDraftQuota(ctx context.Context, repo DraftUsageRepository, userID string, now time.Time) (DraftQuota, error) {
	q, err := repo.DraftQuota(ctx, userID, now)
	if err != nil {
		return DraftQuota{}, err
	}
	if !q.Allowed() {
		return q, fmt.Errorf("%w: %d drafts in the last day", ErrDraftQuotaExhausted, q.Used)
	}
	return q, nil
}
