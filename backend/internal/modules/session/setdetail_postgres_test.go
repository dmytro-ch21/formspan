package session

import (
	"context"
	"testing"
	"time"
)

// TestAssistedRepsSurviveTheRoundTrip is the one that matters: `ReplaceSets`
// deletes every row of a session and reinserts it on each save, so a column
// missing from either the INSERT or the SELECT loses the athlete's data on the
// very next edit — silently, because nothing else changes.
func TestAssistedRepsSurviveTheRoundTrip(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user, id = "u_assist", "ses-assist"
	cleanup(t, pool, id)

	if _, err := repo.Create(ctx, NewSession{
		ID: id, UserID: user, Sport: "strength", Name: "Bench",
		StartedAt: time.Now().UTC().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	// "225 for 5, then 3 more with a spotter" — 8 reps, 3 of them helped.
	// Plus a set with assistance explicitly recorded as none, and one with it
	// unrecorded, because those are three different claims.
	if _, err := repo.ReplaceSets(ctx, user, id, []Set{
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(8), WeightKg: ptrF(102.5),
			AssistedReps: ptrInt(3), Completed: true},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(102.5),
			AssistedReps: ptrInt(0), Completed: true},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(102.5),
			Completed: true},
	}); err != nil {
		t.Fatalf("replace sets: %v", err)
	}

	got, err := repo.Get(ctx, user, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got.Sets) != 3 {
		t.Fatalf("want 3 sets, got %d", len(got.Sets))
	}
	if got.Sets[0].AssistedReps == nil || *got.Sets[0].AssistedReps != 3 {
		t.Fatalf("assisted reps did not survive: %v", got.Sets[0].AssistedReps)
	}
	if got.Sets[0].SoloReps() != 5 {
		t.Fatalf("solo reps %d, want 5", got.Sets[0].SoloReps())
	}
	// Explicit zero and unrecorded must stay distinguishable across the wire.
	if got.Sets[1].AssistedReps == nil || *got.Sets[1].AssistedReps != 0 {
		t.Fatalf("an explicit zero came back as %v — 0 and NULL are different claims",
			got.Sets[1].AssistedReps)
	}
	if got.Sets[2].AssistedReps != nil {
		t.Fatalf("unrecorded assistance came back as %v", *got.Sets[2].AssistedReps)
	}

	// Assisted reps are still reps: the volume rule must not have changed.
	// 8 + 5 + 5 = 18, and tonnage counts all of them.
	v := Summarise(got.Sets)
	if v.TotalReps != 18 {
		t.Fatalf("total reps %d, want 18 — assisted reps are still reps", v.TotalReps)
	}
	if v.WorkingSets != 3 {
		t.Fatalf("working sets %d, want 3 — a spotted set is ONE set", v.WorkingSets)
	}
}

// The CHECK is the last line, but the handler should answer first, naming the
// set. A database error that says "a value is out of range" with no set number
// is what this guards against.
func TestMoreHelpThanRepsIsRejected(t *testing.T) {
	if err := validateSets([]Set{
		{ExerciseID: exBench, Reps: ptrInt(5), AssistedReps: ptrInt(8)},
	}); err == nil {
		t.Fatal("accepted more assisted reps than reps performed")
	}
	if err := validateSets([]Set{
		{ExerciseID: exBench, AssistedReps: ptrInt(2)},
	}); err == nil {
		t.Fatal("accepted assisted reps on a set with no reps")
	}
	if err := validateSets([]Set{
		{ExerciseID: exBench, Reps: ptrInt(8), AssistedReps: ptrInt(0)},
	}); err != nil {
		t.Fatalf("rejected a legitimate explicit zero: %v", err)
	}
}
