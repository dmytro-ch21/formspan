package nutrition

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

func f(v float64) *float64 { return &v }
func s(v string) *string   { return &v }

// The reference athlete, matching energy's: 80 kg, 180 cm, 30, male.
// Mifflin–St Jeor = 1780 kcal/day, which every expectation below is built from
// by hand rather than by re-running the code.
const refRMR = 1780.0

func refInputs() Inputs {
	return Inputs{
		On:                  "2026-08-18",
		WeightKG:            f(80),
		WeightMeasuredOn:    "2026-08-17",
		HeightCM:            f(180),
		DateOfBirth:         s("1996-08-17"),
		Sex:                 s("male"),
		TrainingKcalPerDay:  300,
		TrainingDaysCovered: 28,
		TrainingSessions:    11,
	}
}

func estimated() (float64, bool) { return refRMR, true }

// suggest is the call under test with the two energy-shaped arguments stubbed,
// which is what keeps this file free of a database AND of the energy package's
// own clock (ageYears reads time.Now).
func suggest(t *testing.T, in Inputs, a Activity) *Suggestion {
	t.Helper()
	got, missing := Suggest(in, a, estimated, "estimated")
	if got == nil {
		t.Fatalf("no suggestion; missing %v", missing)
	}
	return got
}

// THE SIGN TRAP, and the reason this test exists at all.
//
// A cut's rate is negative, so its energy delta must be negative and its target
// must land BELOW maintenance. Inverting the comparison — the mistake
// `judgeRate` documents and centralises against — proposes more food to
// somebody already losing too fast, and every number on the screen still looks
// plausible. Both directions are asserted because a single-direction test
// passes against a sign that is inverted for both.
func TestPhaseDirectionDecidesWhetherTheTargetIsAboveOrBelowMaintenance(t *testing.T) {
	for _, tc := range []struct {
		kind      PhaseKind
		wantBelow bool
		wantAbove bool
	}{
		{PhaseCut, true, false},
		{PhaseLeanBulk, false, true},
		{PhaseMaintenance, false, false},
		{PhaseRecomposition, false, false},
	} {
		t.Run(string(tc.kind), func(t *testing.T) {
			in := refInputs()
			in.PhaseKind = tc.kind
			got := suggest(t, in, ActivityLight)
			tdee := got.Basis.TDEEKcal

			switch {
			case tc.wantBelow:
				if got.Kcal >= tdee {
					t.Fatalf("a cut proposed %d kcal against maintenance %d — the sign is inverted", got.Kcal, tdee)
				}
				if got.Basis.EnergyDeltaKcal >= 0 {
					t.Fatalf("a cut's energy delta is %+d, want negative", got.Basis.EnergyDeltaKcal)
				}
			case tc.wantAbove:
				if got.Kcal <= tdee {
					t.Fatalf("a lean bulk proposed %d kcal against maintenance %d — the sign is inverted", got.Kcal, tdee)
				}
				if got.Basis.EnergyDeltaKcal <= 0 {
					t.Fatalf("a lean bulk's energy delta is %+d, want positive", got.Basis.EnergyDeltaKcal)
				}
			default:
				if got.Basis.EnergyDeltaKcal != 0 {
					t.Fatalf("%s moved the target by %+d kcal; it should hold weight", tc.kind, got.Basis.EnergyDeltaKcal)
				}
			}
		})
	}
}

// The arithmetic, worked by hand, so a refactor that changes any term fails
// here rather than in a screenshot six weeks later.
//
// RMR 1780 · light 1.30 → NEAT 534 · training 300 → TDEE 2614.
// Cut midpoint 0.75%/week of 80 kg = 0.6 kg/week → 0.6 × 7700 ÷ 7 = 660 kcal/day.
// 2614 − 660 = 1954 → rounds to 1950.
func TestTheChainIsTheArithmeticInTheDoc(t *testing.T) {
	in := refInputs()
	in.PhaseKind = PhaseCut
	got := suggest(t, in, ActivityLight)

	if got.Basis.NEATKcal != 534 {
		t.Errorf("NEAT %d, want 534", got.Basis.NEATKcal)
	}
	if got.Basis.TDEEKcal != 2614 {
		t.Errorf("TDEE %d, want 2614", got.Basis.TDEEKcal)
	}
	if got.Basis.EnergyDeltaKcal != -660 {
		t.Errorf("delta %d, want -660", got.Basis.EnergyDeltaKcal)
	}
	if got.Kcal != 1950 {
		t.Errorf("kcal %d, want 1950", got.Kcal)
	}
	if got.Basis.Clamped {
		t.Errorf("nothing should have clamped: %s", got.Basis.ClampReason)
	}
}

