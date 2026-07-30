package session

import (
	"testing"
	"time"
)

// set builds a completed working set. Effort is optional: pass nil for both to
// model a lifter who logged reps and weight and nothing else.
func set(reps int, kg float64, rir *int, rpe *float64) Set {
	return Set{
		ExerciseID: "bench-press",
		SetType:    SetTypeWorking,
		Completed:  true,
		Reps:       &reps,
		WeightKg:   &kg,
		RIR:        rir,
		RPE:        rpe,
	}
}

func sess(ago time.Duration, now time.Time, sets ...Set) SessionEffort {
	return SessionEffort{
		SessionID:   "s",
		PerformedAt: now.Add(-ago),
		Sets:        sets,
	}
}

func progIn(goal string, recent ...SessionEffort) ProgressionInput {
	return ProgressionInput{
		ExerciseID:      "bench-press",
		LoadType:        "weight_reps",
		MovementPattern: "horizontal_push",
		Goal:            goal,
		Recent:          recent,
	}
}

var testNow = time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)

// The core of double progression: reps move first, and load only moves once
// the top of the range is reached. Getting this backwards — moving load on any
// good set — is precisely what the previous rule did.
func TestProgress_RepsBeforeLoad(t *testing.T) {
	day := 24 * time.Hour

	// Hypertrophy range is 6–10. Six reps at 2 RIR: room, but the range isn't
	// finished, so the reps move and the bar doesn't.
	p := Progress(progIn("hypertrophy",
		sess(2*day, testNow, set(6, 80, ptrInt(2), nil), set(6, 80, ptrInt(2), nil)),
	), testNow)

	if p.Code != ProgressAddReps {
		t.Fatalf("6 reps at 2 RIR in a 6-10 range: got %q, want %q", p.Code, ProgressAddReps)
	}
	if *p.TargetWeightKg != 80 {
		t.Errorf("weight should hold at 80, got %v", *p.TargetWeightKg)
	}
	if *p.TargetReps != 7 {
		t.Errorf("reps should step to 7, got %v", *p.TargetReps)
	}

	// Same lift at the top of the range: testNow load moves and reps reset.
	p = Progress(progIn("hypertrophy",
		sess(2*day, testNow, set(10, 80, ptrInt(2), nil), set(10, 80, ptrInt(2), nil)),
	), testNow)

	if p.Code != ProgressAddLoad {
		t.Fatalf("10 reps at 2 RIR at the top of the range: got %q, want %q", p.Code, ProgressAddLoad)
	}
	if *p.TargetWeightKg != 82.5 {
		t.Errorf("horizontal_push adds 2.5 to 80, want 82.5, got %v", *p.TargetWeightKg)
	}
	if *p.TargetReps != 6 {
		t.Errorf("reps should reset to the bottom of the range (6), got %v", *p.TargetReps)
	}
}

// The gate is the *worst* set, not the best one. A session that opens with 10
// and collapses to 6 is not a 10-rep session, and the old top-set-only rule
// would have added weight to it.
func TestProgress_WeakestSetGatesLoad(t *testing.T) {
	p := Progress(progIn("hypertrophy",
		sess(48*time.Hour, testNow,
			set(10, 80, ptrInt(3), nil),
			set(8, 80, ptrInt(2), nil),
			set(6, 80, ptrInt(2), nil),
		),
	), testNow)

	if p.Code == ProgressAddLoad {
		t.Fatalf("a session falling 10→6 must not earn a load increase, got %q", p.Code)
	}
	if p.Code != ProgressAddReps {
		t.Fatalf("got %q, want %q", p.Code, ProgressAddReps)
	}
	// It builds from the weakest set, so the whole session comes up together.
	if *p.TargetReps != 7 {
		t.Errorf("should build from the weakest set (6→7), got %v", *p.TargetReps)
	}
	if p.LastMinReps == nil || *p.LastMinReps != 6 || *p.LastMaxReps != 10 {
		t.Errorf("evidence should report the full spread 6–10, got %v–%v", *p.LastMinReps, *p.LastMaxReps)
	}
}

