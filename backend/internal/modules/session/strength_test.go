package session

import (
	"context"
	"math"
	"testing"
	"time"
)

// Strength arithmetic: the properties that hold *across* the pieces, rather
// than the behaviour of any one of them.
//
// onerm_test.go pins what EstimateOneRM returns and progression_test.go pins
// what Progress decides. What neither covers is the seams — a constant in SQL
// that only works because of a bound in Go, and the same domain rule written
// out twice in two files. Those are the ones that break silently, because each
// side stays internally correct while quietly disagreeing with the other.

// maxOneRMMultiplier is load-bearing in SQL, and this is what makes it safe.
//
// BestOneRMs can't run Brzycki in Postgres, so it narrows candidates with
// `weight_kg * 1.44 >= heaviest` and estimates the survivors in Go. The
// property that has to hold is not really "estimates stay under the bound" —
// it is the thing that protects records:
//
//	if a set would BEAT the incumbent, the prefilter must keep it.
//
// Tested as that implication directly rather than as a proxy, because the
// proxy is false by one unit in the last place and the implication is not.
// EstimateOneRM computes `w * 36 / (37 - r)`, which for w=42.5, r=12 is
// 1530/25 = 61.2 exactly; the query passes the pre-divided constant, and
// 42.5 * (36.0/25.0) is 61.199999999999996. So an estimate can land one ulp
// above `w × multiplier`.
//
// That gap can only ever swallow an exact tie, and BestOneRM discards ties
// anyway (`est <= best` skips), so no record is reachable through it. Asserting
// the implication states that precisely instead of hiding it behind an epsilon.
func TestOneRMBound_NeverDiscardsASetThatWouldWin(t *testing.T) {
	weights := []float64{1.25, 20, 42.5, 60, 100, 142.5, 227.5, 500}
	rirs := []int{0, 1, 2, 3, 5, 8, 11, 20}
	rpes := []float64{1, 5, 6.5, 8, 8.5, 9, 9.5, 10}

	// Incumbents worth testing against: the heaviest single logged for the
	// exercise, which is what `heaviest` is in the query. Includes the exact
	// boundary values where the ulp gap lives.
	incumbents := []float64{1.25, 20, 42.5, 60, 61.2, 100, 144, 227.5, 327.6, 720}

	check := func(reps int, kg float64, rir *int, rpe *float64) {
		t.Helper()
		est, ok := EstimateOneRM(reps, kg, rir, rpe)
		if !ok {
			return // Not estimable, so SQL never has to consider it.
		}
		for _, heaviest := range incumbents {
			// Exactly the comparison postgres.go makes.
			kept := kg*maxOneRMMultiplier >= heaviest
			if est > heaviest && !kept {
				t.Errorf("reps=%d kg=%v rir=%s rpe=%s estimates %.6f, which beats "+
					"an incumbent of %.6f — but the prefilter (%.6f >= %.6f) drops "+
					"it, so this personal best would vanish",
					reps, kg, fmtPtrI(rir), fmtPtrF(rpe), est, heaviest,
					kg*maxOneRMMultiplier, heaviest)
			}
		}
	}

	for _, kg := range weights {
		// Deliberately runs past maxEstimableReps: the guarantee has to hold
		// for everything the function *accepts*, and the ceiling is one of the
		// things that could be changed out from under it.
		for reps := 1; reps <= 30; reps++ {
			check(reps, kg, nil, nil)
			for _, r := range rirs {
				v := r
				check(reps, kg, &v, nil)
			}
			for _, p := range rpes {
				v := p
				check(reps, kg, nil, &v)
			}
		}
	}
}

// The bound still has to be an upper bound to within representation error, or
// the implication above holds only by luck of which incumbents were sampled.
func TestOneRMBound_IsAnUpperBoundOnEveryEstimate(t *testing.T) {
	// Relative, and about one ulp at these magnitudes. Not a fudge factor for
	// a wrong bound — a statement that the two expressions are the same real
	// number computed two ways. A genuine excess (a different formula, or a
	// raised ceiling the constant didn't follow) exceeds this by orders of
	// magnitude.
	const tolerance = 1e-9

	for _, kg := range []float64{1.25, 20, 42.5, 60, 100, 227.5, 500} {
		for reps := 1; reps <= 30; reps++ {
			for _, rir := range []int{0, 1, 2, 3, 5, 8, 11} {
				v := rir
				est, ok := EstimateOneRM(reps, kg, &v, nil)
				if !ok {
					continue
				}
				if over := est - kg*maxOneRMMultiplier; over > tolerance*kg {
					t.Errorf("reps=%d kg=%v rir=%d estimated %.6f, %.9f above the "+
						"bound of %.6f — a real excess, not rounding",
						reps, kg, rir, est, over, kg*maxOneRMMultiplier)
				}
			}
		}
	}
}

