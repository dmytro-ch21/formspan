package sequence

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Gated on TEST_DATABASE_URL and skipping silently without it, like every other
// integration test here. Point it at a DIFFERENT database from DATABASE_URL.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered FIRST so it runs LAST: t.Cleanup is LIFO and strictly after
	// every defer, so a `defer pool.Close()` would shut the pool before the row
	// cleanup below got to use it. The gotcha CLAUDE.md calls out.
	t.Cleanup(func() { pool.Close() })
	return pool
}

// seedTechnique creates a library row so the suite does not depend on the seed
// having run.
func seedTechnique(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO techniques (id, name, category, position, function)
		VALUES ($1, $1, 'Submission', 'Guard - Bottom', 'finish')
		ON CONFLICT (id) DO NOTHING`, id); err != nil {
		t.Fatalf("seed technique: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM techniques WHERE id = $1`, id) })
	return id
}

func seedPosition(t *testing.T, pool *pgxpool.Pool, id, name string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO positions (id, name, family) VALUES ($1, $2, 'Guard')
		ON CONFLICT (id) DO NOTHING`, id, name); err != nil {
		t.Fatalf("seed position: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM positions WHERE id = $1`, id) })
	return id
}

// user returns a distinct id per test, and removes that user's sequences after.
//
// Distinct per test because the suite shares one database with every other
// package (`-p 1` serialises them, it does not isolate them), so a fixed
// "test-user" would have two tests writing each other's rows.
func user(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	id := "seq-test-" + t.Name()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM bjj_sequences WHERE owner_user_id = $1`, id)
	})
	return id
}

func ptr(s string) *string { return &s }

// chain builds the class that motivated the whole feature.
func chain(t *testing.T, pool *pgxpool.Pool) ([]NewStep, string) {
	sideControl := seedPosition(t, pool, "seq-test-side-control", "Side Control")
	brk := seedTechnique(t, pool, "seq-test-guard-break")
	cut := seedTechnique(t, pool, "seq-test-knee-cut")
	return []NewStep{
		{TechniqueID: brk, Notes: "cross sleeve, knee in the tailbone"},
		{TechniqueID: cut, EndsAtPositionID: &sideControl},
	}, sideControl
}

func TestCreateAndGetRoundTrip(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	steps, sideControl := chain(t, pool)
	closedGuard := seedPosition(t, pool, "seq-test-closed-guard", "Closed Guard")

	created, err := repo.Create(ctx, uid, NewSequence{
		Name:            "Closed guard to side control",
		Description:     "Tuesday beginners",
		StartPositionID: &closedGuard,
		Steps:           steps,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.Get(ctx, created.ID, uid)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Name != "Closed guard to side control" || got.StepCount != 2 {
		t.Fatalf("round trip lost data: name=%q steps=%d", got.Name, got.StepCount)
	}
	if !got.Editable {
		t.Error("owner should be able to edit their own sequence")
	}
	// The names must be RESOLVED from the library, not stored — that is what
	// makes a renamed technique show its new name everywhere.
	if got.StartPositionName != "Closed Guard" {
		t.Errorf("start position name not resolved: %q", got.StartPositionName)
	}
	if len(got.Steps) != 2 {
		t.Fatalf("want 2 steps, got %d", len(got.Steps))
	}
	// ORDER IS THE CONTENT. Assert it explicitly rather than trusting insertion.
	if got.Steps[0].Order != 0 || got.Steps[1].Order != 1 {
		t.Errorf("sort_order not assigned by index: %d, %d", got.Steps[0].Order, got.Steps[1].Order)
	}
	if got.Steps[0].Notes != "cross sleeve, knee in the tailbone" {
		t.Errorf("notes lost: %q", got.Steps[0].Notes)
	}
	if got.Steps[1].EndsAtPositionID == nil || *got.Steps[1].EndsAtPositionID != sideControl {
		t.Error("ends_at_position_id lost")
	}
	if got.Steps[1].EndsAtPositionName != "Side Control" {
		t.Errorf("end position name not resolved: %q", got.Steps[1].EndsAtPositionName)
	}
	// A step with no recorded destination stays legal and reads as nil, NOT as
	// an empty string that a client would render as a position called "".
	if got.Steps[0].EndsAtPositionID != nil {
		t.Error("unset ends_at should be nil")
	}
	// Library projection, so a client renders without a second fetch.
	if got.Steps[0].Function != "finish" {
		t.Errorf("function not projected from the library: %q", got.Steps[0].Function)
	}
}

// The load-bearing one. Reading somebody else's sequence must be
// indistinguishable from reading one that does not exist.
func TestGetIsNotFoundForAnotherUser(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	owner := user(t, pool)
	steps, _ := chain(t, pool)

	created, err := repo.Create(ctx, owner, NewSequence{Name: "Mine", Steps: steps})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	_, err = repo.Get(ctx, created.ID, "seq-test-someone-else")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound for another user's sequence, got %v", err)
	}
	// And the same answer for an id that was never real, so the two cases
	// cannot be told apart by their errors.
	_, err = repo.Get(ctx, "no-such-sequence", "seq-test-someone-else")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound for a missing id, got %v", err)
	}
}

func TestListExcludesOtherUsersAndOmitsSteps(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	mine := user(t, pool)
	steps, _ := chain(t, pool)

	if _, err := repo.Create(ctx, mine, NewSequence{Name: "Mine", Steps: steps}); err != nil {
		t.Fatalf("create: %v", err)
	}
	theirs := "seq-test-other-owner"
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM bjj_sequences WHERE owner_user_id = $1`, theirs)
	})
	if _, err := repo.Create(ctx, theirs, NewSequence{Name: "Theirs", Steps: steps}); err != nil {
		t.Fatalf("create other: %v", err)
	}

	list, err := repo.List(ctx, mine)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, s := range list {
		if s.Name == "Theirs" {
			t.Fatal("list leaked another user's sequence")
		}
	}
	// Scoped to this user's own rows, so the assertion holds however much other
	// packages have written to the shared database.
	var found *Sequence
	for i := range list {
		if list[i].Name == "Mine" {
			found = &list[i]
		}
	}
	if found == nil {
		t.Fatal("own sequence missing from list")
	}
	// Steps omitted on the list, count present — the N+1 guard.
	if found.Steps != nil {
		t.Error("list should not carry steps")
	}
	if found.StepCount != 2 {
		t.Errorf("step_count should be present on the list, got %d", found.StepCount)
	}
}

