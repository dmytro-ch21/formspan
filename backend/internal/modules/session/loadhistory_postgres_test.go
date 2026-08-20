package session

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The arc of one lift, and the four rules it has to borrow rather than restate.
//
// Every assertion here is aimed at a specific guard. If you change this file,
// delete the guard first and check the test goes red — two tests in this module
// have already shipped passing for the wrong reason.
func TestLoadHistory_OnePointPerSession_OldestFirst(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const mine, theirs = "user_lh_mine", "user_lh_theirs"

	fixtures := []NewSession{
		// Deliberately created out of order, so "oldest first" cannot pass by
		// accident of insertion order.
		histAt("ses-lh-b", mine, "strength", time.Date(2024, 6, 1, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(3), WeightKg: ptrF(120), Completed: true},
		}),
		histAt("ses-lh-a", mine, "strength", time.Date(2024, 5, 1, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			// A warm-up and a set never performed: neither is evidence.
			{ExerciseID: exSquat, SetType: SetTypeWarmup, Reps: ptrInt(5), WeightKg: ptrF(300), Completed: true},
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(1), WeightKg: ptrF(250), Completed: false},
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(90), Completed: true},
			// Another exercise in the same session must not leak into this arc.
			{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(80), Completed: true},
		}),
		// Somebody else's much heavier squat, on a day between mine.
		histAt("ses-lh-other", theirs, "strength", time.Date(2024, 5, 15, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(400), Completed: true},
		}),
	}
	for _, f := range fixtures {
		cleanup(t, pool, f.ID)
		if _, err := repo.Create(ctx, f); err != nil {
			t.Fatalf("create %s: %v", f.ID, err)
		}
	}

	got, err := repo.LoadHistory(ctx, mine, exSquat, LoadHistoryFilter{})
	if err != nil {
		t.Fatalf("load history: %v", err)
	}
	if got.LoadType != "weight_reps" {
		t.Errorf("load_type = %q, want weight_reps — it must come from the catalog", got.LoadType)
	}
	if len(got.Points) != 2 {
		t.Fatalf("want 2 points (one per session, mine only), got %d: %+v", len(got.Points), got.Points)
	}
	// Cross-user isolation. `theirs` trained the same exercise between my two
	// sessions, so a query missing its user scope produces THREE points with a
	// 400kg spike in the middle — visible, but only if something looks.
	for _, p := range got.Points {
		if p.SessionID == "ses-lh-other" {
			t.Fatalf("another athlete's session appeared in my history: %+v", p)
		}
	}
	if got.Points[0].SessionID != "ses-lh-a" || got.Points[1].SessionID != "ses-lh-b" {
		t.Fatalf("want oldest first (a then b), got %s then %s",
			got.Points[0].SessionID, got.Points[1].SessionID)
	}

	a := got.Points[0]
	// Two working sets counted; the warm-up and the never-performed set are
	// not. If SQLWorkingSet were dropped this reads 4.
	if a.Sets != 2 {
		t.Errorf("sets = %d, want 2 — warm-ups and sets never completed are not evidence", a.Sets)
	}
	if a.Reps != 10 {
		t.Errorf("reps = %d, want 10", a.Reps)
	}
	// The 300kg warm-up is the heaviest weight in the session and must not be
	// the top set.
	if a.TopWeightKg == nil || *a.TopWeightKg != 100 {
		t.Errorf("top weight = %v, want 100 — the 300kg warm-up is not a top set", a.TopWeightKg)
	}
	// Bench in the same session must not be in the squat's tonnage.
	if a.TonnageKg != 5*100+5*90 {
		t.Errorf("tonnage = %v, want %v — another exercise's sets are leaking in",
			a.TonnageKg, 5*100+5*90)
	}
}

