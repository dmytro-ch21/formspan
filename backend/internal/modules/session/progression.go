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
//
// # N191 — does today's own session count as evidence against itself
//
// Reported from a device: an athlete moved a meaningfully heavier weight on
// an early set, and the suggestion for the exercise's NEXT set still read
// last session's number — because RecentEfforts/BestOneRMs only ever query
// completed, synced history. Nothing before this section read a set already
// logged earlier in the session currently open.
//
// The product question was never "should today count" — it's the most
// recent evidence there is — but "how", given this file's own standing rule
// two paragraphs up: double progression reasons over a SESSION's pattern,
// never one exceptional set, because a strong day and a warm-up mislabelled
// as working look identical from a single row (see workingSetsWithWeight).
// Folding today's sets in as just another SessionEffort and letting the
// existing machinery run over it — readyForLoad, stalledSessionsAt, and the
// rest — was considered and rejected: those functions assume a FINISHED
// session, and an in-progress one violates that on every request before the
// last set of the day. Set 1 of 3, read through readyForLoad as if it were
// the whole session, is a session that "failed" the rep range by
// definition, on every suggestion asked for before the athlete has even
// attempted set 2.
//
// The decision: today's own working sets are surfaced as a SEPARATE,
// explicitly labelled signal (Plan.InSessionSignal) alongside the unchanged,
// purely historical prescription — never blended into TargetWeightKg or
// TargetReps, and never a new SuggestionCode a client would have to branch
// on as though it were a phase of the rule. Two things follow from that
// split:
//
//   - The existing prescription's determinism is untouched. Code, Reason,
//     TargetWeightKg and TargetReps stay a pure function of Recent, exactly
//     as before this section existed — a client that hasn't been updated
//     for N191 sees exactly the recommendation it always did.
//   - The signal is deliberately NOT gated on "at least two sets" the way
//     the stall check gates on three sessions. Requiring several sets
//     before saying anything would guard against the mislabelled-warm-up
//     case by making the signal slower than the thing it exists to report
//     — and that guard is unnecessary here precisely because the signal
//     never changes the prescription. The worst a mislabelled set can do is
//     show a misleading FYI the athlete can ignore; it can never mis-load a
//     plan. Contrast the stall check, where the same mistake would move
//     real weight onto a bar.
//
// What this explicitly does NOT do, so a future change doesn't "fix" it
// back into the thing it was written to avoid: it does not average today's
// sets into the plan, it does not choose between today's and last session's
// number on the athlete's behalf, and it changes nothing a client that
// ignores the new field ever sees. See applyInSessionSignal, run through a
// defer on every path out of Progress so no branch above has to remember it.

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

	// SuggestEffortConflict: ProgressV2 only (progression_v2.go) — a set
	// carried both a RIR and an RPE, and they imply materially different
	// reserve (the "RPE 8 / 0 RIR" contradiction). v1 lets RIR silently win;
	// v2 says so explicitly instead of guessing which reading is right. See
	// N473/#812.
	SuggestEffortConflict SuggestionCode = "effort_conflict"
	// SuggestAbstain: ProgressV2 only — the evidence is ambiguous rather
	// than simply absent (SuggestRepeatUnknownEffort already covers "no
	// effort recorded at all"). Reached when effort is recorded on some but
	// not every straight working set in the cohort, or when finished history
	// exists but never produced a usable straight-set cohort at all. An
	// honest "can't tell" rather than a confident guess. See N473/#812.
	SuggestAbstain SuggestionCode = "abstain"
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