func TestUpdateReplacesStepsWholesale(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	steps, _ := chain(t, pool)

	created, err := repo.Create(ctx, uid, NewSequence{Name: "Before", Steps: steps})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// nil Steps must LEAVE THE CHAIN ALONE. This is the distinction the whole
	// nil/empty split exists for, and the one a client would silently lose.
	updated, err := repo.Update(ctx, created.ID, uid, Update{Name: ptr("After")})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Name != "After" {
		t.Errorf("name not updated: %q", updated.Name)
	}
	if updated.StepCount != 2 {
		t.Fatalf("nil Steps wiped the chain: %d steps left", updated.StepCount)
	}

	// Non-nil replaces. One step, so a stale second row would show.
	only := []NewStep{steps[1]}
	updated, err = repo.Update(ctx, created.ID, uid, Update{Steps: only})
	if err != nil {
		t.Fatalf("update steps: %v", err)
	}
	if updated.StepCount != 1 {
		t.Fatalf("want 1 step after replace, got %d", updated.StepCount)
	}
	// Re-indexed from zero: the surviving step was at index 1 and must now be
	// at 0, or the unique (sequence_id, sort_order) constraint would collide on
	// the next write and the chain would render with a gap.
	if updated.Steps[0].Order != 0 {
		t.Errorf("sort_order not reassigned on replace: %d", updated.Steps[0].Order)
	}

	// Explicitly empty clears it, which nil must not.
	updated, err = repo.Update(ctx, created.ID, uid, Update{Steps: []NewStep{}})
	if err != nil {
		t.Fatalf("clear steps: %v", err)
	}
	if updated.StepCount != 0 {
		t.Errorf("empty Steps should clear the chain, got %d", updated.StepCount)
	}
}

