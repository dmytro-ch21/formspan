package nutrition

import (
	"fmt"
	"testing"
)

// weighins builds `n` readings ending `endAgo` days before `on`, one per day,
// each at kg. Enough to satisfy or deliberately starve a half.
func weighins(on string, startAgo, n int, kg float64) []Weighin {
	out := make([]Weighin, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, Weighin{On: dayOffset(on, -(startAgo + i)), KG: kg})
	}
	return out
}

func dayOffset(on string, days int) string {
	t, err := parseDay(on)
	if err != nil {
		panic(err)
	}
	return t.AddDate(0, 0, days).Format("2006-01-02")
}

// A fortnight of evidence good enough to pass every guard, at a steady weight.
// Individual tests spoil exactly one thing, so a failure names its own cause.
func goodInputs(on string) AdjustmentInputs {
	return AdjustmentInputs{
		On:                on,
		TargetKcal:        2400,
		TargetEffectiveOn: dayOffset(on, -30),
		PhaseKind:         PhaseCut,
		DaysLogged:        12,
		RMRKcal:           1700,
		Weighins:          append(weighins(on, 0, 6, 80.0), weighins(on, 7, 6, 80.0)...),
	}
}

func has(reasons []string, want string) bool {
	for _, r := range reasons {
		if r == want {
			return true
		}
	}
	return false
}

func TestTheGuardsEachBlockOnTheirOwn(t *testing.T) {
	const on = "2026-08-19"
	for _, tc := range []struct {
		name  string
		spoil func(*AdjustmentInputs)
		want  string
	}{
		{"no target at all", func(in *AdjustmentInputs) { in.TargetKcal = 0 }, BlockedNoTarget},
		{"target set five days ago", func(in *AdjustmentInputs) {
			in.TargetEffectiveOn = dayOffset(on, -5)
		}, BlockedTooSoon},
		{"only nine days logged", func(in *AdjustmentInputs) { in.DaysLogged = 9 }, BlockedNotLogging},
		{"three weigh-ins in the recent half", func(in *AdjustmentInputs) {
			in.Weighins = append(weighins(on, 0, 3, 80), weighins(on, 7, 6, 80)...)
		}, BlockedNotWeighing},
		{"three weigh-ins in the earlier half", func(in *AdjustmentInputs) {
			in.Weighins = append(weighins(on, 0, 6, 80), weighins(on, 7, 3, 80)...)
		}, BlockedNotWeighing},
		{"no live phase", func(in *AdjustmentInputs) { in.PhaseKind = "" }, BlockedNoPhase},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := goodInputs(on)
			tc.spoil(&in)
			adj, blocked := ProposeAdjustment(in)
			if adj != nil {
				t.Fatalf("proposed %+v on evidence that should have blocked", adj)
			}
			if !has(blocked, tc.want) {
				t.Fatalf("blocked_by = %v, want it to include %q", blocked, tc.want)
			}
		})
	}
}

func TestAMissingTargetIsReportedAloneRatherThanBeside(t *testing.T) {
	// Every other guard is a statement ABOUT a target. Listing "too soon" and
	// "not logging" beside "no target" would send the client chasing three
	// fixes for one cause.
	in := goodInputs("2026-08-19")
	in.TargetKcal = 0
	in.DaysLogged = 0
	in.Weighins = nil
	in.PhaseKind = ""
	_, blocked := ProposeAdjustment(in)
	if len(blocked) != 1 || blocked[0] != BlockedNoTarget {
		t.Fatalf("blocked_by = %v, want exactly [%s]", blocked, BlockedNoTarget)
	}
}

