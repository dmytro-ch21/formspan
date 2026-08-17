package exercise

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestAdminAuthoredCarriesLoadMode closes a data-loss path that CI structurally
// cannot see.
//
// `cmd/exportcontent` writes `exercises.json` from `AdminAuthored`. When
// `contentReturning` omitted `load_mode`, every row came back with `""`, the
// export wrote that over the file's real value, and the next deploy —
// specifically BECAUSE this branch added `load_mode` to the seeder's
// change-detection tuple — actively rewrote `per_side` back to `total`.
// Dumbbell tonnage for that exercise then halves again: the exact bug the whole
// change exists to kill, reintroduced through the content pipeline.
//
// **A CI database never exercises it.** The path needs a row with
// `source='admin'`, and CI seeds nothing and authors nothing, so the export
// reports "nothing authored in the console; files untouched" and a green run
// proves the round trip works when it has not been run at all. Both review
// passes reproduced this only by forcing a row to admin ownership by hand,
// which is what this test does.
func TestAdminAuthoredCarriesLoadMode(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	const id = "lm_admin_db_press"
	if _, err := pool.Exec(ctx, `
		INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status, source, load_mode)
		VALUES ($1, 'Fixture Dumbbell Press', 'strength', 'push', 'weight_reps', 'published', 'admin', 'per_side')
		ON CONFLICT (id) DO UPDATE SET source = 'admin', load_mode = 'per_side'`, id); err != nil {
		t.Fatalf("seed admin exercise: %v", err)
	}
	t.Cleanup(func() {
		// Logged rather than swallowed: `vola_test` is shared by every
		// worktree, so a fixture that fails to clean up outlives this run.
		if _, err := pool.Exec(context.Background(), `DELETE FROM exercises WHERE id = $1`, id); err != nil {
			t.Logf("cleanup %s: %v", id, err)
		}
	})

	rows, err := NewPostgresRepository(pool).AdminAuthored(ctx)
	if err != nil {
		t.Fatalf("admin authored: %v", err)
	}
	for _, e := range rows {
		if e.ID != id {
			continue
		}
		if e.LoadMode != LoadModePerSide {
			t.Fatalf("AdminAuthored returned load_mode %q for a per_side exercise — the export "+
				"writes this straight into exercises.json, so %q would become 'total' on the "+
				"next deploy and halve this exercise's tonnage", e.LoadMode, e.LoadMode)
		}
		return
	}
	t.Fatalf("%s did not come back from AdminAuthored at all", id)
}