func TestUpdateStartPositionDistinguishesClearFromUnset(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	steps, _ := chain(t, pool)
	closedGuard := seedPosition(t, pool, "seq-test-cg2", "Closed Guard")

	created, err := repo.Create(ctx, uid, NewSequence{
		Name: "Start set", StartPositionID: &closedGuard, Steps: steps,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// SetStartPosition false leaves it alone even though the id is nil.
	got, err := repo.Update(ctx, created.ID, uid, Update{Name: ptr("Renamed")})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got.StartPositionID == nil {
		t.Fatal("start position cleared by an update that did not mention it")
	}

	// SetStartPosition true with a nil id CLEARS it — the case a lone *string
	// cannot express, and the reason the flag exists.
	got, err = repo.Update(ctx, created.ID, uid, Update{SetStartPosition: true, StartPositionID: nil})
	if err != nil {
		t.Fatalf("clear start: %v", err)
	}
	if got.StartPositionID != nil {
		t.Errorf("start position not cleared: %v", *got.StartPositionID)
	}
}

func TestWritesRefuseAnotherUsersSequence(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	owner := user(t, pool)
	steps, _ := chain(t, pool)

	created, err := repo.Create(ctx, owner, NewSequence{Name: "Mine", Steps: steps})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	intruder := "seq-test-intruder"
	// PINNED TO ErrNotFound, not merely "an error". Accepting any error is
	// exactly how the bug this test now covers got through review: Update
	// returned ErrForbidden for a foreign row, the handler mapped that to 403,
	// and PATCH became an existence oracle — 404 for an unreal id, 403 for a
	// real one belonging to somebody else. `err != nil` was true either way.
	if _, err := repo.Update(ctx, created.ID, intruder, Update{Name: ptr("Hijacked")}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update by a non-owner: want ErrNotFound (indistinguishable from absent), got %v", err)
	}
	if err := repo.Delete(ctx, created.ID, intruder); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete by a non-owner: want ErrNotFound, got %v", err)
	}
	// The other half of the oracle: an id that never existed must answer
	// identically. Asserted together, because the leak is the DIFFERENCE
	// between these two answers and neither alone can show it.
	if _, err := repo.Update(ctx, "seq-test-never-existed", intruder, Update{Name: ptr("x")}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update of a nonexistent id: want ErrNotFound, got %v", err)
	}
	if err := repo.Delete(ctx, "seq-test-never-existed", intruder); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete of a nonexistent id: want ErrNotFound, got %v", err)
	}
	// And it really is untouched, rather than merely reporting an error.
	got, err := repo.Get(ctx, created.ID, owner)
	if err != nil {
		t.Fatalf("get after failed writes: %v", err)
	}
	if got.Name != "Mine" {
		t.Errorf("sequence was modified by a non-owner: %q", got.Name)
	}
}

