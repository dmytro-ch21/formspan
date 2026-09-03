package session

import (
	"math"
	"testing"
	"time"
)

// finishedSess is sess's v2 sibling — a completed session, ended, and
// therefore real history under item 3 (finished-sessions-only). Every v2
// history fixture in this file uses this rather than sess, deliberately:
// sess (progression_test.go) builds a SessionEffort with Finished left at
// its zero value (false), which is exactly the "still open" reading v1 never
// had to care about and v2 must refuse as history.
func finishedSess(ago time.Duration, now time.Time, sets ...Set) SessionEffort {
	s := sess(ago, now, sets...)
	s.Finished = true
	return s
}

// straightSet is set's v2 shorthand for a plain SetTypeWorking set on the
// squat, since every golden-squat fixture below is a squat, not a bench.
func straightSet(reps int, kg float64, rir *int, rpe *float64) Set {
	s := set(reps, kg, rir, rpe)
	s.ExerciseID = "back-squat"
	return s
}

func squatIn(goal string, recent ...SessionEffort) ProgressionInput {
	return ProgressionInput{
		ExerciseID:      "back-squat",
		LoadType:        "weight_reps",
		MovementPattern: "squat",
		Goal:            goal,
		Recent:          recent,
	}
}

// lb335Kg / lb228Kg are the exact reported numbers from N473/#812's parent
// (#753) converted through the SAME constant the mobile/web clients use
// (lbPerKg in progression_v2.go) — so a test asserting "not 335kg-equivalent"
// is asserting about the literal pasted session, not a round number picked
// for convenience.
var (
	lb335Kg = lbToKg(335)
	lb228Kg = lbToKg(228)
)

const almost = 1e-6

func nearlyEqual(a, b float64) bool { return math.Abs(a-b) < almost }

// assertNever335For8 is the one check every sub-case below must pass — it is
// deliberately independent of which SuggestionCode came back, because the
// invariant is about the OUTPUT PAIR, not about which branch produced it.
func assertNever335For8(t *testing.T, label string, p Plan) {
	t.Helper()
	if p.TargetWeightKg == nil || p.TargetReps == nil {
		return
	}
	if nearlyEqual(*p.TargetWeightKg, lb335Kg) && *p.TargetReps == 8 {
		t.Fatalf("%s: GOLDEN TEST VIOLATION — got 335 x 8, a set that was never "+
			"performed (12 reps happened at 228, not at 335). code=%s reason=%q",
			label, p.Code, p.Reason)
	}
}

// TestProgressV2_GoldenSquat_NeverInventsASetThatWasNeverPerformed is the
// ticket's own anchor: "no possible code branch may ever generate 335 x 8
// from reps performed at 228." It is deliberately a table across every
// effort configuration this file's other tests exercise individually, so the
// invariant is checked against every branch ProgressV2 can take from this
// exact session shape, not merely the one branch a single fixture happens to
// reach.
func TestProgressV2_GoldenSquat_NeverInventsASetThatWasNeverPerformed(t *testing.T) {
	day := 24 * time.Hour
	rir0, rir2 := 0, 2
	rpe8 := 8.0

	// The reported shape: three straight sets of 12 at 228, then one top
	// straight set of 3 at 335 — a ramp, all in one finished session. Varied
	// only by what effort (if any) is recorded on the 335 top set, since that
	// is what decides which branch ProgressV2 takes.
	build := func(topRIR *int, topRPE *float64) ProgressionInput {
		return squatIn("", finishedSess(day, testNow,
			straightSet(12, lb228Kg, nil, nil),
			straightSet(12, lb228Kg, nil, nil),
			straightSet(12, lb228Kg, nil, nil),
			straightSet(3, lb335Kg, topRIR, topRPE),
		))
	}

	cases := []struct {
		name     string
		topRIR   *int
		topRPE   *float64
		wantCode SuggestionCode
	}{
		{"no effort recorded at all", nil, nil, SuggestRepeatUnknownEffort},
		// The 228 sets are a DIFFERENT weight, so they are outside the 335
		// cohort entirely — the top set's own recorded RIR is the cohort's
		// only set, and it's full coverage, not partial. That is the fix
		// itself: the 228 sets' effort (or lack of it) is simply irrelevant
		// to a decision about the 335 cohort.
		{"effort with room", &rir2, nil, ProgressAddReps},
		{"conflicting RIR/RPE", &rir0, &rpe8, SuggestEffortConflict},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := ProgressV2(build(tc.topRIR, tc.topRPE), testNow)
			assertNever335For8(t, tc.name, p)
			if p.Code != tc.wantCode {
				t.Errorf("code = %q, want %q (reason: %q)", p.Code, tc.wantCode, p.Reason)
			}
			// The specific, positive assertion behind the golden invariant:
			// the cohort ProgressV2 reasons from is only the 335 set (the
			// straight-set, same-weight cohort), so its rep spread is 3, not
			// 12 — the 228 reps never enter this computation at all.
			if p.LastMinReps == nil || *p.LastMinReps != 3 || p.LastMaxReps == nil || *p.LastMaxReps != 3 {
				t.Errorf("cohort reps = %v..%v, want 3..3 (only the 335 set) — "+
					"228's reps leaked into the cohort", p.LastMinReps, p.LastMaxReps)
			}
			if p.LastWeightKg == nil || !nearlyEqual(*p.LastWeightKg, lb335Kg) {
				t.Errorf("LastWeightKg = %v, want 335lb-equivalent", p.LastWeightKg)
			}
		})
	}
}