// The top-set evidence has to describe one real set. Pairing the top set's
// weight with the session's best rep count invents a set that never happened,
// and everything derived from it — the 1RM estimate above all — inherits the
// fiction. Caught while wiring the handler, which did exactly that.
func TestProgress_TopSetEvidenceIsOneRealSet(t *testing.T) {
	// A back-off set carries the most reps; the top set is heavier and shorter.
	p := Progress(progIn("hypertrophy",
		sess(48*time.Hour, testNow,
			set(10, 80, ptrInt(2), nil),
			set(5, 100, ptrInt(1), nil),
		),
	), testNow)

	if *p.LastWeightKg != 100 {
		t.Fatalf("top set is the heaviest (100), got %v", *p.LastWeightKg)
	}
	if p.LastReps == nil || *p.LastReps != 5 {
		t.Errorf("last_reps must be the top set's own 5, not the session's best 10, got %v", p.LastReps)
	}
	if *p.LastRIR != 1 {
		t.Errorf("effort must come from the top set (1 RIR), got %v", *p.LastRIR)
	}
	// The spread is a separate, session-level fact and still reports both ends.
	if *p.LastMinReps != 5 || *p.LastMaxReps != 10 {
		t.Errorf("spread should be 5–10, got %v–%v", *p.LastMinReps, *p.LastMaxReps)
	}
}

// Effort gates progression independently of reps: hitting the range by
// grinding is not the same lift as hitting it with reserve.
func TestProgress_EffortGatesLoad(t *testing.T) {
	// Top of the range, but the last set went to failure.
	p := Progress(progIn("hypertrophy",
		sess(48*time.Hour, testNow,
			set(10, 80, ptrInt(2), nil),
			set(10, 80, ptrInt(0), nil),
		),
	), testNow)

	if p.Code != SuggestRepeatHard {
		t.Fatalf("top of range but taken to failure: got %q, want %q", p.Code, SuggestRepeatHard)
	}
	if *p.TargetWeightKg != 80 {
		t.Errorf("weight must hold after a failure set, got %v", *p.TargetWeightKg)
	}

	// RPE 10 is the same statement expressed the other way round.
	p = Progress(progIn("hypertrophy",
		sess(48*time.Hour, testNow, set(10, 80, nil, ptrF(10))),
	), testNow)
	if p.Code != SuggestRepeatHard {
		t.Errorf("RPE 10 should read as failure: got %q", p.Code)
	}

	// The subtler case, and the one that separates this from a rep counter:
	// 1 RIR is not failure, so nothing above catches it, but it's below the
	// target reserve. Reaching the top of the range that way means the range
	// was reached by grinding — the reps are banked, the load is not.
	p = Progress(progIn("hypertrophy",
		sess(48*time.Hour, testNow, set(10, 80, ptrInt(1), nil), set(10, 80, ptrInt(1), nil)),
	), testNow)
	if p.Code == ProgressAddLoad {
		t.Fatalf("top of range at 1 RIR is short of the target reserve — must not add load")
	}
	if p.Code != ProgressHold {
		t.Errorf("got %q, want %q", p.Code, ProgressHold)
	}
	if *p.TargetWeightKg != 80 {
		t.Errorf("weight should hold at 80, got %v", *p.TargetWeightKg)
	}
}

// No effort logged means no evidence of room — the honest answer is to repeat
// and ask for the missing datum, never to guess upward.
func TestProgress_UnknownEffortNeverAddsLoad(t *testing.T) {
	p := Progress(progIn("hypertrophy",
		sess(48*time.Hour, testNow, set(10, 80, nil, nil), set(10, 80, nil, nil)),
	), testNow)

	if p.Code != SuggestRepeatUnknownEffort {
		t.Fatalf("10s at the top of the range with no effort logged: got %q, want %q",
			p.Code, SuggestRepeatUnknownEffort)
	}
	if *p.TargetWeightKg != 80 {
		t.Errorf("must not add weight on an unknown effort, got %v", *p.TargetWeightKg)
	}
}