// A drop set is volume but it is not a second set — the W2 distinction, which
// this endpoint gets for free ONLY because it uses both shared rules rather
// than the one that was easier to reach for.
func TestLoadHistory_ADropIsVolumeButNotASet(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_drop"

	f := histAt("ses-lh-drop", user, "strength", time.Date(2024, 7, 1, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
		{ExerciseID: exSquat, SetType: SetTypeDrop, Reps: ptrInt(5), WeightKg: ptrF(60), Completed: true},
	})
	cleanup(t, pool, f.ID)
	if _, err := repo.Create(ctx, f); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.LoadHistory(ctx, user, exSquat, LoadHistoryFilter{})
	if err != nil {
		t.Fatalf("load history: %v", err)
	}
	if len(got.Points) != 1 {
		t.Fatalf("want 1 point, got %d", len(got.Points))
	}
	p := got.Points[0]
	// Both halves matter and they fail in opposite directions: counting the
	// drop as a set inflates the count, excluding its volume deflates the
	// tonnage. A single rule cannot get both right, which is the whole reason
	// there are two.
	if p.Sets != 1 {
		t.Errorf("sets = %d, want 1 — a drop is a continuation of the set above it", p.Sets)
	}
	if p.TonnageKg != 5*100+5*60 {
		t.Errorf("tonnage = %v, want %v — a drop's volume was still lifted",
			p.TonnageKg, 5*100+5*60)
	}
}

// Tonnage folds in the implement count, because it uses SQLTonnage. A pair of
// dumbbells is the fixture that can tell factor 1 from factor 2 — without it
// every parity assertion in this package agrees for the wrong reason.
func TestLoadHistory_TonnageCountsBothImplements(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_impl"

	f := histAt("ses-lh-impl", user, "strength", time.Date(2024, 7, 2, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
		{ExerciseID: exDBBench, SetType: SetTypeWorking, Reps: ptrInt(10), WeightKg: ptrF(30), Completed: true},
	})
	cleanup(t, pool, f.ID)
	if _, err := repo.Create(ctx, f); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.LoadHistory(ctx, user, exDBBench, LoadHistoryFilter{})
	if err != nil {
		t.Fatalf("load history: %v", err)
	}
	if len(got.Points) != 1 {
		t.Fatalf("want 1 point, got %d", len(got.Points))
	}
	// 10 × 30 × 2 dumbbells.
	if got.Points[0].TonnageKg != 600 {
		t.Errorf("tonnage = %v, want 600 — a pair of 30kg dumbbells is 60kg per rep",
			got.Points[0].TonnageKg)
	}
	// The logged weight is per implement, and the top set reports what was
	// logged. Doubling it here would contradict every other screen.
	if got.Points[0].TopWeightKg == nil || *got.Points[0].TopWeightKg != 30 {
		t.Errorf("top weight = %v, want 30 — the doubling belongs to tonnage, not to the weight",
			got.Points[0].TopWeightKg)
	}
}

// A session with no estimable set has NO estimate, and that is a gap rather
// than a zero. A zero would draw the strongest athlete's chart as a collapse.
func TestLoadHistory_NoEstimableSetIsAGapNotAZero(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_gap"

	fixtures := []NewSession{
		histAt("ses-lh-gap-a", user, "strength", time.Date(2024, 8, 1, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			// 20 reps: past the point every rep-max formula diverges, so
			// EstimateOneRM refuses.
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(20), WeightKg: ptrF(60), Completed: true},
		}),
		histAt("ses-lh-gap-b", user, "strength", time.Date(2024, 8, 8, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
		}),
	}
	for _, f := range fixtures {
		cleanup(t, pool, f.ID)
		if _, err := repo.Create(ctx, f); err != nil {
			t.Fatalf("create %s: %v", f.ID, err)
		}
	}

	got, err := repo.LoadHistory(ctx, user, exSquat, LoadHistoryFilter{})
	if err != nil {
		t.Fatalf("load history: %v", err)
	}
	if len(got.Points) != 2 {
		t.Fatalf("want 2 points, got %d", len(got.Points))
	}
	// The high-rep session still has a top weight and tonnage — it is a real
	// session, just not evidence of a maximum.
	if got.Points[0].BestOneRMKg != nil {
		t.Errorf("20 reps produced an estimate of %v — every rep-max formula "+
			"diverges there, so the honest answer is none", *got.Points[0].BestOneRMKg)
	}
	if got.Points[0].TopWeightKg == nil || *got.Points[0].TopWeightKg != 60 {
		t.Errorf("the session is still real: top weight = %v, want 60", got.Points[0].TopWeightKg)
	}
	if got.Points[0].BestOneRMReps != nil || got.Points[0].BestOneRMWeightKg != nil {
		t.Error("evidence was carried for an estimate that does not exist")
	}

	// And where an estimate DOES exist it agrees with the one the records
	// screen publishes, because it is the same function rather than a second
	// opinion in SQL. Hard-coding 112.5 here would pass while quietly allowing
	// the two screens to disagree the day Brzycki is revisited.
	want, ok := EstimateOneRM(5, 100, nil, nil)
	if !ok {
		t.Fatal("EstimateOneRM refused 5x100 — the fixture is wrong, not the code")
	}
	if got.Points[1].BestOneRMKg == nil || *got.Points[1].BestOneRMKg != want {
		t.Errorf("best 1RM = %v, want %v — this must be the same estimate /records "+
			"publishes, or one athlete sees two different bests for one set",
			got.Points[1].BestOneRMKg, want)
	}
	// The evidence names the set that won, so a modelled number can be checked.
	if got.Points[1].BestOneRMReps == nil || *got.Points[1].BestOneRMReps != 5 ||
		got.Points[1].BestOneRMWeightKg == nil || *got.Points[1].BestOneRMWeightKg != 100 {
		t.Errorf("evidence = %v x %v, want 5 x 100",
			got.Points[1].BestOneRMReps, got.Points[1].BestOneRMWeightKg)
	}
}

