package session

import (
	"math"
	"time"
)

// Double progression, autoregulated by reported effort.
//
// This is the thing in the product that tells an athlete what to do rather
// than recording what they did, so it follows the project's standing rule: the
// recommendation is a **deterministic function of recorded data, and it always
// says why**. No model, no hidden weighting. Every plan carries a Code a client
// can branch on and a Reason a human can argue with — and if the reason is
// wrong, the data behind it is in the same response.
//
// It replaced an earlier rule (`Suggest`, removed in the same change) that
// looked at one set and added weight whenever two reps were left in reserve.
// That reads as progression and isn't: it moves load on
// a single good set regardless of whether the session's other sets held up,
// and it has no answer to a stall except "repeat", forever.
//
// What's here is the scheme most strength literature converges on for
// non-novice lifters, and it's deliberately the *basic* one:
//
//  1. Work inside a **rep range**. Add reps at the same load until the top of
//     the range is reached on every working set.
//  2. Then add load and drop back to the bottom of the range. Load and reps
//     progress alternately — hence "double".
//  3. **Effort gates both.** A set taken to failure is not evidence of room,
//     so RIR/RPE decides whether a rep is even available. This is why the app
//     collects effort at all (Helms et al.'s RIR-based autoregulation; the
//     same reasoning behind RPE-scaled programming).
//  4. **A stall triggers a deload, not another repeat.** Three sessions at
//     one load with no rep gained is a plateau; the evidence-backed response
//     is to take load off and re-approach, not to keep grinding.
//
// Every branch still returns a Code to branch on and a Reason a human can
// argue with, and every number it uses is in the response beside it. No model,
// no hidden weighting — the standing rule for anything in this product that
// tells someone what to do.

// SuggestionCode is the machine-readable outcome. Clients branch on this;
// they must not pattern-match Reason, which is prose and may change.
type SuggestionCode string