// Three sessions at one load without gaining a rep is a plateau. The old rule
// had no answer to this and would have said "repeat" indefinitely.
func TestProgress_StallTriggersDeload(t *testing.T) {
	day := 24 * time.Hour
	stuck := func(ago time.Duration) SessionEffort {
		return sess(ago, testNow, set(7, 100, ptrInt(1), nil), set(7, 100, ptrInt(1), nil))
	}

	p := Progress(progIn("hypertrophy", stuck(2*day), stuck(5*day), stuck(9*day)), testNow)

	if p.Code != ProgressDeload {
		t.Fatalf("three sessions stuck at 100: got %q, want %q", p.Code, ProgressDeload)
	}
	if p.SessionsAtLoad != 3 {
		t.Errorf("should count 3 sessions at load, got %d", p.SessionsAtLoad)
	}
	// 10% off 100 is 90, and it must land on something loadable.
	if *p.TargetWeightKg != 90 {
		t.Errorf("deload should drop to 90, got %v", *p.TargetWeightKg)
	}
	if *p.TargetReps != 10 {
		t.Errorf("a deload rebuilds from the top of the range, got %v", *p.TargetReps)
	}

	// Two sessions is a bad week, not a plateau.
	p = Progress(progIn("hypertrophy", stuck(2*day), stuck(5*day)), testNow)
	if p.Code == ProgressDeload {
		t.Errorf("two sessions at a load must not deload")
	}
}

// The stall count is *consecutive* sessions. A lifter who deloaded and worked
// back up to the same weight is starting a fresh attempt at it, not continuing
// a plateau — counting every historical appearance would deload them again the
// moment they returned, which is the opposite of what a deload is for.
func TestProgress_StallCountResetsAfterALoadChange(t *testing.T) {
	day := 24 * time.Hour
	at := func(ago time.Duration, kg float64) SessionEffort {
		return sess(ago, testNow, set(7, kg, ptrInt(1), nil))
	}

	// Newest first: back at 100 once, after a 90kg deload, having previously
	// been at 100 twice.
	p := Progress(progIn("hypertrophy",
		at(2*day, 100), at(5*day, 90), at(9*day, 100), at(12*day, 100),
	), testNow)

	if p.SessionsAtLoad != 1 {
		t.Errorf("only the most recent 100 is consecutive, want 1, got %d", p.SessionsAtLoad)
	}
	if p.Code == ProgressDeload {
		t.Fatalf("a lift just returned to after a deload must not deload again")
	}
}

// A lifter who is progressing has been at the load for three sessions too —
// the stall check must not fire on them.
func TestProgress_ProgressingLiftIsNotAStall(t *testing.T) {
	day := 24 * time.Hour
	top := func(ago time.Duration) SessionEffort {
		return sess(ago, testNow, set(10, 100, ptrInt(2), nil), set(10, 100, ptrInt(2), nil))
	}

	p := Progress(progIn("hypertrophy", top(2*day), top(5*day), top(9*day)), testNow)

	if p.Code != ProgressAddLoad {
		t.Fatalf("three sessions at the top of the range with reserve is progress, not a stall: got %q", p.Code)
	}
}

// A fixed increment means different things at different loads. 2.5kg on a 20kg
// lift is 12.5% — an increase nobody makes twice.
func TestProgress_IncrementScalesWithLoad(t *testing.T) {
	atTop := func(kg float64) Plan {
		return Progress(progIn("hypertrophy",
			sess(48*time.Hour, testNow, set(10, kg, ptrInt(2), nil)),
		), testNow)
	}

	// 5% of 20 is 1.0, below the smallest plate, so it floors there.
	if got := *atTop(20).TargetWeightKg; got != 21.25 {
		t.Errorf("20kg: want a 1.25 plate step to 21.25, got %v", got)
	}
	// 5% of 30 is 1.5 — the pattern's 2.5 is capped, then snapped to a plate.
	if got := *atTop(30).TargetWeightKg; got != 31.25 {
		t.Errorf("30kg: 2.5 exceeds 5%%, want 31.25, got %v", got)
	}
	// 5% of 100 is 5.0, so the pattern's own 2.5 is what applies.
	if got := *atTop(100).TargetWeightKg; got != 102.5 {
		t.Errorf("100kg: want the full 2.5 to 102.5, got %v", got)
	}
}

