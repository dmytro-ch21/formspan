package session

import (
	"reflect"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/modules/workout"
)

func ptrFloat(v float64) *float64 { return &v }

func identityRound(kg float64) float64 { return kg }

// TestGenerateWarmupRamp_NoTargetKnown_ReturnsFalse is #753's own rule, "no
// automatic warm-up when the working target is unknown" — the caller must
// see an explicit false, never an empty-but-valid ramp.
func TestGenerateWarmupRamp_NoTargetKnown_ReturnsFalse(t *testing.T) {
	for _, target := range []float64{0, -10} {
		steps, ok := GenerateWarmupRamp(target, workout.ProfilePrimaryCompound, DefaultWarmupPolicy, identityRound)
		if ok {
			t.Fatalf("target=%v: want ok=false when the working target is not known, got steps=%+v", target, steps)
		}
		if steps != nil {
			t.Fatalf("target=%v: want a nil ramp when ok=false, got %+v", target, steps)
		}
	}
}

// TestGenerateWarmupRamp_AccessoryGetsNoHeavyCompoundRung is #753's own
// wording: the 80-90%/1-2-rep rung is "for heavy compounds" specifically —
// an isolation accessory must never reach it.
func TestGenerateWarmupRamp_AccessoryGetsNoHeavyCompoundRung(t *testing.T) {
	steps, ok := GenerateWarmupRamp(40, workout.ProfileIsolationAccessory, DefaultWarmupPolicy, identityRound)
	if !ok {
		t.Fatalf("want ok=true for a known target")
	}
	// technique + light + moderate, no heavy rung.
	if len(steps) != 3 {
		t.Fatalf("want 3 rungs (technique, light, moderate) for an accessory, got %d: %+v", len(steps), steps)
	}
	for _, s := range steps {
		if s.Label == "heavy" {
			t.Fatalf("an isolation accessory must never reach the heavy-compound-only rung: %+v", steps)
		}
	}
}

// TestGenerateWarmupRamp_HeavyCompoundGetsTheExtraRung is the mirror case: a
// primary compound DOES reach the 80-90%/1-2-rep rung.
func TestGenerateWarmupRamp_HeavyCompoundGetsTheExtraRung(t *testing.T) {
	const target = 100.0
	steps, ok := GenerateWarmupRamp(target, workout.ProfilePrimaryCompound, DefaultWarmupPolicy, identityRound)
	if !ok {
		t.Fatalf("want ok=true for a known target")
	}
	if len(steps) != 4 {
		t.Fatalf("want 4 rungs (technique, light, moderate, heavy) for a primary compound, got %d: %+v", len(steps), steps)
	}
	last := steps[len(steps)-1]
	if last.Label != "heavy" {
		t.Fatalf("want the heavy rung last, got %+v", last)
	}
	if last.PercentOfWork < 0.80 || last.PercentOfWork > 0.90 {
		t.Fatalf("heavy rung percent_of_work = %v, want within #753's 80-90%%", last.PercentOfWork)
	}
	if last.RepMin != 1 || last.RepMax != 2 {
		t.Fatalf("heavy rung reps = %d-%d, want #753's 1-2", last.RepMin, last.RepMax)
	}
}

// TestGenerateWarmupRamp_EveryRungIsAPercentageOfTheWorkingWeight is the
// direct test of #753's own requirement: "the exact ramp... must remain
// configurable — this is a starting policy, not a fixed universal ramp."
// The SAME policy must scale to two very different working weights rather
// than ever landing on the same absolute numbers — proof that nothing here
// is the literal 45/135/225/275/305 sequence #753 explicitly rejects.
func TestGenerateWarmupRamp_EveryRungIsAPercentageOfTheWorkingWeight(t *testing.T) {
	small, _ := GenerateWarmupRamp(60, workout.ProfilePrimaryCompound, DefaultWarmupPolicy, identityRound)
	large, _ := GenerateWarmupRamp(200, workout.ProfilePrimaryCompound, DefaultWarmupPolicy, identityRound)
	if len(small) != len(large) {
		t.Fatalf("the same policy applied to two targets must produce the same NUMBER of rungs: %d vs %d", len(small), len(large))
	}
	for i := range small {
		if small[i].Label != large[i].Label {
			t.Fatalf("rung %d label mismatch: %q vs %q", i, small[i].Label, large[i].Label)
		}
		if small[i].WeightKg == large[i].WeightKg {
			t.Fatalf("rung %d (%s) produced the SAME absolute weight for a 60kg and a 200kg target "+
				"(%v) — every rung must be a percentage of the working weight, never a fixed number",
				i, small[i].Label, small[i].WeightKg)
		}
		wantSmall := 60 * small[i].PercentOfWork
		wantLarge := 200 * large[i].PercentOfWork
		if !nearlyEqual(small[i].WeightKg, wantSmall) || !nearlyEqual(large[i].WeightKg, wantLarge) {
			t.Fatalf("rung %d weight is not target*percent_of_work: got %v/%v, want %v/%v",
				i, small[i].WeightKg, large[i].WeightKg, wantSmall, wantLarge)
		}
	}
}

