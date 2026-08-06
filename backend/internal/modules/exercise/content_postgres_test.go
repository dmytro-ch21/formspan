package exercise

import (
	"context"
	"errors"
	"testing"
)

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

	got, err := repo.CreateExercise(ctx, authored(id))
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
	if _, err := repo.UpdateExercise(ctx, edited); err != nil {
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
	if _, err := repo.CreateExercise(ctx, authored(id)); err != nil {
		t.Fatalf("create: %v", err)
	}

	edited := authored(id)
	edited.Name = "Zercher Squat (edited)"
	edited.Equipment = []string{}
	got, err := repo.UpdateExercise(ctx, edited)
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
	_, err := repo.CreateExercise(ctx, authored(id))
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("create over a seeded id returned %v, want ErrAlreadyExists", err)
	}
}

func TestAdminAuthoredReturnsOnlyConsoleRows(t *testing.T) {
	repo, ctx, id := contentFixture(t)
	if _, err := repo.CreateExercise(ctx, authored(id)); err != nil {
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
	if _, err := repo.CreateExercise(ctx, authored(id)); err != nil {
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