// The rep range is a property of the goal, not the exercise — the same squat
// is a 3-rep lift in a strength block and a 10-rep lift in a hypertrophy one.
func TestProgress_RepRangeFollowsGoal(t *testing.T) {
	cases := []struct {
		goal      string
		low, high int
	}{
		{"powerlifting", 3, 5},
		{"hypertrophy", 6, 10},
		{"endurance", 12, 20},
		{"", 5, 8},
		{"something_unmapped", 5, 8},
	}
	for _, c := range cases {
		p := Progress(progIn(c.goal, sess(48*time.Hour, testNow, set(4, 100, ptrInt(2), nil))), testNow)
		if p.RepRange.Low != c.low || p.RepRange.High != c.high {
			t.Errorf("goal %q: got %d-%d, want %d-%d",
				c.goal, p.RepRange.Low, p.RepRange.High, c.low, c.high)
		}
	}

	// 5 reps is mid-range for hypertrophy but the top of the powerlifting
	// range — the same set has to produce different advice.
	fiveAt2RIR := sess(48*time.Hour, testNow, set(5, 140, ptrInt(2), nil))
	if p := Progress(progIn("powerlifting", fiveAt2RIR), testNow); p.Code != ProgressAddLoad {
		t.Errorf("5 reps tops the powerlifting range, want add_load, got %q", p.Code)
	}
	if p := Progress(progIn("hypertrophy", fiveAt2RIR), testNow); p.Code == ProgressAddLoad {
		t.Errorf("5 reps is below the hypertrophy range, must not add load")
	}
}

// Staleness outranks effort, same ordering rule as the original Suggest: a
// four-month-old easy set is evidence about someone who no longer exists.
func TestProgress_StaleOutranksEffort(t *testing.T) {
	p := Progress(progIn("hypertrophy",
		sess(90*24*time.Hour, testNow, set(10, 80, ptrInt(3), nil)),
	), testNow)

	if p.Code != SuggestRepeatStale {
		t.Fatalf("a 90-day-old set: got %q, want %q", p.Code, SuggestRepeatStale)
	}
	if *p.TargetWeightKg != 80 {
		t.Errorf("stale should repeat the weight, got %v", *p.TargetWeightKg)
	}
}

func TestProgress_NonWeightAndEmptyHistory(t *testing.T) {
	in := progIn("hypertrophy")
	in.LoadType = "time"
	if p := Progress(in, testNow); p.Code != SuggestNotApplicable {
		t.Errorf("a timed exercise: got %q, want %q", p.Code, SuggestNotApplicable)
	}

	if p := Progress(progIn("hypertrophy"), testNow); p.Code != SuggestNoHistory {
		t.Errorf("no sessions: got %q, want %q", p.Code, SuggestNoHistory)
	}

	// Warm-ups alone are not a performance to progress from.
	warm := Set{ExerciseID: "bench-press", SetType: SetTypeWarmup, Completed: true,
		Reps: ptrInt(10), WeightKg: ptrF(40)}
	p := Progress(progIn("hypertrophy", sess(48*time.Hour, testNow, warm)), testNow)
	if p.Code != SuggestRepeatUnknownEffort {
		t.Errorf("warm-ups only: got %q, want %q", p.Code, SuggestRepeatUnknownEffort)
	}
	if p.TargetWeightKg != nil {
		t.Errorf("must not suggest a weight from a warm-up, got %v", *p.TargetWeightKg)
	}
}

// Uncompleted sets are plan, not performance. A template opened and abandoned
// must not become the basis of next session's prescription.
func TestProgress_IgnoresUncompletedSets(t *testing.T) {
	planned := set(10, 200, ptrInt(3), nil)
	planned.Completed = false

	p := Progress(progIn("hypertrophy",
		sess(48*time.Hour, testNow, set(6, 80, ptrInt(2), nil), planned),
	), testNow)

	if p.LastWeightKg == nil || *p.LastWeightKg != 80 {
		t.Fatalf("an uncompleted 200kg set must not be read as performance, got %v", p.LastWeightKg)
	}
	if p.WorkingSets != 1 {
		t.Errorf("should count 1 working set, got %d", p.WorkingSets)
	}
}

