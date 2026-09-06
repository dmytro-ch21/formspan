package session

import (
	"context"
	"testing"
	"time"
)

// ShadowReplayCandidates feeds cmd/shadowreplay (N515/#903); these pin the
// query underneath it against a real database, the same discipline
// recent_efforts_test.go already gives RecentEfforts/RecentEffortsV2.

func TestShadowReplayCandidates_FindsAFinishedWeightedWorkingSet(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-shadow-finished")

	in := strengthSession("ses-shadow-finished", "user_shadow_finished", []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RIR: ptrInt(2), Completed: true},
	})
	ended := in.StartedAt.Add(50 * time.Minute)
	in.EndedAt = &ended
	if _, err := repo.Create(ctx, in); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.ShadowReplayCandidates(ctx)
	if err != nil {
		t.Fatalf("ShadowReplayCandidates: %v", err)
	}
	if !containsCandidate(got, "user_shadow_finished", exSquat) {
		t.Fatalf("expected (user_shadow_finished, %s) among candidates, got %d candidates", exSquat, len(got))
	}
}

// The open session must never count — the exact "current session becomes
// its own history" failure RecentEffortsV2 was built to close, one layer
// earlier: an unfinished session must not even be a candidate to replay.
func TestShadowReplayCandidates_ExcludesAnUnfinishedSession(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-shadow-open")

	in := strengthSession("ses-shadow-open", "user_shadow_open", []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RIR: ptrInt(2), Completed: true},
	})
	// strengthSession leaves EndedAt nil — still open.
	if _, err := repo.Create(ctx, in); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.ShadowReplayCandidates(ctx)
	if err != nil {
		t.Fatalf("ShadowReplayCandidates: %v", err)
	}
	if containsCandidate(got, "user_shadow_open", exSquat) {
		t.Fatalf("an unfinished session must never produce a shadow-replay candidate")
	}
}

// A warm-up, an incomplete set, and a non-weight_reps exercise (exPullUp, a
// reps-only bodyweight movement — same "strength" sport as the rest of this
// fixture session, unlike exRun, so it can share one session with them) must
// all be excluded — none of them is something either engine can build a
// prescription from, so a candidate naming one would send cmd/shadowreplay
// to a pair that trivially reads SuggestNoHistory/SuggestNotApplicable on
// both sides and never actually disagrees.
func TestShadowReplayCandidates_ExcludesUnusableSets(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-shadow-unusable")

	in := strengthSession("ses-shadow-unusable", "user_shadow_unusable", []Set{
		{ExerciseID: exSquat, SetType: SetTypeWarmup, Reps: ptrInt(5), WeightKg: ptrF(60), Completed: true},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: false},
		{ExerciseID: exPullUp, SetType: SetTypeWorking, Reps: ptrInt(8), Completed: true},
	})
	ended := in.StartedAt.Add(50 * time.Minute)
	in.EndedAt = &ended
	if _, err := repo.Create(ctx, in); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.ShadowReplayCandidates(ctx)
	if err != nil {
		t.Fatalf("ShadowReplayCandidates: %v", err)
	}
	if containsCandidate(got, "user_shadow_unusable", exSquat) {
		t.Errorf("a warm-up-only exercise must not produce a candidate")
	}
	if containsCandidate(got, "user_shadow_unusable", exBench) {
		t.Errorf("an incomplete set must not produce a candidate")
	}
	if containsCandidate(got, "user_shadow_unusable", exPullUp) {
		t.Errorf("a non-weight_reps exercise must not produce a candidate")
	}
}

func containsCandidate(got []ProgressionCandidate, userID, exerciseID string) bool {
	for _, c := range got {
		if c.UserID == userID && c.ExerciseID == exerciseID {
			return true
		}
	}
	return false
}