// The activity ladder stops at 1.45 because training is added SEPARATELY.
// A textbook 1.55 "moderately active" here would double-count every session —
// this pins the ceiling so raising it is a deliberate act with a red test.
func TestActivityFactorsAreNEATOnly(t *testing.T) {
	if got := ActivityFactors[ActivityActive]; got > 1.45 {
		t.Fatalf("the top activity factor is %g; anything above 1.45 includes exercise, "+
			"which is already added as TrainingKcalPerDay — that double-counts every session", got)
	}
	// And the training term must actually reach the total.
	base := refInputs()
	base.TrainingKcalPerDay = 0
	withTraining := refInputs()
	withTraining.TrainingKcalPerDay = 400

	a := suggest(t, base, ActivityLight)
	b := suggest(t, withTraining, ActivityLight)
	if b.Basis.TDEEKcal-a.Basis.TDEEKcal != 400 {
		t.Fatalf("400 kcal of training moved TDEE by %d", b.Basis.TDEEKcal-a.Basis.TDEEKcal)
	}
}

// A competition date does not change physiology. Six kilos in four weeks is a
// 1.9%/week ask; the answer is the cut ceiling and a plan that says so, not a
// target that starves the athlete.
func TestMakingWeightIsClampedAtTheCutCeiling(t *testing.T) {
	in := refInputs()
	in.PhaseKind = PhaseMakingWeight
	in.PhaseTargetOn = s("2026-09-15") // 28 days out
	in.PhaseTargetWeightKG = f(74)     // 6 kg to go

	got := suggest(t, in, ActivityLight)
	ceiling := RateTargets[PhaseCut].Max
	if math.Abs(got.Basis.TargetRatePerWeek) > ceiling+1e-9 {
		t.Fatalf("rate %.4f/week exceeds the cut ceiling %.4f", math.Abs(got.Basis.TargetRatePerWeek), ceiling)
	}
}

// A deadline that has run out, both ways round.
//
// TODAY divides by zero and yields +Inf, which math.Min quietly turns into the
// ceiling — so that half is masked and, on its own, tests nothing. THE PAST is
// the case the guard actually exists for, and it is far worse than a crash: a
// negative day count makes the required rate negative, the per-phase sign
// inverts it again, and the athlete who just missed their weigh-in is handed a
// 3%/week SURPLUS. Mutation-testing the guard is what surfaced this — the
// original test only covered today and stayed green with the guard removed.
func TestMakingWeightWithNoTimeLeftDoesNotProduceInfinity(t *testing.T) {
	in := refInputs()
	in.PhaseKind = PhaseMakingWeight
	in.PhaseTargetOn = s("2026-08-18") // today
	in.PhaseTargetWeightKG = f(74)

	got := suggest(t, in, ActivityLight)
	if math.IsInf(got.Basis.TargetRateKGPerWk, 0) || math.IsNaN(got.Basis.TargetRateKGPerWk) {
		t.Fatalf("rate is %v", got.Basis.TargetRateKGPerWk)
	}
	if got.Kcal <= 0 {
		t.Fatalf("kcal %d", got.Kcal)
	}
}