func TestDeleteCascadesSteps(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	steps, _ := chain(t, pool)

	created, err := repo.Create(ctx, uid, NewSequence{Name: "Doomed", Steps: steps})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Delete(ctx, created.ID, uid); err != nil {
		t.Fatalf("delete: %v", err)
	}
	// The orphan check the FK is there to prevent. Asserted directly against
	// the table, because Get would return ErrNotFound either way and prove
	// nothing about the steps.
	var left int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM bjj_sequence_steps WHERE sequence_id = $1`, created.ID).Scan(&left); err != nil {
		t.Fatalf("count steps: %v", err)
	}
	if left != 0 {
		t.Errorf("%d orphaned steps survived the delete", left)
	}
}

// A pruned position must not take the athlete's chain with it — the reason both
// position FKs are ON DELETE SET NULL rather than CASCADE. `UpsertPositions`
// genuinely prunes rows absent from positions.json, so this is a live path.
func TestPrunedPositionNullsRatherThanDeletes(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	brk := seedTechnique(t, pool, "seq-test-prune-tech")

	// Deliberately NOT via seedPosition: this one gets deleted mid-test, and a
	// cleanup that deletes it again would mask a failure to delete here.
	if _, err := pool.Exec(ctx, `
		INSERT INTO positions (id, name, family) VALUES ('seq-test-doomed-pos', 'Doomed', 'Guard')
		ON CONFLICT (id) DO NOTHING`); err != nil {
		t.Fatalf("seed position: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM positions WHERE id = 'seq-test-doomed-pos'`)
	})

	created, err := repo.Create(ctx, uid, NewSequence{
		Name:            "Survives a prune",
		StartPositionID: ptr("seq-test-doomed-pos"),
		Steps:           []NewStep{{TechniqueID: brk, EndsAtPositionID: ptr("seq-test-doomed-pos")}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM positions WHERE id = 'seq-test-doomed-pos'`); err != nil {
		t.Fatalf("prune position: %v", err)
	}

	got, err := repo.Get(ctx, created.ID, uid)
	if err != nil {
		t.Fatalf("sequence did not survive the prune: %v", err)
	}
	if got.StartPositionID != nil {
		t.Error("start position should be NULL after the prune")
	}
	if len(got.Steps) != 1 {
		t.Fatalf("the step was deleted with the position: %d steps left", len(got.Steps))
	}
	if got.Steps[0].EndsAtPositionID != nil {
		t.Error("step end position should be NULL after the prune")
	}
}

func TestInvalidInputIsRejectedBeforePostgres(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)

	// A technique id that is not in the library. The FK catches it; the point
	// is that it surfaces as ErrInvalidInput and not a raw SQL error, which is
	// the module pattern's rule about what may escape a repository.
	_, err := repo.Create(ctx, uid, NewSequence{
		Name:  "Bad ref",
		Steps: []NewStep{{TechniqueID: "no-such-technique"}},
	})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput for an unknown technique, got %v", err)
	}
}

func TestValidateRejectsWhatTheSchemaCannot(t *testing.T) {
	// Pure logic, no database — so it runs even without TEST_DATABASE_URL,
	// which is most of the time locally.
	if err := (NewSequence{Name: ""}).Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Error("an unnamed sequence should be refused")
	}
	tooMany := make([]NewStep, MaxSteps+1)
	for i := range tooMany {
		tooMany[i] = NewStep{TechniqueID: fmt.Sprintf("t%d", i)}
	}
	if err := ValidateSteps(tooMany); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("a chain of %d steps should be refused", len(tooMany))
	}
	if err := ValidateSteps([]NewStep{{TechniqueID: ""}}); !errors.Is(err, ErrInvalidInput) {
		t.Error("a step with no technique should be refused")
	}
	// Duplicates ARE allowed, unlike curriculum items: sweep, get passed, sweep
	// again is ordinary grappling and a chain that records it is more accurate.
	if err := ValidateSteps([]NewStep{{TechniqueID: "a"}, {TechniqueID: "a"}}); err != nil {
		t.Errorf("a repeated technique should be legal in a chain: %v", err)
	}
	// nil Steps on an Update means "leave alone" and must not be validated as
	// an empty chain.
	if err := (Update{Name: ptr("ok")}).Validate(); err != nil {
		t.Errorf("an update that does not mention steps should validate: %v", err)
	}
}

// The only 403 in the module, and it had no test until review pointed out that
// the sole ErrForbidden path was uncovered.
//
// A VOLA-authored row is ownerless, which the schema only permits when
// `source <> 'user'` (bjj_sequences_source_matches_owner) — so it has to be
// inserted by hand: nothing in the repository can create one, deliberately.
func TestReferenceChainIsReadableAndNotWritable(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	brk := seedTechnique(t, pool, "seq-test-ref-tech")

	var id string
	if err := pool.QueryRow(ctx, `
		INSERT INTO bjj_sequences (owner_user_id, source, name)
		VALUES (NULL, 'seed', 'Reference chain') RETURNING id`).Scan(&id); err != nil {
		t.Fatalf("seed reference sequence: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM bjj_sequences WHERE id = $1`, id) })
	if _, err := pool.Exec(ctx, `
		INSERT INTO bjj_sequence_steps (sequence_id, technique_id, sort_order)
		VALUES ($1, $2, 0)`, id, brk); err != nil {
		t.Fatalf("seed reference step: %v", err)
	}

	// Readable by anyone, and flagged not-editable so no client has to work it
	// out by comparing user ids.
	got, err := repo.Get(ctx, id, uid)
	if err != nil {
		t.Fatalf("a reference chain must be readable: %v", err)
	}
	if got.Editable {
		t.Error("a reference chain must not report itself editable")
	}

	// ErrForbidden, NOT ErrNotFound — the caller can plainly see this row, so
	// 403 discloses nothing. This is the one case where the two must differ.
	if _, err := repo.Update(ctx, id, uid, Update{Name: ptr("Mine now")}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("update of a reference chain: want ErrForbidden, got %v", err)
	}
	// Delete must agree with Update rather than answering 404 for the same row
	// and the same caller.
	if err := repo.Delete(ctx, id, uid); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete of a reference chain: want ErrForbidden, got %v", err)
	}
}

