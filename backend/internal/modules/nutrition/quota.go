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
//	1080px photo, real plate    2620   795..1374    1792       6
//
// Three things follow, and together they say the split was measuring the wrong
// variable.
//
// **Input is a floor, not a variable.** ~1,340 tokens whatever the athlete
// types, because the system prompt and JSON schema are sent every time and
// dominate. A photograph is an ADDITION to that floor, never a multiplier —
// and the size of the addition is the resolution the client sends, not a
// property of "being a photo": ~658 tokens at 768px, ~1,195 at 1024px, and
// **~1,272 at the 1080px the app actually resizes to** (`describe.tsx` does
// `resize: { width: 1080 }, compress: 0.8`). An earlier version of this
// comment quoted ~500 for the image, which was both the wrong number and the
// wrong resolution.
//
// **Output is the bill, and it tracks ITEM COUNT.** 184 tokens for one item,
// 519 for three, ~885 for six typed. Roughly half of that is reasoning, which
// is billed as output. So the expensive call is a BIG MEAL, and it is about as
// expensive typed as photographed.
//
// **That last claim is measured now rather than inferred.** The real plate from
// N40 — fried egg, potato hash, pickled mushrooms, pickles, bread — went
// through the shipped path nine times at 1080px:
//
//	real plate, 6 items   input 2,620   output 795..1,374 (mean ~994)
//	typed, 6 items        input 1,348   output 798..1,022 (mean ~885)
//
// Photo output sits inside the typed range for the same meal, which is what
// "output tracks item count, not modality" predicted. The previous version of
// this comment had to infer that; it no longer does.
//
// **Two corrections to earlier claims in this file, both from too few
// samples.** Recorded rather than quietly fixed, because the sampling mistake
// is more reusable than either number.
//
//  1. It said a photo call gets NO prompt-cache discount ("0 cached"). Wrong —
//     that rested on two photo calls against a cold cache. Warm, every one of
//     six consecutive calls cached 1,792 of 2,620. Photo calls DO cache; they
//     cache a smaller SHARE than text (~68% here, and expect nearer ~51% in
//     production, since 1,792 includes the repeated image bytes and real
//     athletes send different pictures — only the ~1,330-token prompt prefix
//     is shared).
//  2. The photo/text ratio for the same meal is still ~1.2-1.5x, but for a
//     different reason than stated: not "no caching", just more uncached input.
//
// **Run-to-run spread is the finding worth carrying.** Identical input, same
// model, consecutive calls: the typed six-item meal returned 798 and 1,022
// output tokens (±13%), and the photographed one ranged 795 to 1,374 across
// nine runs (**±29%**). A single measurement of a reasoning model is not a
// cost. Any cost claim in this repo should say how many samples it rests on;
// these rest on nine and two, which is why the usage columns exist.
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
