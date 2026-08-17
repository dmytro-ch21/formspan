package exercise

import "testing"

// The same bug the grip work shipped, on the column that replaced the derived
// factor — and it was reintroduced here rather than inherited.
//
// `Restore` feeds a revision's JSON payload to `updateWithin`, and this change
// put `implements` in that UPDATE's SET clause. Every revision in existence
// predates migration 000056, so every snapshot has no `implements` key: it
// unmarshals to 0, `NormalizeImplements` reads that as 1, and restoring a
// description edit silently halves a pair of dumbbells. CHECK passes, 200
// returned, and the console's revision list renders only the name.
//
// The `load_mode` guard directly above this one exists for exactly this, and
// its own comment says the two must stay in step. They did not, for one commit.
func TestRestoringAPreImplementsRevisionDoesNotHalveTheExercise(t *testing.T) {
	repo, ctx, id := contentFixture(t)

	pair := authored(id)
	pair.LoadMode = LoadModePerSide
	pair.Implements = 2
	if _, err := repo.CreateExercise(ctx, pair, testActor); err != nil {
		t.Fatalf("create: %v", err)
	}

	// A snapshot shaped the way pre-000056 code wrote one: no `implements` key.
	// Literal JSON rather than a marshalled Exercise, because the current
	// struct always emits the key and would reproduce today's shape instead.
	if _, err := repo.pool.Exec(ctx, `
		INSERT INTO exercise_revisions (exercise_id, revision, actor, action, payload)
		VALUES ($1, 97, 'user_fixture', 'update', $2::jsonb)
		ON CONFLICT (exercise_id, revision) DO UPDATE SET payload = EXCLUDED.payload`,
		id, `{"id":"`+id+`","name":"Zercher Squat","sport":"strength",
		      "movement_pattern":"squat","load_type":"weight_reps","is_unilateral":false,
		      "load_mode":"per_side","primary_muscles":[],"secondary_muscles":[],"equipment":[]}`); err != nil {
		t.Fatalf("seed pre-implements revision: %v", err)
	}

	restored, err := repo.Restore(ctx, id, 97, testActor)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restored.Implements != 2 {
		t.Fatalf("restore set implements to %d, want 2 — a revision that predates the "+
			"column says nothing about it, and reading that silence as 1 halves every "+
			"logged set of this exercise", restored.Implements)
	}

	// Read the column back: the RETURNING used to hide this exact class of bug
	// by re-reading a value the SET had not touched.
	var stored int
	if err := repo.pool.QueryRow(ctx,
		`SELECT implements FROM exercises WHERE id = $1`, id).Scan(&stored); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored != 2 {
		t.Fatalf("the column holds %d after the restore, want 2", stored)
	}
}

// And the other half, which "always preserve" would break: a revision that DOES
// carry a count must be restorable to it.
func TestRestoringAModernRevisionAppliesItsImplements(t *testing.T) {
	repo, ctx, id := contentFixture(t)

	pair := authored(id)
	pair.LoadMode = LoadModePerSide
	pair.Implements = 2
	if _, err := repo.CreateExercise(ctx, pair, testActor); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := repo.pool.Exec(ctx, `
		INSERT INTO exercise_revisions (exercise_id, revision, actor, action, payload)
		VALUES ($1, 96, 'user_fixture', 'update', $2::jsonb)
		ON CONFLICT (exercise_id, revision) DO UPDATE SET payload = EXCLUDED.payload`,
		id, `{"id":"`+id+`","name":"Zercher Squat","sport":"strength",
		      "movement_pattern":"squat","load_type":"weight_reps","is_unilateral":true,
		      "load_mode":"per_side","implements":1,"primary_muscles":[],
		      "secondary_muscles":[],"equipment":[]}`); err != nil {
		t.Fatalf("seed revision: %v", err)
	}

	restored, err := repo.Restore(ctx, id, 96, testActor)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restored.Implements != 1 {
		t.Fatalf("restore left implements at %d, want 1 — a revision that names a value "+
			"must be restorable, or the absent-key rule has become 'never change this "+
			"column'", restored.Implements)
	}
}

// A pre-000056 revision must not be SERVED with `"implements": 0` either: the
// contract's enum admits 1 and 2, on a field this change made required.
func TestAnOldRevisionReportsALegalImplementCount(t *testing.T) {
	repo, ctx, id := contentFixture(t)

	if _, err := repo.CreateExercise(ctx, authored(id), testActor); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := repo.pool.Exec(ctx, `
		INSERT INTO exercise_revisions (exercise_id, revision, actor, action, payload)
		VALUES ($1, 95, 'user_fixture', 'create', $2::jsonb)
		ON CONFLICT (exercise_id, revision) DO UPDATE SET payload = EXCLUDED.payload`,
		id, `{"id":"`+id+`","name":"Zercher Squat","sport":"strength",
		      "movement_pattern":"squat","load_type":"weight_reps","is_unilateral":false,
		      "primary_muscles":[],"secondary_muscles":[],"equipment":[]}`); err != nil {
		t.Fatalf("seed revision: %v", err)
	}

	revs, err := repo.Revisions(ctx, id)
	if err != nil {
		t.Fatalf("revisions: %v", err)
	}
	if len(revs) == 0 {
		t.Fatal("no revisions came back")
	}
	for _, r := range revs {
		if r.Payload.Implements != 1 && r.Payload.Implements != 2 {
			t.Fatalf("revision %d serves implements=%d, which the contract's enum "+
				"does not admit", r.Revision, r.Payload.Implements)
		}
	}
}