// And the bound has to be tight, or the prefilter isn't filtering.
//
// A bound of, say, 10× would satisfy the test above while making the SQL scan
// essentially every set the athlete has ever logged — correct, and pointless.
// This pins that the multiplier is actually reached, so it is the smallest
// value that keeps the query sound.
func TestOneRMBound_IsTightEnoughToBeWorthApplying(t *testing.T) {
	// The worst case: exactly maxEstimableReps of effective work, which is
	// where Brzycki's denominator is smallest.
	est, ok := EstimateOneRM(maxEstimableReps, 100, nil, nil)
	if !ok {
		t.Fatalf("%d reps should sit exactly on the ceiling", maxEstimableReps)
	}
	if !approx(est, 100*maxOneRMMultiplier) {
		t.Errorf("the ceiling case estimates %.4f but the bound is %.4f — the "+
			"bound is looser than it needs to be, so the prefilter reads more "+
			"rows than it has to", est, 100*maxOneRMMultiplier)
	}
	// Sanity on the absolute value, so a change to either side is visible
	// here rather than only in a ratio that still agrees with itself.
	if !approx(maxOneRMMultiplier, 1.44) {
		t.Errorf("Brzycki at 12 reps is 36/25 = 1.44, got %.4f", maxOneRMMultiplier)
	}
}

// RPE → reps-in-reserve is written out twice, in two files, and has to mean
// the same thing in both.
//
// EstimateOneRM converts it to decide what a set implies you could lift once;
// reserveOf converts it to decide whether there was room to add weight. Same
// domain rule, two call sites — exactly the shape that has drifted in this
// codebase before (the working-set definition, twice). If they disagree, the
// app can tell you a set was easy enough to progress from while estimating it
// as though you were closer to failure.
func TestEffortConversion_AgreesBetweenEstimatorAndProgressionRule(t *testing.T) {
	for _, rpe := range []float64{1, 5, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 11} {
		p := rpe
		fromRule, ok := reserveOf(Set{RPE: &p})
		if !ok {
			t.Fatalf("RPE %v should convert", rpe)
		}

		// The estimator's conversion isn't exported, so it's recovered from
		// the outside: an RPE set and an equivalent RIR set must estimate
		// identically. That's a stronger check than reading both formulas,
		// because it fails if either one changes.
		viaRPE, okA := EstimateOneRM(3, 100, nil, &p)
		asRIR := int(fromRule)
		if float64(asRIR) != fromRule {
			// Half steps have no integer RIR twin; check them by their
			// neighbours instead of skipping the case entirely.
			lo, _ := EstimateOneRM(3, 100, ptrInt(int(math.Floor(fromRule))), nil)
			hi, _ := EstimateOneRM(3, 100, ptrInt(int(math.Ceil(fromRule))), nil)
			if !okA || viaRPE <= lo || viaRPE >= hi {
				t.Errorf("RPE %v converts to %.1f reserve, so its estimate %.2f "+
					"should sit strictly between %.2f and %.2f", rpe, fromRule, viaRPE, lo, hi)
			}
			continue
		}
		viaRIR, okB := EstimateOneRM(3, 100, &asRIR, nil)
		if okA != okB || !approx(viaRPE, viaRIR) {
			t.Errorf("RPE %v means %.1f reps in reserve to the progression rule, "+
				"but the estimator disagrees: %.2f via RPE vs %.2f via RIR %d",
				rpe, fromRule, viaRPE, viaRIR, asRIR)
		}
	}

	// Both sides must clamp an impossible RPE the same way, and in the
	// direction that doesn't invent reserve.
	if r, _ := reserveOf(Set{RPE: ptrF(11)}); r != 0 {
		t.Errorf("RPE above 10 should clamp to zero reserve, got %v", r)
	}

	// RIR is the observed quantity; RPE is a conversion. Where both exist,
	// both sides have to prefer the same one, or a set with conflicting
	// entries reads as easy to one and hard to the other.
	conflicting := Set{RIR: ptrInt(0), RPE: ptrF(6)}
	if r, _ := reserveOf(conflicting); r != 0 {
		t.Errorf("progression rule should trust RIR 0 over RPE 6, got %v reserve", r)
	}
	toFailure, _ := EstimateOneRM(5, 100, ptrInt(0), ptrF(6))
	atFailure, _ := EstimateOneRM(5, 100, ptrInt(0), nil)
	if !approx(toFailure, atFailure) {
		t.Errorf("estimator should trust RIR 0 over RPE 6: %.2f vs %.2f", toFailure, atFailure)
	}
}

