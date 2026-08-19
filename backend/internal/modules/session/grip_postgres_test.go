package session

import (
	"context"
	"errors"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/modules/exercise"
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

	// EVERY grip-mentioning CHECK, not the first one an unordered scan returns:
	// with a second such constraint a badly-named one could hide behind a
	// well-named one and this test would flap rather than fail.
	var total, named int
	var offenders []string
	err := pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE conname LIKE '%grip%'),
		       coalesce(array_agg(conname) FILTER (WHERE conname NOT LIKE '%grip%'), '{}')
		FROM pg_constraint
		WHERE conrelid = 'session_sets'::regclass
		  AND contype = 'c'
		  AND pg_get_constraintdef(oid) LIKE '%grip%'`).Scan(&total, &named, &offenders)
	if err != nil {
		t.Fatalf("querying session_sets CHECK constraints: %v", err)
	}
	if total == 0 {
		t.Fatal("no CHECK constraint on session_sets mentions grip at all")
	}
	if named != total {
		// Names the OFFENDER. The first version printed a count here, so the
		// message read `named "all 1"` — a diagnostic that misidentifies itself
		// at exactly the moment somebody needs it.
		t.Fatalf("grip CHECK constraint(s) %v do not contain \"grip\" in the name — "+
			"translatePgError matches on that substring to return ErrInvalidGrip, so "+
			"every unknown grip now reaches the client as a generic invalid_input and "+
			"no phone can repair itself", offenders)
	}
}

// TestEveryOfferedGripIsInTheVocabulary is the seam between the two packages
// that used to be one.
//
// `exercise.OfferedGrips` names which grips a movement should OFFER; `ValidGrip`
// here names which grips EXIST. They were the same file until N16 served the
// first one, and nothing in the type system now stops them naming different
// things — `OfferedGrips` returns plain strings precisely so the catalog does
// not have to import the logging module.
//
// So this is the guard. A typo in a subset would ship a chip the server then
// refuses with `invalid_grip`, which the phone silently drops: the athlete taps
// it and nothing sticks. Lives on this side because this side owns the
// vocabulary; a test-only import of `exercise` creates no production cycle.
func TestEveryOfferedGripIsInTheVocabulary(t *testing.T) {
	// Derived, not mirrored: a ninth pattern gaining grips is checked the day it
	// is added, rather than the day somebody remembers this list exists.
	patterns := exercise.PatternsWithGrips()
	if len(patterns) == 0 {
		t.Fatal("PatternsWithGrips is empty, so this test would pass vacuously")
	}
	for _, p := range patterns {
		for _, g := range exercise.OfferedGrips(p) {
			if !ValidGrip(Grip(g)) {
				t.Errorf("OfferedGrips(%q) offers %q, which ValidGrip refuses", p, g)
			}
		}
	}
}
