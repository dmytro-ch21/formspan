package nutrition

import "testing"

// "Does this look right?" (N69) — the third section `nutrition-design.md` §5
// asked for, and the one that existed nowhere.
//
// The arithmetic is small and the ways it goes quietly wrong are not: a sign
// error produces a date in the past rather than an error, a zero rate divides
// to infinity, and a missing goal weight would otherwise render as an all-clear.
// Each of those is a case below.

func fp(v float64) *float64 { return &v }
func sp(v string) *string   { return &v }

// A cut: 90 kg now, 82 kg goal, 0.75%/week ≈ 0.675 kg/week.
func cutInputs(goal float64, deadline *string) Inputs {
	return Inputs{
		On:                  "2026-01-01",
		PhaseKind:           PhaseCut,
		PhaseTargetWeightKG: &goal,
		PhaseTargetOn:       deadline,
	}
}

func TestProjectionSaysWhenAGoalArrives(t *testing.T) {
	// 8 kg to lose at 0.675 kg/week is 11.85 weeks — about 83 days.
	p := project(cutInputs(82, nil), 90, -0.675)
	if p == nil {
		t.Fatal("no projection for a phase that has a goal weight")
	}
	if p.KGToGo != 8 {
		t.Errorf("kg to go %v, want 8", p.KGToGo)
	}
	if p.WeeksToGo < 11.8 || p.WeeksToGo > 11.9 {
		t.Errorf("weeks %v, want about 11.85", p.WeeksToGo)
	}
	if p.ReachedOn != "2026-03-25" {
		t.Errorf("reached on %q, want 2026-03-25", p.ReachedOn)
	}
	// No deadline set: nil, NOT false. "No deadline" and "misses the deadline"
	// must not render alike.
	if p.MeetsDeadline != nil {
		t.Errorf("meets_deadline is %v with no deadline set — absent is the only honest answer", *p.MeetsDeadline)
	}
	if p.Already || p.Unreachable {
		t.Errorf("flagged already/unreachable on an ordinary plan: %+v", p)
	}
}

func TestProjectionMeetsAComfortableDeadline(t *testing.T) {
	// Arrives 25 March; deadline 1 June.
	p := project(cutInputs(82, sp("2026-06-01")), 90, -0.675)
	if p.MeetsDeadline == nil || !*p.MeetsDeadline {
		t.Fatalf("should meet a deadline two months after arrival: %+v", p)
	}
	if p.DaysLate != 0 || p.ShortfallKG != 0 {
		t.Errorf("reported lateness on a plan that arrives early: %+v", p)
	}
}

// THE case §5 exists for: a goal that cannot be reached in time.
func TestProjectionCatchesAnImpossibleDeadline(t *testing.T) {
	// 8 kg at 0.675/week needs ~12 weeks. The deadline is 4 weeks out.
	p := project(cutInputs(82, sp("2026-01-29")), 90, -0.675)
	if p.MeetsDeadline == nil {
		t.Fatal("no verdict on a deadline that was set")
	}
	if *p.MeetsDeadline {
		t.Fatalf("said a 4-week deadline is met by a 12-week plan: %+v", p)
	}
	if p.DaysLate <= 0 {
		t.Errorf("days late %d, want positive", p.DaysLate)
	}
	// 28 days at 0.675/week moves ~2.7 kg, leaving ~5.3 of the 8.
	if p.ShortfallKG < 5 || p.ShortfallKG > 5.5 {
		t.Errorf("shortfall %v kg, want about 5.3 — this is the number that says "+
			"HOW WRONG the plan is, where the date says only that it is wrong", p.ShortfallKG)
	}
}

// Two settings that each look fine on their own screen and contradict.
func TestProjectionCatchesAPlanPointingTheWrongWay(t *testing.T) {
	// A BULK (positive rate) with a goal weight BELOW current.
	in := Inputs{On: "2026-01-01", PhaseKind: PhaseLeanBulk, PhaseTargetWeightKG: fp(82)}
	p := project(in, 90, +0.3)
	if p == nil || !p.Unreachable {
		t.Fatalf("a bulk toward a lower goal weight is not reachable: %+v", p)
	}
	if p.UnreachableReason == "" {
		t.Error("no reason given — 'unreachable' alone tells the athlete nothing to fix")
	}
	// It must NOT have invented a date. A negative week count would render as a
	// day in the past, which reads as an answer rather than a contradiction.
	if p.ReachedOn != "" {
		t.Errorf("invented an arrival date %q for an unreachable plan", p.ReachedOn)
	}
}

func TestProjectionSaysNothingWithoutAGoalWeight(t *testing.T) {
	// Nil, not an all-clear: "we did not check" and "it checks out" are
	// different answers and only one of them is reassuring.
	if p := project(Inputs{On: "2026-01-01", PhaseKind: PhaseCut}, 90, -0.675); p != nil {
		t.Fatalf("projected without a goal weight: %+v", p)
	}
}

func TestProjectionOnAHoldingPhaseIsUnreachableNotWrong(t *testing.T) {
	in := Inputs{On: "2026-01-01", PhaseKind: PhaseMaintenance, PhaseTargetWeightKG: fp(82)}
	p := project(in, 90, 0)
	if p == nil || !p.Unreachable {
		t.Fatalf("a zero rate never arrives: %+v", p)
	}
	// Specifically not a division by zero rendering as Infinity weeks.
	if p.WeeksToGo != 0 || p.ReachedOn != "" {
		t.Errorf("a zero rate produced %v weeks and %q", p.WeeksToGo, p.ReachedOn)
	}
}

func TestProjectionTreatsArrivalAsArrived(t *testing.T) {
	// Within a tenth of a kilo. Demanding exactness leaves somebody "0.02 kg
	// away" forever, because a scale does not resolve better than that.
	p := project(cutInputs(82, nil), 82.05, -0.675)
	if p == nil || !p.Already {
		t.Fatalf("90 g from the goal is arrived: %+v", p)
	}
	if p.ReachedOn != "" {
		t.Errorf("projected a future arrival for a goal already met: %q", p.ReachedOn)
	}
}

// A deadline already past must not produce a negative span or a date behind us.
func TestProjectionHandlesADeadlineInThePast(t *testing.T) {
	p := project(cutInputs(82, sp("2025-12-01")), 90, -0.675)
	if p.MeetsDeadline == nil || *p.MeetsDeadline {
		t.Fatalf("a past deadline cannot be met: %+v", p)
	}
	if p.ShortfallKG != 8 {
		t.Errorf("shortfall %v, want the whole 8 kg — no time remains to move any of it", p.ShortfallKG)
	}
}