// inSessionSignalThresholdFraction is how far today's own average has to sit
// from the historically-derived TargetWeightKg before InSessionSignal is
// worth surfacing at all — see the N191 note above. Reuses deloadFraction's
// own number rather than inventing a second, unexplained threshold in the
// same file: ten percent is already this file's answer to "how big a move is
// worth acting on," and this signal is meant to read as the same order of
// magnitude as a deload, not a hair-trigger on ordinary set-to-set noise.
const inSessionSignalThresholdFraction = 0.10

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

	// Finished is true once the session carries an ended_at — see N473/#812.
	// V1's `Progress` below has never read this field and must not start:
	// this exists purely for ProgressV2 (progression_v2.go), which treats an
	// unfinished session (false here) as never having happened, because the
	// currently-open session becoming its own history is exactly the "12
	// reps at 228, recombined with 335" failure mode's sibling bug. Left
	// false by any test fixture that doesn't set it, which is the correct
	// reading for every fixture written before this field existed — nobody
	// retroactively becomes "finished" by a field they never populated.
	Finished bool
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

	// InSessionWorkingWeightsKg is today's own already-logged WORKING sets
	// for this exercise, so far, in THIS session — see the N191 note above.
	//
	// Client-supplied, not looked up: the authoritative copy of "what have I
	// already lifted today" lives on the device (mobile writes SQLite first,
	// see apps/mobile/app/session/[id].tsx), and a set is real evidence
	// whether or not it has reached this server yet. Reading it back out of
	// RecentEfforts instead would tie this signal to sync succeeding first —
	// exactly the dependency N191 forbids, since a dead zone would silently
	// disable the one thing an athlete standing in it most needs to see.
	//
	// Only the WEIGHT of each set travels, not the whole Set: weight is what
	// the reported bug was about ("I did a larger weight"), and it's the one
	// number this signal can compare against TargetWeightKg without
	// inventing a second axis — reps, effort — that it does not reason
	// about.
	InSessionWorkingWeightsKg []float64

	// UnitSystem is "imperial" or "metric" — client-supplied, same pattern as
	// Goal above, and for the same reason: the client already knows the
	// athlete's own preference (profile.UnitSystem), and round-tripping
	// through a lookup here would be a new cross-module dependency for a
	// value the caller already has in hand. Anything else, including empty,
	// reads as metric — the rounding this repo has always done, so a client
	// that doesn't send this yet sees byte-identical numbers.
	//
	// Read only by ProgressV2 (progression_v2.go) — see roundToPlateV2's doc
	// comment for why a suggestion has to be rounded in the unit the athlete
	// actually trains in rather than converted through kg.
	UnitSystem string
}

// InSessionSignalCode flags when today's own performance disagrees with the
// standing, history-derived prescription above. A separate type from
// SuggestionCode on purpose — see the N191 note on Progress for why this is
// an additional field rather than a new value of Code.
type InSessionSignalCode string

const (
	// InSessionAbove: today's own working sets, so far, average meaningfully
	// heavier than the standing prescription.
	InSessionAbove InSessionSignalCode = "in_session_above"
	// InSessionBelow: the mirror case — today reads meaningfully lighter.
	InSessionBelow InSessionSignalCode = "in_session_below"
)