// TestTheCatalogReadPathCarriesLoadMode covers the OTHER select — the public
// one, which every client actually reads.
//
// `AdminAuthored` has a test above because dropping `load_mode` there corrupts
// the seed file. Dropping it from `selectColumns` is quieter and reaches
// further: `GET /v1/exercises` and `GET /v1/exercises/{id}` are where the
// phone and the web session page learn that a movement is entered per hand, so
// an empty value there does not break anything — it silently stops telling the
// athlete which number to type, on all 142 of them, while every arithmetic
// test in the repository still passes because the tonnage rule reads the
// column directly in SQL and never goes near this path.
//
// The contract now lists `load_mode` in `Exercise.required`, which is the
// promise this test is the enforcement for.
func TestTheCatalogReadPathCarriesLoadMode(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	// Owned by this test rather than borrowed from the catalog: a seeded row
	// would make the assertion depend on `exercise`'s own Seed() having run,
	// which is the cross-package dependency this repository just finished
	// removing everywhere else.
	const id = "lm_read_db_press"
	if _, err := pool.Exec(ctx, `
		INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status, source, load_mode)
		VALUES ($1, 'Fixture Read Path Press', 'strength', 'push', 'weight_reps', 'published', 'seed', 'per_side')
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name, sport = EXCLUDED.sport,
			movement_pattern = EXCLUDED.movement_pattern, load_type = EXCLUDED.load_type,
			status = EXCLUDED.status, source = EXCLUDED.source,
			load_mode = EXCLUDED.load_mode`, id); err != nil {
		t.Fatalf("seed exercise: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM exercises WHERE id = $1`, id); err != nil {
			t.Logf("cleanup %s: %v", id, err)
		}
	})

	repo := NewPostgresRepository(pool)

	got, err := repo.Get(ctx, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.LoadMode != LoadModePerSide {
		t.Fatalf("Get returned load_mode %q, want %q — a client reading this cannot tell the "+
			"athlete to enter one dumbbell", got.LoadMode, LoadModePerSide)
	}

	// Both, because they are two different SQL statements sharing one column
	// list, and a change that reaches one can miss the other.
	list, err := repo.List(ctx, Filter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, e := range list {
		if e.ID != id {
			continue
		}
		if e.LoadMode != LoadModePerSide {
			t.Fatalf("List returned load_mode %q, want %q", e.LoadMode, LoadModePerSide)
		}
		return
	}
	t.Fatalf("%s did not come back from List at all", id)
}

// TestAnOldRevisionStillReportsALegalLoadMode covers the one read path whose
// `load_mode` does not come from the column.
//
// A revision is a JSON snapshot, and `exercise_revisions` (migration 000039)
// predates `load_mode` (000052). Any revision written between those two
// deploys has no `load_mode` key: it unmarshals to "" and would go out as
// `"load_mode": ""` — a value the schema's `enum` does not admit, on a field
// this branch just moved into `Exercise.required`.
//
// Restoring such a revision USED to be safe for free, because `updateWithin`
// never wrote the column and the RETURNING re-read the real one. That is no
// longer true — T2 put the column in the SET clause — so restore now needs its
// own absent-key rule, and has one. See
// `TestRestoringAPreColumnRevisionDoesNotSilentlyHalveTheExercise`, which is
// the test this comment used to argue was unnecessary.
func TestAnOldRevisionStillReportsALegalLoadMode(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	const id = "lm_rev_db_press"
	if _, err := pool.Exec(ctx, `
		INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status, source, load_mode)
		VALUES ($1, 'Fixture Revision Press', 'strength', 'push', 'weight_reps', 'draft', 'admin', 'per_side')
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name, sport = EXCLUDED.sport,
			movement_pattern = EXCLUDED.movement_pattern, load_type = EXCLUDED.load_type,
			status = EXCLUDED.status, source = EXCLUDED.source,
			load_mode = EXCLUDED.load_mode`, id); err != nil {
		t.Fatalf("seed exercise: %v", err)
	}
	// Cascades to the revision, so one delete covers both.
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM exercises WHERE id = $1`, id); err != nil {
			t.Logf("cleanup %s: %v", id, err)
		}
	})

	// A payload shaped the way pre-000052 code wrote it: no `load_mode` key at
	// all. Written as literal JSON rather than by marshalling an Exercise,
	// because the current struct always emits the key — marshalling one would
	// reproduce today's shape and prove nothing about the rows this exists for.
	if _, err := pool.Exec(ctx, `
		INSERT INTO exercise_revisions (exercise_id, revision, actor, action, payload)
		VALUES ($1, 1, 'user_fixture', 'create', $2::jsonb)
		ON CONFLICT (exercise_id, revision) DO UPDATE SET payload = EXCLUDED.payload`,
		id, `{"id":"`+id+`","name":"Fixture Revision Press","sport":"strength",
		      "movement_pattern":"push","load_type":"weight_reps","is_unilateral":false}`); err != nil {
		t.Fatalf("seed revision: %v", err)
	}

	revs, err := NewPostgresRepository(pool).Revisions(ctx, id)
	if err != nil {
		t.Fatalf("revisions: %v", err)
	}
	if len(revs) == 0 {
		t.Fatalf("no revisions came back for %s", id)
	}
	if got := revs[0].Payload.LoadMode; got != LoadModeTotal {
		t.Fatalf("revision payload load_mode = %q, want %q — the contract's enum admits "+
			"only 'total' and 'per_side', and this response is typed as an Exercise", got, LoadModeTotal)
	}
}

// TestTheConsoleCanAuthorAndCorrectLoadMode is T2 at the level that matters:
// the column, not the struct.
//
// `createWithin` never wrote `load_mode`, so every exercise created in the
// admin console took the column default `total` — a dumbbell exercise authored
// there reported half its real tonnage from the moment it existed. And
// `updateWithin` did not write it either, so nothing could put it right: the
// omission that protected a deploy-set value from being cleared also made a
// wrong value permanent.
//
// Both halves are covered here, plus the guarantee that replaced the old
// protection — an edit that never mentions the field must write back what is
// already stored.
func TestTheConsoleCanAuthorAndCorrectLoadMode(t *testing.T) {
	repo, ctx, id := contentFixture(t)

	perSide := authored(id)
	perSide.LoadMode = LoadModePerSide
	created, err := repo.CreateExercise(ctx, perSide, testActor)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.LoadMode != LoadModePerSide {
		t.Fatalf("CreateExercise returned load_mode %q, want %q — a console-authored "+
			"dumbbell exercise born 'total' halves its own tonnage forever",
			created.LoadMode, LoadModePerSide)
	}

	// Read back rather than trusting the RETURNING, because the bug this covers
	// was the column never being written at all.
	var stored string
	if err := repo.pool.QueryRow(ctx,
		`SELECT load_mode FROM exercises WHERE id = $1`, id).Scan(&stored); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored != LoadModePerSide {
		t.Fatalf("the column holds %q, want %q", stored, LoadModePerSide)
	}

	// An edit that says nothing about load_mode. This is the handler's shape:
	// merge the request onto the STORED row, then write the whole thing.
	current, err := repo.GetExercise(ctx, id)
	if err != nil {
		t.Fatalf("get for write: %v", err)
	}
	renamed := exerciseRequest{Name: ptr("Zercher Squat (Wide)")}.applyTo(current)
	updated, err := repo.UpdateExercise(ctx, renamed, testActor)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.LoadMode != LoadModePerSide {
		t.Fatalf("a rename reset load_mode to %q — adding the column to the UPDATE "+
			"removed the omission that used to protect it, and the merge is what "+
			"replaces that guarantee", updated.LoadMode)
	}

	// And the correction path: a row already classified wrongly can be fixed,
	// which before this change no endpoint could do.
	fix := exerciseRequest{LoadMode: ptr(LoadModeTotal)}.applyTo(updated)
	fixed, err := repo.UpdateExercise(ctx, fix, testActor)
	if err != nil {
		t.Fatalf("update to total: %v", err)
	}
	if fixed.LoadMode != LoadModeTotal {
		t.Fatalf("load_mode is %q after correcting it to %q", fixed.LoadMode, LoadModeTotal)
	}
}

// TestRestoringAPreColumnRevisionDoesNotSilentlyHalveTheExercise is the bug
// T2's own fix created, found by review and not by any check.
//
// Putting `load_mode` in `updateWithin`'s SET clause removed a guarantee that
// had been free: while the UPDATE never wrote the column, `Restore` could feed
// it any payload and the RETURNING still read back the live value. Now the
// UPDATE writes what Restore hands it — and a revision written before the
// column existed hands it "", which `NormalizeLoadMode` turns into `total`.
//
// So clicking Restore on an old revision of a dumbbell exercise halved it:
// CHECK satisfied, 200 returned, and the console's revision list even displays
// that revision as `total`, which makes the damage look deliberate.
func TestRestoringAPreColumnRevisionDoesNotSilentlyHalveTheExercise(t *testing.T) {
	repo, ctx, id := contentFixture(t)

	perSide := authored(id)
	perSide.LoadMode = LoadModePerSide
	if _, err := repo.CreateExercise(ctx, perSide, testActor); err != nil {
		t.Fatalf("create: %v", err)
	}

	// A snapshot shaped the way pre-000052 code wrote one: no `load_mode` key.
	// Literal JSON rather than a marshalled Exercise, because the current struct
	// always emits the key and would reproduce today's shape instead.
	if _, err := repo.pool.Exec(ctx, `
		INSERT INTO exercise_revisions (exercise_id, revision, actor, action, payload)
		VALUES ($1, 99, 'user_fixture', 'update', $2::jsonb)
		ON CONFLICT (exercise_id, revision) DO UPDATE SET payload = EXCLUDED.payload`,
		id, `{"id":"`+id+`","name":"Zercher Squat","sport":"strength",
		      "movement_pattern":"squat","load_type":"weight_reps","is_unilateral":false,
		      "primary_muscles":[],"secondary_muscles":[],"equipment":[]}`); err != nil {
		t.Fatalf("seed pre-column revision: %v", err)
	}

	restored, err := repo.Restore(ctx, id, 99, testActor)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restored.LoadMode != LoadModePerSide {
		t.Fatalf("restore set load_mode to %q, want %q — a revision that predates the "+
			"column says nothing about it, and reading that silence as 'total' halves "+
			"every logged set of this exercise", restored.LoadMode, LoadModePerSide)
	}

	// Read the column back too: the RETURNING used to hide this exact bug by
	// re-reading a value the SET had not touched, so trusting it here would
	// repeat the mistake that let the bug through.
	var stored string
	if err := repo.pool.QueryRow(ctx,
		`SELECT load_mode FROM exercises WHERE id = $1`, id).Scan(&stored); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored != LoadModePerSide {
		t.Fatalf("the column holds %q after the restore, want %q", stored, LoadModePerSide)
	}
}

// The other half, and it must not be lost while fixing the first: a revision
// that DOES carry a load_mode is restored as it stands.
//
// Without this, "preserve the stored value" is an equally simple fix that makes
// restore silently refuse to change the column — which is not a restore, and
// contradicts what the endpoint promises ("copies that revision's content
// back"). Before T2, restore genuinely could not change this column; now it can,
// and that is an improvement worth pinning.
func TestRestoringAModernRevisionAppliesItsLoadMode(t *testing.T) {
	repo, ctx, id := contentFixture(t)

	total := authored(id)
	total.LoadMode = LoadModeTotal
	if _, err := repo.CreateExercise(ctx, total, testActor); err != nil {
		t.Fatalf("create: %v", err)
	}

	snapshot := authored(id)
	snapshot.LoadMode = LoadModePerSide
	payload, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if _, err := repo.pool.Exec(ctx, `
		INSERT INTO exercise_revisions (exercise_id, revision, actor, action, payload)
		VALUES ($1, 98, 'user_fixture', 'update', $2::jsonb)
		ON CONFLICT (exercise_id, revision) DO UPDATE SET payload = EXCLUDED.payload`,
		id, payload); err != nil {
		t.Fatalf("seed revision: %v", err)
	}

	restored, err := repo.Restore(ctx, id, 98, testActor)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restored.LoadMode != LoadModePerSide {
		t.Fatalf("restore left load_mode at %q, want %q — a revision that names a "+
			"value must be restorable, or the absent-key rule has become "+
			"'never change this column'", restored.LoadMode, LoadModePerSide)
	}
}

// TestTheConsoleCanAuthorAndCorrectImplements is T2's lesson applied to the
// column that replaced the derived factor.
//
// `load_mode` was unwritable by the console for a while, so every dumbbell
// exercise authored there was born counting single. `implements` IS the
// tonnage factor now, so the same omission would be the same bug — and
// `updateWithin` not writing it would make a wrong count permanent, which is
// the other half T2 recorded.
func TestTheConsoleCanAuthorAndCorrectImplements(t *testing.T) {
	repo, ctx, id := contentFixture(t)

	pair := authored(id)
	pair.LoadMode = LoadModePerSide
	pair.Implements = 2
	created, err := repo.CreateExercise(ctx, pair, testActor)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Implements != 2 {
		t.Fatalf("created with implements=%d, want 2 — a console-authored pair that "+
			"counts single halves its own tonnage from the moment it exists",
			created.Implements)
	}

	// Read the column back rather than trusting the RETURNING: the bug being
	// guarded against is the column never being written at all.
	var stored int
	if err := repo.pool.QueryRow(ctx,
		`SELECT implements FROM exercises WHERE id = $1`, id).Scan(&stored); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored != 2 {
		t.Fatalf("the column holds %d, want 2", stored)
	}

	// An edit that says nothing about it must not reset it — the handler merges
	// onto the stored row, which is what replaces the old guarantee that a
	// column the UPDATE never wrote could not be cleared.
	current, err := repo.GetExercise(ctx, id)
	if err != nil {
		t.Fatalf("get for write: %v", err)
	}
	renamed := exerciseRequest{Name: ptr("Renamed Pair")}.applyTo(current)
	updated, err := repo.UpdateExercise(ctx, renamed, testActor)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Implements != 2 {
		t.Fatalf("a rename reset implements to %d", updated.Implements)
	}

	// And a wrong count is correctable, which the derived rule never allowed:
	// the only way to change the factor used to be flipping `is_unilateral`,
	// which silently changed the reps hint too.
	fix := exerciseRequest{Implements: ptr(1)}.applyTo(updated)
	fixed, err := repo.UpdateExercise(ctx, fix, testActor)
	if err != nil {
		t.Fatalf("update to 1: %v", err)
	}
	if fixed.Implements != 1 {
		t.Fatalf("implements is %d after correcting it to 1", fixed.Implements)
	}
}