// Every branch has to produce something a client can render. A nil target or
// an empty reason is a silent hole in the UI.
func TestProgress_EveryOutcomeIsRenderable(t *testing.T) {
	day := 24 * time.Hour
	stuck := sess(2*day, testNow, set(7, 100, ptrInt(1), nil))
	cases := map[string]ProgressionInput{
		"no_history": progIn("hypertrophy"),
		"stale":      progIn("hypertrophy", sess(90*day, testNow, set(5, 80, ptrInt(2), nil))),
		"unknown":    progIn("hypertrophy", sess(2*day, testNow, set(5, 80, nil, nil))),
		"failure":    progIn("hypertrophy", sess(2*day, testNow, set(5, 80, ptrInt(0), nil))),
		"add_reps":   progIn("hypertrophy", sess(2*day, testNow, set(6, 80, ptrInt(2), nil))),
		"add_load":   progIn("hypertrophy", sess(2*day, testNow, set(10, 80, ptrInt(2), nil))),
		"hold":       progIn("hypertrophy", sess(2*day, testNow, set(8, 80, ptrInt(1), nil))),
		"deload":     progIn("hypertrophy", stuck, sess(5*day, testNow, set(7, 100, ptrInt(1), nil)), sess(9*day, testNow, set(7, 100, ptrInt(1), nil))),
	}

	for name, in := range cases {
		p := Progress(in, testNow)
		if p.Code == "" {
			t.Errorf("%s: empty code", name)
		}
		if p.Reason == "" {
			t.Errorf("%s: empty reason", name)
		}
		if p.RepRange.Low <= 0 || p.RepRange.High < p.RepRange.Low {
			t.Errorf("%s: nonsensical rep range %d-%d", name, p.RepRange.Low, p.RepRange.High)
		}
		// Anything with history has to name both a weight and a rep target,
		// or the client has half a prescription to render.
		if name != "no_history" {
			if p.TargetWeightKg == nil {
				t.Errorf("%s: nil target weight", name)
			}
			if p.TargetReps == nil {
				t.Errorf("%s: nil target reps", name)
			} else if *p.TargetReps <= 0 {
				t.Errorf("%s: non-positive target reps %d", name, *p.TargetReps)
			}
		}
	}
}

