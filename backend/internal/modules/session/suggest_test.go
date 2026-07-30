package session

import (
	"context"
	"testing"
	"time"
)

// The progression rule decides what an athlete loads next, so every branch is
// pinned here. These are pure-function tests — no database, no skip.

func perf(mod func(*Performance)) *Performance {
	p := &Performance{
		ExerciseID:      exSquat,
		PerformedAt:     time.Now().UTC().Add(-3 * 24 * time.Hour),
		Reps:            ptrInt(5),
		WeightKg:        ptrF(100),
		MovementPattern: "squat",
		LoadType:        "weight_reps",
	}
	if mod != nil {
		mod(p)
	}
	return p
}

func TestSuggest_NoHistoryMakesNoClaim(t *testing.T) {
	s := Suggest(nil, time.Now().UTC())
	if s.Code != SuggestNoHistory {
		t.Fatalf("want no_history, got %s", s.Code)
	}
	if s.SuggestedWeightKg != nil {
		t.Errorf("suggested a weight with nothing to base it on: %v", *s.SuggestedWeightKg)
	}
}

func TestSuggest_IncreasesWhenRepsWereLeftInReserve(t *testing.T) {
	s := Suggest(perf(func(p *Performance) { p.RIR = ptrInt(3) }), time.Now().UTC())
	if s.Code != SuggestIncrease {
		t.Fatalf("want increase, got %s (%s)", s.Code, s.Reason)
	}
	if s.SuggestedWeightKg == nil || *s.SuggestedWeightKg != 105 {
		t.Errorf("squat should go up 5kg: %v", s.SuggestedWeightKg)
	}
	// The reason must name the evidence, not just assert a conclusion.
	if !contains(s.Reason, "3 reps") {
		t.Errorf("reason doesn't cite the RIR: %q", s.Reason)
	}
	// The reason must stay unit-free — the client renders the target weight
	// in the athlete's own units, and "kg" here would leak metric into a
	// pounds interface.
	if contains(s.Reason, "kg") || contains(s.Reason, "lb") {
		t.Errorf("reason hardcodes a unit: %q", s.Reason)
	}
}

func TestSuggest_IncrementScalesWithTheMovement(t *testing.T) {
	for _, tc := range []struct {
		pattern string
		want    float64
	}{
		{"squat", 105},
		{"hinge", 105},
		{"olympic", 105},
		{"horizontal_push", 102.5},
		{"vertical_pull", 102.5},
		{"lunge", 102.5},
		{"isolation", 101.25},
		{"rotation", 101.25},
		{"something_unmapped", 101.25},
	} {
		s := Suggest(perf(func(p *Performance) {
			p.RIR = ptrInt(2)
			p.MovementPattern = tc.pattern
		}), time.Now().UTC())
		if s.SuggestedWeightKg == nil || *s.SuggestedWeightKg != tc.want {
			t.Errorf("%s: want %v, got %v", tc.pattern, tc.want, s.SuggestedWeightKg)
		}
	}
}

func TestSuggest_HoldsAtOrNearFailure(t *testing.T) {
	for _, p := range []*Performance{
		perf(func(p *Performance) { p.RIR = ptrInt(0) }),
		perf(func(p *Performance) { p.RPE = ptrF(10) }),
		perf(func(p *Performance) { p.RPE = ptrF(9.5) }),
	} {
		s := Suggest(p, time.Now().UTC())
		if s.Code != SuggestRepeatHard {
			t.Errorf("want repeat_hard, got %s (%s)", s.Code, s.Reason)
		}
		if s.SuggestedWeightKg == nil || *s.SuggestedWeightKg != 100 {
			t.Errorf("should repeat the same weight, got %v", s.SuggestedWeightKg)
		}
	}
}

// One rep in reserve is real work but not room — the case that would be
// wrong in both directions if it were lumped in with either neighbour.
func TestSuggest_OneRepInReserveConsolidates(t *testing.T) {
	s := Suggest(perf(func(p *Performance) { p.RIR = ptrInt(1) }), time.Now().UTC())
	if s.Code != SuggestRepeatConsolidate {
		t.Fatalf("want repeat_consolidate, got %s", s.Code)
	}
	if *s.SuggestedWeightKg != 100 {
		t.Errorf("should repeat, got %v", *s.SuggestedWeightKg)
	}
}

func TestSuggest_RefusesToGuessWhenEffortWasNeverRecorded(t *testing.T) {
	s := Suggest(perf(nil), time.Now().UTC())
	if s.Code != SuggestRepeatUnknownEffort {
		t.Fatalf("want repeat_unknown_effort, got %s", s.Code)
	}
	if *s.SuggestedWeightKg != 100 {
		t.Errorf("should repeat rather than guess, got %v", *s.SuggestedWeightKg)
	}
}