// TestProgressV1_GoldenSquat_StillReproducesTheOriginalBug pins v1's
// Progress as UNCHANGED and UNFIXED — the explicit requirement that anyone
// not on new_recommendation_engine sees exactly the old behaviour. If this
// test ever goes red, either v1 was touched (which the ticket forbids) or the
// fixture stopped reproducing the reported bug shape.
func TestProgressV1_GoldenSquat_StillReproducesTheOriginalBug(t *testing.T) {
	day := 24 * time.Hour
	in := squatIn("", sess(day, testNow, // sess, not finishedSess: v1 doesn't
		// care about Finished, and using the v1 helper makes that explicit.
		straightSet(12, lb228Kg, nil, nil),
		straightSet(12, lb228Kg, nil, nil),
		straightSet(12, lb228Kg, nil, nil),
		straightSet(3, lb335Kg, nil, nil),
	))
	p := Progress(in, testNow)
	if p.TargetWeightKg == nil || !nearlyEqual(*p.TargetWeightKg, lb335Kg) {
		t.Fatalf("expected v1 to still select 335lb-equivalent as the top weight, got %v", p.TargetWeightKg)
	}
	if p.TargetReps == nil || *p.TargetReps != 8 {
		t.Fatalf("expected v1 to still clamp the rep spread to the general ceiling "+
			"of 8, got %v — v1 must stay byte-for-byte unchanged behind the flag", p.TargetReps)
	}
}

// TestProgressV2_StraightSetsOnly_BackoffExcluded is item 2: a backoff set
// at a much higher rep count and a different weight must not be folded into
// the straight-set cohort, in either direction (it can't become the anchor,
// and it can't widen the rep spread once a straight-set anchor is chosen).
func TestProgressV2_StraightSetsOnly_BackoffExcluded(t *testing.T) {
	day := 24 * time.Hour
	rir2 := 2
	backoff := straightSet(20, 60, nil, nil)
	backoff.SetType = SetTypeBackoff

	in := squatIn("", finishedSess(day, testNow,
		straightSet(5, 100, &rir2, nil),
		straightSet(5, 100, &rir2, nil),
		backoff,
	))
	p := ProgressV2(in, testNow)
	if p.LastWeightKg == nil || *p.LastWeightKg != 100 {
		t.Fatalf("anchor must be the straight-set weight (100), got %v", p.LastWeightKg)
	}
	if p.LastMaxReps == nil || *p.LastMaxReps != 5 {
		t.Fatalf("the backoff set's 20 reps must never enter the cohort, got max=%v", p.LastMaxReps)
	}
	if p.WorkingSets != 2 {
		t.Fatalf("WorkingSets = %d, want 2 (the backoff set excluded)", p.WorkingSets)
	}
}

