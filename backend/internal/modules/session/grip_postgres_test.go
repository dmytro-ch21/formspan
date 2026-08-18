package session

import (
	"context"
	"errors"
	"slices"
	"strings"
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
	// And the narrower sentinel, which is what `writeErr` turns into the
	// `invalid_grip` code the phone repairs on. Asserting only the broad one —
	// as this test did until the code existed — passes for a repository that has
	// forgotten grips are special, because `ErrInvalidGrip` wraps `ErrInvalidInput`
	// and every weaker answer satisfies the check above.
	if !errors.Is(err, ErrInvalidGrip) {
		t.Fatalf("error %v does not wrap ErrInvalidGrip, so this refusal reaches the "+
			"client as a generic invalid_input and no client can act on it", err)
	}
}

// The migration that widened the vocabulary has to be exercised through the
// DATABASE, not just through Go's `ValidGrip`. The handler check and the CHECK
// constraint are two independent lists, and 000058 rewrote the second one — a
// Go-only test would pass with the constraint still naming four values, and the
// failure would appear as a 400 on a grip the app happily offers.
func TestTheDatabaseAcceptsTheGripsN9Added(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	for _, g := range []Grip{GripMixed, GripHook} {
		id := "ses-grip-" + string(g)
		cleanup(t, pool, id)
		got, err := repo.Create(ctx, strengthSession(id, "user_n9", []Set{
			{ExerciseID: exBench, Reps: ptrInt(5), Grip: ptrGrip(g), Completed: true},
		}))
		if err != nil {
			t.Fatalf("the database refused %q: %v — migration 000058 did not widen "+
				"session_sets_grip_valid", g, err)
		}
		// Round-tripped, not merely accepted: a column that stored it and read
		// back nil would be the same silent erasure T4 was about.
		if len(got.Sets) != 1 || got.Sets[0].Grip == nil || *got.Sets[0].Grip != g {
			t.Fatalf("stored %q but read back %v", g, got.Sets[0].Grip)
		}
	}
}

// 000058 DROPS and re-ADDs the CHECK, and `translatePgError` selects the
// `invalid_grip` wire code by matching the substring "grip" in the constraint
// NAME. Re-adding it as, say, `session_sets_hold_valid` would compile, migrate
// cleanly, keep refusing bad grips — and silently downgrade the refusal to a
// generic `invalid_input`, at which point stale clients stop repairing
// themselves and just fail to sync.
//
// Nothing about that is visible in the migration diff, so it is asserted here
// against the live database rather than trusted.
func TestTheGripConstraintKeepsTheNameTheWireCodeDependsOn(t *testing.T) {
	_, pool := newTestRepo(t)
	ctx := context.Background()

	var name string
	err := pool.QueryRow(ctx, `
		SELECT conname FROM pg_constraint
		WHERE conrelid = 'session_sets'::regclass
		  AND contype = 'c'
		  AND pg_get_constraintdef(oid) LIKE '%grip%'`).Scan(&name)
	if err != nil {
		t.Fatalf("no CHECK constraint on session_sets mentions grip: %v", err)
	}
	if !strings.Contains(name, "grip") {
		t.Fatalf("the grip CHECK is named %q, which does not contain \"grip\" — "+
			"translatePgError matches on that substring to return ErrInvalidGrip, so "+
			"every unknown grip now reaches the client as a generic invalid_input and "+
			"no phone can repair itself", name)
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
func TestGripIsAskedWhereTheVocabularyCanAnswerIt(t *testing.T) {
	for _, p := range []string{
		"horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull", "isolation",
		// N9: these three were in the WITHHELD list until `mixed` and `hook`
		// existed. The inversion is the feature — 93 of 762 exercises, and the
		// ones where grip matters most.
		"hinge", "carry", "olympic",
	} {
		if !GripApplies(p) {
			t.Errorf("GripApplies(%q) = false, want true", p)
		}
	}
	for _, p := range []string{
		// Meaningless — no vocabulary would make the question worth asking.
		"squat", "lunge", "jump", "locomotion", "mobility", "core", "rotation", "grappling",
		// And an exercise whose pattern the client could not load.
		"",
	} {
		if GripApplies(p) {
			t.Errorf("GripApplies(%q) = true, want false", p)
		}
	}
}

// The per-pattern subsets, which are a question-quality rule rather than a
// constraint — nothing server-side refuses an odd pairing, so these assertions
// ARE the specification.
func TestGripsForOffersOnlyWhatTheMovementCanUse(t *testing.T) {
	four := []Grip{GripRegular, GripNeutral, GripReverse, GripAngled}
	for _, p := range []string{
		"horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull", "isolation",
	} {
		if got := GripsFor(p); !slices.Equal(got, four) {
			t.Errorf("GripsFor(%q) = %v, want the original four", p, got)
		}
	}

	// `mixed` on hinges ALONE. You do not mix-grip a snatch, and a mixed
	// farmer's carry is not a thing — offering it there would relocate the
	// false-entry mistake this feature exists to fix rather than remove it.
	if !slices.Contains(GripsFor("hinge"), GripMixed) {
		t.Error("a hinge cannot offer mixed, which is the one movement family it belongs to")
	}
	for _, p := range []string{
		"carry", "olympic", "horizontal_push", "horizontal_pull",
		"vertical_push", "vertical_pull", "isolation",
	} {
		if slices.Contains(GripsFor(p), GripMixed) {
			t.Errorf("GripsFor(%q) offers mixed", p)
		}
	}

	// `neutral` on hinges and olympic lifts reads wrong and is not: the catalog
	// files the Hex Bar Deadlift and four kettlebell/dumbbell swings under
	// `hinge`, and 22 of `olympic`'s 25 rows are kettlebell or dumbbell cleans
	// and snatches. Removing it — the obvious tidy-up — takes the control away
	// from most of the bucket.
	for _, p := range []string{"hinge", "olympic"} {
		if !slices.Contains(GripsFor(p), GripNeutral) {
			t.Errorf("GripsFor(%q) dropped neutral; check the catalog before "+
				"deciding that is right", p)
		}
	}

	// The four originals stay OFF the new patterns where they are meaningless.
	for _, p := range []string{"hinge", "carry", "olympic"} {
		if slices.Contains(GripsFor(p), GripAngled) {
			t.Errorf("GripsFor(%q) offers angled", p)
		}
	}
	if slices.Contains(GripsFor("olympic"), GripReverse) {
		t.Error("GripsFor(olympic) offers reverse")
	}

	// Emptiness IS GripApplies, so the two can never disagree.
	for _, p := range []string{"squat", "core", ""} {
		if len(GripsFor(p)) != 0 {
			t.Errorf("GripsFor(%q) is non-empty but the question is meaningless", p)
		}
	}

	// Every offered value must be a real grip. A typo here would ship a chip
	// the server then refuses with `invalid_grip`, which the phone would
	// silently drop — the athlete taps it and nothing sticks.
	for _, p := range []string{
		"horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull",
		"isolation", "hinge", "carry", "olympic",
	} {
		for _, g := range GripsFor(p) {
			if !ValidGrip(g) {
				t.Errorf("GripsFor(%q) offers %q, which ValidGrip refuses", p, g)
			}
		}
	}
}