// Staleness outranks effort: a four-month-old easy set is evidence about
// someone who no longer exists.
func TestSuggest_StalenessOutranksEffort(t *testing.T) {
	s := Suggest(perf(func(p *Performance) {
		p.RIR = ptrInt(4)
		p.PerformedAt = time.Now().UTC().Add(-120 * 24 * time.Hour)
	}), time.Now().UTC())
	if s.Code != SuggestRepeatStale {
		t.Fatalf("want repeat_stale, got %s (%s)", s.Code, s.Reason)
	}
	if *s.SuggestedWeightKg != 100 {
		t.Errorf("should repeat, got %v", *s.SuggestedWeightKg)
	}
}

// The boundary itself: 28 days is still fresh, a day past it is not.
func TestSuggest_StalenessBoundary(t *testing.T) {
	now := time.Now().UTC()
	fresh := Suggest(perf(func(p *Performance) {
		p.RIR = ptrInt(3)
		p.PerformedAt = now.Add(-27 * 24 * time.Hour)
	}), now)
	if fresh.Code != SuggestIncrease {
		t.Errorf("27 days should still be fresh, got %s", fresh.Code)
	}
	stale := Suggest(perf(func(p *Performance) {
		p.RIR = ptrInt(3)
		p.PerformedAt = now.Add(-29 * 24 * time.Hour)
	}), now)
	if stale.Code != SuggestRepeatStale {
		t.Errorf("29 days should be stale, got %s", stale.Code)
	}
}

func TestSuggest_SaysNothingAboutUnweightedWork(t *testing.T) {
	for _, p := range []*Performance{
		perf(func(p *Performance) { p.LoadType = "time"; p.WeightKg = nil; p.RIR = ptrInt(3) }),
		perf(func(p *Performance) { p.LoadType = "distance_time"; p.WeightKg = nil }),
		// weight_reps but nothing recorded — still nothing to add to.
		perf(func(p *Performance) { p.WeightKg = nil; p.RIR = ptrInt(3) }),
	} {
		s := Suggest(p, time.Now().UTC())
		if s.Code != SuggestNotApplicable {
			t.Errorf("want not_applicable for %s, got %s", p.LoadType, s.Code)
		}
		if s.SuggestedWeightKg != nil {
			t.Errorf("suggested a weight for unweighted work: %v", *s.SuggestedWeightKg)
		}
	}
}

// The evidence travels with every suggestion, so the athlete can check the
// reasoning rather than take it on trust.
func TestSuggest_AlwaysCarriesTheEvidence(t *testing.T) {
	s := Suggest(perf(func(p *Performance) { p.RIR = ptrInt(2); p.RPE = ptrF(8) }), time.Now().UTC())
	if s.LastWeightKg == nil || *s.LastWeightKg != 100 {
		t.Errorf("last weight missing: %v", s.LastWeightKg)
	}
	if s.LastReps == nil || *s.LastReps != 5 {
		t.Errorf("last reps missing: %v", s.LastReps)
	}
	if s.LastRIR == nil || s.LastRPE == nil || s.LastPerformedAt == nil {
		t.Errorf("effort or date missing from the evidence")
	}
}

// --- the lookup behind it -------------------------------------------------

func TestLastPerformances_TakesTheTopWorkingSetOfTheLatestSession(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-hist-old")
	cleanup(t, pool, "ses-hist-new")

	old := strengthSession("ses-hist-old", "user_hist", []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(90), RIR: ptrInt(1), Completed: true},
	})
	old.StartedAt = time.Now().UTC().Add(-10 * 24 * time.Hour)
	if _, err := repo.Create(ctx, old); err != nil {
		t.Fatalf("create old: %v", err)
	}

	recent := strengthSession("ses-hist-new", "user_hist", []Set{
		// A heavier warm-up than the working sets, to prove warm-ups are
		// excluded rather than merely deprioritised.
		{ExerciseID: exSquat, SetType: SetTypeWarmup, Reps: ptrInt(3), WeightKg: ptrF(200), Completed: true},
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RIR: ptrInt(2), Completed: true},
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(3), WeightKg: ptrF(110), RIR: ptrInt(0), Completed: true},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(8), WeightKg: ptrF(60), RPE: ptrF(7), Completed: true},
	})
	recent.StartedAt = time.Now().UTC().Add(-2 * 24 * time.Hour)
	if _, err := repo.Create(ctx, recent); err != nil {
		t.Fatalf("create recent: %v", err)
	}

	got, err := repo.LastPerformances(ctx, "user_hist", []string{exSquat, exBench, "no-such-exercise"})
	if err != nil {
		t.Fatalf("last performances: %v", err)
	}

	sq, ok := got[exSquat]
	if !ok {
		t.Fatal("no squat history returned")
	}
	if sq.WeightKg == nil || *sq.WeightKg != 110 {
		t.Errorf("want the heaviest working set (110), got %v", sq.WeightKg)
	}
	if sq.RIR == nil || *sq.RIR != 0 {
		t.Errorf("effort should come from the same set: %v", sq.RIR)
	}
	if sq.MovementPattern == "" || sq.LoadType == "" {
		t.Errorf("catalog fields not joined: %+v", sq)
	}

	bp, ok := got[exBench]
	if !ok || bp.WeightKg == nil || *bp.WeightKg != 60 {
		t.Errorf("bench history wrong: %+v", bp)
	}
	if _, ok := got["no-such-exercise"]; ok {
		t.Error("returned history for an exercise with none")
	}

	// And the whole point: 110kg at RIR 0 must not become a recommendation
	// to add weight.
	s := Suggest(&sq, time.Now().UTC())
	if s.Code != SuggestRepeatHard {
		t.Errorf("want repeat_hard off a RIR-0 top set, got %s", s.Code)
	}
}