// Offline capture sends a client-generated id so its sync retry is idempotent.
// This is the pair of tests that make that safe rather than merely working.
func TestClientSuppliedIDIsIdempotentForTheSameOwner(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	steps, _ := chain(t, pool)
	const id = "seq-test-client-generated-id"

	first, err := repo.Create(ctx, uid, NewSequence{ID: id, Name: "From the mat", Steps: steps})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if first.ID != id {
		t.Fatalf("client id not honoured: got %q", first.ID)
	}

	// The retry a flaky gym connection produces. Must succeed, not 409.
	again, err := repo.Create(ctx, uid, NewSequence{ID: id, Name: "From the mat", Steps: steps})
	if err != nil {
		t.Fatalf("replay by the same owner must be idempotent, got %v", err)
	}
	if again.ID != id || again.StepCount != 2 {
		t.Fatalf("replay changed the row: id=%q steps=%d", again.ID, again.StepCount)
	}

	// THE PROPERTY THAT ACTUALLY NEEDS A TEST, and it is not "no duplicate
	// steps" — UNIQUE (sequence_id, sort_order) makes duplication impossible
	// whatever the code does, so asserting it proves the constraint and not
	// the short-circuit. (Measured: mutating the replay path to re-insert
	// leaves that assertion green.)
	//
	// The real hazard is REVERSION. The athlete captures a chain on the mat,
	// refines it at a desk, and only then does the phone get signal and push
	// its original copy. A replay that rewrites the row silently throws the
	// desk edit away, and the athlete never sees it happen.
	if _, err := repo.Update(ctx, id, uid, Update{
		Name:  ptr("Refined at a desk"),
		Steps: []NewStep{steps[0]},
	}); err != nil {
		t.Fatalf("edit: %v", err)
	}
	replayed, err := repo.Create(ctx, uid, NewSequence{ID: id, Name: "From the mat", Steps: steps})
	if err != nil {
		t.Fatalf("replay after edit: %v", err)
	}
	if replayed.Name != "Refined at a desk" {
		t.Errorf("a late sync retry reverted the name to the captured one: %q", replayed.Name)
	}
	if replayed.StepCount != 1 {
		t.Errorf("a late sync retry restored the captured steps over the edit: %d", replayed.StepCount)
	}
}

