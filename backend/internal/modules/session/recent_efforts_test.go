package session

import (
	"context"
	"testing"
	"time"
)

// RecentEfforts feeds the progression rule, so what it does and doesn't return
// decides what an athlete is told to load. The rule itself is pinned by pure
// tests in progression_test.go; these pin the query underneath it.

func TestRecentEfforts_GroupsWorkingSetsBySessionNewestFirst(t *testing.T) {
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

	got, err := repo.RecentEfforts(ctx, "user_hist", []string{exSquat, exBench, "no-such-exercise"})
	if err != nil {
		t.Fatalf("recent efforts: %v", err)
	}

	sq, ok := got[exSquat]
	if !ok {
		t.Fatal("no squat history returned")
	}
	if len(sq.Recent) != 2 {
		t.Fatalf("want both sessions, got %d", len(sq.Recent))
	}
	// Newest first — the rule reads Recent[0] as "last time".
	if sq.Recent[0].SessionID != "ses-hist-new" {
		t.Errorf("want the newest session first, got %s", sq.Recent[0].SessionID)
	}
	// Two working sets, not three: the 200kg warm-up is excluded. If it
	// leaked through, the rule would recommend a weight nobody worked at.
	if len(sq.Recent[0].Sets) != 2 {
		t.Fatalf("want 2 working sets (warm-up excluded), got %d", len(sq.Recent[0].Sets))
	}
	for _, set := range sq.Recent[0].Sets {
		if set.WeightKg != nil && *set.WeightKg == 200 {
			t.Error("the warm-up leaked into the working sets")
		}
	}
	if sq.MovementPattern == "" || sq.LoadType == "" {
		t.Errorf("catalog fields not joined: %+v", sq)
	}

	if bp, ok := got[exBench]; !ok || len(bp.Recent) != 1 {
		t.Errorf("bench history wrong: %+v", bp)
	}
	if _, ok := got["no-such-exercise"]; ok {
		t.Error("returned history for an exercise with none")
	}

	// And the point of all of it: the top set was 110kg at RIR 0, so this
	// must not come back as a recommendation to add weight.
	sq.Goal = "hypertrophy"
	if p := Progress(sq, time.Now().UTC()); p.Code != SuggestRepeatHard {
		t.Errorf("want repeat_hard off a RIR-0 top set, got %s (%s)", p.Code, p.Reason)
	}
}

// The window counts *sessions*, so a session must never come back with only
// some of its sets. A row-based window would cut one in half, and the
// weakest-set gate would then read the surviving sets as the whole session and
// add weight to a session that fell apart.
func TestRecentEfforts_WindowsWholeSessions(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	// Four sessions of four sets each — more than progressionWindow, and more
	// sets than the window would allow if it counted rows.
	for i := 0; i < 4; i++ {
		id := "ses-window-" + itoa(i)
		cleanup(t, pool, id)
		s := strengthSession(id, "user_window", []Set{
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RIR: ptrInt(2), Completed: true},
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RIR: ptrInt(2), Completed: true},
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RIR: ptrInt(2), Completed: true},
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(4), WeightKg: ptrF(100), RIR: ptrInt(1), Completed: true},
		})
		s.StartedAt = time.Now().UTC().Add(-time.Duration(i+1) * 24 * time.Hour)
		if _, err := repo.Create(ctx, s); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}

	got, err := repo.RecentEfforts(ctx, "user_window", []string{exSquat})
	if err != nil {
		t.Fatalf("recent efforts: %v", err)
	}
	sq := got[exSquat]
	if len(sq.Recent) != progressionWindow {
		t.Fatalf("want %d sessions, got %d", progressionWindow, len(sq.Recent))
	}
	for _, s := range sq.Recent {
		if len(s.Sets) != 4 {
			t.Errorf("session %s came back with %d of its 4 sets — the window cut a session in half",
				s.SessionID, len(s.Sets))
		}
	}
}

// Found against real data: two sessions in, the newest contained the exercise
// with nothing logged against it — added to the session but never performed.
// That row is not evidence, and letting it win erased a real 102.5kg set
// behind it and reported "not measured in weight".
func TestRecentEfforts_IgnoresSetsWithNothingRecorded(t *testing.T) {
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

	got, err := repo.RecentEfforts(ctx, "user_empty", []string{exSquat})
	if err != nil {
		t.Fatalf("recent efforts: %v", err)
	}
	sq, ok := got[exSquat]
	if !ok || len(sq.Recent) == 0 {
		t.Fatal("an unlogged set erased the real history behind it")
	}
	if w := sq.Recent[0].Sets[0].WeightKg; w == nil || *w != 102.5 {
		t.Fatalf("want the last real performance (102.5), got %v", w)
	}
	// 5 reps at 2 RIR is mid-range for powerlifting's 3-5... at the top, in
	// fact, so the load moves.
	sq.Goal = "powerlifting"
	if p := Progress(sq, time.Now().UTC()); p.Code != ProgressAddLoad {
		t.Errorf("want add_load off 5 reps at 2 RIR in a 3-5 range, got %s (%s)", p.Code, p.Reason)
	}
}