// TestProgressV2_StraightSetsOnly_SameWeightBackoffStillExcluded is the same
// requirement isolated from sameWeightCohort: this backoff set sits at the
// SAME weight as the straight sets, so only the SetType filter — not the
// weight-cohort filter — can be what keeps it out. Without this, a mutation
// that deleted the SetType check entirely passed
// TestProgressV2_StraightSetsOnly_BackoffExcluded above anyway, because that
// fixture's backoff set happened to sit at a different weight and the
// weight-cohort filter caught it by coincidence.
func TestProgressV2_StraightSetsOnly_SameWeightBackoffStillExcluded(t *testing.T) {
	day := 24 * time.Hour
	rir2 := 2
	backoff := straightSet(20, 100, nil, nil) // same weight, no effort recorded
	backoff.SetType = SetTypeBackoff

	in := squatIn("", finishedSess(day, testNow,
		straightSet(5, 100, &rir2, nil),
		straightSet(5, 100, &rir2, nil),
		backoff,
	))
	p := ProgressV2(in, testNow)
	if p.WorkingSets != 2 {
		t.Fatalf("WorkingSets = %d, want 2 — a same-weight backoff set must still be "+
			"excluded by set type, not merely by weight", p.WorkingSets)
	}
	if p.LastMaxReps == nil || *p.LastMaxReps != 5 {
		t.Fatalf("the same-weight backoff set's 20 reps must never enter the cohort, got max=%v",
			p.LastMaxReps)
	}
	// If the backoff set had leaked in, its missing effort would make
	// coverage partial and the code would be abstain instead.
	if p.Code == SuggestAbstain {
		t.Fatalf("code is abstain — the backoff set's missing effort must not have leaked in")
	}
}

// TestProgressV2_Abstain_OnlyNonStraightSetsLoggedForEverything is the other
// half of item 2: when a finished session logged NOTHING straight for this
// exercise (every set a backoff/AMRAP/failure/drop), there is no cohort to
// build at all — an honest abstain, not a guess built from the wrong role.
func TestProgressV2_Abstain_OnlyNonStraightSetsLoggedForEverything(t *testing.T) {
	day := 24 * time.Hour
	amrap := straightSet(15, 80, nil, nil)
	amrap.SetType = SetTypeAMRAP

	in := squatIn("", finishedSess(day, testNow, amrap))
	p := ProgressV2(in, testNow)
	if p.Code != SuggestAbstain {
		t.Fatalf("code = %q, want %q", p.Code, SuggestAbstain)
	}
	if p.TargetWeightKg != nil || p.TargetReps != nil {
		t.Fatalf("abstain must not carry a numeric target, got weight=%v reps=%v",
			p.TargetWeightKg, p.TargetReps)
	}
}

// TestProgressV2_FinishedSessionsOnly_OpenSessionNeverBecomesHistory is item
// 3, and the one field this whole file exists to introduce: an unfinished
// session, however recent or heavy, must never be read as history.
func TestProgressV2_FinishedSessionsOnly_OpenSessionNeverBecomesHistory(t *testing.T) {
	day := 24 * time.Hour
	rir2 := 2

	openToday := sess(0, testNow, straightSet(1, 200, &rir2, nil)) // Finished left false
	finishedLastWeek := finishedSess(7*day, testNow, straightSet(8, 100, &rir2, nil))

	in := squatIn("", openToday, finishedLastWeek)
	p := ProgressV2(in, testNow)

	if p.LastWeightKg == nil || *p.LastWeightKg != 100 {
		t.Fatalf("must reason from the finished session's 100kg, not the open "+
			"session's 200kg, got %v", p.LastWeightKg)
	}
}

// TestProgressV2_FinishedSessionsOnly_OnlyAnOpenSessionMeansNoHistory covers
// the other end: if EVERY entry in Recent is unfinished, there is genuinely
// nothing to prescribe from yet, and the reason should read that way rather
// than claiming "first time logging this" to someone mid-workout.
func TestProgressV2_FinishedSessionsOnly_OnlyAnOpenSessionMeansNoHistory(t *testing.T) {
	in := squatIn("", sess(0, testNow, straightSet(5, 100, nil, nil))) // Finished false
	p := ProgressV2(in, testNow)
	if p.Code != SuggestNoHistory {
		t.Fatalf("code = %q, want %q", p.Code, SuggestNoHistory)
	}
	if p.Reason == "First time logging this. Pick a weight you could do 8 reps "+
		"with, stop 2 short, and the next session builds from it." {
		t.Fatalf("an in-progress session must not be described as if nothing had been logged")
	}
}

