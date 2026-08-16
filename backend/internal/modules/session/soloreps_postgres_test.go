package session

import (
	"context"
	"testing"
	"time"
)

// TestTheSoloRuleReachesTheDatabase is the half unit tests cannot reach.
//
// Every query involved builds `Set` values from its own projection, and a
// column missing from ANY of them reads as nil — which `SoloReps` treats as
// "all solo". So the fix looks applied, compiles, and passes hand-built
// fixtures while the database path silently keeps the old behaviour. That trap
// is why T1 had to land with W1 rather than after it.
func TestTheSoloRuleReachesTheDatabase(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user, id = "u_solo", "ses-solo"
	cleanup(t, pool, id)

	if _, err := repo.Create(ctx, NewSession{
		ID: id, UserID: user, Sport: "strength", Name: "Bench",
		StartedAt: time.Now().UTC().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	// Eight reps at 102.5 with a spotter on three: five unaided.
	if _, err := repo.ReplaceSets(ctx, user, id, []Set{
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(8), WeightKg: ptrF(102.5),
			AssistedReps: ptrInt(3), Completed: true},
	}); err != nil {
		t.Fatalf("replace sets: %v", err)
	}

	// The estimate, through the repository rather than the pure function.
	best, err := repo.BestOneRMs(ctx, user, []string{exBench})
	if err != nil {
		t.Fatalf("best 1rm: %v", err)
	}
	want := 102.5 * 36 / (37 - 5) // five solo reps
	if got := best[exBench]; got < want-0.01 || got > want+0.01 {
		t.Fatalf("best 1RM %.2f, want %.2f — the query is still reading full reps", got, want)
	}

	// And the rep PR, which needs a REPS-ONLY exercise: `RecordMostReps` exists
	// only for `load_type: 'reps'`, i.e. bodyweight work. That is not a
	// technicality — band- and machine-assisted pull-ups ARE that case, and are
	// the flagship reason to record assistance at all.
	//
	// The first version of this asserted against a barbell exercise, where no
	// such record is ever produced. It passed, and mutating the projection left
	// it passing, because the loop body never ran. Hence `sawRepRecord`: an
	// assertion inside a filter needs proof the filter matched something.
	const pullUp = "archer-pull-up"
	if _, err := repo.ReplaceSets(ctx, user, id, []Set{
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(8), WeightKg: ptrF(102.5),
			AssistedReps: ptrInt(3), Completed: true},
		// Twelve with four assisted is EIGHT unaided...
		{ExerciseID: pullUp, SetType: SetTypeWorking, Reps: ptrInt(12),
			AssistedReps: ptrInt(4), Completed: true},
		// ...so this clean nine beats it, even though twelve is the bigger
		// number. Without a competing set the test could not tell a solo
		// ranking from a full-reps one.
		{ExerciseID: pullUp, SetType: SetTypeWorking, Reps: ptrInt(9), Completed: true},
	}); err != nil {
		t.Fatalf("replace sets with a bodyweight exercise: %v", err)
	}

	recs, err := repo.Records(ctx, user, []string{pullUp})
	if err != nil {
		t.Fatalf("records: %v", err)
	}
	sawRepRecord := false
	for _, er := range recs {
		if er.ExerciseID != pullUp {
			continue
		}
		for _, rec := range er.Records {
			if rec.Kind != RecordMostReps {
				continue
			}
			sawRepRecord = true
			// The clean nine wins: eight unaided loses to nine unaided, even
			// though the assisted set logged the larger number.
			if rec.Reps == nil || *rec.Reps != 9 {
				t.Fatalf("rep record is %v, want 9 — twelve reps with four assisted is eight "+
					"unaided, so a clean nine beats it", rec.Reps)
			}
			// And the evidence is what was logged, not a derived figure. `reps`
			// is the full count with the assistance alongside, so one response
			// never carries two meanings for the same field.
			if rec.AssistedReps != nil {
				t.Fatalf("the winning set had no assistance, yet reported %v", *rec.AssistedReps)
			}
		}
	}
	if !sawRepRecord {
		t.Fatal("no most_reps record came back, so the assertion above never ran")
	}

	// The progression path reads it too, and reports both numbers so a client
	// can show "8 (5 alone)" without inferring either.
	efforts, err := repo.RecentEfforts(ctx, user, []string{exBench})
	if err != nil {
		t.Fatalf("recent efforts: %v", err)
	}
	found := false
	for _, in := range efforts {
		for _, eff := range in.Recent {
			for _, s := range eff.Sets {
				if s.AssistedReps == nil {
					continue
				}
				found = true
				if *s.AssistedReps != 3 || s.SoloReps() != 5 {
					t.Fatalf("recent effort carried assisted=%v solo=%d", *s.AssistedReps, s.SoloReps())
				}
			}
		}
	}
	if !found {
		t.Fatal("no recent effort carried assisted_reps — progression cannot see the split")
	}
}
