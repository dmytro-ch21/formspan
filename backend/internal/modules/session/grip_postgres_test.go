package session

import (
	"context"
	"errors"
	"slices"
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

// GripApplies has no backend caller — the clients gate their pickers on their
// own copy of this list — so without a test nothing pins it at all, and an
// uncalled source of truth is exactly how the two copies drift apart.
//
// The exclusions are the half worth pinning: squats, jumps and conditioning,
// where no vocabulary would make the question worth asking.
//
// This comment used to say hinges, carries and olympic lifts were absent
// "BECAUSE the enum has no `mixed` or `hook`", and warned that adding those
// values without revisiting the list would leave the picker hidden. N9 added
// them and DID revisit the list — but not this paragraph, which then sat as a
// flat self-contradiction directly above a body asserting all three are
// present. Three separate review passes swept for exactly this class of rot and
// all three missed it, including the one that found six other instances.
// GripsFor must hand every caller its own slice.
//
// The doc above declares this deliberate and load-bearing, and review measured
// it surviving: swapping the literals for package-level tables passed both
// existing tests. Unobservable today — there is no backend caller — but the
// client's `offeredGrips` builds on this list, and a shared table that one
// caller sorts is corrupted for every later one.
func TestGripsForReturnsAFreshSliceEachCall(t *testing.T) {
	for _, p := range []string{"hinge", "carry", "olympic", "horizontal_push", "isolation"} {
		a, b := GripsFor(p), GripsFor(p)
		if len(a) == 0 {
			t.Fatalf("GripsFor(%q) is empty; the fixture is wrong", p)
		}
		if &a[0] == &b[0] {
			t.Errorf("GripsFor(%q) returns the SAME backing array twice — one caller "+
				"sorting or writing in place corrupts it for every later one", p)
		}
		// And prove it concretely rather than by pointer identity alone.
		a[0] = GripHook
		if GripsFor(p)[0] == GripHook && b[0] != GripHook {
			t.Errorf("writing to GripsFor(%q)'s result changed what later callers see", p)
		}
	}
}

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

	// The three new patterns, pinned as FULL SETS rather than by membership.
	//
	// Membership spot-checks were what shipped in #266, and review measured
	// four mutations surviving them: hinge losing `hook`, carry/olympic losing
	// `hook`, hinge losing `regular`, hinge gaining `reverse` — all green.
	// `hook` had no positive assertion anywhere, which is half of N9's headline
	// unpinned, and since `GripsFor` has no backend caller this test is the
	// only server-side pin there is. An equality is the whole specification;
	// a `Contains` is one clause of it.
	if got := GripsFor("hinge"); !slices.Equal(got, []Grip{GripRegular, GripNeutral, GripMixed, GripHook}) {
		t.Errorf("GripsFor(hinge) = %v, want regular/neutral/mixed/hook", got)
	}
	for _, p := range []string{"carry", "olympic"} {
		if got := GripsFor(p); !slices.Equal(got, []Grip{GripRegular, GripNeutral, GripHook}) {
			t.Errorf("GripsFor(%q) = %v, want regular/neutral/hook", p, got)
		}
	}

	// `mixed` on hinges ALONE, kept as its own assertion because it is the one
	// property the equalities above would still satisfy if every subset were
	// rewritten together by someone who thought mixed belonged on a carry.
	for _, p := range []string{
		"carry", "olympic", "horizontal_push", "horizontal_pull",
		"vertical_push", "vertical_pull", "isolation",
	} {
		if slices.Contains(GripsFor(p), GripMixed) {
			t.Errorf("GripsFor(%q) offers mixed", p)
		}
	}

	// `neutral` on hinges and olympic lifts reads wrong and is not. Counted from
	// the seed catalog: 20 of `hinge`'s 55 rows are kettlebell, dumbbell or
	// hex-bar, and 12 of `olympic`'s 25 are kettlebell (11) or dumbbell (1).
	// Neither is a majority — olympic is 13 barbell — which is the point: both
	// buckets are split, so dropping either value strands a real half.
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

	// Emptiness IS GripApplies — asserted rather than assumed. The two agree by
	// construction today, but `GripApplies` is one edit away from being an
	// independent switch that happens to match, and nothing else would notice.
	for _, p := range []string{
		"horizontal_push", "horizontal_pull", "vertical_push", "vertical_pull",
		"isolation", "hinge", "carry", "olympic", "squat", "core", "", "not_a_pattern",
	} {
		if GripApplies(p) != (len(GripsFor(p)) > 0) {
			t.Errorf("GripApplies(%q) = %v but GripsFor gives %d values — these have "+
				"come apart", p, GripApplies(p), len(GripsFor(p)))
		}
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