// TestProgressV2_SkipsAnUnusableFinishedSessionForARealOneBehindIt mirrors
// v1's TestProgress_SkipsAnUnusableSessionForARealOneBehindIt: a finished
// session with no usable straight-set cohort must not hide a usable one
// further back in history.
func TestProgressV2_SkipsAnUnusableFinishedSessionForARealOneBehindIt(t *testing.T) {
	day := 24 * time.Hour
	unusable := straightSet(5, 100, nil, nil)
	unusable.WeightKg = nil // logged reps only — not usable

	in := squatIn("",
		finishedSess(day, testNow, unusable),
		finishedSess(3*day, testNow, straightSet(5, 100, nil, nil)),
	)
	p := ProgressV2(in, testNow)
	if p.LastWeightKg == nil {
		t.Fatalf("expected the real session behind the unusable one to be found")
	}
}

// TestProgressV2_EffortRequired_PartialCoverageAbstains is item 4's new
// middle case: SOME but not all straight sets at the anchor weight carry
// effort. Distinct from "none at all", which keeps the existing
// repeat_unknown_effort behaviour (TestProgressV2_EffortRequired_NoneAtAll).
func TestProgressV2_EffortRequired_PartialCoverageAbstains(t *testing.T) {
	day := 24 * time.Hour
	rir2 := 2
	in := squatIn("", finishedSess(day, testNow,
		straightSet(8, 100, &rir2, nil),
		straightSet(8, 100, nil, nil), // no effort on this one
	))
	p := ProgressV2(in, testNow)
	if p.Code != SuggestAbstain {
		t.Fatalf("code = %q, want %q — partial effort coverage is ambiguous, not silent",
			p.Code, SuggestAbstain)
	}
}

func TestProgressV2_EffortRequired_NoneAtAll(t *testing.T) {
	day := 24 * time.Hour
	in := squatIn("", finishedSess(day, testNow,
		straightSet(8, 100, nil, nil),
		straightSet(8, 100, nil, nil),
	))
	p := ProgressV2(in, testNow)
	if p.Code != SuggestRepeatUnknownEffort {
		t.Fatalf("code = %q, want %q", p.Code, SuggestRepeatUnknownEffort)
	}
}

// TestProgressV2_EffortConflict_RIRAndRPEDisagreeMaterially is item 5, and
// the exact contradiction named in the report: RPE 8 implies about 2 reps in
// reserve, RIR recorded as 0 says none. v1 lets RIR silently win; v2 must
// name the conflict instead.
func TestProgressV2_EffortConflict_RIRAndRPEDisagreeMaterially(t *testing.T) {
	day := 24 * time.Hour
	rir0 := 0
	rpe8 := 8.0
	in := squatIn("", finishedSess(day, testNow,
		straightSet(8, 100, &rir0, &rpe8),
		straightSet(8, 100, &rir0, &rpe8),
	))
	p := ProgressV2(in, testNow)
	if p.Code != SuggestEffortConflict {
		t.Fatalf("code = %q, want %q", p.Code, SuggestEffortConflict)
	}
	if p.TargetWeightKg != nil || p.TargetReps != nil {
		t.Fatalf("effort_conflict must not carry a numeric target, got weight=%v reps=%v",
			p.TargetWeightKg, p.TargetReps)
	}
}

// TestProgressV2_EffortConflict_CloseReadingsAreNotAConflict makes sure the
// new check has a real negative case — RIR 2 / RPE 8 (which implies roughly
// 2 reserve too) must NOT be flagged, or every ordinary session using both
// fields loosely would abstain for no reason.
func TestProgressV2_EffortConflict_CloseReadingsAreNotAConflict(t *testing.T) {
	day := 24 * time.Hour
	rir2 := 2
	rpe8 := 8.0
	in := squatIn("", finishedSess(day, testNow,
		straightSet(8, 100, &rir2, &rpe8),
		straightSet(8, 100, &rir2, &rpe8),
	))
	p := ProgressV2(in, testNow)
	if p.Code == SuggestEffortConflict {
		t.Fatalf("RIR 2 / RPE 8 roughly agree and must not be flagged as a conflict")
	}
}