func TestAMissedWeighInDeadlineDoesNotPrescribeASurplus(t *testing.T) {
	in := refInputs()
	in.PhaseKind = PhaseMakingWeight
	in.PhaseTargetOn = s("2026-08-01") // seventeen days ago
	in.PhaseTargetWeightKG = f(74)     // still 6 kg over

	got := suggest(t, in, ActivityLight)
	if got.Basis.EnergyDeltaKcal > 0 {
		t.Fatalf("the weigh-in was missed and still 6 kg over, but the target went UP by %+d kcal "+
			"(rate %+.4f/week) — a negative day count inverted the sign",
			got.Basis.EnergyDeltaKcal, got.Basis.TargetRatePerWeek)
	}
	if got.Kcal > got.Basis.TDEEKcal {
		t.Fatalf("target %d kcal is above maintenance %d while still over the division weight",
			got.Kcal, got.Basis.TDEEKcal)
	}
}

// Already under the division weight: hold, do not keep cutting into the
// weigh-in.
func TestMakingWeightStopsOnceMade(t *testing.T) {
	in := refInputs()
	in.PhaseKind = PhaseMakingWeight
	in.PhaseTargetOn = s("2026-09-15")
	in.PhaseTargetWeightKG = f(85) // heavier than the athlete

	got := suggest(t, in, ActivityLight)
	if got.Basis.EnergyDeltaKcal != 0 {
		t.Fatalf("already made weight but the target moved by %+d kcal", got.Basis.EnergyDeltaKcal)
	}
}

// Every clamp, each reached on its own, and each reporting itself. A clamp that
// binds silently is arithmetic whose last line does not follow from the one
// above it.
func TestClampsBindAndSaySo(t *testing.T) {
	t.Run("deficit capped as a share of maintenance", func(t *testing.T) {
		// A very heavy athlete: the cut midpoint asks for a deficit far past
		// a quarter of maintenance.
		in := refInputs()
		in.PhaseKind = PhaseCut
		in.WeightKG = f(160)
		got := suggest(t, in, ActivitySedentary)
		if !got.Basis.Clamped {
			t.Fatalf("expected a clamp; kcal %d, TDEE %d", got.Kcal, got.Basis.TDEEKcal)
		}
		// Reads the constant rather than repeating the number: a hardcoded
		// percentage here is a second place the rail is written down, and it
		// silently stops testing the rail the moment somebody tunes it.
		floor := float64(got.Basis.TDEEKcal) * (1 - maxDeficitFraction)
		if float64(got.Kcal) < floor-10 {
			t.Fatalf("kcal %d is below %.0f%% of TDEE %d (=%.0f)",
				got.Kcal, (1-maxDeficitFraction)*100, got.Basis.TDEEKcal, floor)
		}
	})

	t.Run("never below resting", func(t *testing.T) {
		got, _ := Suggest(refInputsWithPhase(PhaseCut), ActivitySedentary,
			func() (float64, bool) { return 2400, true }, "estimated")
		if got == nil {
			t.Fatal("no suggestion")
		}
		if float64(got.Kcal) < 2400*minKcalOverResting-10 {
			t.Fatalf("kcal %d fell below resting × %g = %.0f", got.Kcal, minKcalOverResting, 2400*minKcalOverResting)
		}
	})

	// THE CASE THE SUBTEST ABOVE CANNOT SEE, and the one review found.
	//
	// Its numbers (RMR 2400 against a TDEE of 3420) never trip a percentage
	// rail, so it only ever exercised the floor on the path where no cap fired.
	// The rails used to return early, which made the floor unreachable the
	// moment a cap fired first — and this is an ordinary athlete, not a corner
	// case: the reference RMR of 1780, sedentary, no logged training, on a
	// standard cut. The cap lands at 1500 and resting is 1780.
	t.Run("the floor still binds when a percentage cap fired first", func(t *testing.T) {
		in := refInputsWithPhase(PhaseCut)
		in.TrainingKcalPerDay = 0
		got := suggest(t, in, ActivitySedentary)

		if float64(got.Kcal) < refRMR {
			t.Fatalf("proposed %d kcal against a resting rate of %.0f — the floor was "+
				"skipped because a percentage cap returned first (clamp reason: %q)",
				got.Kcal, refRMR, got.Basis.ClampReason)
		}
		if !got.Basis.Clamped {
			t.Error("a rail bound but Clamped is false")
		}
		if got.Basis.ClampReason != "the target was raised to stay above your resting rate" {
			t.Errorf("clamp reason is %q — the floor is applied last so its message "+
				"should win over the cap's", got.Basis.ClampReason)
		}
	})

	// The explanation the athlete reads is built from the constants, so tuning
	// a rail can never leave a stale percentage in the sentence beside it. The
	// message said "25%" for a while after the cap moved to 30%.
	t.Run("the clamp message quotes the constant it enforces", func(t *testing.T) {
		in := refInputsWithPhase(PhaseCut)
		in.WeightKG = f(160)
		got := suggest(t, in, ActivitySedentary)
		want := fmt.Sprintf("%.0f%%", maxDeficitFraction*100)
		if got.Basis.Clamped && strings.Contains(got.Basis.ClampReason, "capped") &&
			!strings.Contains(got.Basis.ClampReason, want) {
			t.Fatalf("clamp reason %q does not quote the actual cap (%s)", got.Basis.ClampReason, want)
		}
	})
}