// The heaviest set is not always the best estimate, and the endpoint must not
// quietly assume it is. 5x100 estimates higher than 1x110.
func TestLoadHistory_BestEstimateIsNotTheHeaviestSet(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_best"

	f := histAt("ses-lh-best", user, "strength", time.Date(2024, 9, 1, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(1), WeightKg: ptrF(110), Completed: true},
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
	})
	cleanup(t, pool, f.ID)
	if _, err := repo.Create(ctx, f); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.LoadHistory(ctx, user, exSquat, LoadHistoryFilter{})
	if err != nil {
		t.Fatalf("load history: %v", err)
	}
	p := got.Points[0]
	if p.TopWeightKg == nil || *p.TopWeightKg != 110 {
		t.Errorf("top weight = %v, want 110", p.TopWeightKg)
	}
	// The two point at different sets, which is the property. If the estimate
	// were taken from the top set this reads 110.
	if p.BestOneRMWeightKg == nil || *p.BestOneRMWeightKg != 100 {
		t.Errorf("the estimate came from the %vkg set; 5x100 is stronger evidence "+
			"than 1x110 and the two record kinds must be free to disagree",
			p.BestOneRMWeightKg)
	}
}

// The cap keeps the NEWEST sessions. A chart that silently loses its right-hand
// edge is worse than one that starts late, because the recent end is the half
// anybody is looking at.
func TestLoadHistory_CapDropsTheOldest(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_cap"

	for i, day := range []int{1, 2, 3} {
		f := histAt(
			"ses-lh-cap-"+string(rune('a'+i)), user, "strength",
			time.Date(2024, 10, day, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
				{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(float64(100 + day)), Completed: true},
			})
		cleanup(t, pool, f.ID)
		if _, err := repo.Create(ctx, f); err != nil {
			t.Fatalf("create %s: %v", f.ID, err)
		}
	}

	got, err := repo.LoadHistory(ctx, user, exSquat, LoadHistoryFilter{Limit: 2})
	if err != nil {
		t.Fatalf("load history: %v", err)
	}
	if len(got.Points) != 2 {
		t.Fatalf("want 2 points under a limit of 2, got %d", len(got.Points))
	}
	// Still ascending, and it is the FIRST day that was dropped.
	if got.Points[0].SessionID != "ses-lh-cap-b" || got.Points[1].SessionID != "ses-lh-cap-c" {
		t.Errorf("kept %s and %s; the cap must drop the oldest and keep the newest, "+
			"still oldest-first", got.Points[0].SessionID, got.Points[1].SessionID)
	}

	// Above the ceiling is clamped, not honoured — otherwise the bound is
	// advisory and a caller can ask for everything.
	if (LoadHistoryFilter{Limit: maxLoadHistoryPoints + 5_000}).points() != maxLoadHistoryPoints {
		t.Error("a limit above the ceiling was honoured; the cap is not a cap")
	}
	if (LoadHistoryFilter{}).points() != maxLoadHistoryPoints {
		t.Error("an unset limit must mean the maximum, not zero points")
	}
}