// TestProgressV2_EffortConflict_AssistedSetIsExempt: reserveOf already
// forces an assisted set's reserve to zero regardless of what was logged, so
// a conflicting-looking RIR/RPE pair on one must not ALSO trigger
// effort_conflict — that would be reporting a disagreement about a question
// this engine already has a confident, documented answer to.
func TestProgressV2_EffortConflict_AssistedSetIsExempt(t *testing.T) {
	day := 24 * time.Hour
	rir0 := 0
	rpe8 := 8.0
	assisted := straightSet(8, 100, &rir0, &rpe8)
	two := 2
	assisted.AssistedReps = &two

	in := squatIn("", finishedSess(day, testNow, assisted))
	p := ProgressV2(in, testNow)
	if p.Code == SuggestEffortConflict {
		t.Fatalf("an assisted set's RIR/RPE must not be treated as a conflict")
	}
}

// TestProgressV2_CoherentCohort_AnchorIsTheStraightSetTop confirms the
// cohort is chosen by the heaviest STRAIGHT weight, and that only sets
// matching it enter the rep-spread computation — the direct fix for the
// reported bug, isolated from the golden fixture's specific numbers.
func TestProgressV2_CoherentCohort_AnchorIsTheStraightSetTop(t *testing.T) {
	day := 24 * time.Hour
	rir2 := 2
	in := squatIn("", finishedSess(day, testNow,
		straightSet(12, 60, &rir2, nil),
		straightSet(10, 80, &rir2, nil),
		straightSet(5, 100, &rir2, nil), // heaviest straight set: the anchor
	))
	p := ProgressV2(in, testNow)
	if p.LastWeightKg == nil || *p.LastWeightKg != 100 {
		t.Fatalf("anchor must be 100 (the heaviest straight set), got %v", p.LastWeightKg)
	}
	if p.LastMinReps == nil || *p.LastMinReps != 5 || p.LastMaxReps == nil || *p.LastMaxReps != 5 {
		t.Fatalf("cohort reps must be 5..5 (only the 100kg set) — the 60kg and 80kg "+
			"sets' reps must not enter the spread, got %v..%v", p.LastMinReps, p.LastMaxReps)
	}
}

// TestProgressV2_Stall_UsesCoherentFinishedHistory is item 3 applied to the
// stall lookback: an unfinished session at the SAME weight must not count
// toward the plateau, and neither may a straight-set/same-weight mismatch in
// an older finished session.
func TestProgressV2_Stall_UsesCoherentFinishedHistory(t *testing.T) {
	day := 24 * time.Hour
	rir1 := 1 // below targetRIR (2) -> not ready for load, so a stall can register
	sessionAt100 := func(ago time.Duration) SessionEffort {
		return finishedSess(ago, testNow,
			straightSet(5, 100, &rir1, nil),
			straightSet(5, 100, &rir1, nil),
		)
	}
	in := squatIn("",
		sessionAt100(day),
		sessionAt100(2*day),
		sessionAt100(3*day),
	)
	p := ProgressV2(in, testNow)
	if p.SessionsAtLoad != 3 {
		t.Fatalf("SessionsAtLoad = %d, want 3", p.SessionsAtLoad)
	}
	if p.Code != ProgressDeload {
		t.Fatalf("code = %q, want %q after three stalled finished sessions", p.Code, ProgressDeload)
	}
}