func refInputsWithPhase(k PhaseKind) Inputs {
	in := refInputs()
	in.PhaseKind = k
	return in
}

// THE OTHER SILENT FAILURE. Deriving from the generic baseline — which
// energy's own doc calls 20–30% high — overfeeds by roughly 400 kcal/day and
// the cut never happens. A caveat is not enough because there is no caveat an
// athlete can act on, so it is a refusal.
func TestACoarseProfileIsRefusedRatherThanDerivedWithACaveat(t *testing.T) {
	got, missing := Suggest(refInputs(), ActivityLight, estimated, "coarse")
	if got != nil {
		t.Fatalf("derived from a coarse resting rate: %d kcal", got.Kcal)
	}
	if len(missing) == 0 {
		t.Fatal("refused without naming what is missing; the client's fix is a form, and it needs to know which field")
	}
}

// An absent field is reported by name, not as a bare failure, and weight is
// reported separately from the three that only affect precision.
func TestMissingFieldsAreNamed(t *testing.T) {
	for _, tc := range []struct {
		name string
		mut  func(*Inputs)
		want string
	}{
		{"no weight", func(i *Inputs) { i.WeightKG = nil }, MissingWeight},
		{"no height", func(i *Inputs) { i.HeightCM = nil }, MissingHeight},
		{"no dob", func(i *Inputs) { i.DateOfBirth = nil }, MissingDOB},
		{"no sex", func(i *Inputs) { i.Sex = nil }, MissingSex},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := refInputs()
			tc.mut(&in)
			got, missing := Suggest(in, ActivityLight, estimated, "estimated")
			if got != nil {
				t.Fatal("derived from an incomplete profile")
			}
			if !contains(missing, tc.want) {
				t.Fatalf("missing %v, want it to name %q", missing, tc.want)
			}
		})
	}
}

// The relaxation ladder, in order. A large athlete on a small target cannot
// hold protein and fat at their preferred levels and still have carbohydrate
// left; the order in which they give way is a decision, and this is where it is
// written down.
func TestMacroRelaxationLadder(t *testing.T) {
	t.Run("normal case holds both preferences", func(t *testing.T) {
		in := refInputsWithPhase(PhaseCut)
		got := suggest(t, in, ActivityLight)
		if got.Basis.Relaxed != "" {
			t.Fatalf("relaxed unnecessarily: %q", got.Basis.Relaxed)
		}
		if got.Basis.ProteinGPerKG != proteinDeficitGPerKG {
			t.Errorf("protein %g g/kg, want %g in a deficit", got.Basis.ProteinGPerKG, proteinDeficitGPerKG)
		}
	})

	t.Run("fat gives way before protein", func(t *testing.T) {
		// 160 kg at a low resting rate: protein alone at 2.2 g/kg is 352 g =
		// 1408 kcal, so fat has to come down before carbohydrate exists.
		in := refInputsWithPhase(PhaseCut)
		in.WeightKG = f(160)
		in.TrainingKcalPerDay = 0
		got, _ := Suggest(in, ActivitySedentary, func() (float64, bool) { return 1500, true }, "estimated")
		if got == nil {
			t.Fatal("no suggestion")
		}
		if got.Basis.Relaxed == "" {
			t.Fatalf("nothing relaxed, but kcal %d against protein %d g and fat %d g", got.Kcal, got.ProteinG, got.FatG)
		}
		if got.Basis.FatGPerKG > fatGPerKG {
			t.Errorf("fat %g g/kg went up", got.Basis.FatGPerKG)
		}
		// Protein must not be touched while fat still has room above its floor.
		if got.Basis.FatGPerKG > fatFloorGPerKG && got.Basis.ProteinGPerKG < proteinDeficitGPerKG {
			t.Errorf("protein was cut to %g g/kg while fat was still at %g g/kg — wrong order",
				got.Basis.ProteinGPerKG, got.Basis.FatGPerKG)
		}
	})

	t.Run("carbohydrate is never negative", func(t *testing.T) {
		in := refInputsWithPhase(PhaseCut)
		in.WeightKG = f(200)
		in.TrainingKcalPerDay = 0
		got, _ := Suggest(in, ActivitySedentary, func() (float64, bool) { return 1200, true }, "estimated")
		if got == nil {
			t.Fatal("no suggestion")
		}
		if got.CarbG < 0 || got.ProteinG < 0 || got.FatG < 0 {
			t.Fatalf("negative macro: %d kcal → P%d C%d F%d", got.Kcal, got.ProteinG, got.CarbG, got.FatG)
		}
	})
}