// A date window scopes the series, and `to` is inclusive of its day at the
// handler boundary — tested here on the exclusive end the repository is given.
func TestLoadHistory_WindowScopesTheSeries(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_window"

	for i, day := range []int{1, 10, 20} {
		f := histAt(
			"ses-lh-win-"+string(rune('a'+i)), user, "strength",
			time.Date(2024, 11, day, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
				{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
			})
		cleanup(t, pool, f.ID)
		if _, err := repo.Create(ctx, f); err != nil {
			t.Fatalf("create %s: %v", f.ID, err)
		}
	}

	from := time.Date(2024, 11, 5, 0, 0, 0, 0, time.UTC)
	to := time.Date(2024, 11, 15, 0, 0, 0, 0, time.UTC)
	got, err := repo.LoadHistory(ctx, user, exSquat, LoadHistoryFilter{From: &from, To: &to})
	if err != nil {
		t.Fatalf("load history: %v", err)
	}
	if len(got.Points) != 1 || got.Points[0].SessionID != "ses-lh-win-b" {
		t.Fatalf("want only the 10th, got %+v", got.Points)
	}
}

// An unknown exercise is a 404, not an empty chart. "You have never trained
// this" and "there is no such exercise" are different answers and a client
// showing the first for the second sends somebody looking for lost data.
func TestLoadHistory_UnknownExerciseIsNotFound(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	_, err := repo.LoadHistory(ctx, "user_lh_404", "no-such-exercise-anywhere", LoadHistoryFilter{})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound for an exercise that does not exist, got %v", err)
	}

	// A known exercise never trained is an empty series, NOT a 404 — the two
	// cases must stay distinguishable in both directions.
	got, err := repo.LoadHistory(ctx, "user_lh_404", exOHP, LoadHistoryFilter{})
	if err != nil {
		t.Fatalf("a known but untrained exercise should be empty, not an error: %v", err)
	}
	if len(got.Points) != 0 {
		t.Fatalf("want no points, got %d", len(got.Points))
	}
	if got.Points == nil {
		t.Error("points must serialise as [] rather than null — a client mapping over " +
			"null is a crash, and this is the common first-use case")
	}
}

// An assisted set is estimated from the reps done UNAIDED, because that is what
// /records publishes for the same set. This is the finding review caught: the
// query did not select assisted_reps at all, so a spotted or band-assisted set
// estimated from its full count and the two screens disagreed — 8 assisted-by-3
// at 102.5kg reads 115.3 on the records page and 127.2 here.
//
// The trap is documented on `Set`: a query that does not SELECT assisted_reps
// hydrates every set with it permanently nil, and nothing complains. This was
// the fourth query to walk into it.
func TestLoadHistory_AnAssistedSetIsEstimatedFromSoloReps(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_assist"

	f := histAt("ses-lh-assist", user, "strength", time.Date(2024, 12, 1, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
		{
			ExerciseID: exPullUp, SetType: SetTypeWorking,
			Reps: ptrInt(8), AssistedReps: ptrInt(3), WeightKg: ptrF(102.5),
			Completed: true,
		},
	})
	cleanup(t, pool, f.ID)
	if _, err := repo.Create(ctx, f); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.LoadHistory(ctx, user, exPullUp, LoadHistoryFilter{})
	if err != nil {
		t.Fatalf("load history: %v", err)
	}
	if len(got.Points) != 1 {
		t.Fatalf("want 1 point, got %d", len(got.Points))
	}
	p := got.Points[0]

	// The same function every other 1RM surface uses, rather than a number
	// spelled out here — hard-coding would pass while letting this endpoint
	// drift from /records the day the rule changes.
	want, ok := EstimateSetOneRM(Set{
		Reps: ptrInt(8), AssistedReps: ptrInt(3), WeightKg: ptrF(102.5),
	})
	if !ok {
		t.Fatal("EstimateSetOneRM refused the fixture")
	}
	if p.BestOneRMKg == nil || *p.BestOneRMKg != want {
		t.Errorf("best 1RM = %v, want %v — an assisted set must be estimated from "+
			"the reps done unaided, exactly as /records does it",
			p.BestOneRMKg, want)
	}
	// And the naive reading must NOT be what came back.
	naive, _ := EstimateOneRM(8, 102.5, nil, nil)
	if p.BestOneRMKg != nil && *p.BestOneRMKg == naive {
		t.Errorf("best 1RM = %v is the estimate from the FULL rep count — "+
			"assisted_reps is being ignored", naive)
	}

	// The evidence carries the full count AND the assistance, matching how
	// Record reports it. Showing 8 under a solo-5 estimate with no assisted
	// figure beside it is unrecheckable.
	if p.BestOneRMReps == nil || *p.BestOneRMReps != 8 {
		t.Errorf("evidence reps = %v, want the full count 8", p.BestOneRMReps)
	}
	if p.BestOneRMAssistedReps == nil || *p.BestOneRMAssistedReps != 3 {
		t.Errorf("evidence assisted = %v, want 3 — without it the full rep count "+
			"cannot be reconciled with the estimate", p.BestOneRMAssistedReps)
	}
}