// TestGenerateWarmupRamp_RepsDecreaseAsLoadIncreases pins #753's own words:
// "reps decrease as load approaches the working weight."
func TestGenerateWarmupRamp_RepsDecreaseAsLoadIncreases(t *testing.T) {
	steps, ok := GenerateWarmupRamp(100, workout.ProfilePrimaryCompound, DefaultWarmupPolicy, identityRound)
	if !ok || len(steps) < 2 {
		t.Fatalf("need a real, multi-rung ramp for this test: %+v", steps)
	}
	for i := 1; i < len(steps); i++ {
		if steps[i].PercentOfWork <= steps[i-1].PercentOfWork {
			t.Fatalf("rung %d (%v%%) is not heavier than rung %d (%v%%) — rungs must be ordered by ascending load",
				i, steps[i].PercentOfWork, i-1, steps[i-1].PercentOfWork)
		}
		if steps[i].RepMax > steps[i-1].RepMax {
			t.Fatalf("rung %d's max reps (%d) exceed the LIGHTER rung %d's (%d) — reps must "+
				"decrease as load approaches the working weight", i, steps[i].RepMax, i-1, steps[i-1].RepMax)
		}
	}
}

// TestGenerateWarmupRamp_ConfigurableNotOneFixedSequence is the acceptance
// criterion made literal: a DIFFERENT WarmupPolicy produces a genuinely
// different ramp from the same target, proving this is data a caller can
// swap, not a single hardcoded sequence GenerateWarmupRamp always returns.
func TestGenerateWarmupRamp_ConfigurableNotOneFixedSequence(t *testing.T) {
	const target = 100.0
	defaultSteps, _ := GenerateWarmupRamp(target, workout.ProfilePrimaryCompound, DefaultWarmupPolicy, identityRound)

	custom := WarmupPolicy{
		TechniqueLabel: "bar", TechniquePercentOfWork: 0.10, TechniqueRepMin: 8, TechniqueRepMax: 8,
		Bands: []WarmupBand{
			{Label: "single-jump", PercentOfWorkMin: 0.70, PercentOfWorkMax: 0.70, RepMin: 3, RepMax: 3},
		},
	}
	customSteps, ok := GenerateWarmupRamp(target, workout.ProfilePrimaryCompound, custom, identityRound)
	if !ok {
		t.Fatalf("want ok=true")
	}
	if len(customSteps) == len(defaultSteps) {
		t.Fatalf("a custom policy with a different band count must not produce the same rung count as the default")
	}
	if len(customSteps) != 2 {
		t.Fatalf("want technique + the one custom band = 2 rungs, got %d: %+v", len(customSteps), customSteps)
	}
	if !nearlyEqual(customSteps[1].WeightKg, target*0.70) {
		t.Fatalf("custom band weight = %v, want exactly 70%% of target (%v)", customSteps[1].WeightKg, target*0.70)
	}
}

// TestGenerateWarmupRamp_RoundingIsAppliedPerRung proves `round` is actually
// consulted, not ignored — a caller passing the athlete's real equipment
// rounding must see it reflected in every rung, not just accepted and
// discarded.
func TestGenerateWarmupRamp_RoundingIsAppliedPerRung(t *testing.T) {
	roundTo5 := func(kg float64) float64 {
		return float64(int((kg+2.5)/5)) * 5
	}
	steps, ok := GenerateWarmupRamp(97, workout.ProfileIsolationAccessory, DefaultWarmupPolicy, roundTo5)
	if !ok {
		t.Fatalf("want ok=true")
	}
	for _, s := range steps {
		if s.WeightKg != roundTo5(97*s.PercentOfWork) {
			t.Fatalf("rung %q weight %v was not rounded via the provided function", s.Label, s.WeightKg)
		}
		if int(s.WeightKg)%5 != 0 {
			t.Fatalf("rung %q weight %v is not a multiple of 5 — round was not applied", s.Label, s.WeightKg)
		}
	}
}