// Weight suggestions must land on plates that exist. 63.7kg is arithmetic.
func TestRoundToPlate(t *testing.T) {
	cases := []struct{ in, want float64 }{
		{63.7, 63.75}, {100, 100}, {82.4, 82.5}, {21.1, 21.25}, {90.0, 90},
	}
	for _, c := range cases {
		if got := roundToPlate(c.in); got != c.want {
			t.Errorf("roundToPlate(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

// An athlete who does exactly what the app says must never see the prescribed
// load go backwards. This is the whole promise of a progression rule.
func TestProgress_ObedientLifterNeverRegresses(t *testing.T) {
	day := 24 * time.Hour
	history := []SessionEffort{}
	weight, reps := 100.0, 6
	lowest := weight

	for n := 0; n < 8; n++ {
		// Perform exactly what was prescribed, at the target reserve.
		history = append([]SessionEffort{{
			SessionID:   "s" + itoa(n),
			PerformedAt: testNow.Add(-time.Duration(8-n) * day),
			Sets: []Set{
				set(reps, weight, ptrInt(2), nil),
				set(reps, weight, ptrInt(2), nil),
				set(reps, weight, ptrInt(2), nil),
			},
		}}, history...)

		p := Progress(progIn("hypertrophy", history...), testNow)
		t.Logf("session %d: did %.2f x %d -> %-9s next %.2f x %d",
			n+1, weight, reps, p.Code, *p.TargetWeightKg, *p.TargetReps)

		if *p.TargetWeightKg < lowest {
			t.Errorf("session %d: prescribed load fell from %.2f to %.2f after a session "+
				"that gained a rep — %s (%s)", n+1, lowest, *p.TargetWeightKg, p.Code, p.Reason)
		}
		if *p.TargetWeightKg > lowest {
			lowest = *p.TargetWeightKg
		}
		weight, reps = *p.TargetWeightKg, *p.TargetReps
	}
}

// The input the *handler* builds, not the one a fixture builds.
//
// Every other test here calls progIn, which hardcodes LoadType — an input the
// handler could never produce for an exercise with no history. That gap hid a
// real bug: RecentEfforts only knew an exercise's load type from a set row, so
// a never-logged exercise arrived with LoadType "" and the not_applicable
// guard fired before the no_history one. Every exercise in a new user's first
// session was told it wasn't measured in weight, and no_history's carefully
// written first-timer text was dead code.
func TestProgress_NoHistoryReachesTheFirstTimerBranch(t *testing.T) {
	// Exactly what handler.go does: index a map that has no such key, then
	// fill in the id and goal.
	efforts := map[string]ProgressionInput{}
	in := efforts["back-squat"]
	in.ExerciseID, in.Goal = "back-squat", "hypertrophy"
	// The catalog fields the query now supplies for every requested id.
	in.LoadType, in.MovementPattern = "weight_reps", "squat"

	p := Progress(in, testNow)
	if p.Code != SuggestNoHistory {
		t.Fatalf("a never-logged barbell squat: got %q (%s), want %q",
			p.Code, p.Reason, SuggestNoHistory)
	}

	// And the guard it has to stay behind: a genuinely unweighted movement.
	in.LoadType = "time"
	if p := Progress(in, testNow); p.Code != SuggestNotApplicable {
		t.Errorf("a plank with no history: got %q, want %q", p.Code, SuggestNotApplicable)
	}
}

// The contract says target_reps is "always inside rep_range". Four branches
// echoed the last session's reps unclamped, so a 15-rep set logged in a
// hypertrophy block and re-read under a powerlifting goal came back as
// "3-5 range, target 15".
func TestProgress_TargetRepsStayInsideTheRange(t *testing.T) {
	day := 24 * time.Hour
	cases := map[string]ProgressionInput{
		"stale":    progIn("powerlifting", sess(90*day, testNow, set(15, 60, ptrInt(2), nil))),
		"failure":  progIn("powerlifting", sess(2*day, testNow, set(15, 60, ptrInt(0), nil))),
		"unknown":  progIn("powerlifting", sess(2*day, testNow, set(20, 40, nil, nil))),
		"hold":     progIn("", sess(2*day, testNow, set(2, 200, ptrInt(1), nil))),
		"add_reps": progIn("powerlifting", sess(2*day, testNow, set(1, 100, ptrInt(3), nil))),
	}
	for name, in := range cases {
		p := Progress(in, testNow)
		if p.TargetReps == nil {
			t.Errorf("%s: nil target reps", name)
			continue
		}
		if *p.TargetReps < p.RepRange.Low || *p.TargetReps > p.RepRange.High {
			t.Errorf("%s: target %d is outside the %d-%d range (%s)",
				name, *p.TargetReps, p.RepRange.Low, p.RepRange.High, p.Code)
		}
	}
}

// An unusable newest session must not erase real history behind it.
//
// The SQL admits a row carrying any measure; the domain needs reps *and*
// weight. A weight-only row on a weighted lift passes one filter and fails the
// other, and reading only Recent[0] threw away a perfectly good session two
// rows down — the same failure TestRecentEfforts_IgnoresSetsWithNothingRecorded
// pins one layer lower.
func TestProgress_SkipsAnUnusableSessionForARealOneBehindIt(t *testing.T) {
	day := 24 * time.Hour
	weightOnly := Set{ExerciseID: "bench-press", SetType: SetTypeWorking,
		Completed: true, WeightKg: ptrF(90)} // no reps

	p := Progress(progIn("hypertrophy",
		sess(1*day, testNow, weightOnly),
		sess(4*day, testNow, set(8, 100, ptrInt(2), nil), set(8, 100, ptrInt(2), nil)),
	), testNow)

	if p.LastWeightKg == nil || *p.LastWeightKg != 100 {
		t.Fatalf("a row with no reps must not erase the 100kg session behind it, got %v",
			p.LastWeightKg)
	}
	if p.Code != ProgressAddReps || *p.TargetReps != 9 {
		t.Errorf("should progress from the real session: got %q %v reps (%s)",
			p.Code, p.TargetReps, p.Reason)
	}
}

// sessions_at_load and hit_target_effort are part of the response, so they
// have to be true of the history on every branch that ships them — not just
// the ones that happen to compute them before returning.
func TestProgress_EvidenceIsPopulatedOnEveryBranchWithHistory(t *testing.T) {
	day := 24 * time.Hour
	at := func(ago time.Duration) SessionEffort {
		return sess(ago, testNow, set(7, 100, ptrInt(3), nil))
	}
	// Three sessions at one weight, all with reserve to spare. Stale outranks
	// everything, but the evidence underneath is unchanged by that.
	p := Progress(progIn("hypertrophy", sess(90*day, testNow, set(7, 100, ptrInt(3), nil)),
		at(93*day), at(96*day)), testNow)

	if p.Code != SuggestRepeatStale {
		t.Fatalf("setup: want %q, got %q", SuggestRepeatStale, p.Code)
	}
	if p.SessionsAtLoad != 3 {
		t.Errorf("sessions_at_load should describe the history, got %d", p.SessionsAtLoad)
	}
	if !p.HitTargetEffort {
		t.Error("hit_target_effort should be true at 3 RIR throughout")
	}
}