// InSessionSignal is the note layered on top of a history-derived plan when
// today's own working sets disagree with it — see the N191 doc note on
// Progress. It carries its own Code and Reason so it satisfies the same
// "argue with the reason" contract as Plan itself, plus exactly the numbers a
// client needs to show why: what today averaged, and how many sets that
// average is built from.
type InSessionSignal struct {
	Code            InSessionSignalCode `json:"code"`
	Reason          string              `json:"reason"`
	AverageWeightKg float64             `json:"average_weight_kg"`
	WorkingSets     int                 `json:"working_sets"`
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

	// InSessionSignal flags when today's own already-logged working sets
	// (ProgressionInput.InSessionWorkingWeightsKg) diverge meaningfully from
	// TargetWeightKg above — see the N191 note on Progress. Nil covers three
	// cases alike: nothing logged yet today, no numeric prescription to
	// compare against (SuggestNoHistory, SuggestNotApplicable), or today
	// agrees closely enough with the plan that flagging it would be noise. A
	// client that ignores this field sees exactly the recommendation it
	// always has — this never rewrites TargetWeightKg or TargetReps itself.
	InSessionSignal *InSessionSignal `json:"in_session_signal"`
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
//
// p is a NAMED return specifically so applyInSessionSignal can run through a
// single deferred call and see whatever p every branch below returns,
// without every `return p` having to remember to route through it — see the
// N191 note above.
func Progress(in ProgressionInput, now time.Time) (p Plan) {
	rng := repRangeForGoal(in.Goal)
	p = Plan{RepRange: rng}
	defer func() { p = applyInSessionSignal(in, p) }()

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
	// Drops excluded, same as everywhere else. This is report-only evidence —
	// no rule branch reads it — but the web progression card renders it as
	// "across N sets", so leaving it as len(sets) put "4" beside a session the
	// rows, the tile, the history and the feed all called 3. The same
	// one-screen-two-answers bug this change exists to close, on the one
	// surface nobody thought to look at. Found in review.
	p.WorkingSets = 0
	for _, s := range sets {
		if s.SetType != SetTypeDrop {
			p.WorkingSets++
		}
	}
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

// applyInSessionSignal is Progress's last step on every path — see the N191
// note above Progress and the doc comments on InSessionSignal and
// ProgressionInput.InSessionWorkingWeightsKg.
//
// It may only ADD p.InSessionSignal. Every other field on p is left exactly
// as the branch above computed it — Code, Reason, TargetWeightKg and
// TargetReps stay a pure function of in.Recent, never of
// in.InSessionWorkingWeightsKg. That split is the whole decision this
// function exists to enforce, not an implementation detail of it.
func applyInSessionSignal(in ProgressionInput, p Plan) Plan {
	// Nothing to compare against — no numeric prescription (SuggestNoHistory
	// and SuggestNotApplicable both leave TargetWeightKg nil) — or nothing
	// logged yet today. Both are silence, not a signal.
	if p.TargetWeightKg == nil || len(in.InSessionWorkingWeightsKg) == 0 {
		return p
	}
	standing := *p.TargetWeightKg
	if standing <= 0 {
		return p
	}

	var sum float64
	for _, w := range in.InSessionWorkingWeightsKg {
		sum += w
	}
	n := len(in.InSessionWorkingWeightsKg)
	avg := sum / float64(n)
	// A second, independent guard against a non-finite average — the wire
	// parser (handler.go's parseInSessionWeights) already refuses NaN, +/-Inf
	// and anything past maxInSessionWeightKg per set, but that alone doesn't
	// stop many ordinary, individually-finite values from OVERFLOWING to
	// +Inf once summed (found in review, N191): this function has no way to
	// know a future caller reused it against input that skipped that parser,
	// and a non-finite AverageWeightKg reaching apihttp.WriteJSON fails the
	// JSON encode AFTER the 200 status line is already written, corrupting
	// the WHOLE response — every exercise in the request, not just this one.
	if math.IsNaN(avg) || math.IsInf(avg, 0) {
		return p
	}

	delta := (avg - standing) / standing
	if math.IsNaN(delta) || math.IsInf(delta, 0) {
		return p
	}
	if math.Abs(delta) < inSessionSignalThresholdFraction {
		return p
	}

	sets := plural(n, "set")
	if delta > 0 {
		p.InSessionSignal = &InSessionSignal{
			Code: InSessionAbove, AverageWeightKg: avg, WorkingSets: n,
			Reason: "Today's own " + sets + " so far are meaningfully heavier " +
				"than the plan above, which is still built from last time. " +
				"The number here hasn't changed — that's your call to make if " +
				"today's the real one.",
		}
	} else {
		p.InSessionSignal = &InSessionSignal{
			Code: InSessionBelow, AverageWeightKg: avg, WorkingSets: n,
			Reason: "Today's own " + sets + " so far are meaningfully lighter " +
				"than the plan above, which is still built from last time. " +
				"Could be a lighter day — the number here hasn't changed.",
		}
	}
	return p
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
	// ASSISTED SETS HAVE NO RESERVE, and that overrides whatever was logged.
	//
	// This is the same doctrine `EstimateSetOneRM` applies, arriving at the
	// other consumer of effort. A recorded RIR on an assisted set describes the
	// set WITH help — "2 in reserve" means two more with the spotter — so
	// pairing it with the solo rep count double-counts the help. If somebody
	// needed a spotter, they had nothing left at the rep before.
	//
	// Without this, `repSpread` reads solo reps while these gates read
	// whole-set reserve, and three sets of ten-with-two-assisted at RIR 2 come
	// out as "every set hit the top of the range with something left — add
	// weight". A spotter walks the athlete onto a heavier bar, which is exactly
	// what repSpread's own comment says this change exists to prevent. Found in
	// review: the reps half had migrated and the reserve half had not.
	//
	// It follows that a spotted session reads as taken to failure, and that is
	// correct rather than a side effect: needing a spotter IS training at the
	// limit, so the plan repeats the weight instead of advancing.
	if s.AssistedReps != nil && *s.AssistedReps > 0 {
		return 0, true
	}
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