func TestClientSuppliedIDCannotStealAnotherUsersSequence(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	owner := user(t, pool)
	steps, _ := chain(t, pool)
	const id = "seq-test-contested-id"

	if _, err := repo.Create(ctx, owner, NewSequence{ID: id, Name: "Mine", Steps: steps}); err != nil {
		t.Fatalf("create: %v", err)
	}

	// THE IDOR A CLIENT-SUPPLIED ID MAKES REACHABLE. Without the owner
	// predicate on the conflict path this hands the attacker the owner's
	// sequence, which is the bug the activity module shipped once already.
	intruder := "seq-test-id-thief"
	got, err := repo.Create(ctx, intruder, NewSequence{ID: id, Name: "Mine now", Steps: steps})
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("want ErrAlreadyExists for a taken id, got err=%v seq=%+v", err, got)
	}
	if got.Name != "" {
		t.Fatalf("the conflict path leaked another user's sequence: %q", got.Name)
	}

	// The owner's row is untouched.
	still, err := repo.Get(ctx, id, owner)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if still.Name != "Mine" {
		t.Errorf("owner's sequence was overwritten: %q", still.Name)
	}
}

func TestServerPicksAnIDWhenTheClientDoesNot(t *testing.T) {
	// The web path, unchanged by any of the above.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	steps, _ := chain(t, pool)

	a, err := repo.Create(ctx, uid, NewSequence{Name: "No id", Steps: steps})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	b, err := repo.Create(ctx, uid, NewSequence{Name: "No id either", Steps: steps})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if a.ID == "" || b.ID == "" || a.ID == b.ID {
		t.Fatalf("server ids must be present and distinct: %q vs %q", a.ID, b.ID)
	}
}

// The one conflict arm with no coverage, and the easiest collision to hit in
// practice: reference-chain ids are handed to every caller by List, so they are
// the ids a client provably knows.
func TestClientIDCannotClaimAReferenceChain(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	steps, _ := chain(t, pool)

	var id string
	if err := pool.QueryRow(ctx, `
		INSERT INTO bjj_sequences (owner_user_id, source, name)
		VALUES (NULL, 'seed', 'Reference chain') RETURNING id`).Scan(&id); err != nil {
		t.Fatalf("seed reference sequence: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM bjj_sequences WHERE id = $1`, id) })

	got, err := repo.Create(ctx, uid, NewSequence{ID: id, Name: "Mine now", Steps: steps})
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("want ErrAlreadyExists for a reference id, got err=%v seq=%+v", err, got)
	}
	if got.Name != "" {
		t.Errorf("the conflict path leaked the reference chain: %q", got.Name)
	}
	// And it is untouched.
	still, err := repo.Get(ctx, id, uid)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if still.Name != "Reference chain" || still.StepCount != 0 {
		t.Errorf("reference chain was modified: %q / %d steps", still.Name, still.StepCount)
	}
}

func TestClientIDCharsetAndLength(t *testing.T) {
	// Pure logic; runs without a database.
	ok := []string{"abcdefgh", "0e2f4a6c-1b3d-4e5f-8a9b-0c1d2e3f4a5b", strings.Repeat("a", 64)}
	for _, id := range ok {
		if err := (NewSequence{ID: id, Name: "n"}).Validate(); err != nil {
			t.Errorf("%q should be a legal client id: %v", id, err)
		}
	}
	bad := []string{
		"short",                 // under 8
		strings.Repeat("a", 65), // over 64
		"has space",             // whitespace in a URL segment
		"has/slash",             // path separator
		"has#hash",              // fragment
		"tab\there",             // control character
		"ünïcodeeee",            // outside the allowed set
	}
	for _, id := range bad {
		if err := (NewSequence{ID: id, Name: "n"}).Validate(); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%q should be refused as a client id, got %v", id, err)
		}
	}
}