// History is per-user, and this is the query that would leak it.
func TestRecentEfforts_IsUserScoped(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-hist-theirs")

	theirs := strengthSession("ses-hist-theirs", "user_hist_other", []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(300), RIR: ptrInt(5), Completed: true},
	})
	if _, err := repo.Create(ctx, theirs); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.RecentEfforts(ctx, "user_hist_nobody", []string{exSquat})
	if err != nil {
		t.Fatalf("recent efforts: %v", err)
	}
	// The key is present now and always: the query is driven from the
	// requested ids, so every one comes back with its catalog fields whether
	// or not there's history. That's what makes "never logged" tellable from
	// "not a weighted lift".
	//
	// So the leak this test exists to catch is no longer "is the key there" —
	// it's whether any of *their* sets came with it.
	if n := len(got[exSquat].Recent); n != 0 {
		t.Fatalf("returned %d sessions of another user's training history", n)
	}
	if got[exSquat].LoadType == "" {
		t.Error("catalog fields should still arrive for an exercise with no history")
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

// Walks one lift through the whole double-progression cycle against real
// Postgres.
//
// The unit tests in progression_test.go prove each branch in isolation from a
// hand-built input. This proves the query and the rule agree about the *same*
// data — that what RecentEfforts groups is what Progress expects to read, in
// the order it expects. A branch can be individually correct and still never
// fire because the rows arrive shaped differently than the fixture assumed.
func TestProgressionCycle_EndToEnd(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	mk := func(id string, ago time.Duration, reps []int, kg float64, rir int) {
		cleanup(t, pool, id)
		sets := []Set{}
		for _, r := range reps {
			sets = append(sets, Set{ExerciseID: exBench, SetType: SetTypeWorking,
				Reps: ptrInt(r), WeightKg: ptrF(kg), RIR: ptrInt(rir), Completed: true})
		}
		s := strengthSession(id, "user_cycle", sets)
		s.StartedAt = time.Now().UTC().Add(-ago)
		if _, err := repo.Create(ctx, s); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	plan := func() Plan {
		got, err := repo.RecentEfforts(ctx, "user_cycle", []string{exBench})
		if err != nil {
			t.Fatalf("recent efforts: %v", err)
		}
		in := got[exBench]
		in.Goal = "hypertrophy" // 6-10
		return Progress(in, time.Now().UTC())
	}
	day := 24 * time.Hour

	// Mid-range with reserve → reps move, load holds.
	mk("cyc-1", 2*day, []int{7, 7, 7}, 60, 2)
	if p := plan(); p.Code != ProgressAddReps || *p.TargetWeightKg != 60 || *p.TargetReps != 8 {
		t.Fatalf("step 1: got %s %v x %v (%s)", p.Code, p.TargetWeightKg, p.TargetReps, p.Reason)
	}

	// Top of range on every set with reserve → load moves, reps reset.
	mk("cyc-2", 1*day, []int{10, 10, 10}, 60, 2)
	if p := plan(); p.Code != ProgressAddLoad || *p.TargetWeightKg != 62.5 || *p.TargetReps != 6 {
		t.Fatalf("step 2: got %s %v x %v (%s)", p.Code, p.TargetWeightKg, p.TargetReps, p.Reason)
	}

	// One set falls short → the weakest set gates it, no load increase.
	mk("cyc-3", 12*time.Hour, []int{10, 10, 6}, 62.5, 2)
	if p := plan(); p.Code == ProgressAddLoad {
		t.Fatalf("step 3: a 10/10/6 session must not add load, got %s", p.Code)
	} else if *p.TargetReps != 7 {
		t.Fatalf("step 3: should build from the weakest set, got %v reps (%s)", p.TargetReps, p.Reason)
	}

	// Now genuinely stuck: three sessions at one load with the same reps.
	//
	// Three sessions *at the weight* isn't enough on its own — cyc-3 above
	// ended at 6 and these end at 7, so a rep was gained, which is the
	// progression working rather than a plateau. It takes three with no gain.
	mk("cyc-4", 8*time.Hour, []int{7, 7, 7}, 62.5, 1)
	mk("cyc-5", 4*time.Hour, []int{7, 7, 7}, 62.5, 1)
	mk("cyc-6", 2*time.Hour, []int{7, 7, 7}, 62.5, 1)
	p := plan()
	if p.Code != ProgressDeload {
		t.Fatalf("step 4: want deload after 3 stuck sessions, got %s (%d at load) (%s)",
			p.Code, p.SessionsAtLoad, p.Reason)
	}
	if *p.TargetWeightKg != 56.25 {
		t.Errorf("step 4: 10%% off 62.5 rounded to a plate is 56.25, got %v", *p.TargetWeightKg)
	}
	t.Logf("cycle: add_reps -> add_load -> hold(weakest set) -> deload %v x %v",
		*p.TargetWeightKg, *p.TargetReps)
}

// TestRecentEffortsV2_OpenSessionNeverOccupiesAWindowSlot is N473/#812's own
// wire-level regression: RecentEfforts' DENSE_RANK numbers sessions BEFORE
// any finished/unfinished distinction, so a currently-open session (which is
// always the NEWEST by definition — it's the one the athlete is in right
// now) consumes rank 1 and pushes the window's oldest finished session out.
// An athlete calling this endpoint mid-session — exactly when `today_sets`
// exists to be used — would see at most progressionWindow-1 real finished
// sessions through RecentEfforts, which is precisely the failure that would
// have made ProgressV2's stall/deload check unreachable in real traffic.
// Caught in backend review, not by any pure-function test, because every
// ProgressV2 test builds ProgressionInput by hand and none modeled a session
// actually occupying a rank slot ahead of real history.
//
// RecentEffortsV2 fixes this by moving `ended_at IS NOT NULL` INTO the
// ranked CTE's WHERE clause, so the window itself only ever ranks finished
// sessions — asserted here by creating progressionWindow finished sessions
// plus one still-open session started most recently, and confirming
// RecentEffortsV2 returns exactly progressionWindow sessions, all finished,
// while RecentEfforts (called against the identical fixture, unmodified) is
// shown missing the oldest of them because the open session displaced it.
func TestRecentEffortsV2_OpenSessionNeverOccupiesAWindowSlot(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	finishedIDs := make([]string, 0, progressionWindow)
	for i := 0; i < progressionWindow; i++ {
		id := "ses-v2-finished-" + itoa(i)
		finishedIDs = append(finishedIDs, id)
		cleanup(t, pool, id)
		s := strengthSession(id, "user_v2_window", []Set{
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RIR: ptrInt(2), Completed: true},
		})
		// finishedIDs[0] is the OLDEST (furthest back), finishedIDs[last] the
		// newest of the three — all still older than the open session
		// created below. Getting this backwards makes finishedIDs[0] the
		// session v1's OWN window keeps regardless of the open session
		// (found by running this test: the first version of it had this
		// inverted and the "control" assertion below correctly caught it).
		s.StartedAt = time.Now().UTC().Add(-time.Duration(progressionWindow-i+1) * 24 * time.Hour)
		end := s.StartedAt.Add(time.Hour)
		s.EndedAt = &end
		if _, err := repo.Create(ctx, s); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}

	openID := "ses-v2-open"
	cleanup(t, pool, openID)
	open := strengthSession(openID, "user_v2_window", []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(1), WeightKg: ptrF(200), Completed: true},
	})
	open.StartedAt = time.Now().UTC().Add(-time.Hour) // newest — ranks first
	// EndedAt left nil: this session is still open.
	if _, err := repo.Create(ctx, open); err != nil {
		t.Fatalf("create %s: %v", openID, err)
	}

	v2, err := repo.RecentEffortsV2(ctx, "user_v2_window", []string{exSquat})
	if err != nil {
		t.Fatalf("recent efforts v2: %v", err)
	}
	sq := v2[exSquat]
	if len(sq.Recent) != progressionWindow {
		t.Fatalf("RecentEffortsV2: want %d finished sessions in the window, got %d — "+
			"the open session must never occupy a slot", progressionWindow, len(sq.Recent))
	}
	for _, s := range sq.Recent {
		if !s.Finished {
			t.Errorf("RecentEffortsV2 returned an unfinished session (%s) inside the window", s.SessionID)
		}
		if s.SessionID == openID {
			t.Errorf("RecentEffortsV2 returned the open session (%s) at all", openID)
		}
	}
	// The oldest finished session must still be reachable — it must NOT have
	// been pushed out by the open one, which is exactly what RecentEfforts
	// (below) fails to guarantee.
	found := false
	for _, s := range sq.Recent {
		if s.SessionID == finishedIDs[0] {
			found = true
		}
	}
	if !found {
		t.Errorf("RecentEffortsV2 lost the oldest finished session (%s) — window slots leaked "+
			"to something else", finishedIDs[0])
	}

	// The control: RecentEfforts (v1's own, unmodified) against the IDENTICAL
	// fixture shows the bug this test exists to pin. If this ever stops
	// failing to include finishedIDs[0], either the fixture changed or
	// RecentEfforts itself did — and RecentEfforts must never change.
	v1, err := repo.RecentEfforts(ctx, "user_v2_window", []string{exSquat})
	if err != nil {
		t.Fatalf("recent efforts (v1, control): %v", err)
	}
	sq1 := v1[exSquat]
	if len(sq1.Recent) != progressionWindow {
		t.Fatalf("control: want %d sessions from RecentEfforts, got %d", progressionWindow, len(sq1.Recent))
	}
	v1HasOldest := false
	for _, s := range sq1.Recent {
		if s.SessionID == finishedIDs[0] {
			v1HasOldest = true
		}
	}
	if v1HasOldest {
		t.Fatalf("control assumption broken: RecentEfforts (v1) unexpectedly still reached the "+
			"oldest finished session (%s) even with the open session ranked first — "+
			"the scenario this test relies on to demonstrate RecentEffortsV2's fix no longer holds",
			finishedIDs[0])
	}
}

