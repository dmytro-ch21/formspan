package session

import (
	"math"
	"time"
)

// ProgressV2 is the phase-1 "safety release" for the strength progression
// engine — N473, carved out of #753 as its own ticket (#812) specifically
// because #753 named phase 1 as the part with a narrow, testable bar and
// phases 2-5 (a per-workout-item prescription model, a separate warm-up
// engine, splitting recommendation products, an audit trail) as substantial
// designs that need their own tickets. This file is phase 1 ONLY: it does
// not add a prescription model, a warm-up engine, or an audit trail, and it
// must not grow one by accretion.
//
// Gated behind the `new_recommendation_engine` feature flag (see
// featureflag.Repository.Enabled and Handler.Suggestions) — Progress above,
// and every function it calls, is UNCHANGED and stays exactly as buggy as it
// has always been for anyone not on the flag. Nothing in this file may be
// called from Progress, and nothing in Progress may be changed to call this
// file: the two are deliberately parallel, not layered.
//
// # What was actually wrong
//
// `repSpread` (used by v1's Progress) selects the heaviest weight performed
// for an exercise but computes the rep range across EVERY non-warm-up
// working-or-not set at ANY weight in the session. A squat session with a
// few sets of 12 at 228kg-equivalent and a single top set at 335 therefore
// reads as "335 for a min of however many reps the 228 sets did", clamped
// into the rep range and handed back as a literal instruction to load 335
// for 8 — a set that was never performed at that weight. See N473/#812 and
// its parent #753 for the reported session this reproduces.
//
// The root cause is a COHORT problem: the rule compares reps across sets
// that are not comparable — different weights, and (a related bug) different
// SET ROLES (a backoff or an AMRAP set is not the same evidence as a straight
// working set, and folding one into the other's rep range is the same
// category error one level down). Every fix below follows from insisting on
// a coherent cohort before reasoning about it at all.
//
// # The six other requirements, and where each lives
//
//  1. Coherent cohort: straightWorkingSetsWithWeight + sameWeightCohort,
//     used to build `cohort` below before anything is computed from it.
//  2. Straight-sets-only: straightWorkingSetsWithWeight filters to
//     SetTypeWorking specifically — a backoff, drop, AMRAP or failure set
//     is EXCLUDED from straight-set progression rather than reinterpreted
//     under a role-specific rule, which would be the phase-2 prescription
//     model's job, not this ticket's.
//  3. Finished sessions only: finishedSessions filters on
//     SessionEffort.Finished before anything below ever sees a session.
//  4. Effort required: effortCoverage below; ALL-missing keeps the existing
//     SuggestRepeatUnknownEffort behaviour (repeat + log effort), SOME-missing
//     is new and returns SuggestAbstain — see effortCoverage's own comment
//     for why those read differently.
//  5. effortConflict / SuggestEffortConflict: a set carrying both a RIR and
//     an RPE that imply materially different reserve (the "RPE 8 / 0 RIR"
//     contradiction) stops the engine rather than letting RIR silently win.
//  6. SuggestAbstain: the explicit "can't tell" result, reached both from
//     partial effort coverage and from a finished-history that never
//     produced a usable straight-set cohort at all.
//
// # Rounding (item 8: real equipment-increment rounding)
//
// v1's roundToPlate always snaps to a 1.25kg grid, which is right for an
// athlete training in kilograms and is exactly how 68.9lb happened for one
// training in pounds: 31.25kg is a clean 1.25kg step, and 31.25 * 2.2046226
// is 68.9 — a real plate increment in ONE unit landing on an unloadable
// number in the other, purely from the round-trip. There is no equipment
// schema in this codebase yet (per-workout-item `equipment_increment` is
// explicitly a phase-2 field in #753 — a per-workout-item prescription model
// is out of scope here), so this fix stays inside phase 1's boundary: round
// in whichever unit the athlete actually trains in, using real commercial
// plate increments for THAT unit (5/10lb, matching the existing 1.25/2.5/5kg
// scheme), rather than rounding to a kg grid and hoping the conversion lands
// on something clean. See roundToPlateV2 and incrementWithinV2.
//
// ProgressV2 mirrors Progress's overall shape and reuses its pure helpers
// (topSet, repSpread, reserveOf, allSetsHadReserve, tookToFailure,
// readyForLoad, clampReps, incrementFor, roundToPlate, itoa, plural) against
// the CORRECTED cohort — none of those helpers care what slice of sets they
// are handed, and the fix is entirely in which slice that is.
func ProgressV2(in ProgressionInput, now time.Time) (p Plan) {
	rng := repRangeForGoal(in.Goal)
	p = Plan{RepRange: rng}
	defer func() { p = applyInSessionSignal(in, p) }()

	if in.LoadType != "weight_reps" {
		p.Code = SuggestNotApplicable
		p.Reason = "Not measured in weight — progress this by time or distance instead."
		return p
	}

	finished := finishedSessions(in.Recent)
	if len(finished) == 0 {
		p.Code = SuggestNoHistory
		if len(in.Recent) > 0 {
			// There IS a session — it just hasn't ended yet, so it can't be
			// history (item 3). Distinct wording from "first time logging
			// this", which would be actively wrong for someone mid-session.
			p.Reason = "Nothing finished yet to build a prescription from — " +
				"once this session wraps up, the next one has something to work from."
		} else {
			p.Reason = "First time logging this. Pick a weight you could do " +
				itoa(rng.High) + " reps with, stop " + itoa(targetRIR) +
				" short, and the next session builds from it."
		}
		return p
	}

	// Walk finished sessions, newest first, for the first one with a
	// coherent straight-set cohort — same reasoning
	// TestProgress_SkipsAnUnusableSessionForARealOneBehindIt already pins on
	// v1: an unusable session must not hide a usable one behind it.
	var last SessionEffort
	var cohort []Set
	for _, s := range finished {
		straight := straightWorkingSetsWithWeight(s.Sets)
		if len(straight) == 0 {
			continue
		}
		anchor := *topSet(straight).WeightKg
		c := sameWeightCohort(straight, anchor)
		if len(c) > 0 {
			last, cohort = s, c
			break
		}
	}
	if len(cohort) == 0 {
		p.Code = SuggestAbstain
		p.Reason = "Recent finished sessions for this exercise have no plain working " +
			"set with a recorded weight — not enough to reason from. Log a straight " +
			"working set and this starts building."
		return p
	}

	top := topSet(cohort)
	weight := *top.WeightKg
	performedAt := last.PerformedAt
	p.LastPerformedAt = &performedAt
	p.LastWeightKg = &weight
	p.LastRIR, p.LastRPE = top.RIR, top.RPE
	p.LastReps = top.Reps
	p.LastAssistedReps = top.AssistedReps
	p.WorkingSets = len(cohort) // straightWorkingSetsWithWeight already excludes drops
	// TargetWeightKg is deliberately NOT set here, unlike v1's equivalent
	// point. Item 6 means an abstain/effort_conflict result must carry no
	// guessed number at all — Last* above is the evidence ("here's what
	// happened"), Target* is the recommendation ("here's what to do next"),
	// and the whole point of abstaining is declining to answer the second
	// question. Every OTHER branch below sets its own TargetWeightKg
	// explicitly, same as it already sets its own TargetReps.

	minReps, maxReps := repSpread(cohort)
	p.LastMinReps, p.LastMaxReps = &minReps, &maxReps

	p.HitTargetEffort = allSetsHadReserve(cohort, targetRIR)
	p.SessionsAtLoad = stalledSessionsAtV2(finished, weight)

	if now.Sub(last.PerformedAt) > staleAfter {
		weeks := int(now.Sub(last.PerformedAt).Hours() / (24 * 7))
		reps := clampReps(minReps, rng)
		p.TargetWeightKg = &weight
		p.TargetReps = &reps
		p.Code = SuggestRepeatStale
		p.Reason = "It's been " + plural(weeks, "week") +
			". Repeat this to see where you are before adding to it."
		return p
	}

	// Item 5: a materially conflicting RIR/RPE pair on any cohort set means
	// this engine cannot trust reserve for the session, full stop — checked
	// BEFORE the coarser "was effort recorded at all" question, because a
	// conflict is a stronger, more specific finding than "some missing".
	if hasEffortConflict(cohort) {
		p.Code = SuggestEffortConflict
		p.Reason = "Last time, one set logged both an RIR and an RPE and they don't " +
			"agree — this can't tell whether there was room, so it isn't guessing. " +
			"Log just one of the two next time."
		return p
	}

	all, none := effortCoverage(cohort)
	if none {
		reps := clampReps(maxReps, rng)
		p.TargetWeightKg = &weight
		p.TargetReps = &reps
		p.Code = SuggestRepeatUnknownEffort
		p.Reason = "No effort recorded last time, so there's no evidence this was easy. " +
			"Repeat it and log an RIR or RPE."
		return p
	}
	if !all {
		// Item 4/6: SOME but not every cohort set carries effort. Distinct
		// from "none" above — that case has a safe, existing answer (repeat
		// and start recording); this one has evidence that is genuinely
		// ambiguous, because the sets missing effort could have been the
		// ones nearest failure, and there's no way to tell from here.
		p.Code = SuggestAbstain
		p.Reason = "Effort wasn't recorded on every straight set last time, so there's " +
			"no reliable read on how the session held up. Log RIR or RPE on every " +
			"working set for a suggestion."
		return p
	}

	if p.SessionsAtLoad >= stallSessions && !readyForLoad(cohort, rng) {
		down := roundToPlateV2(weight*(1-deloadFraction), in.UnitSystem)
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

	if tookToFailure(cohort) {
		reps := clampReps(maxReps, rng)
		p.TargetWeightKg = &weight
		p.TargetReps = &reps
		p.Code = SuggestRepeatHard
		p.Reason = "You finished at or near failure. Repeat this weight before adding to it."
		return p
	}

	switch {
	case readyForLoad(cohort, rng):
		add := incrementWithinV2(in.MovementPattern, weight, in.UnitSystem)
		next := roundToPlateV2(weight+add, in.UnitSystem)
		reps := rng.Low
		p.TargetWeightKg = &next
		p.TargetReps = &reps
		p.Code = ProgressAddLoad
		p.Reason = "Every set hit " + itoa(rng.High) + " with something left. " +
			"Add weight and drop back to " + itoa(rng.Low) + " reps."
		return p

	case p.HitTargetEffort && minReps < rng.High:
		reps := clampReps(minReps+1, rng)
		p.TargetWeightKg = &weight
		p.TargetReps = &reps
		p.Code = ProgressAddReps
		p.Reason = "You had reserve left across the set. Same weight, " +
			itoa(reps) + " reps this time."
		return p

	default:
		reps := clampReps(maxReps, rng)
		p.TargetWeightKg = &weight
		p.TargetReps = &reps
		p.Code = ProgressHold
		p.Reason = "That was close to your limit on at least one set. " +
			"Repeat it until every set is comfortable, then the reps move."
		return p
	}
}

// finishedSessions is item 3: the currently-open session (or any session
// without an ended_at, however that came about) must never be its own
// history. Filters rather than mutates, and preserves order — everything
// downstream still reads newest-first.
func finishedSessions(recent []SessionEffort) []SessionEffort {
	out := make([]SessionEffort, 0, len(recent))
	for _, s := range recent {
		if s.Finished {
			out = append(out, s)
		}
	}
	return out
}

// straightWorkingSetsWithWeight is workingSetsWithWeight's v2 sibling: same
// completed/weighted filter, PLUS item 2's straight-sets-only restriction.
// SetTypeWorking is the only role straight-set double progression reasons
// about; backoff, drop, AMRAP and failure sets are excluded rather than
// folded in, because none of them are evidence for the same question a
// straight working set answers ("did the range hold at this load").
//
// set_type is NOT NULL DEFAULT 'working' at the database column, and
// insertSets defaults an empty client value to SetTypeWorking before it's
// ever written — so a stored set's SetType is always a real, valid value,
// never blank, and this can compare it directly.
func straightWorkingSetsWithWeight(sets []Set) []Set {
	out := []Set{}
	for _, s := range sets {
		if s.SetType != SetTypeWorking || !s.Completed {
			continue
		}
		if s.WeightKg == nil || s.Reps == nil || *s.WeightKg <= 0 {
			continue
		}
		out = append(out, s)
	}
	return out
}

// weightCohortEpsilonKg tolerates float noise between two sets that are the
// "same" weight without letting through two sets that are genuinely
// different loads — the smallest real increment (smallestPlateKg, 1.25) is
// four orders of magnitude larger than this, so nothing loadable can ever
// collide with it.
const weightCohortEpsilonKg = 1e-6

// sameWeightCohort is item 1's other half: once a session's heaviest
// straight working weight is known (the anchor), the cohort a rep range may
// be computed over is exactly the sets performed at THAT weight — never the
// session's full straight-set list, which is what let 228kg-equivalent reps
// recombine with a 335 anchor in the first place.
func sameWeightCohort(sets []Set, anchor float64) []Set {
	out := []Set{}
	for _, s := range sets {
		if math.Abs(*s.WeightKg-anchor) < weightCohortEpsilonKg {
			out = append(out, s)
		}
	}
	return out
}

// conflictThreshold is how far a set's own RIR and RPE can imply different
// reserve before this engine refuses to pick one. RPE 8 converts to roughly
// 2 reps in reserve (10-8); RIR recorded as 0 says zero. That two-rep gap is
// the reported "RPE 8 / 0 RIR" contradiction itself, so the threshold sits
// exactly at it rather than comfortably above it — a gap that size is the
// material case this exists to catch, not noise to tolerate.
const conflictThreshold = 2.0

// hasEffortConflict is item 5: true when any cohort set carries both a RIR
// and an RPE that convert to materially different reserve. Assisted sets are
// exempt — reserveOf already overrides both readings to zero reserve for an
// assisted set (see its own doc comment), so there is nothing for the two to
// disagree about there, and flagging one as a conflict would be a false
// positive on a question this engine already has a confident answer to.
func hasEffortConflict(sets []Set) bool {
	for _, s := range sets {
		if s.AssistedReps != nil && *s.AssistedReps > 0 {
			continue
		}
		if s.RIR == nil || s.RPE == nil {
			continue
		}
		rirReserve := float64(*s.RIR)
		rpeReserve := math.Max(0, 10-math.Min(*s.RPE, 10))
		if math.Abs(rirReserve-rpeReserve) >= conflictThreshold {
			return true
		}
	}
	return false
}

// effortCoverage answers item 4 for a cohort: all is true when every set
// carries a RIR or an RPE, none is true when not one does. Both being false
// (some but not all) is the new, honest middle case ProgressV2 reads as
// SuggestAbstain rather than either extreme's existing answer.
func effortCoverage(sets []Set) (all, none bool) {
	total, withEffort := 0, 0
	for _, s := range sets {
		total++
		if s.RIR != nil || s.RPE != nil {
			withEffort++
		}
	}
	return withEffort == total, withEffort == 0
}

// stalledSessionsAtV2 mirrors stalledSessionsAt's plateau count, but walks
// only FINISHED sessions (item 3) and, within each, the STRAIGHT-SET,
// SAME-WEIGHT cohort (items 1-2) rather than every working set at any
// weight — the same coherence fix applied to the historical lookback, not
// just the current session's own reasoning.
func stalledSessionsAtV2(finished []SessionEffort, weight float64) int {
	n, floor := 0, -1
	for _, s := range finished {
		straight := straightWorkingSetsWithWeight(s.Sets)
		if len(straight) == 0 {
			break
		}
		top := *topSet(straight).WeightKg
		if math.Abs(top-weight) >= weightCohortEpsilonKg {
			break
		}
		cohort := sameWeightCohort(straight, weight)
		min, _ := repSpread(cohort)
		if floor >= 0 && min < floor {
			break
		}
		floor = min
		n++
	}
	return n
}

// lbPerKg mirrors the mobile and web clients' own conversion constant
// (apps/mobile/lib/units.ts, apps/web/src/lib/units.ts) exactly, so a value
// rounded here reconverts, on the client, to the SAME lb number — which is
// the entire point of rounding in lb rather than kg. Any drift between this
// and the clients' constant would reintroduce a smaller version of the same
// round-trip bug this file exists to close.
const lbPerKg = 2.2046226218

func kgToLb(kg float64) float64 { return kg * lbPerKg }
func lbToKg(lb float64) float64 { return lb / lbPerKg }

// incrementByPatternLb is incrementByPattern's imperial sibling — real
// commercial plate increments in pounds (a pair of 5s is a 10lb jump, a pair
// of 2.5s is 5lb), scaled to the same movement-pattern intent as the kg
// table, not derived from it by conversion.
var incrementByPatternLb = map[string]float64{
	"squat":   10,
	"hinge":   10,
	"olympic": 10,

	"horizontal_push": 5,
	"vertical_push":   5,
	"horizontal_pull": 5,
	"vertical_pull":   5,
	"lunge":           5,
}

const defaultIncrementLb = 5
const smallestPlateLb = 5

func incrementForLb(pattern string) float64 {
	if v, ok := incrementByPatternLb[pattern]; ok {
		return v
	}
	return defaultIncrementLb
}

// incrementWithinV2 is incrementWithin's unit-aware sibling (item 8). Metric
// is byte-identical to v1 — same table, same cap, same floor — so a caller
// that never sends UnitSystem sees the numbers it always has. Imperial does
// the whole computation in pounds and converts to kg exactly once, at the
// end, which is what roundToPlateV2 needs handed to it: a value that is
// ALREADY a clean lb number before it goes back through the wire's kg field.
func incrementWithinV2(pattern string, weightKg float64, unitSystem string) float64 {
	if unitSystem != "imperial" {
		return incrementWithin(pattern, weightKg)
	}
	weightLb := kgToLb(weightKg)
	add := incrementForLb(pattern)
	if capped := weightLb * maxIncrementFraction; add > capped {
		add = capped
	}
	if add < smallestPlateLb {
		add = smallestPlateLb
	}
	return lbToKg(add)
}

// roundToPlateV2 is roundToPlate's unit-aware sibling (item 8) and the fix
// for the reported 68.9lb: v1 always snaps to a 1.25kg grid, which is a real
// increment for an athlete training in kilograms and, for one training in
// pounds, a lossy round-trip — 31.25kg is a clean 1.25kg step and 31.25 *
// 2.2046226 is 68.9, an unloadable number produced by rounding in the wrong
// unit rather than by any arithmetic mistake.
//
// This rounds directly in the unit the athlete trains in, using a real
// plate increment for THAT unit, so the number that reaches the client is
// already clean in the unit it will be displayed in — there is no second
// rounding step for the client to get right or wrong.
//
// There is no per-athlete equipment configuration in this codebase (a
// per-workout-item `equipment_increment` is explicitly phase 2 in #753) —
// this is the phase-1-scoped fix: real per-unit plate increments, not a
// literal reading of the athlete's own rack.
func roundToPlateV2(kg float64, unitSystem string) float64 {
	if unitSystem != "imperial" {
		return roundToPlate(kg)
	}
	lb := kgToLb(kg)
	return lbToKg(math.Round(lb/smallestPlateLb) * smallestPlateLb)
}