// Protein is scaled to bodyweight and moves with the phase — the g/kg figure is
// what makes it arguable, so it is reported rather than only the gram total.
func TestProteinIsHigherInADeficit(t *testing.T) {
	cut := suggest(t, refInputsWithPhase(PhaseCut), ActivityLight)
	bulk := suggest(t, refInputsWithPhase(PhaseLeanBulk), ActivityLight)
	if !(cut.Basis.ProteinGPerKG > bulk.Basis.ProteinGPerKG) {
		t.Fatalf("cut %g g/kg is not above lean bulk %g g/kg", cut.Basis.ProteinGPerKG, bulk.Basis.ProteinGPerKG)
	}
	if cut.ProteinG <= 0 {
		t.Fatal("no protein target")
	}
}

// The rounding is coarse and therefore kcal will NOT equal 4P+4C+9F. That is
// intended and stated in the contract; this test records the size of the gap so
// nobody "fixes" it by recomputing kcal from the macros and discarding a clamp.
func TestKcalIsAuthoritativeAndTheAtwaterSumOnlyApproximatesIt(t *testing.T) {
	got := suggest(t, refInputsWithPhase(PhaseCut), ActivityLight)
	sum := got.ProteinG*4 + got.CarbG*4 + got.FatG*9
	if diff := math.Abs(float64(sum - got.Kcal)); diff > 60 {
		t.Fatalf("macros sum to %d against a %d kcal target (%.0f apart) — too far to be rounding",
			sum, got.Kcal, diff)
	}
}

// An unknown phase kind must hold weight, not cut. A vocabulary the server
// gains before this build knows it is a real deployment state, and
// under-feeding on it would be the worse failure.
func TestAnUnknownPhaseKindHoldsWeight(t *testing.T) {
	in := refInputs()
	in.PhaseKind = PhaseKind("peak_week")
	got := suggest(t, in, ActivityLight)
	if got.Basis.EnergyDeltaKcal != 0 {
		t.Fatalf("unknown phase moved the target by %+d kcal", got.Basis.EnergyDeltaKcal)
	}
}

// The bands are a mirror of anthropometry.ts. check-rate-parity.py compares the
// two files; this asserts the shape the script relies on, so a refactor that
// renames or restructures them fails in Go too rather than only in Python.
func TestRateBandsAreSaneMagnitudes(t *testing.T) {
	for kind, band := range RateTargets {
		if band == nil {
			continue
		}
		if band.Min > band.Max {
			t.Errorf("%s: min %g above max %g", kind, band.Min, band.Max)
		}
		if band.Max > 0.02 {
			t.Errorf("%s: max %g is stored as a percentage, not a fraction", kind, band.Max)
		}
	}
	if RateTargets[PhaseMakingWeight] != nil {
		t.Error("making_weight must have no band — its rate comes from the deadline")
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