// The increment table is a training judgement, not an implementation detail:
// it decides how fast every lift in the app moves. Pinned explicitly so a
// change to it is a deliberate edit to a test, not a silent one-line diff.
func TestIncrementFor_ScalesWithTheMuscleMassInvolved(t *testing.T) {
	big := []string{"squat", "hinge", "olympic"}
	medium := []string{"horizontal_push", "vertical_push", "horizontal_pull", "vertical_pull", "lunge"}
	small := []string{"isolation", "core", "rotation", "carry", "", "not_a_pattern"}

	for _, p := range big {
		if got := incrementFor(p); got != 5 {
			t.Errorf("%s should add 5kg, got %v", p, got)
		}
	}
	for _, p := range medium {
		if got := incrementFor(p); got != 2.5 {
			t.Errorf("%s should add 2.5kg, got %v", p, got)
		}
	}
	// Unmapped patterns fall to the smallest step. That default matters more
	// than it looks: an unrecognised movement getting a squat's 5kg jump is a
	// stall dressed up as progress.
	for _, p := range small {
		if got := incrementFor(p); got != defaultIncrement {
			t.Errorf("%s should fall back to %v, got %v", p, defaultIncrement, got)
		}
	}

	// The ordering is the actual claim — the exact numbers are calibration.
	if incrementFor("squat") <= incrementFor("horizontal_push") ||
		incrementFor("horizontal_push") <= incrementFor("isolation") {
		t.Error("increments must decrease with the muscle mass involved")
	}
}

// Every suggested weight has to be loadable, on every branch that produces
// one — not only the ones roundToPlate is called on today.
//
// A 63.7kg recommendation is arithmetic, not something anyone can put on a
// bar, and the failure is quiet: it renders fine and simply can't be followed.
func TestProgress_EverySuggestedWeightIsLoadable(t *testing.T) {
	day := 24 * time.Hour
	// Awkward starting loads chosen so a naive percentage lands off-plate.
	for _, kg := range []float64{22.5, 37.5, 63.75, 101.25, 142.5} {
		for _, goal := range []string{"", "powerlifting", "hypertrophy", "endurance"} {
			for _, in := range []ProgressionInput{
				progIn(goal, sess(2*day, testNow, set(3, kg, ptrInt(3), nil))),
				progIn(goal, sess(2*day, testNow, set(20, kg, ptrInt(3), nil))),
				progIn(goal, sess(2*day, testNow, set(5, kg, ptrInt(0), nil))),
				progIn(goal, sess(90*day, testNow, set(5, kg, ptrInt(2), nil))),
				// A genuine stall, which is the deload path — the one branch
				// that multiplies rather than adds.
				progIn(goal,
					sess(1*day, testNow, set(5, kg, ptrInt(1), nil)),
					sess(3*day, testNow, set(5, kg, ptrInt(1), nil)),
					sess(5*day, testNow, set(5, kg, ptrInt(1), nil)),
				),
			} {
				p := Progress(in, testNow)
				if p.TargetWeightKg == nil {
					continue
				}
				w := *p.TargetWeightKg
				if w <= 0 {
					t.Errorf("goal=%q from %vkg: suggested a non-positive %v (%s)", goal, kg, w, p.Code)
					continue
				}
				// Modulo on floats needs the tolerance; the values are exact
				// multiples of 1.25 or they aren't.
				if r := math.Mod(math.Round(w*100), smallestPlateKg*100); r != 0 {
					t.Errorf("goal=%q from %vkg: suggested %.4fkg, not a multiple of %v (%s)",
						goal, kg, w, smallestPlateKg, p.Code)
				}
			}
		}
	}
}

// A deload has to actually reduce the load. At light weights 10% can round
// straight back to where it started, and a "deload" that changes nothing is
// worse than none — it tells the athlete to back off while prescribing the
// weight they just failed to progress.
func TestProgress_DeloadNeverSuggestsTheSameOrMoreWeight(t *testing.T) {
	day := 24 * time.Hour
	for _, kg := range []float64{1.25, 2.5, 5, 10, 20, 60, 200} {
		stuck := func(ago time.Duration) SessionEffort {
			return sess(ago, testNow, set(7, kg, ptrInt(1), nil))
		}
		p := Progress(progIn("hypertrophy", stuck(day), stuck(3*day), stuck(5*day)), testNow)
		if p.Code != ProgressDeload {
			// Below about 12.5kg a 10% cut rounds to nothing, so the rule
			// declines to deload rather than pretending. That's the correct
			// behaviour — assert only that it didn't call it a deload.
			continue
		}
		if *p.TargetWeightKg >= kg {
			t.Errorf("%vkg: deload suggested %v, which is not lighter", kg, *p.TargetWeightKg)
		}
	}
}

