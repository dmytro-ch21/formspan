package exercise

import (
	"context"
	"errors"
	"testing"
)

// The actor every console write in these tests is attributed to. A constant so
// the audit assertions read as "this specific caller".
const testActor = "user_test_admin"

// Integration tests for the write path. These cover the properties the handler
// tests structurally CANNOT: the fake repository implements its own ownership
// check, so mutating `WHERE source = 'admin'` out of the real UPDATE left the
// whole handler suite green. That guard is the thing standing between a console
// edit and a silent revert on the next deploy, so it is checked here against
// real Postgres.

// contentFixture gives each test its own row and removes it afterwards.
//
// The DELETE is registered as a t.Cleanup AFTER newTestRepo has already
// registered pool.Close — LIFO means the delete runs first, while the pool is
// still open. Registering it the other way round is the documented trap in this
// repo and it fails as a confusing "conn closed".
func contentFixture(t *testing.T) (*PostgresRepository, context.Context, string) {
	t.Helper()
	repo := newTestRepo(t)
	ctx := context.Background()
	id := "test-zercher-squat"
	t.Cleanup(func() {
		_, _ = repo.pool.Exec(ctx, `DELETE FROM exercises WHERE id = $1`, id)
	})
	_, _ = repo.pool.Exec(ctx, `DELETE FROM exercises WHERE id = $1`, id)
	return repo, ctx, id
}

// seededFixture creates a row the DEPLOY owns, and removes it afterwards.
//
// These tests used to reach for a real catalog id (`back-squat`) and skip if it
// was missing. That passed locally only because cmd/seed had been run by hand —
// CI runs `migrate up` and nothing else, so in CI the id did not exist, the
// "refuses a seeded id" test created it instead of being refused, and the row it
// leaked then broke the adoption test two functions later. Exactly the trap
// CLAUDE.md records from the proficiency work.
//
// UpsertAll is what `cmd/seed` runs and does not name `source`, so the column
// takes its `DEFAULT 'seed'` — this is a genuinely deploy-owned row, not a
// hand-set flag.
func seededFixture(t *testing.T, repo *PostgresRepository, ctx context.Context, id string) Exercise {
	t.Helper()
	t.Cleanup(func() {
		_, _ = repo.pool.Exec(ctx, `DELETE FROM exercises WHERE id = $1`, id)
	})
	_, _ = repo.pool.Exec(ctx, `DELETE FROM exercises WHERE id = $1`, id)

	row := authored(id)
	row.Name = "Seeded " + id
	if err := repo.UpsertAll(ctx, []Exercise{row}); err != nil {
		t.Fatalf("seed fixture: %v", err)
	}
	stored, err := repo.GetExercise(ctx, id)
	if err != nil {
		t.Fatalf("read fixture back: %v", err)
	}
	if stored.Source != "seed" {
		t.Fatalf("fixture has source %q, want seed — UpsertAll should leave the default", stored.Source)
	}
	return stored
}

func authored(id string) Exercise {
	return Exercise{
		ID: id, Name: "Zercher Squat", Sport: "strength",
		MovementPattern: "squat", MovementPatternDetail: "Front-loaded squat",
		PrimaryMuscles: []string{"quadriceps"}, SecondaryMuscles: []string{"core"},
		Equipment: []string{"barbell"}, LoadType: LoadTypeWeightReps,
		Instructions: "Bar in the crook of the elbows.",
	}
}