// A window with only one bound. The both-bounds case is covered above; a
// previous endpoint of mine mis-numbered parameters in exactly the one-bound
// case, so both halves are exercised rather than assumed.
func TestLoadHistory_ASingleBoundStillScopes(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_onebound"

	for i, day := range []int{1, 10, 20} {
		f := histAt(
			"ses-lh-ob-"+string(rune('a'+i)), user, "strength",
			time.Date(2025, 1, day, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
				{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
			})
		cleanup(t, pool, f.ID)
		if _, err := repo.Create(ctx, f); err != nil {
			t.Fatalf("create %s: %v", f.ID, err)
		}
	}

	from := time.Date(2025, 1, 15, 0, 0, 0, 0, time.UTC)
	got, err := repo.LoadHistory(ctx, user, exSquat, LoadHistoryFilter{From: &from})
	if err != nil {
		t.Fatalf("from-only: %v", err)
	}
	if len(got.Points) != 1 || got.Points[0].SessionID != "ses-lh-ob-c" {
		t.Fatalf("from-only should keep the 20th alone, got %+v", got.Points)
	}

	to := time.Date(2025, 1, 5, 0, 0, 0, 0, time.UTC)
	got, err = repo.LoadHistory(ctx, user, exSquat, LoadHistoryFilter{To: &to})
	if err != nil {
		t.Fatalf("to-only: %v", err)
	}
	if len(got.Points) != 1 || got.Points[0].SessionID != "ses-lh-ob-a" {
		t.Fatalf("to-only should keep the 1st alone, got %+v", got.Points)
	}
}

// Two sets in one session tying on the estimate must return the SAME evidence
// every time, and it must be the earlier one.
//
// This is the property `position` was added to the ORDER BY for, and review
// pointed out that nothing enforced it: with no tie in any fixture, both
// deleting `sc.position` and relaxing the Go tie-break to `>=` passed. The
// numbers are chosen to tie EXACTLY in binary — 5 × 100 and 1 × 112.5 both
// estimate 112.5 — because a near-tie would prove nothing.
func TestLoadHistory_ATiedEstimateKeepsTheEarlierSet(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_tie"

	a, aok := EstimateOneRM(5, 100, nil, nil)
	b, bok := EstimateOneRM(1, 112.5, nil, nil)
	if !aok || !bok || a != b {
		t.Fatalf("the fixture must TIE to test a tie-break: 5x100 = %v, 1x112.5 = %v", a, b)
	}

	f := histAt("ses-lh-tie", user, "strength", time.Date(2025, 2, 1, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
		// Position 0: the set that must win, because it came first.
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(1), WeightKg: ptrF(112.5), Completed: true},
	})
	cleanup(t, pool, f.ID)
	if _, err := repo.Create(ctx, f); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Repeated, because the failure this guards against is non-determinism:
	// one call agreeing proves nothing about the next.
	for i := 0; i < 4; i++ {
		got, err := repo.LoadHistory(ctx, user, exSquat, LoadHistoryFilter{})
		if err != nil {
			t.Fatalf("load history: %v", err)
		}
		p := got.Points[0]
		if p.BestOneRMReps == nil || *p.BestOneRMReps != 5 {
			t.Fatalf("call %d: evidence reps = %v, want the FIRST tying set (5 x 100). "+
				"Without position in the ORDER BY this flips between requests.",
				i, p.BestOneRMReps)
		}
	}
}