// --- DetectWarmupFatigue -----------------------------------------------

// TestDetectWarmupFatigue_NoTrigger_OrdinaryWarmup is the common-case
// baseline every other test in this block is contrasted against: a
// perfectly ordinary warm-up set raises nothing.
func TestDetectWarmupFatigue_NoTrigger_OrdinaryWarmup(t *testing.T) {
	reasons := DetectWarmupFatigue(50, 5, ptrInt(8), nil, 100, 8)
	if len(reasons) != 0 {
		t.Fatalf("an ordinary light warm-up must raise nothing, got %v", reasons)
	}
}

// TestDetectWarmupFatigue_HighEffort_RPE is trigger 1's RPE half — #753:
// "Reported warm-up RPE ≥7."
func TestDetectWarmupFatigue_HighEffort_RPE(t *testing.T) {
	reasons := DetectWarmupFatigue(40, 5, nil, ptrFloat(7), 100, 8)
	if len(reasons) != 1 || reasons[0] != FatigueHighEffort {
		t.Fatalf("want exactly [high_effort] for a warm-up set logged at RPE 7, got %v", reasons)
	}
}

// TestDetectWarmupFatigue_HighEffort_RPEBelowThresholdDoesNotFire pins the
// threshold itself: RPE 6 must NOT trigger — otherwise the guard is not
// exercised by the input it exists to reject (this repo's own "nine guards
// mutation tested, the tenth did not exist" lesson, applied here directly).
func TestDetectWarmupFatigue_HighEffort_RPEBelowThresholdDoesNotFire(t *testing.T) {
	reasons := DetectWarmupFatigue(40, 5, nil, ptrFloat(6), 100, 8)
	for _, r := range reasons {
		if r == FatigueHighEffort {
			t.Fatalf("RPE 6 must not trigger high_effort (threshold is 7), got %v", reasons)
		}
	}
}

// TestDetectWarmupFatigue_HighEffort_LowRIR is trigger 1's RIR half —
// #753: "or low RIR."
func TestDetectWarmupFatigue_HighEffort_LowRIR(t *testing.T) {
	reasons := DetectWarmupFatigue(40, 5, ptrInt(1), nil, 100, 8)
	if len(reasons) != 1 || reasons[0] != FatigueHighEffort {
		t.Fatalf("want exactly [high_effort] for a warm-up set logged at 1 RIR, got %v", reasons)
	}
}

// TestDetectWarmupFatigue_NearWorkingLoadHighReps is trigger 2, #753's own
// wording: "A near-working-load warm-up with as many or more reps than the
// work target."
func TestDetectWarmupFatigue_NearWorkingLoadHighReps(t *testing.T) {
	// 85kg is 85% of a 100kg target — near-working-load — done for 10 reps
	// against an 8-rep target, and left with plenty of reserve so high_effort
	// does not also fire, isolating this trigger.
	reasons := DetectWarmupFatigue(85, 10, ptrInt(6), nil, 100, 8)
	if len(reasons) != 1 || reasons[0] != FatigueNearWorkingLoadHighReps {
		t.Fatalf("want exactly [near_working_load_high_reps], got %v", reasons)
	}
}

// TestDetectWarmupFatigue_NearWorkingLoad_FewerRepsDoesNotFire pins the rep
// half of trigger 2: the same 85% load for FEWER reps than the target is an
// entirely ordinary heavy warm-up rung and must not be flagged.
func TestDetectWarmupFatigue_NearWorkingLoad_FewerRepsDoesNotFire(t *testing.T) {
	reasons := DetectWarmupFatigue(85, 2, ptrInt(6), nil, 100, 8)
	if len(reasons) != 0 {
		t.Fatalf("85%% load for only 2 reps against an 8-rep target is an ordinary heavy rung, got %v", reasons)
	}
}

// TestDetectWarmupFatigue_ModerateLoadDoubleReps is trigger 3, #753's own
// wording: "A moderate-load warm-up with roughly twice the working
// repetitions."
func TestDetectWarmupFatigue_ModerateLoadDoubleReps(t *testing.T) {
	// 60kg is 60% of a 100kg target — squarely moderate — for 16 reps
	// against an 8-rep target: exactly double.
	reasons := DetectWarmupFatigue(60, 16, ptrInt(6), nil, 100, 8)
	if len(reasons) != 1 || reasons[0] != FatigueModerateLoadDoubleReps {
		t.Fatalf("want exactly [moderate_load_double_reps], got %v", reasons)
	}
}

