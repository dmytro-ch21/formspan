package session

import "time"

// Progressive-overload suggestions.
//
// This is the first thing in the product that tells an athlete what to do
// rather than recording what they did, so it follows the project's standing
// rule: the recommendation is a **deterministic function of recorded data,
// and it always says why**. No model, no hidden weighting. Every suggestion
// carries a Code a client can branch on and a Reason a human can argue with —
// and if the reason is wrong, the data behind it is visible in the same
// response.
//
// The rule is effort-driven, which is the whole reason RIR and RPE are
// collected at all. Weight alone can't tell you whether a set was easy; a
// lifter who grinds out five reps and one who leaves three in reserve log the
// identical row. So the decision keys off what they reported, and when they
// reported nothing the honest answer is "repeat it", not a guess.

// SuggestionCode is the machine-readable outcome. Clients branch on this;
// they must not pattern-match Reason, which is prose and may change.
type SuggestionCode string

const (
	// SuggestNoHistory: never logged, so there's nothing to reason from.
	SuggestNoHistory SuggestionCode = "no_history"
	// SuggestNotApplicable: not measured in weight (a plank, a run).
	SuggestNotApplicable SuggestionCode = "not_applicable"
	// SuggestIncrease: there was room left, so add the movement's increment.
	SuggestIncrease SuggestionCode = "increase"
	// SuggestRepeatHard: at or near failure last time.
	SuggestRepeatHard SuggestionCode = "repeat_hard"
	// SuggestRepeatUnknownEffort: no RIR or RPE recorded, so effort is unknown.
	SuggestRepeatUnknownEffort SuggestionCode = "repeat_unknown_effort"
	// SuggestRepeatStale: long enough ago that the last number isn't evidence
	// of what you can do today.
	SuggestRepeatStale SuggestionCode = "repeat_stale"
	// SuggestRepeatConsolidate: one rep in reserve — real, but not room.
	SuggestRepeatConsolidate SuggestionCode = "repeat_consolidate"
)

// staleAfter is when a previous performance stops being evidence about today.
// Four weeks is long enough to cover a normal training block plus a missed
// week, and short enough that a layoff doesn't hand someone a number they've
// detrained out of.
const staleAfter = 28 * 24 * time.Hour

// Increments, in kilograms, by movement pattern.
//
// Not one number, because "add 2.5 kg" is trivial on a squat and a fortnight
// of progress on a lateral raise. Scaled to the muscle mass involved, which
// is what the movement pattern already encodes — the coarse pattern earning
// its keep, exactly as intended when it was split from the detail field.
var incrementByPattern = map[string]float64{
	"squat":   5,
	"hinge":   5,
	"olympic": 5,

	"horizontal_push": 2.5,
	"vertical_push":   2.5,
	"horizontal_pull": 2.5,
	"vertical_pull":   2.5,
	"lunge":           2.5,
}

// defaultIncrement covers isolation, core, rotation and anything unmapped —
// the small stuff, where a big jump is a stall dressed up as progress.
const defaultIncrement = 1.25

func incrementFor(pattern string) float64 {
	if v, ok := incrementByPattern[pattern]; ok {
		return v
	}
	return defaultIncrement
}

// Performance is the top working set of the most recent session containing an
// exercise. Warm-ups are excluded upstream: progressing off a warm-up would
// suggest a weight nobody actually worked at.
type Performance struct {
	ExerciseID  string
	PerformedAt time.Time
	Reps        *int
	WeightKg    *float64
	RIR         *int
	RPE         *float64
	// From the catalog, for the increment and the applicability check.
	MovementPattern string
	LoadType        string
}