// Every rep assisted means nothing was demonstrated unaided, so there is no
// estimate at all — the refusal the contract now promises explicitly. The
// session is still real: it has tonnage, a set, and a top weight.
func TestLoadHistory_AFullyAssistedSetSupportsNoEstimate(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_allassist"

	f := histAt("ses-lh-allassist", user, "strength", time.Date(2025, 3, 1, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
		{
			ExerciseID: exSquat, SetType: SetTypeWorking,
			Reps: ptrInt(5), AssistedReps: ptrInt(5), WeightKg: ptrF(100),
			Completed: true,
		},
	})
	cleanup(t, pool, f.ID)
	if _, err := repo.Create(ctx, f); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.LoadHistory(ctx, user, exSquat, LoadHistoryFilter{})
	if err != nil {
		t.Fatalf("load history: %v", err)
	}
	if len(got.Points) != 1 {
		t.Fatalf("want 1 point, got %d", len(got.Points))
	}
	p := got.Points[0]

	if p.BestOneRMKg != nil {
		t.Errorf("best 1RM = %v — every rep was assisted, so nothing was "+
			"demonstrated unaided and there is nothing to estimate from", *p.BestOneRMKg)
	}
	// ALL of the evidence, not just the reps — an evidence field surviving
	// without the estimate it belongs to is the shape that makes a modelled
	// number unrecheckable.
	if p.BestOneRMReps != nil || p.BestOneRMWeightKg != nil ||
		p.BestOneRMAssistedReps != nil || p.BestOneRMRIR != nil || p.BestOneRMRPE != nil {
		t.Errorf("evidence survived without an estimate: reps=%v weight=%v assisted=%v rir=%v rpe=%v",
			p.BestOneRMReps, p.BestOneRMWeightKg, p.BestOneRMAssistedReps,
			p.BestOneRMRIR, p.BestOneRMRPE)
	}

	// Deliberate, not inherited: the set still happened. It counts as a set,
	// its volume was still moved, and the bar still held that weight.
	if p.Sets != 1 || p.Reps != 5 || p.TonnageKg != 500 {
		t.Errorf("sets=%d reps=%d tonnage=%v, want 1/5/500 — a fully assisted set "+
			"is still a set that was performed", p.Sets, p.Reps, p.TonnageKg)
	}
	if p.TopWeightKg == nil || *p.TopWeightKg != 100 {
		t.Errorf("top weight = %v, want 100", p.TopWeightKg)
	}
}

// Effort travels with the estimate, so the evidence can be recomputed by the
// rule that chose it. Without RIR, "5 x 100" under a 120.0 estimate recomputes
// to 112.5 and looks wrong to anybody who checks.
func TestLoadHistory_EffortTravelsWithTheEstimate(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_effort"

	f := histAt("ses-lh-effort", user, "strength", time.Date(2025, 4, 1, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
		{
			ExerciseID: exSquat, SetType: SetTypeWorking,
			Reps: ptrInt(5), WeightKg: ptrF(100), RIR: ptrInt(2), Completed: true,
		},
	})
	cleanup(t, pool, f.ID)
	if _, err := repo.Create(ctx, f); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.LoadHistory(ctx, user, exSquat, LoadHistoryFilter{})
	if err != nil {
		t.Fatalf("load history: %v", err)
	}
	p := got.Points[0]

	if p.BestOneRMRIR == nil || *p.BestOneRMRIR != 2 {
		t.Fatalf("evidence RIR = %v, want 2 — without it the estimate cannot be "+
			"recomputed from the evidence beside it", p.BestOneRMRIR)
	}
	// The whole point: the evidence, fed back through the rule, reproduces the
	// published number. Asserted rather than described.
	again, ok := EstimateOneRM(*p.BestOneRMReps, *p.BestOneRMWeightKg, p.BestOneRMRIR, p.BestOneRMRPE)
	if !ok || p.BestOneRMKg == nil || again != *p.BestOneRMKg {
		t.Errorf("recomputing the evidence gives %v but the published estimate is %v",
			again, p.BestOneRMKg)
	}
}

