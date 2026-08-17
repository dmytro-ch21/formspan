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
	if got.Points[0].OneRMReps != nil || got.Points[0].OneRMWeightKg != nil {
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
	if got.Points[1].OneRMReps == nil || *got.Points[1].OneRMReps != 5 ||
		got.Points[1].OneRMWeightKg == nil || *got.Points[1].OneRMWeightKg != 100 {
		t.Errorf("evidence = %v x %v, want 5 x 100",
			got.Points[1].OneRMReps, got.Points[1].OneRMWeightKg)
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
	if p.OneRMWeightKg == nil || *p.OneRMWeightKg != 100 {
		t.Errorf("the estimate came from the %vkg set; 5x100 is stronger evidence "+
			"than 1x110 and the two record kinds must be free to disagree",
			p.OneRMWeightKg)
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