// Small formatters so a failure names the exact input rather than a pointer.
func fmtPtrI(v *int) string {
	if v == nil {
		return "nil"
	}
	return itoa(*v)
}

func fmtPtrF(v *float64) string {
	if v == nil {
		return "nil"
	}
	return itoa(int(*v*10)) + "/10"
}

// BestOneRM and BestOneRMs are the same rule written twice: once in Go over
// whole Sets, once as a SQL prefilter plus a Go pass over the surviving rows.
// They have to agree, and nothing until now checked that they did.
//
// The same pairing as TestHistoryAgreesWithSummarise, for the same reason. The
// SQL half can't run Brzycki, so it narrows by weight and hands the rest back
// — and every narrowing is a chance to discard a row that would have won. A
// disagreement here is a personal best that silently stops existing.
//
// Deliberately built from sets where the answer is *not* the heaviest weight,
// because that's the case a naive implementation on either side gets wrong.
func TestBestOneRM_GoAndSQLAgree(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	all := []Set{
		// A heavy single. The obvious candidate, and not the winner.
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(1), WeightKg: ptrF(140), RIR: ptrInt(0), Completed: true},
		// Lighter, but far more reps: 12 × 100 estimates 144, which beats it.
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(12), WeightKg: ptrF(100), RIR: ptrInt(0), Completed: true},
		// Lighter still, but with reserve left — effort folded in matters.
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(8), WeightKg: ptrF(105), RIR: ptrInt(3), Completed: true},
		// Beyond the rep ceiling: estimable by neither, and must not win.
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(25), WeightKg: ptrF(60), RIR: ptrInt(0), Completed: true},
		// A very heavy warm-up, which counts for nothing on either side.
		{ExerciseID: exSquat, SetType: SetTypeWarmup, Reps: ptrInt(5), WeightKg: ptrF(200), Completed: true},
		// Planned and never performed. Also nothing.
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(10), WeightKg: ptrF(180), RIR: ptrInt(2), Completed: false},
		// A second exercise, so the per-exercise partitioning is exercised
		// rather than assumed.
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(80), RPE: ptrF(8), Completed: true},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(3), WeightKg: ptrF(90), RPE: ptrF(9.5), Completed: true},
	}

	// Split across two sessions, because the SQL searches a whole history
	// while the Go function sees one list.
	cleanup(t, pool, "ses-agree-1")
	cleanup(t, pool, "ses-agree-2")
	if _, err := repo.Create(ctx, strengthSession("ses-agree-1", "user_agree", all[:4])); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := repo.Create(ctx, strengthSession("ses-agree-2", "user_agree", all[4:])); err != nil {
		t.Fatalf("create: %v", err)
	}

	fromSQL, err := repo.BestOneRMs(ctx, "user_agree", []string{exSquat, exBench})
	if err != nil {
		t.Fatalf("best 1rms: %v", err)
	}

	for _, id := range []string{exSquat, exBench} {
		mine := []Set{}
		for _, s := range all {
			if s.ExerciseID == id {
				mine = append(mine, s)
			}
		}
		want, at, ok := BestOneRM(mine)
		got, hasSQL := fromSQL[id]
		if ok != hasSQL {
			t.Errorf("%s: Go found a best = %v, SQL found one = %v", id, ok, hasSQL)
			continue
		}
		if !approx(got, want) {
			t.Errorf("%s: SQL says %.4f, Go says %.4f (from %d × %v)",
				id, got, want, *at.Reps, *at.WeightKg)
		}
	}

	// And the specific trap, stated outright so a regression reads clearly.
	//
	// The winner is 8 × 105 at 3 RIR — eleven effective reps, 105 × 36/26 =
	// 145.38. It beats both the 140 single and the 12 × 100 (144), which is
	// the whole argument for folding effort in: the best *evidence* of a
	// maximum came from neither the heaviest set nor the longest one.
	if best := fromSQL[exSquat]; !approx(best, 145.3846) {
		t.Errorf("squat best should be 8 × 105 at 3 RIR = 145.38: got %.4f", best)
	}
}
