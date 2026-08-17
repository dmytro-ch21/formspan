package session

import (
	"context"
	"errors"
	"testing"
)

func ptrGrip(g Grip) *Grip { return &g }

// TestGripSurvivesTheWholesaleReplace is T3 made executable.
//
// `ReplaceSets` DELETEs every row of a session and reinserts them, so a new
// per-set column has to be written by `insertSets` AND read back by
// `attachSets` — and the second half is the one that bites. Add the column to
// the INSERT but forget the SELECT, and every client, however correctly it
// passes fields through, PUTs back a set whose grip the server itself just
// failed to hand it. The wipe comes from the server's own read.
//
// So this writes a grip, reads it back, and then writes the READ-BACK sets
// again — which is exactly what a client does on the next edit.
func TestGripSurvivesTheWholesaleReplace(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-grip")

	created, err := repo.Create(ctx, strengthSession("ses-grip", "user_a", []Set{
		{ExerciseID: exBench, Reps: ptrInt(5), WeightKg: ptrF(100),
			Grip: ptrGrip(GripNeutral), Completed: true},
		// Deliberately unrecorded, and it must STAY unrecorded — nil is not
		// `regular`, and a round trip that fills it in would be inventing
		// training nobody logged.
		{ExerciseID: exSquat, Reps: ptrInt(3), WeightKg: ptrF(140), Completed: true},
	}))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Sets[0].Grip == nil || *created.Sets[0].Grip != GripNeutral {
		t.Fatalf("grip came back %v from the create read, want neutral", created.Sets[0].Grip)
	}
	if created.Sets[1].Grip != nil {
		t.Fatalf("an unrecorded grip came back as %v — nil must stay nil", *created.Sets[1].Grip)
	}

	// The second edit, made of what the server handed back. This is the step
	// that wipes the column when either half of the pair is missing.
	again, err := repo.ReplaceSets(ctx, "user_a", "ses-grip", created.Sets)
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if again.Sets[0].Grip == nil || *again.Sets[0].Grip != GripNeutral {
		t.Fatalf("grip is %v after a round trip — the wholesale replace dropped it",
			again.Sets[0].Grip)
	}
	if again.Sets[1].Grip != nil {
		t.Fatalf("an unrecorded grip became %v across a replace", *again.Sets[1].Grip)
	}
}

// The database is the last line, and it is the one that cannot be talked out of
// it. A client that invents a grip gets a 400 from `validateSets`; a caller
// that bypasses the handler gets this.
func TestTheDatabaseRefusesAGripNobodyDefined(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-grip-bad")

	_, err := repo.Create(ctx, strengthSession("ses-grip-bad", "user_a", []Set{
		{ExerciseID: exBench, Reps: ptrInt(5), Grip: ptrGrip("banana"), Completed: true},
	}))
	if err == nil {
		t.Fatal("an unknown grip was stored — the CHECK constraint is not doing its job")
	}
	// Not merely "an error": the module's rule is that no raw SQL error escapes
	// a repository. Asserting only `err != nil` would pass while leaking a
	// pgconn.PgError — constraint name, table name and all — to the client.
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("error %v does not wrap ErrInvalidInput, so this is a 500 and a leaked "+
			"driver message rather than a 400", err)
	}
}

// GripApplies has no backend caller — the clients gate their pickers on their
// own copy of this list — so without a test nothing pins it at all, and an
// uncalled source of truth is exactly how the two copies drift apart.
//
// The exclusions are the half worth pinning. Hinges, carries and olympic lifts
// are absent BECAUSE the enum has no `mixed` or `hook`; if someone adds those
// values later and this list is not revisited, the picker stays hidden on the
// movements the new values exist for.
func TestGripIsOnlyAskedWhereTheseFourAnswerIt(t *testing.T) {
	for _, p := range []string{
		"horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull", "isolation",
	} {
		if !GripApplies(p) {
			t.Errorf("GripApplies(%q) = false, want true", p)
		}
	}
	for _, p := range []string{
		// Meaningless.
		"squat", "lunge", "jump", "locomotion", "mobility", "core", "rotation", "grappling",
		// Withheld: their real answer is `mixed` or `hook`. See N9.
		"hinge", "carry", "olympic",
		// And an exercise whose pattern the client could not load.
		"",
	} {
		if GripApplies(p) {
			t.Errorf("GripApplies(%q) = true, want false", p)
		}
	}
}
