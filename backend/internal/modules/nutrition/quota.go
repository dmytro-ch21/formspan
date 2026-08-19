package nutrition

import (
	"context"
	"fmt"
	"time"
)

// The daily cap, per athlete.
//
// # ONE budget, not one per path — and the measurement that collapsed them
//
// This was 20 text / 5 photo, counted separately so "the dearer path cannot
// exhaust the cheap one". That split has now been wrong twice, in opposite
// directions, and the second correction is what removed it.
//
// It was first sized on an ASSUMED ~50x cost ratio between a photo call and a
// text one. Measured on Haiku that was ~1.4x. Measured on the shipped model
// (`gpt-5.6-luna`, live calls, 2026-08-19) the picture is this:
//
//	case                       input   output   cached   items
//	"two eggs"                  1317      184        0       1
//	3-item meal, typed          1327      519     1302       3
//	6-item meal, typed          1348      798     1302       6
//	6-item meal, typed (again)  1348     1022     1345       6
//	768px photo                 2006        —        0       —
//	1024px photo                2543        —        0       —
//
// Three things follow, and together they say the split was measuring the wrong
// variable.
//
// **Input is a floor, not a variable.** ~1,340 tokens whatever the athlete
// types, because the system prompt and JSON schema are sent every time and
// dominate. A photo adds ~658 tokens at 768px — an addition, never a
// multiplier.
//
// **Output is the bill, and it tracks ITEM COUNT.** 184 tokens for one item,
// 519 for three, ~885 for six. Roughly half of that is reasoning, which is
// billed as output. So the expensive call is a BIG MEAL, and it is exactly as
// expensive typed as photographed — a six-item description costs three to four
// times a one-item photograph.
//
// **Photo-vs-text, for the same meal, is about 1.2–1.5x.** Slightly worse than
// the raw token counts suggest, because a photo call gets NO prompt-cache
// discount at all (measured: 0 cached, against ~1,345 of 1,348 on a warm text
// call). Still nowhere near a difference worth two counters.
//
// So the athlete who photographed five meals was being stopped from
// photographing a sixth while remaining free to type a twentieth — a rule that
// bore no relation to what anything cost. One budget is simpler and closer to
// the truth.
//
// **Note the run-to-run spread**: the same six-item description returned 798
// and 1,022 output tokens on consecutive calls, ±13%. A single measurement of
// a reasoning model is not a cost, and any future re-tune should say how many
// samples it rests on. These figures are four synthetic descriptions, not
// production traffic — which is what the usage columns added alongside this
// exist to accumulate.
//
// # Why 25
//
// The two old caps summed to 25, and nothing measured argues for moving the
// total — the correction was to the SHAPE of the limit, not its size. Holding
// the total fixed also means no athlete's usable allowance shrinks: anyone who
// was within the old limits is within this one.
//
// It stays deliberately generous rather than defensive. A cap an athlete hits
// during ordinary use teaches them not to rely on the feature, which is the
// opposite of what this release is trying to find out.
//
// # What is NOT lost
//
// `source` is still recorded on every row. The mix of photo to text is a real
// question and the data still answers it; it simply no longer decides who gets
// stopped.
const DailyEstimates = 25

// QuotaWindow is how far back the count reaches.
//
// A rolling 24 hours rather than a calendar day, because a calendar day needs
// a timezone, and the athlete's timezone is a thing this endpoint would
// otherwise have to know for no other reason. Rolling also cannot be gamed by
// logging at 23:59 and again at 00:01.
const QuotaWindow = 24 * time.Hour

// Quota is what the athlete has left, for reporting back rather than for
// deciding — the decision is `Allowed` below, computed in one place so a
// client cannot reach a different answer by comparing the numbers itself.
// **No `Source` field.** It was here when the cap was per-path, and leaving it
// on a combined budget would be worse than removing it: a client rendering
// "3 of 25 photos" from `source: "photo"` and `limit: 25` states something
// false about what the athlete may do next. The field's meaning went with the
// split.
type Quota struct {
	Used      int `json:"used"`
	Limit     int `json:"limit"`
	Remaining int `json:"remaining"`
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
func NewQuota(used int, oldest *time.Time) Quota {
	remaining := DailyEstimates - used
	if remaining < 0 {
		remaining = 0
	}
	q := Quota{Used: used, Limit: DailyEstimates, Remaining: remaining}
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
	// Usage is what the call cost.
	//
	// Recorded because **nothing in this system could previously answer "what
	// did that cost"**, which is why the caps above are still the ones sized
	// against a guess. N49's plan was to replace them with "a week of
	// production traffic" — and a week of it would have produced call counts
	// and nothing else, leaving the numbers exactly as unfounded as before.
	//
	// Zero on a call that never reached the provider; NOT zero on a refusal,
	// which was billed in full.
	Usage Usage
}

// EstimateUsageRepository counts and records estimate calls.
//
// Separate from the nutrition Repository because it has nothing to do with
// what the athlete ate — it is metering, and folding it into the food-log
// repository would put a spend concern inside the type every food read goes
// through.
type EstimateUsageRepository interface {
	// Quota reports usage for one athlete within the window ending at `now`,
	// across BOTH paths. `now` is a parameter rather than read from the clock
	// so the window boundary is testable without waiting a day.
	Quota(ctx context.Context, userID string, now time.Time) (Quota, error)
	// Record writes one call.
	Record(ctx context.Context, rec EstimateRecord) error
}

// CheckQuota is the gate, in one function so every caller reaches the same
// answer.
func CheckQuota(ctx context.Context, repo EstimateUsageRepository, userID string, now time.Time) (Quota, error) {
	q, err := repo.Quota(ctx, userID, now)
	if err != nil {
		return Quota{}, err
	}
	if !q.Allowed() {
		return q, fmt.Errorf("%w: %d estimates in the last day", ErrQuotaExhausted, q.Used)
	}
	return q, nil
}