// TestDetectWarmupFatigue_ModerateLoad_LessThanDoubleDoesNotFire pins the
// "roughly TWICE" half of trigger 3 — 1.5x is a harder-than-usual warm-up
// set, not the pattern #753 names.
func TestDetectWarmupFatigue_ModerateLoad_LessThanDoubleDoesNotFire(t *testing.T) {
	reasons := DetectWarmupFatigue(60, 12, ptrInt(6), nil, 100, 8)
	if len(reasons) != 0 {
		t.Fatalf("60%% load for 1.5x the working reps must not trigger moderate_load_double_reps, got %v", reasons)
	}
}

// TestDetectWarmupFatigue_UnknownTarget_PercentTriggersNeverFire is the
// belt-and-braces guard on the two load-ratio triggers: with no target
// weight/reps to compare against, dividing by them must never run at all —
// the effort trigger, which needs no target, still can.
func TestDetectWarmupFatigue_UnknownTarget_PercentTriggersNeverFire(t *testing.T) {
	reasons := DetectWarmupFatigue(85, 20, nil, ptrFloat(8), 0, 0)
	if len(reasons) != 1 || reasons[0] != FatigueHighEffort {
		t.Fatalf("with no known target, only high_effort (which needs no target) may fire, got %v", reasons)
	}
}

// TestDetectWarmupFatigue_MultipleTriggersCanFireTogether confirms the
// triggers are independent checks, not a single mutually-exclusive branch —
// and that regardless of how many fire, the caller-facing prompt is the
// ONE question #753 specifies (see WarmupFatiguePrompt), not composed text
// per reason.
func TestDetectWarmupFatigue_MultipleTriggersCanFireTogether(t *testing.T) {
	// 90kg/90% of 100kg, 12 reps against an 8-rep target (near-working-load +
	// high reps), AND RPE 8 (high effort) — both should fire.
	reasons := DetectWarmupFatigue(90, 12, nil, ptrFloat(8), 100, 8)
	if len(reasons) != 2 {
		t.Fatalf("want both high_effort and near_working_load_high_reps, got %v", reasons)
	}
	has := map[WarmupFatigueReason]bool{}
	for _, r := range reasons {
		has[r] = true
	}
	if !has[FatigueHighEffort] || !has[FatigueNearWorkingLoadHighReps] {
		t.Fatalf("want both triggers present, got %v", reasons)
	}
}

// --- The OHP golden regression test, verbatim from #753's own report ------

// ohpSet mirrors straightSet, for the exercise this golden test is actually
// about.
func ohpSet(reps int, kg float64, rir *int, rpe *float64) Set {
	s := set(reps, kg, rir, rpe)
	s.ExerciseID = "overhead-press"
	return s
}