func TestWeighingSteadilyOnACutProposesEatingLess(t *testing.T) {
	// THE SIGN, and the reason this test exists at its full length.
	//
	// A cut's target rate is NEGATIVE. An athlete holding steady at 80kg is
	// losing nothing, so they are behind target and must eat LESS. An inverted
	// sign proposes MORE food to somebody already failing to lose, with every
	// number on screen still looking plausible — the failure this file is most
	// likely to ship and least likely to notice.
	adj, blocked := ProposeAdjustment(goodInputs("2026-08-19"))
	if adj == nil {
		t.Fatalf("no proposal: %v", blocked)
	}
	if adj.DeltaKcal >= 0 {
		t.Fatalf("delta = %+d — a steady weight on a cut must REDUCE intake", adj.DeltaKcal)
	}
	if adj.ToKcal >= adj.FromKcal {
		t.Fatalf("to_kcal %d is not below from_kcal %d", adj.ToKcal, adj.FromKcal)
	}
	if adj.Basis.ObservedKGPerWeek != 0 {
		t.Errorf("observed = %v, want 0 for a steady weight", adj.Basis.ObservedKGPerWeek)
	}
	if adj.Basis.TargetKGPerWeek >= 0 {
		t.Errorf("target rate = %v, want negative on a cut", adj.Basis.TargetKGPerWeek)
	}
}

func TestLosingTooFastOnACutProposesEatingMore(t *testing.T) {
	// The mirror, which is what makes the test above mean something: a test
	// that only ever checks one direction passes against a constant.
	in := goodInputs("2026-08-19")
	in.Weighins = append(weighins("2026-08-19", 0, 6, 78.5), weighins("2026-08-19", 7, 6, 80.0)...)
	adj, blocked := ProposeAdjustment(in)
	if adj == nil {
		t.Fatalf("no proposal: %v", blocked)
	}
	if adj.DeltaKcal <= 0 {
		t.Fatalf("delta = %+d — losing 1.5kg/week on a cut must INCREASE intake", adj.DeltaKcal)
	}
}

func TestGainingTooSlowlyOnALeanBulkProposesEatingMore(t *testing.T) {
	// The other phase direction. Lean bulk's target rate is positive, so the
	// same steady weight that means "eat less" on a cut means "eat more" here —
	// which a sign error would get backwards in only one of the two.
	in := goodInputs("2026-08-19")
	in.PhaseKind = PhaseLeanBulk
	adj, blocked := ProposeAdjustment(in)
	if adj == nil {
		t.Fatalf("no proposal: %v", blocked)
	}
	if adj.DeltaKcal <= 0 {
		t.Fatalf("delta = %+d — a steady weight on a lean bulk must INCREASE intake", adj.DeltaKcal)
	}
}

func TestAWeightMovingAtTargetIsLeftAlone(t *testing.T) {
	// Inside the deadband nothing is distinguishable from noise, and proposing
	// a change there would churn the target every fortnight forever.
	in := goodInputs("2026-08-19")
	// Cut midpoint is 0.75%/week; at 80kg that is -0.6kg.
	in.Weighins = append(weighins("2026-08-19", 0, 6, 79.4), weighins("2026-08-19", 7, 6, 80.0)...)
	adj, blocked := ProposeAdjustment(in)
	if adj != nil {
		t.Fatalf("proposed %+d kcal for an athlete already on target", adj.DeltaKcal)
	}
	if !has(blocked, BlockedOnTrack) {
		t.Fatalf("blocked_by = %v, want %s", blocked, BlockedOnTrack)
	}
}

func TestOneStepIsCappedBothWays(t *testing.T) {
	// A wrong adjustment should cost a fortnight, not a phase.
	for _, tc := range []struct {
		name     string
		recentKG float64
		target   int
		wantAbs  int
	}{
		// 10% of 3000 is 300, so the flat 250 is the tighter of the two here.
		{"a large target caps at the flat 250", 80.0, 3000, MaxStepKcal},
		// 10% of 1500 is 150, well under 250, so the percentage binds instead.
		// Both rows are needed: whichever limit is looser never gets exercised,
		// so a single row passes against a rule that only ever applies one.
		{"a small target caps at 10% instead", 80.0, 1500, 150},
		// A limit that is NOT a multiple of ten: 10% of 2450 is 245. Rounding
		// to nearest would return 250 and exceed the cap this function exists
		// to impose, and every row above is a round number, so none of them can
		// tell the two roundings apart.
		{"a limit off the ten-boundary rounds down", 80.0, 2450, 240},
		// Losing too fast, so the cap binds on an INCREASE. Every row above
		// takes the decrease branch; a mutation to the increase branch survives
		// a table that never enters it.
		{"an increase is capped too", 77.0, 3000, MaxStepKcal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := goodInputs("2026-08-19")
			in.TargetKcal = tc.target
			in.RMRKcal = 0 // isolate the step cap from the floor
			in.Weighins = append(weighins("2026-08-19", 0, 6, tc.recentKG), weighins("2026-08-19", 7, 6, 80.0)...)
			adj, blocked := ProposeAdjustment(in)
			if adj == nil {
				t.Fatalf("no proposal: %v", blocked)
			}
			if got := abs(adj.DeltaKcal); got != tc.wantAbs {
				t.Fatalf("|delta| = %d, want %d (raw was %d)", got, tc.wantAbs, adj.Basis.RawDeltaKcal)
			}
			if !adj.Basis.Capped || adj.Basis.CapReason == "" {
				t.Error("a capped proposal must say so, or its arithmetic does not add up on screen")
			}
		})
	}
}