// N474, full round trip through real Postgres — the exact bug report
// reproduced end to end: a bench progression sits at 250kg for 3 reps (a
// powerlifting-range top set), the athlete then logs a deliberately lighter
// session tagged IntentLight (185kg for 12), and the NEXT suggestion must
// still be built from 250kg, not the intervening light session — proving
// the intent column, the RecentEfforts query change, and Progress's own
// evidence-search skip all agree with each other through the real
// repository, not just in the pure unit tests in progression_test.go.
func TestProgressionCycle_LightSessionDoesNotDisturbIt(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	mk := func(id string, ago time.Duration, intent SessionIntent, reps []int, kg float64, rir int) {
		cleanup(t, pool, id)
		sets := []Set{}
		for _, r := range reps {
			sets = append(sets, Set{ExerciseID: exBench, SetType: SetTypeWorking,
				Reps: ptrInt(r), WeightKg: ptrF(kg), RIR: ptrInt(rir), Completed: true})
		}
		s := strengthSession(id, "user_light_cycle", sets)
		s.Intent = intent
		s.StartedAt = time.Now().UTC().Add(-ago)
		if _, err := repo.Create(ctx, s); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	plan := func() Plan {
		got, err := repo.RecentEfforts(ctx, "user_light_cycle", []string{exBench})
		if err != nil {
			t.Fatalf("recent efforts: %v", err)
		}
		in := got[exBench]
		in.Goal = "powerlifting" // 3-5
		return Progress(in, time.Now().UTC())
	}
	day := 24 * time.Hour

	// The established progression: 250kg for 3, well inside a 3-5 range
	// with room (RIR 2).
	mk("lgt-1", 2*day, IntentNormal, []int{3, 3, 3}, 250, 2)
	before := plan()
	if before.LastWeightKg == nil || *before.LastWeightKg != 250 {
		t.Fatalf("fixture bug: evidence weight = %v before the light session, want 250", before.LastWeightKg)
	}

	// A deliberately lighter session — 185kg for 12 reps, well outside the
	// powerlifting range and with plenty of reserve. This is the EXACT shape
	// the ticket reports: read as evidence by the old rule, this session
	// alone would satisfy readyForLoad and suggest adding weight off 185.
	mk("lgt-2", 1*day, IntentLight, []int{12, 12, 12}, 185, 4)

	after := plan()
	if after.LastWeightKg == nil || *after.LastWeightKg != 250 {
		t.Fatalf("evidence weight after the light session = %v, want 250 — "+
			"the light session must never become the evidence session", after.LastWeightKg)
	}
	if after.TargetWeightKg == nil || *after.TargetWeightKg != 250 {
		t.Fatalf("target weight = %v, want 250 — a light session must never move the load", *after.TargetWeightKg)
	}
	if after.Code != ProgressAddReps {
		// 3 reps at RIR 2 in a 3-5 range: room, but not yet at the top —
		// reps move, load does not. The exact branch matters less than the
		// weight staying at 250; asserted for completeness.
		t.Errorf("code = %q, want %q", after.Code, ProgressAddReps)
	}
}