// Suggestion is what a client shows next to an exercise before its first set.
type Suggestion struct {
	ExerciseID string `json:"exercise_id"`

	// The evidence. Always sent when there is any, even when no increase is
	// suggested — "last time you did X" is useful on its own, and it's what
	// makes the recommendation checkable rather than merely trusted.
	LastPerformedAt *time.Time `json:"last_performed_at"`
	LastReps        *int       `json:"last_reps"`
	LastWeightKg    *float64   `json:"last_weight_kg"`
	LastRIR         *int       `json:"last_rir"`
	LastRPE         *float64   `json:"last_rpe"`

	// SuggestedWeightKg is what to load. Nil when there's nothing to say.
	// Equal to LastWeightKg whenever the answer is "repeat it".
	SuggestedWeightKg *float64       `json:"suggested_weight_kg"`
	Code              SuggestionCode `json:"code"`
	Reason            string         `json:"reason"`

	// EstimatedOneRMKg is what the last set implies you could lift once,
	// effort included. Nil when the set can't support an estimate — no
	// weight, or more effective reps than any rep-max curve survives.
	EstimatedOneRMKg *float64 `json:"estimated_1rm_kg"`
	// BestOneRMKg is the highest estimate anywhere in the caller's history
	// for this exercise, so the current one reads as progress or as ground
	// already covered. Nil when there is none.
	BestOneRMKg *float64 `json:"best_1rm_kg"`
}

// Suggest turns one previous performance into a recommendation.
//
// Ordering matters and is deliberate: applicability, then staleness, then
// effort. A four-month-old set at a hard RPE should read as "it's been a
// while", not "you were near failure" — the older fact is the one that
// governs.
func Suggest(p *Performance, now time.Time) Suggestion {
	if p == nil {
		return Suggestion{
			Code:   SuggestNoHistory,
			Reason: "First time logging this — record what you lift and the next session starts from it.",
		}
	}

	s := Suggestion{
		ExerciseID:      p.ExerciseID,
		LastPerformedAt: &p.PerformedAt,
		LastReps:        p.Reps,
		LastWeightKg:    p.WeightKg,
		LastRIR:         p.RIR,
		LastRPE:         p.RPE,
	}

	// Only weight-bearing work gets a weight suggestion. A plank progresses
	// in seconds and a run in distance; pretending otherwise would put a
	// number where none belongs.
	if p.LoadType != "weight_reps" || p.WeightKg == nil {
		s.Code = SuggestNotApplicable
		s.Reason = "Not measured in weight — nothing to add."
		return s
	}

	repeat := *p.WeightKg
	s.SuggestedWeightKg = &repeat

	if now.Sub(p.PerformedAt) > staleAfter {
		weeks := int(now.Sub(p.PerformedAt).Hours() / (24 * 7))
		s.Code = SuggestRepeatStale
		s.Reason = "It's been " + plural(weeks, "week") + " — repeat this before adding to it."
		return s
	}

	// RIR is checked first where both exist: it's the direct statement of how
	// much was left, and RPE is the same judgement expressed backwards.
	switch {
	case p.RIR == nil && p.RPE == nil:
		s.Code = SuggestRepeatUnknownEffort
		s.Reason = "No effort recorded last time, so there's nothing to say it was easy. Repeat it and log an RIR or RPE."
		return s

	case (p.RIR != nil && *p.RIR == 0) || (p.RPE != nil && *p.RPE >= 9.5):
		s.Code = SuggestRepeatHard
		s.Reason = "Last set was at or near failure. Repeat the weight before adding to it."
		return s

	case (p.RIR != nil && *p.RIR >= 2) || (p.RIR == nil && p.RPE != nil && *p.RPE <= 8):
		add := incrementFor(p.MovementPattern)
		next := *p.WeightKg + add
		s.SuggestedWeightKg = &next
		s.Code = SuggestIncrease
		// Deliberately unit-free: the client shows the target weight in the
		// athlete's own units, and a reason that hardcoded "kg" would leak
		// metric into a pounds interface.
		s.Reason = "You had " + describeRoom(p) + " left last time — there's room to add weight."
		return s

	default:
		// RIR 1, or RPE strictly between 8 and 9.5. Real work, but not room.
		s.Code = SuggestRepeatConsolidate
		s.Reason = "Close to your limit last time. Repeat the weight and consolidate it."
		return s
	}
}

func describeRoom(p *Performance) string {
	if p.RIR != nil {
		return plural(*p.RIR, "rep")
	}
	return "room"
}

func plural(n int, unit string) string {
	if n == 1 {
		return "1 " + unit
	}
	return itoa(n) + " " + unit + "s"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}