func TestTheProposalNeverGoesBelowResting(t *testing.T) {
	// The floor is the athlete's resting rate, and NOT a multiple of it.
	//
	// This first shipped as RMR*1.1, taken from the spec. `target.go` had
	// already removed that exact margin and recorded why — at 1.1 it binds on
	// the reference athlete, whose 1954 kcal target on a standard cut is one
	// any coach would sign off, because RMR 1780 puts the rail at 1958. Here
	// the consequence is worse than a noisy explanation: when this rail binds
	// it proposes RAISING intake for somebody failing to lose, and calls it
	// safety. Found by review.
	in := goodInputs("2026-08-19")
	in.TargetKcal = 1800
	in.RMRKcal = 1700
	adj, blocked := ProposeAdjustment(in)
	if adj == nil {
		t.Fatalf("no proposal: %v", blocked)
	}
	if float64(adj.ToKcal) < in.RMRKcal*minKcalOverResting {
		t.Fatalf("to_kcal = %d, below resting (%.0f)", adj.ToKcal, in.RMRKcal*minKcalOverResting)
	}
	if !adj.Basis.Capped {
		t.Error("a proposal held at the floor must report itself capped")
	}
}

func TestTheAdjustmentFloorIsTheDERIVATIONSFloor(t *testing.T) {
	// The invariant behind the test above, asserted directly rather than
	// implied by a number.
	//
	// Two files each owning a floor is how they drift, and drift here is not
	// cosmetic: a target the derivation blesses would be one the adjustment
	// immediately proposes raising, so the two halves of the same feature would
	// disagree about the same athlete on the same day. A reference athlete
	// makes it concrete — 1954 kcal against RMR 1780 is legal to derive, so it
	// must also be legal to hold.
	const referenceRMR, referenceTarget = 1780.0, 1954
	if float64(referenceTarget) < referenceRMR*minKcalOverResting {
		t.Fatalf("the derivation's own reference target %d is below its floor — the constant moved",
			referenceTarget)
	}
	in := goodInputs("2026-08-19")
	in.TargetKcal = referenceTarget
	in.RMRKcal = referenceRMR
	adj, blocked := ProposeAdjustment(in)
	if adj == nil {
		t.Fatalf("no proposal: %v", blocked)
	}
	if adj.DeltaKcal > 0 {
		t.Fatalf("delta = %+d — a steady weight on a cut must not RAISE intake; the floor is binding where the derivation would not",
			adj.DeltaKcal)
	}
}

func TestAProposalTakesEffectTomorrowNeverToday(t *testing.T) {
	// Today is mostly eaten. A target applied retroactively would move the
	// day's remaining figure under an athlete who has already acted on it.
	adj, _ := ProposeAdjustment(goodInputs("2026-08-19"))
	if adj == nil {
		t.Fatal("no proposal")
	}
	if adj.EffectiveOn != "2026-08-20" {
		t.Fatalf("effective_on = %s, want 2026-08-20", adj.EffectiveOn)
	}
}