const (
	// SuggestNoHistory: never logged, so there's nothing to reason from.
	SuggestNoHistory SuggestionCode = "no_history"
	// SuggestNotApplicable: not measured in weight (a plank, a run).
	SuggestNotApplicable SuggestionCode = "not_applicable"
	// SuggestRepeatHard: at or near failure last time.
	SuggestRepeatHard SuggestionCode = "repeat_hard"
	// SuggestRepeatUnknownEffort: no RIR or RPE recorded, so effort is unknown.
	SuggestRepeatUnknownEffort SuggestionCode = "repeat_unknown_effort"
	// SuggestRepeatStale: long enough ago that the last number isn't evidence
	// of what you can do today.
	SuggestRepeatStale SuggestionCode = "repeat_stale"
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
//
// These are the *intent*; incrementWithin caps them relative to the bar.
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

// RepRange is the window a lift progresses inside before load moves.
//
// Chosen by the workout's goal rather than by the exercise, because the same
// barbell squat is a 3-rep lift in a powerlifting block and a 10-rep lift in a
// hypertrophy one. Ranges follow the conventional loading zones: strength
// work sits in the 1–5 band, hypertrophy across roughly 6–12, endurance
// above that.
type RepRange struct {
	Low  int `json:"low"`
	High int `json:"high"`
}

func repRangeForGoal(goal string) RepRange {
	switch goal {
	case "powerlifting":
		return RepRange{Low: 3, High: 5}
	case "hypertrophy":
		return RepRange{Low: 6, High: 10}
	case "endurance":
		return RepRange{Low: 12, High: 20}
	}
	// General training: wide enough to build in, narrow enough that load
	// still moves regularly.
	return RepRange{Low: 5, High: 8}
}

// targetRIR is the reserve a working set should finish with.
//
// Two is the usual recommendation for accumulating volume without the
// disproportionate fatigue of training to failure — close enough to be
// stimulating, far enough to be repeatable across a session's later sets.
const targetRIR = 2

// stallSessions is how many sessions at an unchanged load and rep count read
// as a plateau rather than a bad day. Two could be a poor night's sleep;
// three is a pattern.
const stallSessions = 3

// progressionWindow is how many past sessions per exercise the repository
// loads. Equal to stallSessions because that is the deepest question the rule
// asks — anything older changes no branch, so fetching it would be set rows
// pulled across the wire to be ignored.
const progressionWindow = stallSessions

// deloadFraction is how much load comes off a stall. Ten percent is the
// conventional step — enough to clear accumulated fatigue, small enough that
// the ground is regained in a session or two rather than a block.
const deloadFraction = 0.10

// maxIncrementFraction caps a jump relative to the bar.
//
// A fixed 2.5kg is 1.8% of a 140kg bench and 6% of a 40kg one — the same
// number meaning two completely different things. Beginners on light loads
// get pushed into a stall by increments that look modest in absolute terms,
// so the pattern increment is capped at five percent of what's on the bar.
const maxIncrementFraction = 0.05

// smallestPlateKg is the finest real-world adjustment. Suggesting less than
// this is arithmetic, not something anyone can load.
const smallestPlateKg = 1.25

const (
	// ProgressAddReps: same load, one more rep — the first half of double
	// progression, and where most sessions land.
	ProgressAddReps SuggestionCode = "add_reps"
	// ProgressAddLoad: the top of the range was reached on every working set,
	// so load moves and reps reset to the bottom.
	ProgressAddLoad SuggestionCode = "add_load"
	// ProgressDeload: stalled at one load; take weight off and re-approach.
	ProgressDeload SuggestionCode = "deload"
	// ProgressHold: last session didn't complete the range at target effort.
	// Repeat it — the work isn't finished at this load yet.
	ProgressHold SuggestionCode = "hold"
)

// SessionEffort is one past session's working sets for a single exercise,
// which is what a progression decision actually needs — the top set alone
// can't say whether the session held up.
type SessionEffort struct {
	SessionID   string
	PerformedAt time.Time
	// Sets in the order performed, warm-ups already excluded.
	Sets []Set
}

// ProgressionInput is everything the rule reads. Assembled by the repository
// so the decision itself stays a pure function — testable without a database,
// and identical on every client because only one place computes it.
type ProgressionInput struct {
	ExerciseID      string
	LoadType        string
	MovementPattern string
	// Goal of the workout this exercise is being performed in, deciding the
	// rep range. Empty means general.
	Goal string
	// Most recent first, capped at what the stall check needs.
	Recent []SessionEffort
}

// Plan is a progression recommendation: what to load, for how many reps, and
// the reasoning laid out so it can be disagreed with.
type Plan struct {
	Code   SuggestionCode `json:"code"`
	Reason string         `json:"reason"`

	// TargetWeightKg and TargetReps are the prescription. Nil when the
	// exercise isn't loaded in weight.
	TargetWeightKg *float64 `json:"target_weight_kg"`
	TargetReps     *int     `json:"target_reps"`
	RepRange       RepRange `json:"rep_range"`

	// The evidence, so the recommendation is checkable rather than trusted.
	// It travels even when the answer is "repeat": "last time you did X" is
	// useful on its own, and it's what makes a wrong recommendation
	// self-diagnosing rather than merely wrong.
	LastPerformedAt *time.Time `json:"last_performed_at"`
	// LastWeightKg, LastReps, LastRIR and LastRPE all describe the *top set*
	// — one real set that happened. They are only meaningful together: pairing
	// the top set's weight with the session's best rep count would describe a
	// set nobody performed, and anything derived from it (a 1RM estimate, say)
	// would be inflated by exactly that fiction.
	LastWeightKg *float64 `json:"last_weight_kg"`
	LastReps     *int     `json:"last_reps"`
	// LastAssistedReps is how many of LastReps had help. Absent means none
	// recorded. `last_reps - last_assisted_reps` is what the athlete did alone,
	// and it is what the rep-range progression above is measured against.
	LastAssistedReps *int     `json:"last_assisted_reps"`
	LastRIR          *int     `json:"last_rir"`
	LastRPE          *float64 `json:"last_rpe"`
	// LastMinReps and LastMaxReps are the spread across every working set,
	// belonging to the session rather than to any one set. The minimum is what
	// gates progression.
	LastMinReps    *int `json:"last_min_reps"`
	LastMaxReps    *int `json:"last_max_reps"`
	WorkingSets    int  `json:"working_sets"`
	SessionsAtLoad int  `json:"sessions_at_load"`
	// True when every working set finished at or above the target reserve.
	HitTargetEffort bool `json:"hit_target_effort"`
}

// Suggestion is what a client shows next to an exercise before its first set:
// the plan, plus the one-rep-max context that makes it legible as progress.
//
// Plan is embedded, so its fields flatten into the same JSON object — the
// prescription and its evidence are one thing to a client, and splitting them
// into a nested object would only make every consumer reach one level deeper.
type Suggestion struct {
	ExerciseID string `json:"exercise_id"`
	Plan

	// EstimatedOneRMKg is what the last top set implies you could lift once,
	// effort included. Nil when the set can't support an estimate — no weight,
	// or more effective reps than any rep-max curve survives.
	EstimatedOneRMKg *float64 `json:"estimated_1rm_kg"`
	// BestOneRMKg is the highest estimate anywhere in the caller's history for
	// this exercise, so the current one reads as progress or as ground already
	// covered. Nil when there is none.
	BestOneRMKg *float64 `json:"best_1rm_kg"`
}

// Progress decides the next prescription for one exercise.
//
// Order is deliberate and mirrors how a coach reasons: is this even a loaded
// lift, is there history, is that history still current, has it stalled, did
// the last session complete the range, and only then — add reps or add load.
func Progress(in ProgressionInput, now time.Time) Plan {
	rng := repRangeForGoal(in.Goal)
	p := Plan{RepRange: rng}

	if in.LoadType != "weight_reps" {
		p.Code = SuggestNotApplicable
		p.Reason = "Not measured in weight — progress this by time or distance instead."
		return p
	}
	if len(in.Recent) == 0 {
		p.Code = SuggestNoHistory
		p.Reason = "First time logging this. Pick a weight you could do " +
			itoa(rng.High) + " reps with, stop " + itoa(targetRIR) +
			" short, and the next session builds from it."
		return p
	}

	// The first session with sets this rule can actually read, not simply the
	// newest one.
	//
	// The SQL filter admits a row carrying *any* measure; the domain needs
	// reps and weight together. A weight-only row on a weighted lift passes
	// one and fails the other, and stopping at Recent[0] threw away a
	// perfectly good session behind it — the same erasure
	// TestRecentEfforts_IgnoresSetsWithNothingRecorded pins a layer lower.
	var last SessionEffort
	var sets []Set
	for _, s := range in.Recent {
		if usable := workingSetsWithWeight(s.Sets); len(usable) > 0 {
			last, sets = s, usable
			break
		}
	}
	if len(sets) == 0 {
		p.Code = SuggestRepeatUnknownEffort
		p.Reason = "Nothing weighted recorded last time — log a working set and this starts building."
		return p
	}

	top := topSet(sets)
	weight := *top.WeightKg
	performedAt := last.PerformedAt
	p.LastPerformedAt = &performedAt
	p.LastWeightKg = &weight
	// Effort is reported from the top set specifically, so the number a client
	// shows beside "last time" is the one the heaviest set carried — not an
	// average that belongs to no set that happened.
	p.LastRIR, p.LastRPE = top.RIR, top.RPE
	// The full count, so "last time: 8" still matches what the athlete logged
	// and sees in their history. What they managed UNAIDED rides alongside it
	// rather than replacing it — the progression rule reads the solo number,
	// the client shows both, and neither has to infer the other.
	p.LastReps = top.Reps
	p.LastAssistedReps = top.AssistedReps
	p.WorkingSets = len(sets)
	p.TargetWeightKg = &weight

	minReps, maxReps := repSpread(sets)
	p.LastMinReps, p.LastMaxReps = &minReps, &maxReps

	// Computed before any branch returns. These are statements about the
	// history, not about the branch taken, so a client rendering "2 sessions
	// at this weight" must not get 0 merely because the answer happened to be
	// "it's been a while".
	p.HitTargetEffort = allSetsHadReserve(sets, targetRIR)
	p.SessionsAtLoad = stalledSessionsAt(in.Recent, weight)

	if now.Sub(last.PerformedAt) > staleAfter {
		weeks := int(now.Sub(last.PerformedAt).Hours() / (24 * 7))
		reps := clampReps(minReps, rng)
		p.TargetReps = &reps
		p.Code = SuggestRepeatStale
		p.Reason = "It's been " + plural(weeks, "week") +
			". Repeat this to see where you are before adding to it."
		return p
	}

	// Effort has to be known before anything can be called room.
	if !anyEffortRecorded(sets) {
		reps := clampReps(maxReps, rng)
		p.TargetReps = &reps
		p.Code = SuggestRepeatUnknownEffort
		p.Reason = "No effort recorded last time, so there's no evidence this was easy. " +
			"Repeat it and log an RIR or RPE."
		return p
	}

	// A stall outranks everything below: repeating a load that hasn't moved
	// in three sessions is the definition of the thing a deload fixes.
	if p.SessionsAtLoad >= stallSessions && !readyForLoad(sets, rng) {
		down := roundToPlate(weight * (1 - deloadFraction))
		if down < weight {
			reps := rng.High
			p.TargetWeightKg = &down
			p.TargetReps = &reps
			p.Code = ProgressDeload
			p.Reason = "Three sessions at this weight without gaining a rep. " +
				"Take about ten percent off, rebuild the range, and come back to it."
			return p
		}
	}

	// Failure last time is not room, whatever the reps said.
	if tookToFailure(sets) {
		reps := clampReps(maxReps, rng)
		p.TargetReps = &reps
		p.Code = SuggestRepeatHard
		p.Reason = "You finished at or near failure. Repeat this weight before adding to it."
		return p
	}

	switch {
	case readyForLoad(sets, rng):
		// Top of the range on every working set, with reserve to spare — the
		// one condition that earns a load increase.
		add := incrementWithin(in.MovementPattern, weight)
		next := roundToPlate(weight + add)
		reps := rng.Low
		p.TargetWeightKg = &next
		p.TargetReps = &reps
		p.Code = ProgressAddLoad
		p.Reason = "Every set hit " + itoa(rng.High) + " with something left. " +
			"Add weight and drop back to " + itoa(rng.Low) + " reps."
		return p

	case p.HitTargetEffort && minReps < rng.High:
		// Room, but the range isn't finished — reps move first. Progressing
		// load here is what makes a lifter stall inside a fortnight.
		reps := clampReps(minReps+1, rng)
		p.TargetReps = &reps
		p.Code = ProgressAddReps
		p.Reason = "You had reserve left across the set. Same weight, " +
			itoa(reps) + " reps this time."
		return p

	default:
		reps := clampReps(maxReps, rng)
		p.TargetReps = &reps
		p.Code = ProgressHold
		p.Reason = "That was close to your limit on at least one set. " +
			"Repeat it until every set is comfortable, then the reps move."
		return p
	}
}

// workingSetsWithWeight filters to the sets a decision can be made from.
func workingSetsWithWeight(sets []Set) []Set {
	out := []Set{}
	for _, s := range sets {
		if s.SetType == SetTypeWarmup || !s.Completed {
			continue
		}
		if s.WeightKg == nil || s.Reps == nil || *s.WeightKg <= 0 {
			continue
		}
		out = append(out, s)
	}
	return out
}

func topSet(sets []Set) Set {
	best := sets[0]
	for _, s := range sets[1:] {
		if *s.WeightKg > *best.WeightKg ||
			(*s.WeightKg == *best.WeightKg && *s.Reps > *best.Reps) {
			best = s
		}
	}
	return best
}

// repSpread is the range of reps across the session's working sets. The
// *minimum* is what gates progression — a first set of 8 and a last of 4 is
// not "8 reps at this weight", and treating it as such is how the naive rule
// pushes load onto a session that was already falling apart.
// repSpread reads SOLO reps, and that is what makes double progression honest.
//
// The rule advances reps inside a range until every working set reaches the top
// of it, and only then moves the load. Counting spotted reps toward that means a
// spotter walks the athlete up to a weight increase they cannot yet handle
// alone — the rule recommending a load the evidence does not support, which is
// the one thing a deterministic progression must not do.
//
// A set with no assistance recorded is unchanged, which is every set logged
// before the column existed.
func repSpread(sets []Set) (min, max int) {
	min, max = sets[0].SoloReps(), sets[0].SoloReps()
	for _, s := range sets[1:] {
		r := s.SoloReps()
		if r < min {
			min = r
		}
		if r > max {
			max = r
		}
	}
	return min, max
}

func anyEffortRecorded(sets []Set) bool {
	for _, s := range sets {
		if s.RIR != nil || s.RPE != nil {
			return true
		}
	}
	return false
}

// reserveOf converts whatever effort was logged into reps in reserve.
// RIR wins over RPE: it's the observed quantity, RPE is a conversion.
func reserveOf(s Set) (float64, bool) {
	if s.RIR != nil {
		return float64(*s.RIR), true
	}
	if s.RPE != nil {
		return math.Max(0, 10-math.Min(*s.RPE, 10)), true
	}
	return 0, false
}

// allSetsHadReserve is true when every set that reported effort finished at or
// above the target. Sets with no effort logged don't veto — they're silent,
// not evidence of difficulty.
func allSetsHadReserve(sets []Set, target float64) bool {
	saw := false
	for _, s := range sets {
		r, ok := reserveOf(s)
		if !ok {
			continue
		}
		saw = true
		if r < target {
			return false
		}
	}
	return saw
}

func tookToFailure(sets []Set) bool {
	for _, s := range sets {
		if r, ok := reserveOf(s); ok && r < 1 {
			return true
		}
	}
	return false
}

// readyForLoad is the gate on adding weight: every working set at the top of
// the range, and effort still at or above target. Both halves matter — hitting
// the reps by grinding the last set is not the same lift.
func readyForLoad(sets []Set, rng RepRange) bool {
	min, _ := repSpread(sets)
	return min >= rng.High && allSetsHadReserve(sets, targetRIR)
}

// stalledSessionsAt counts how many consecutive recent sessions sat at this
// load **without gaining a rep** — the plateau signal.
//
// Both halves matter, and the rep half was missing at first, with consequences
// worth spelling out. Climbing 6 → 7 → 8 at a fixed weight *is* double
// progression working; it is the entire first phase of the cycle. Counting
// those as a stall deloaded the lifter on the third session, and since the
// deload takes 10% off while the following add_load gives ~5% back, a lifter
// doing exactly what the app told them was walked **down** roughly 5% every
// four sessions, indefinitely. Caught in review, reproduced, and now pinned by
// TestProgress_ObedientLifterNeverRegresses.
//
// Consecutive, too: a load returned to after a deload is a fresh attempt, not
// a continuing plateau.
func stalledSessionsAt(recent []SessionEffort, weight float64) int {
	n, floor := 0, -1
	for _, s := range recent {
		sets := workingSetsWithWeight(s.Sets)
		if len(sets) == 0 || *topSet(sets).WeightKg != weight {
			break
		}
		min, _ := repSpread(sets)
		// Walking backwards through history, so a *lower* minimum in an older
		// session means reps were gained since. That's progress, and the run
		// of stalled sessions ends here.
		if floor >= 0 && min < floor {
			break
		}
		floor = min
		n++
	}
	return n
}

// incrementWithin scales the movement's increment to what's actually on the
// bar. The pattern increment is the intent; the cap stops it being a 6% jump
// on a light lift, which is a stall waiting to happen.
func incrementWithin(pattern string, weight float64) float64 {
	add := incrementFor(pattern)
	if capped := weight * maxIncrementFraction; add > capped {
		add = capped
	}
	if add < smallestPlateKg {
		add = smallestPlateKg
	}
	return add
}

// roundToPlate snaps to something loadable. A suggestion of 63.7kg is
// arithmetic; nobody has that plate.
func roundToPlate(kg float64) float64 {
	return math.Round(kg/smallestPlateKg) * smallestPlateKg
}

// clampReps holds a rep target inside the range, which the contract states
// unconditionally.
//
// It bites when the goal changes: the range is the *current* workout's, while
// the history came from whatever block it was logged in. A 15-rep set from a
// hypertrophy phase, re-read under a powerlifting goal, would otherwise come
// back as "3-5 range, target 15" — a self-contradicting response.
func clampReps(reps int, rng RepRange) int {
	if reps < rng.Low {
		return rng.Low
	}
	if reps > rng.High {
		return rng.High
	}
	return reps
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