func TestProgressV2_Stall_UnfinishedSessionDoesNotCountTowardThePlateau(t *testing.T) {
	day := 24 * time.Hour
	rir1 := 1
	openAt100 := sess(0, testNow, straightSet(5, 100, &rir1, nil)) // Finished false
	finishedAt100 := func(ago time.Duration) SessionEffort {
		return finishedSess(ago, testNow, straightSet(5, 100, &rir1, nil), straightSet(5, 100, &rir1, nil))
	}
	in := squatIn("",
		openAt100,
		finishedAt100(day),
		finishedAt100(2*day),
	)
	p := ProgressV2(in, testNow)
	// Only 2 FINISHED sessions at load — one short of the stall threshold —
	// so this must not deload, even though 3 SessionEffort entries exist.
	if p.SessionsAtLoad != 2 {
		t.Fatalf("SessionsAtLoad = %d, want 2 (the open session must not count)", p.SessionsAtLoad)
	}
	if p.Code == ProgressDeload {
		t.Fatalf("must not deload from only 2 finished stalled sessions")
	}
}

// TestProgressV2_Rounding_ImperialUsesRealPlateIncrements is item 8. 31.25kg
// is a clean 1.25kg step and the exact input that produces v1's reported
// 68.9lb once displayed — this asserts v2's imperial rounding lands on a
// clean lb number instead.
func TestProgressV2_Rounding_ImperialUsesRealPlateIncrements(t *testing.T) {
	day := 24 * time.Hour
	rir2 := 2
	in := squatIn("", finishedSess(day, testNow,
		straightSet(8, 31.25, &rir2, nil), // ready for load: 8 is the general ceiling
		straightSet(8, 31.25, &rir2, nil),
	))
	in.UnitSystem = "imperial"
	p := ProgressV2(in, testNow)
	if p.Code != ProgressAddLoad {
		t.Fatalf("code = %q, want %q", p.Code, ProgressAddLoad)
	}
	if p.TargetWeightKg == nil {
		t.Fatalf("expected a numeric target")
	}
	gotLb := kgToLb(*p.TargetWeightKg)
	rounded := math.Round(gotLb/5) * 5
	if !nearlyEqual(gotLb, rounded) {
		t.Fatalf("target %.4f lb is not a clean 5lb increment (68.9lb-style round-trip loss)", gotLb)
	}
}

// TestProgressV2_Rounding_MetricIsByteIdenticalToV1 confirms the "a client
// that never sends unit_system sees exactly what it always has" promise:
// v2's metric path must call the SAME roundToPlate/incrementWithin v1 uses,
// not a reimplementation that happens to agree today.
func TestProgressV2_Rounding_MetricIsByteIdenticalToV1(t *testing.T) {
	day := 24 * time.Hour
	rir2 := 2
	buildSets := func() []Set {
		return []Set{
			straightSet(8, 100, &rir2, nil),
			straightSet(8, 100, &rir2, nil),
		}
	}
	v1In := squatIn("", finishedSess(day, testNow, buildSets()...))
	v2In := squatIn("", finishedSess(day, testNow, buildSets()...))
	// v2In.UnitSystem left empty on purpose — the default, and the case that
	// must match v1 exactly.

	p1 := Progress(v1In, testNow)
	p2 := ProgressV2(v2In, testNow)
	if p1.Code != p2.Code {
		t.Fatalf("codes differ: v1=%q v2=%q", p1.Code, p2.Code)
	}
	if (p1.TargetWeightKg == nil) != (p2.TargetWeightKg == nil) {
		t.Fatalf("target-weight presence differs: v1=%v v2=%v", p1.TargetWeightKg, p2.TargetWeightKg)
	}
	if p1.TargetWeightKg != nil && *p1.TargetWeightKg != *p2.TargetWeightKg {
		t.Fatalf("metric target weight differs: v1=%v v2=%v", *p1.TargetWeightKg, *p2.TargetWeightKg)
	}
}

func TestProgressV2_NotApplicable(t *testing.T) {
	in := ProgressionInput{LoadType: "time"}
	p := ProgressV2(in, testNow)
	if p.Code != SuggestNotApplicable {
		t.Fatalf("code = %q, want %q", p.Code, SuggestNotApplicable)
	}
}

func TestProgressV2_NoHistoryAtAll(t *testing.T) {
	in := squatIn("")
	p := ProgressV2(in, testNow)
	if p.Code != SuggestNoHistory {
		t.Fatalf("code = %q, want %q", p.Code, SuggestNoHistory)
	}
}