func TestTheProposalCarriesItsWholeArithmetic(t *testing.T) {
	// The feature is a number you can argue with. Every field the explanation
	// renders has to be present, or the UI shows a verdict instead.
	adj, _ := ProposeAdjustment(goodInputs("2026-08-19"))
	if adj == nil {
		t.Fatal("no proposal")
	}
	b := adj.Basis
	if b == nil {
		t.Fatal("no basis — the proposal is a verdict without one")
	}
	for name, got := range map[string]int{
		"days_logged":            b.DaysLogged,
		"days_considered":        b.DaysConsidered,
		"days_on_current_target": b.DaysOnCurrentTarget,
		"weighins_recent":        b.WeighinsRecent,
		"weighins_earlier":       b.WeighinsEarlier,
	} {
		if got <= 0 {
			t.Errorf("basis.%s = %d, want it stated", name, got)
		}
	}
	if b.KcalPerKG != kcalPerKG {
		t.Errorf("basis.kcal_per_kg = %v, want %v", b.KcalPerKG, kcalPerKG)
	}
	if b.TrendWeightKG <= 0 || b.EarlierTrendKG <= 0 {
		t.Errorf("trend weights not stated: %v and %v", b.TrendWeightKG, b.EarlierTrendKG)
	}
	if adj.ProteinG <= 0 || adj.FatG <= 0 {
		t.Errorf("macros not recomputed for the new target: %+v", adj)
	}
}

func TestOnlyTheFortnightCounts(t *testing.T) {
	// Readings outside the window are not evidence about it, and a future-dated
	// one is not evidence about the past. Both would otherwise land in the
	// earlier half and drag the observed rate toward nothing.
	const on = "2026-08-19"
	all := append(weighins(on, 0, 6, 79.0), weighins(on, 7, 6, 80.0)...)
	all = append(all, Weighin{On: dayOffset(on, -40), KG: 95}) // ancient
	all = append(all, Weighin{On: dayOffset(on, 3), KG: 60})   // future
	recent, earlier := splitHalves(all, on)
	if len(recent) != 6 || len(earlier) != 6 {
		t.Fatalf("halves = %d recent, %d earlier — want 6 and 6", len(recent), len(earlier))
	}
	if m := mean(recent); m != 79.0 {
		t.Errorf("recent mean = %v, want 79 — a stray reading leaked in", m)
	}
	if m := mean(earlier); m != 80.0 {
		t.Errorf("earlier mean = %v, want 80 — a stray reading leaked in", m)
	}
}

func TestTheHalvesSplitAtSevenDays(t *testing.T) {
	// The boundary itself: day 6 is recent, day 7 is earlier. Off by one here
	// silently moves a reading between the two means being subtracted.
	const on = "2026-08-19"
	recent, earlier := splitHalves([]Weighin{
		{On: dayOffset(on, -6), KG: 1},
		{On: dayOffset(on, -7), KG: 2},
		{On: dayOffset(on, -13), KG: 3},
		{On: dayOffset(on, -14), KG: 4},
	}, on)
	if len(recent) != 1 || recent[0].KG != 1 {
		t.Errorf("recent = %+v, want just the day-6 reading", recent)
	}
	if len(earlier) != 2 {
		t.Errorf("earlier = %+v, want the day-7 and day-13 readings", earlier)
	}
	for _, w := range earlier {
		if w.KG == 4 {
			t.Error("the day-14 reading is outside the window and must not count")
		}
	}
}

func TestMakingWeightAlreadyMadeIsAHoldRatherThanABlock(t *testing.T) {
	// The guard this file shipped without, on purpose. `makingWeightRate`
	// returns 0 once the target weight is reached — an instruction to HOLD, not
	// an underivable rate. An earlier draft blocked on it and its own comment
	// misdescribed why, which would have refused to help exactly the athlete
	// sitting on weight before a competition.
	on := "2026-08-19"
	target := dayOffset(on, 20)
	weight := 74.0
	in := goodInputs(on)
	in.PhaseKind = PhaseMakingWeight
	in.PhaseTargetOn = &target
	in.PhaseTargetWeightKG = &weight
	// Sitting at 76 while still 2kg over: a real rate, so a real proposal.
	in.Weighins = append(weighins(on, 0, 6, 76.0), weighins(on, 7, 6, 76.0)...)
	adj, blocked := ProposeAdjustment(in)
	if adj == nil {
		t.Fatalf("no proposal for a making-weight athlete who has stalled: %v", blocked)
	}
	if adj.DeltaKcal >= 0 {
		t.Fatalf("delta = %+d — stalled with weight still to lose must reduce intake", adj.DeltaKcal)
	}
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

var _ = fmt.Sprintf