// TestWarmupEngine_GoldenOHP_HoldsWorkingWeightAndFlagsFatiguingWarmup is
// N495/#865's own required permanent regression test, resolving #753's OHP
// scenario exactly as specified: "hold 115 inside a configured 6-8 range;
// flag 95×12@7 as potentially fatiguing preparation." Three things in one
// test, deliberately, because the ticket ties them together as one scenario:
//
//  1. ProgressV2, with an athlete-configured 6-8 rep range (N494/#864),
//     holds the working weight at 115 rather than inventing a different
//     number from a mismatched cohort — the same coherent-cohort discipline
//     N473/#812's squat golden test already pins, applied to this exercise.
//  2. GenerateWarmupRamp, called only once that 115 prescription exists,
//     produces a real ramp — proving the phase-2/phase-3 dependency #753
//     itself describes.
//  3. DetectWarmupFatigue flags a 95×12@RPE7 warm-up set against that same
//     115/prescribed-reps target — and Summarise proves the flag alone
//     changes NOTHING about stored volume: the set stays warm-up-side until
//     it is explicitly reclassified, exactly like any other correction to a
//     logged set.
func TestWarmupEngine_GoldenOHP_HoldsWorkingWeightAndFlagsFatiguingWarmup(t *testing.T) {
	day := 24 * time.Hour
	rir2 := ptrInt(2)
	const workingWeight = 115.0

	repMin, repMax := 6, 8
	athlete := &workout.ItemProtocol{RepRangeMin: &repMin, RepRangeMax: &repMax}
	resolved := ResolveProtocol(nil, athlete, workout.ProfilePrimaryCompound)

	in := ProgressionInput{
		ExerciseID:      "overhead-press",
		LoadType:        "weight_reps",
		MovementPattern: "vertical_push",
		Goal:            "general", // would be 5-8 without the configured protocol
		Protocol:        &resolved,
		Recent: []SessionEffort{
			finishedSess(1*day, testNow,
				ohpSet(6, workingWeight, rir2, nil),
				ohpSet(6, workingWeight, rir2, nil),
				ohpSet(6, workingWeight, rir2, nil),
			),
		},
	}

	// --- 1. The prescription itself holds 115 inside the configured 6-8 range.
	p := ProgressV2(in, testNow)
	if p.RepRange != (RepRange{Low: repMin, High: repMax}) {
		t.Fatalf("rep range = %+v, want the configured 6-8", p.RepRange)
	}
	if p.TargetWeightKg == nil || !nearlyEqual(*p.TargetWeightKg, workingWeight) {
		t.Fatalf("target weight = %v, want exactly the held 115 — no invented number", p.TargetWeightKg)
	}
	if p.TargetReps == nil {
		t.Fatalf("target reps must be set")
	}
	targetReps := *p.TargetReps

	// --- 2. A warm-up ramp exists BECAUSE that prescription now exists.
	steps, ok := GenerateWarmupRamp(*p.TargetWeightKg, workout.ProfilePrimaryCompound, DefaultWarmupPolicy, identityRound)
	if !ok || len(steps) == 0 {
		t.Fatalf("want a real ramp once the working weight is known, got ok=%v steps=%v", ok, steps)
	}

	// --- 3. The reported 95×12@RPE7 warm-up set is flagged as potentially
	// fatiguing preparation.
	flags := DetectWarmupFatigue(95, 12, nil, ptrFloat(7), *p.TargetWeightKg, targetReps)
	if len(flags) == 0 {
		t.Fatalf("95×12@RPE7 against a 115/%d-rep prescription must be flagged as potentially "+
			"fatiguing preparation, got no flags", targetReps)
	}
	has := map[WarmupFatigueReason]bool{}
	for _, f := range flags {
		has[f] = true
	}
	if !has[FatigueHighEffort] {
		t.Errorf("RPE 7 alone should trigger high_effort; flags=%v", flags)
	}
	// 95/115 is ~82.6%, above the near-working-load floor, and 12 reps is
	// more than the working target — pin this SECOND, independent trigger
	// too, not just high_effort. Losing this half would still leave the
	// broader `len(flags) == 0` check above green.
	if !has[FatigueNearWorkingLoadHighReps] {
		t.Errorf("95kg is ~82%% of 115kg with more reps than the working target — should also "+
			"trigger near_working_load_high_reps; flags=%v", flags)
	}

	// --- The flag changes nothing about stored volume until confirmed.
	warmupRPE := 7.0
	sets := []Set{
		{ExerciseID: "overhead-press", SetType: SetTypeWarmup, Completed: true, Reps: ptrInt(12), WeightKg: ptrFloat(95), RPE: &warmupRPE},
		ohpSet(6, workingWeight, rir2, nil),
		ohpSet(6, workingWeight, rir2, nil),
		ohpSet(6, workingWeight, rir2, nil),
	}
	before := Summarise(sets)
	if before.WarmupSets != 1 || before.WarmupReps != 12 || !nearlyEqual(before.WarmupTonnageKg, 12*95) {
		t.Fatalf("warm-up set must be counted on the WARMUP side of Volume: got %+v", before)
	}
	if before.WorkingSets != 3 || before.TotalReps != 18 {
		t.Fatalf("the flagged warm-up must NOT have been folded into working volume: got %+v", before)
	}

	// Detecting the flag again changes nothing — it is a pure read.
	_ = DetectWarmupFatigue(95, 12, nil, ptrFloat(7), *p.TargetWeightKg, targetReps)
	after := Summarise(sets)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("calling DetectWarmupFatigue must never itself change Volume: before=%+v after=%+v", before, after)
	}

	// Only an EXPLICIT reclassification — the athlete editing the set's own
	// SetType, exactly as any other correction to a logged set is made —
	// moves it into working volume. Nothing in this package does this
	// automatically.
	sets[0].SetType = SetTypeWorking
	reclassified := Summarise(sets)
	if reclassified.WarmupSets != 0 {
		t.Fatalf("after explicit reclassification, nothing should remain on the warm-up side: %+v", reclassified)
	}
	if reclassified.WorkingSets != 4 || reclassified.TotalReps != 30 {
		t.Fatalf("after explicit reclassification, the set's reps must count toward working volume: %+v", reclassified)
	}
}