// TestLoadHistory_DocumentedRulesPredictBothNumbers is the contract's worked
// example, executed.
//
// `weight_kg` is what is stamped on the implement, and TWO published numbers
// read it differently, on purpose:
//
//   - a 1RM estimate is a claim about a lift, and a lifter quotes the dumbbell
//     rather than the pair — so it reads `weight_kg` as logged, unmultiplied;
//   - tonnage is total work moved, so it multiplies by `load_factor`.
//
// Whichever of the two an athlete distrusted, nothing on the wire told them
// which reading applied — issue #383. The contract states it now, on every
// field that carries a load, and this is the check that the words and the
// server agree.
//
// EVERY EXPECTATION BELOW IS HAND-COMPUTED FROM THE DOCUMENTED RULES, not from
// the functions under test. `TestLoadHistory_AnAssistedSetIsEstimatedFromSoloReps`
// above deliberately does the opposite — it feeds the published evidence back
// through `EstimateOneRM` to prove they reconcile — and that shape cannot catch
// a formula that is wrong in the same way twice. These numbers were worked out
// from the spec text and only then compared against the server:
//
//	set:      a PAIR of 30 kg dumbbells, 5 reps, 2 in reserve
//	tonnage = reps x weight_kg x load_factor = 5 x 30 x 2      = 300 kg
//	1RM     = Brzycki on the per-implement weight, effort folded in,
//	          effective reps = 5 reps + 2 RIR = 7,
//	          30 x 36/(37-7) = 30 x 1.2                        =  36 kg
//
// Both are exact in binary — 36/30 is 1.2 and 30 x 1.2 is 36 — so these are
// equality assertions rather than tolerances, and a drift of any size fails.
//
// The fixture DISTINGUISHES the two readings, which is the property that makes
// asserting either one worth anything: each wrong reading lands on its own
// wrong number. A 1RM taken off the pair is 72, not 36. A tonnage that ignored
// the pair is 150, not 300. At load factor 1 all four collapse into two, the
// test passes under either reading, and it measures nothing — which is why the
// factor is read back from the database below rather than assumed.
func TestLoadHistory_DocumentedRulesPredictBothNumbers(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_lh_l4"

	f := histAt("ses-lh-l4", user, "strength", time.Date(2024, 8, 3, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
		{ExerciseID: exDBBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(30),
			RIR: ptrInt(2), Completed: true},
	})
	cleanup(t, pool, f.ID)
	if _, err := repo.Create(ctx, f); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Read the factor back rather than trusting the fixture's own declaration.
	// `exDBBench` is a PAIR today; if it is ever reclassified to one implement,
	// the two readings coincide and every assertion below passes under both —
	// the silent disarm `requireUnsorted` exists to prevent elsewhere in this
	// package. Fail loudly instead of going quietly trivial.
	stored, err := repo.Get(ctx, user, f.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(stored.Sets) != 1 {
		t.Fatalf("want 1 set back, got %d", len(stored.Sets))
	}
	if stored.Sets[0].LoadFactor != 2 {
		t.Fatalf("load factor = %d, want 2 — at factor 1 the per-implement and "+
			"total readings are the same number and this test cannot fail. "+
			"Point it at an exercise whose `implements` is 2.",
			stored.Sets[0].LoadFactor)
	}

	got, err := repo.LoadHistory(ctx, user, exDBBench, LoadHistoryFilter{})
	if err != nil {
		t.Fatalf("load history: %v", err)
	}
	if len(got.Points) != 1 {
		t.Fatalf("want 1 point, got %d", len(got.Points))
	}
	pt := got.Points[0]

	// Tonnage is total work moved, so the pair counts twice.
	if pt.TonnageKg != 300 {
		t.Errorf("tonnage_kg = %v, want 300 (5 x 30 x 2). 150 would mean the "+
			"documented `load_factor` was not applied", pt.TonnageKg)
	}
	// The 1RM is the lift as a lifter would quote it, so the pair counts once.
	if pt.BestOneRMKg == nil {
		t.Fatalf("best_1rm_kg is null, want 36 — 5 reps at 2 RIR is 7 effective, " +
			"well inside the 12-rep ceiling")
	}
	if *pt.BestOneRMKg != 36 {
		t.Errorf("best_1rm_kg = %v, want 36 (30 x 36/(37-7)). 72 would mean the "+
			"estimate had folded in `load_factor`, which the contract says it "+
			"does not", *pt.BestOneRMKg)
	}
	// The evidence beside the estimate is in the same per-implement unit, or a
	// client recomputing the documented formula from it arrives at 72.
	if pt.BestOneRMWeightKg == nil || *pt.BestOneRMWeightKg != 30 {
		t.Errorf("best_1rm_weight_kg = %v, want 30 — the evidence must be the "+
			"weight the estimate was taken from", pt.BestOneRMWeightKg)
	}
	if pt.TopWeightKg == nil || *pt.TopWeightKg != 30 {
		t.Errorf("top_weight_kg = %v, want 30 — a top set is reported as logged",
			pt.TopWeightKg)
	}
}