func TestCreateWritesAnAdminRowThatSeedingCannotTouch(t *testing.T) {
	repo, ctx, id := contentFixture(t)

	got, err := repo.CreateExercise(ctx, authored(id), testActor)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got.Source != "admin" {
		t.Errorf("source %q, want admin", got.Source)
	}
	if got.CreatedAt.IsZero() || got.UpdatedAt.IsZero() {
		t.Error("timestamps came back zero")
	}

	// The whole point of source='admin': a deploy's re-seed must not revert it.
	// UpsertAll is what `cmd/seed` runs, and its ON CONFLICT is scoped to
	// seeded rows.
	reverted := authored(id)
	reverted.Name = "Reverted By The Deploy"
	if err := repo.UpsertAll(ctx, []Exercise{reverted}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	after, err := repo.GetExercise(ctx, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if after.Name != "Zercher Squat" {
		t.Errorf("the seeder overwrote an admin row: name is now %q", after.Name)
	}
}

// A draft is invisible to athletes, and publishing is what makes it visible.
//
// The two negative assertions are load-bearing: deleting the status filter from
// the public List leaves every other test in this package green, because the
// console paths return drafts on purpose. A draft leaking into the catalog is
// exactly the regression nothing else here can see.
func TestADraftExerciseIsInvisibleUntilPublished(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	const id = "test-draft-exercise"
	// Deleting BEFORE as well as after, like contentFixture: a previous run
	// that died mid-test leaves the row behind and every later run then fails
	// on "already exists", which reads as a regression in the code rather than
	// residue. Revisions go with it — the FK cascades.
	clean := func() { _, _ = repo.pool.Exec(ctx, `DELETE FROM exercises WHERE id = $1`, id) }
	clean()
	t.Cleanup(clean)

	created, err := repo.CreateExercise(ctx, authored(id), testActor)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// The console creates DRAFTS. The column default is 'published' because it
	// describes the 504 backfilled rows — delete `'draft'` from the INSERT and
	// this silently publishes instead.
	if created.Status != StatusDraft {
		t.Fatalf("a console-created exercise has status %q, want draft", created.Status)
	}

	inList := func() bool {
		t.Helper()
		all, err := repo.List(ctx, Filter{})
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		for _, e := range all {
			if e.ID == id {
				return true
			}
		}
		return false
	}
	if inList() {
		t.Error("a draft is in the public catalog — athletes can see unfinished content")
	}
	if _, err := repo.Get(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Errorf("public Get of a draft = %v, want ErrNotFound", err)
	}
	// Not hidden from the console, which would make it unfinishable.
	if _, err := repo.GetExercise(ctx, id); err != nil {
		t.Errorf("the console cannot see its own draft: %v", err)
	}

	if _, err := repo.Publish(ctx, id, testActor); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if !inList() {
		t.Error("a published exercise is still missing from the public catalog")
	}
	// Publishing twice is ErrNotFound, not a silent success.
	if _, err := repo.Publish(ctx, id, testActor); !errors.Is(err, ErrNotFound) {
		t.Errorf("re-publishing = %v, want ErrNotFound", err)
	}
}

// Every console write leaves a revision, and a restore appends rather than
// erasing what it rolled back from.
func TestEveryConsoleWriteToAnExerciseLeavesARevision(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	const id = "test-history-exercise"
	clean := func() { _, _ = repo.pool.Exec(ctx, `DELETE FROM exercises WHERE id = $1`, id) }
	clean()
	t.Cleanup(clean)

	first := authored(id)
	first.Name = "First Draft"
	if _, err := repo.CreateExercise(ctx, first, testActor); err != nil {
		t.Fatalf("create: %v", err)
	}
	second := authored(id)
	second.Name = "Second Name"
	if _, err := repo.UpdateExercise(ctx, second, testActor); err != nil {
		t.Fatalf("update: %v", err)
	}
	if _, err := repo.Publish(ctx, id, testActor); err != nil {
		t.Fatalf("publish: %v", err)
	}

	revs, err := repo.Revisions(ctx, id)
	if err != nil {
		t.Fatalf("revisions: %v", err)
	}
	if len(revs) != 3 {
		t.Fatalf("got %d revisions, want 3 (create, update, publish)", len(revs))
	}
	if revs[0].Action != ActionPublish || revs[2].Action != ActionCreate {
		t.Errorf("actions newest-first = %q..%q, want publish..create",
			revs[0].Action, revs[2].Action)
	}
	for _, rev := range revs {
		if rev.Actor != testActor {
			t.Errorf("revision %d attributed to %q", rev.Revision, rev.Actor)
		}
	}
	if revs[2].Payload.Name != "First Draft" {
		t.Errorf("revision 1 payload = %q, want the state at that time", revs[2].Payload.Name)
	}

	restored, err := repo.Restore(ctx, id, 1, testActor)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restored.Name != "First Draft" {
		t.Errorf("restored name = %q", restored.Name)
	}
	// ...and it did NOT unpublish. A content rollback must not withdraw a live
	// exercise from every athlete's catalog.
	if restored.Status != StatusPublished {
		t.Errorf("restoring set status to %q — a content rollback must not change "+
			"visibility", restored.Status)
	}
	after, _ := repo.Revisions(ctx, id)
	if len(after) != 4 || after[0].Action != ActionRestore {
		t.Errorf("after restore: %d revisions, newest %q — a rollback that erases "+
			"its own evidence is not an audit trail", len(after), after[0].Action)
	}
	if _, err := repo.Restore(ctx, id, 99, testActor); !errors.Is(err, ErrNotFound) {
		t.Errorf("restoring a missing revision = %v, want ErrNotFound", err)
	}
}

// Editing a seeded row is allowed now, and the write TAKES OWNERSHIP.
//
// The inverse of the test it replaces. The old rule refused the edit because
// the next deploy's re-seed would silently revert it, for only the fields the
// change-detection tuple covers. The write now flips `source` to 'admin', and
// the seeder's own `WHERE source = 'seed'` leaves it alone from then on.
//
// The re-seed at the end is the load-bearing half: drop `source = 'admin'` from
// the SET clause and everything above it still passes while the deploy quietly
// undoes the edit.
func TestUpdatingASeededRowTakesOwnershipOfIt(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	const id = "test-seeded-row"
	seeded := seededFixture(t, repo, ctx, id)

	edited := seeded
	edited.Name = "Edited In The Console"
	if _, err := repo.UpdateExercise(ctx, edited, testActor); err != nil {
		t.Fatalf("update of a seeded row = %v, want it to succeed now", err)
	}
	after, err := repo.GetExercise(ctx, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if after.Name != "Edited In The Console" {
		t.Fatalf("the edit did not land: %q", after.Name)
	}
	if after.Source != "admin" {
		t.Fatalf("source = %q, want admin — the edit must take ownership, or the "+
			"next deploy reverts it", after.Source)
	}

	// The deploy runs on every release and must now skip this row.
	if err := repo.UpsertAll(ctx, []Exercise{seeded}); err != nil {
		t.Fatalf("re-seed: %v", err)
	}
	final, err := repo.GetExercise(ctx, id)
	if err != nil {
		t.Fatalf("get after re-seed: %v", err)
	}
	if final.Name != "Edited In The Console" {
		t.Errorf("the re-seed reverted the console edit to %q — the UPDATE is not "+
			"taking ownership", final.Name)
	}
}

func TestUpdateEditsAnAdminRow(t *testing.T) {
	repo, ctx, id := contentFixture(t)
	if _, err := repo.CreateExercise(ctx, authored(id), testActor); err != nil {
		t.Fatalf("create: %v", err)
	}

	edited := authored(id)
	edited.Name = "Zercher Squat (edited)"
	edited.Equipment = []string{}
	got, err := repo.UpdateExercise(ctx, edited, testActor)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got.Name != "Zercher Squat (edited)" {
		t.Errorf("name %q", got.Name)
	}
	if len(got.Equipment) != 0 {
		t.Errorf("equipment %v, want cleared", got.Equipment)
	}
	// Lists come back as `[]`, never nil — a nil round-tripping into the next
	// write would be sent as NULL and fail the NOT NULL column.
	if got.PrimaryMuscles == nil || got.SecondaryMuscles == nil || got.Equipment == nil {
		t.Error("a list came back nil rather than empty")
	}
}

func TestCreateRefusesAnIDTheCatalogAlreadyHas(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	const id = "test-already-seeded"
	seededFixture(t, repo, ctx, id)

	// An admin row shadowing a seeded id is the collision that matters: the
	// deploy's upsert would skip it, leaving the two to disagree forever.
	_, err := repo.CreateExercise(ctx, authored(id), testActor)
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("create over a seeded id returned %v, want ErrAlreadyExists", err)
	}
}

func TestAdminAuthoredReturnsOnlyConsoleRows(t *testing.T) {
	repo, ctx, id := contentFixture(t)
	if _, err := repo.CreateExercise(ctx, authored(id), testActor); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.AdminAuthored(ctx)
	if err != nil {
		t.Fatalf("admin authored: %v", err)
	}
	found := false
	for _, e := range got {
		if e.Source != "admin" {
			t.Errorf("%s has source %q — the export would carry a seeded row", e.ID, e.Source)
		}
		if e.ID == id {
			found = true
		}
	}
	if !found {
		t.Errorf("the authored exercise is missing from the export's set")
	}
}

// Adoption is scoped to admin rows, and the reason is not the value — setting
// `seed` on a row that is already `seed` is invisible — but `updated_at`.
// Clients delta-sync on it, so an unscoped adoption makes every seeded exercise
// look changed to every device.
func TestAdoptOnlyTouchesAdminRows(t *testing.T) {
	repo, ctx, id := contentFixture(t)
	if _, err := repo.CreateExercise(ctx, authored(id), testActor); err != nil {
		t.Fatalf("create: %v", err)
	}
	const seededID = "test-untouched-by-adopt"
	before := seededFixture(t, repo, ctx, seededID)

	if err := repo.AdoptAsSeeded(ctx, []string{id, seededID}); err != nil {
		t.Fatalf("adopt: %v", err)
	}

	adopted, err := repo.GetExercise(ctx, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if adopted.Source != "seed" {
		t.Errorf("source %q, want seed — the deploy should own it now", adopted.Source)
	}

	after, err := repo.GetExercise(ctx, seededID)
	if err != nil {
		t.Fatalf("get seeded: %v", err)
	}
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Errorf("updated_at moved on an already-seeded row (%v -> %v) — every device "+
			"would see it as changed", before.UpdatedAt, after.UpdatedAt)
	}
}

// The ownership decision behind N39, checked against real Postgres.
//
// The note was very nearly built as a column the seeder ignores — omitted from
// both of `upsertSQL`'s column lists — so that annotating a seeded exercise
// could not take it out of deploy management. That was rejected: the flip is
// temporary and `exportcontent`+`AdoptAsSeeded` is its remedy, while a column
// the seeder ignores is one `AdminAuthored` (`WHERE source = 'admin'`) never
// sees, so the note would never reach `exercises.json` and would die on a fresh
// database.
//
// This test is what makes that choice a fact rather than a comment. It fails if
// `note` is dropped from the SET clause OR from the IS DISTINCT FROM guard —
// two separate lists, either of which silently disables a deploy's ability to
// correct a note.
func TestADeployCanCorrectTheNoteOnASeededRow(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	id := "test-note-seeded-row"
	stored := seededFixture(t, repo, ctx, id)
	if stored.Note != "" {
		t.Fatalf("fixture started with note %q, want empty", stored.Note)
	}

	// A later deploy ships an explanation for this row — the W7 case exactly.
	corrected := authored(id)
	corrected.Name = stored.Name
	corrected.Note = "One bell, so the weight counts once."
	if err := repo.UpsertAll(ctx, []Exercise{corrected}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	after, err := repo.GetExercise(ctx, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if after.Note != "One bell, so the weight counts once." {
		t.Fatalf("the deploy could not write a note onto a seeded row: %q", after.Note)
	}

	// ...and it can be corrected AGAIN, which is what the change-detection
	// guard controls. If `note` is missing from the IS DISTINCT FROM tuple, a
	// re-seed whose ONLY change is the note matches nothing and updates nothing
	// — the row keeps a stale explanation forever, with every other field still
	// tracking the deploy, so nothing looks broken.
	corrected.Note = "One bell, held opposite the working leg, so it counts once."
	if err := repo.UpsertAll(ctx, []Exercise{corrected}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	again, err := repo.GetExercise(ctx, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if again.Note != corrected.Note {
		t.Errorf("a note-only re-seed changed nothing: %q — note is missing from the change-detection guard", again.Note)
	}
}

// The other half: a console-authored note is the row's, not the deploy's, and
// survives a re-seed like every other admin-owned field.
func TestAnAuthoredNoteSurvivesADeploy(t *testing.T) {
	repo, ctx, id := contentFixture(t)

	written := authored(id)
	written.Note = "Counts once — one implement, not a pair."
	if _, err := repo.CreateExercise(ctx, written, testActor); err != nil {
		t.Fatalf("create: %v", err)
	}

	deploy := authored(id)
	deploy.Note = "Whatever the seed file said."
	if err := repo.UpsertAll(ctx, []Exercise{deploy}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	after, err := repo.GetExercise(ctx, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if after.Note != "Counts once — one implement, not a pair." {
		t.Errorf("the deploy overwrote an authored note: %q", after.Note)
	}

	// And AdminAuthored — what cmd/exportcontent reads — carries it, which is
	// the durability half of the ownership decision. A note the exporter cannot
	// see never reaches exercises.json and dies with the database.
	authoredRows, err := repo.AdminAuthored(ctx)
	if err != nil {
		t.Fatalf("admin authored: %v", err)
	}
	var found bool
	for _, e := range authoredRows {
		if e.ID == id {
			found = true
			if e.Note != "Counts once — one implement, not a pair." {
				t.Errorf("AdminAuthored dropped the note: %q — the export would write '' over it", e.Note)
			}
		}
	}
	if !found {
		t.Fatalf("%s is not in AdminAuthored", id)
	}
}

// `Restore` must not blank a note, and this is the THIRD time this exact bug
// has been available in this function — `load_mode` (000052) and `implements`
// (000057) came before it, and both arrived the same way: adding the column to
// `updateWithin`'s SET clause is what makes restore able to destroy it.
//
// Every revision written before 000061 has no `note` key. It unmarshals to ""
// and the UPDATE writes that over a live explanation — then `writeWithRevision`
// records the wipe as a legitimate revision, so the audit trail agrees it was
// meant. Found in review, not by the check suite.
func TestRestoringAPreNoteRevisionDoesNotBlankTheNote(t *testing.T) {
	repo, ctx, id := contentFixture(t)

	annotated := authored(id)
	annotated.Note = "One bell, so the weight counts once."
	if _, err := repo.CreateExercise(ctx, annotated, testActor); err != nil {
		t.Fatalf("create: %v", err)
	}

	// A snapshot shaped the way pre-000061 code wrote one: no `note` key.
	// Literal JSON rather than a marshalled Exercise — though note that with
	// `omitempty` the current struct would ALSO omit it for an empty note,
	// which is precisely why the guard treats absent as "leave it".
	if _, err := repo.pool.Exec(ctx, `
		INSERT INTO exercise_revisions (exercise_id, revision, actor, action, payload)
		VALUES ($1, 95, 'user_fixture', 'update', $2::jsonb)
		ON CONFLICT (exercise_id, revision) DO UPDATE SET payload = EXCLUDED.payload`,
		id, `{"id":"`+id+`","name":"Zercher Squat","sport":"strength",
		      "movement_pattern":"squat","load_type":"weight_reps","is_unilateral":false,
		      "load_mode":"total","implements":1,
		      "primary_muscles":[],"secondary_muscles":[],"equipment":[]}`); err != nil {
		t.Fatalf("seed pre-note revision: %v", err)
	}

	restored, err := repo.Restore(ctx, id, 95, testActor)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restored.Note != "One bell, so the weight counts once." {
		t.Fatalf("restore blanked the note (%q) — a revision that predates the column "+
			"says nothing about it, and reading that silence as empty destroys content "+
			"with no other copy until the next export", restored.Note)
	}

	// Read the column back: the RETURNING has hidden this exact class of bug
	// before, by re-reading a value the SET had not touched.
	var stored string
	if err := repo.pool.QueryRow(ctx,
		`SELECT note FROM exercises WHERE id = $1`, id).Scan(&stored); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored != "One bell, so the weight counts once." {
		t.Fatalf("the column holds %q after the restore", stored)
	}
}

// And the other half, which "always preserve" would break: a revision that DOES
// carry a note is restored as it stands, or Restore has stopped meaning
// "put that revision's content back".
func TestRestoringARevisionAppliesItsNote(t *testing.T) {
	repo, ctx, id := contentFixture(t)

	annotated := authored(id)
	annotated.Note = "The current explanation."
	if _, err := repo.CreateExercise(ctx, annotated, testActor); err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := repo.pool.Exec(ctx, `
		INSERT INTO exercise_revisions (exercise_id, revision, actor, action, payload)
		VALUES ($1, 94, 'user_fixture', 'update', $2::jsonb)
		ON CONFLICT (exercise_id, revision) DO UPDATE SET payload = EXCLUDED.payload`,
		id, `{"id":"`+id+`","name":"Zercher Squat","sport":"strength",
		      "movement_pattern":"squat","load_type":"weight_reps","is_unilateral":false,
		      "load_mode":"total","implements":1,"note":"The older explanation.",
		      "primary_muscles":[],"secondary_muscles":[],"equipment":[]}`); err != nil {
		t.Fatalf("seed revision: %v", err)
	}

	restored, err := repo.Restore(ctx, id, 94, testActor)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restored.Note != "The older explanation." {
		t.Errorf("restore kept %q — a revision that carries a note must apply it", restored.Note)
	}
}