// Found against real data: two sessions in, the newest contained the exercise
// with nothing logged against it — added to the session but never performed.
// That row is not evidence, and letting it win erased a real 102.5kg set
// behind it and reported "not measured in weight".
func TestLastPerformances_IgnoresSetsWithNothingRecorded(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-real-perf")
	cleanup(t, pool, "ses-empty-perf")

	real := strengthSession("ses-real-perf", "user_empty", []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(102.5), RIR: ptrInt(2), Completed: true},
	})
	real.StartedAt = time.Now().UTC().Add(-5 * 24 * time.Hour)
	if _, err := repo.Create(ctx, real); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Newer, but the squat row carries no measures at all.
	empty := strengthSession("ses-empty-perf", "user_empty", []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Completed: true},
	})
	empty.StartedAt = time.Now().UTC().Add(-1 * time.Hour)
	if _, err := repo.Create(ctx, empty); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.LastPerformances(ctx, "user_empty", []string{exSquat})
	if err != nil {
		t.Fatalf("last performances: %v", err)
	}
	p, ok := got[exSquat]
	if !ok {
		t.Fatal("an unlogged set erased the real history behind it")
	}
	if p.WeightKg == nil || *p.WeightKg != 102.5 {
		t.Fatalf("want the last real performance (102.5), got %v", p.WeightKg)
	}
	if s := Suggest(&p, time.Now().UTC()); s.Code != SuggestIncrease {
		t.Errorf("want increase off 2 RIR, got %s (%s)", s.Code, s.Reason)
	}
}

// History is per-user, and this is the query that would leak it.
func TestLastPerformances_IsUserScoped(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-hist-theirs")

	theirs := strengthSession("ses-hist-theirs", "user_hist_other", []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(300), RIR: ptrInt(5), Completed: true},
	})
	if _, err := repo.Create(ctx, theirs); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.LastPerformances(ctx, "user_hist_nobody", []string{exSquat})
	if err != nil {
		t.Fatalf("last performances: %v", err)
	}
	if _, ok := got[exSquat]; ok {
		t.Fatal("returned another user's training history")
	}
}

// The header must climb as the session is performed, not start at the
// plan's total. A template opens with every set present and none completed,
// so an uncompleted set has to contribute nothing at all.
func TestSummarise_CountsOnlyCompletedSets(t *testing.T) {
	planned := []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100)},
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100)},
	}

	// Nothing lifted yet: the exercise is on the card, the volume is zero.
	v := Summarise(planned)
	if v.WorkingSets != 0 || v.TotalReps != 0 || v.TonnageKg != 0 {
		t.Fatalf("a planned-but-unperformed session already has volume: %+v", v)
	}
	if len(v.ExerciseIDs) != 1 {
		t.Errorf("the exercise should still be listed: %+v", v.ExerciseIDs)
	}

	// One set done: half the plan's numbers.
	planned[0].Completed = true
	v = Summarise(planned)
	if v.WorkingSets != 1 || v.TotalReps != 5 || v.TonnageKg != 500 {
		t.Fatalf("after one completed set: %+v", v)
	}

	planned[1].Completed = true
	v = Summarise(planned)
	if v.WorkingSets != 2 || v.TotalReps != 10 || v.TonnageKg != 1000 {
		t.Fatalf("after both: %+v", v)
	}
}

// Effort from a set that was never performed must not drive the next
// session's recommendation either.
func TestSummarise_IgnoresEffortOnUncompletedSets(t *testing.T) {
	v := Summarise([]Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), RPE: ptrF(10)},
	})
	if v.HardestRPE != 0 {
		t.Fatalf("an unperformed set set the hardest RPE: %v", v.HardestRPE)
	}
}
