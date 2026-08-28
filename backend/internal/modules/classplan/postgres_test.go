package classplan

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Gated on TEST_DATABASE_URL and skipping silently without it, like every
// other integration test here. Point it at a DIFFERENT database from
// DATABASE_URL.
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
	// every defer, so a `defer pool.Close()` would shut the pool before the
	// row cleanup below got to use it. The gotcha CLAUDE.md calls out, and
	// sequence's own testPool documents identically.
	t.Cleanup(func() { pool.Close() })
	return pool
}

// seedTechnique creates a library row so the suite does not depend on the
// seed having run — matching sequence.seedTechnique.
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

// user returns a distinct id per test, and removes that user's class plans
// after. Distinct per test because the suite shares one database with every
// other package (`-p 1` serialises them, it does not isolate them), so a
// fixed "test-user" would have two tests writing each other's rows.
func user(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	id := "cp-test-" + t.Name()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM class_plans WHERE owner_user_id = $1`, id)
	})
	return id
}

func ptr(s string) *string { return &s }

// plan builds the class that motivates the feature: a warmup, a technique
// drill against the catalog, and live rounds.
func plan(t *testing.T, pool *pgxpool.Pool) []NewBlock {
	tech := seedTechnique(t, pool, "cp-test-armbar")
	return []NewBlock{
		{Type: BlockTypeWarmup, DurationMinutes: 10, Notes: "jog, shrimp, break-falls"},
		{Type: BlockTypeTechniqueDrill, DurationMinutes: 20, TechniqueID: &tech},
		{Type: BlockTypeLiveRounds, DurationMinutes: 15, Notes: "5 min rounds, king of the hill"},
	}
}

func TestCreateAndGetRoundTrip(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	blocks := plan(t, pool)

	created, err := repo.Create(ctx, uid, NewClassPlan{
		Name:        "Tuesday fundamentals",
		Description: "Beginners, guard passing focus",
		Blocks:      blocks,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID == "" {
		t.Fatal("server should have assigned an id")
	}

	got, err := repo.Get(ctx, created.ID, uid)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Name != "Tuesday fundamentals" {
		t.Errorf("name lost: %q", got.Name)
	}
	if got.BlockCount != 3 {
		t.Fatalf("want 3 blocks, got %d", got.BlockCount)
	}
	if got.TotalDurationMinutes != 45 {
		t.Errorf("total duration = %d, want 45", got.TotalDurationMinutes)
	}
	if len(got.Blocks) != 3 {
		t.Fatalf("want 3 blocks returned, got %d", len(got.Blocks))
	}
	// ORDER IS THE CONTENT. Assert it explicitly rather than trusting
	// insertion order.
	for i, b := range got.Blocks {
		if b.Order != i {
			t.Errorf("block %d has order %d, want %d", i, b.Order, i)
		}
	}
	if got.Blocks[0].Type != BlockTypeWarmup || got.Blocks[0].Notes != "jog, shrimp, break-falls" {
		t.Errorf("warmup block wrong: %+v", got.Blocks[0])
	}
	// The technique_drill block must carry the resolved library projection.
	drill := got.Blocks[1]
	if drill.Type != BlockTypeTechniqueDrill {
		t.Fatalf("block 1 should be a technique_drill, got %q", drill.Type)
	}
	if drill.TechniqueID == nil || *drill.TechniqueID != "cp-test-armbar" {
		t.Errorf("technique_id lost: %v", drill.TechniqueID)
	}
	if drill.TechniqueName != "cp-test-armbar" {
		t.Errorf("technique name not resolved from the library: %q", drill.TechniqueName)
	}
	if drill.TechniquePosition != "Guard - Bottom" {
		t.Errorf("technique position not resolved from the library: %q", drill.TechniquePosition)
	}
	if drill.FreeText != nil {
		t.Errorf("a technique_drill block with a technique_id must not carry free_text: %v", drill.FreeText)
	}
	if got.Blocks[2].Type != BlockTypeLiveRounds {
		t.Errorf("block 2 should be live_rounds, got %q", got.Blocks[2].Type)
	}
}

// The load-bearing one. Reading somebody else's plan must be
// indistinguishable from reading one that does not exist — there is no
// public/VOLA-authored row in this domain at all, so EVERY foreign id must
// answer ErrNotFound.
func TestGetIsNotFoundForAnotherUser(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	owner := user(t, pool)
	blocks := plan(t, pool)

	created, err := repo.Create(ctx, owner, NewClassPlan{Name: "Mine", Blocks: blocks})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	_, err = repo.Get(ctx, created.ID, "cp-test-someone-else")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound for another user's plan, got %v", err)
	}
	// And the same answer for an id that was never real, so the two cases
	// cannot be told apart by their errors.
	_, err = repo.Get(ctx, "no-such-plan", "cp-test-someone-else")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound for a missing id, got %v", err)
	}
}

func TestListExcludesOtherUsersAndOmitsBlocks(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	mine := user(t, pool)
	blocks := plan(t, pool)

	if _, err := repo.Create(ctx, mine, NewClassPlan{Name: "Mine", Blocks: blocks}); err != nil {
		t.Fatalf("create: %v", err)
	}
	theirs := "cp-test-other-owner"
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM class_plans WHERE owner_user_id = $1`, theirs)
	})
	if _, err := repo.Create(ctx, theirs, NewClassPlan{Name: "Theirs", Blocks: blocks}); err != nil {
		t.Fatalf("create other: %v", err)
	}

	list, err := repo.List(ctx, mine)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, p := range list {
		if p.Name == "Theirs" {
			t.Fatal("list leaked another user's plan")
		}
	}
	var found *ClassPlan
	for i := range list {
		if list[i].Name == "Mine" {
			found = &list[i]
		}
	}
	if found == nil {
		t.Fatal("own plan missing from list")
	}
	// Blocks omitted on the list, count and total duration present — the
	// N+1 guard.
	if found.Blocks != nil {
		t.Error("list should not carry blocks")
	}
	if found.BlockCount != 3 {
		t.Errorf("block_count should be present on the list, got %d", found.BlockCount)
	}
	if found.TotalDurationMinutes != 45 {
		t.Errorf("total_duration_minutes should be present on the list, got %d", found.TotalDurationMinutes)
	}
}

func TestUpdateReplacesBlocksWholesale(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	blocks := plan(t, pool)

	created, err := repo.Create(ctx, uid, NewClassPlan{Name: "Before", Blocks: blocks})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// nil Blocks must LEAVE THE PLAN'S BLOCKS ALONE — the distinction the
	// whole nil/empty split exists for, and the one a client would silently
	// lose.
	updated, err := repo.Update(ctx, created.ID, uid, ClassPlanUpdate{Name: ptr("After")})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Name != "After" {
		t.Errorf("name not updated: %q", updated.Name)
	}
	if updated.BlockCount != 3 {
		t.Fatalf("nil Blocks wiped the schedule: %d blocks left", updated.BlockCount)
	}

	// Non-nil replaces. One block, so a stale second row would show.
	only := []NewBlock{{Type: BlockTypeWarmup, DurationMinutes: 5, Notes: "quick warmup only"}}
	updated, err = repo.Update(ctx, created.ID, uid, ClassPlanUpdate{Blocks: only})
	if err != nil {
		t.Fatalf("update blocks: %v", err)
	}
	if updated.BlockCount != 1 || updated.TotalDurationMinutes != 5 {
		t.Fatalf("want 1 block totalling 5 minutes after replace, got %d blocks / %d minutes",
			updated.BlockCount, updated.TotalDurationMinutes)
	}
	if updated.Blocks[0].Order != 0 {
		t.Errorf("sort_order not reassigned on replace: %d", updated.Blocks[0].Order)
	}

	// Explicitly empty clears it, which nil must not.
	updated, err = repo.Update(ctx, created.ID, uid, ClassPlanUpdate{Blocks: []NewBlock{}})
	if err != nil {
		t.Fatalf("clear blocks: %v", err)
	}
	if updated.BlockCount != 0 {
		t.Errorf("empty Blocks should clear the schedule, got %d", updated.BlockCount)
	}
}

func TestWritesRefuseAnotherUsersPlan(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	owner := user(t, pool)
	blocks := plan(t, pool)

	created, err := repo.Create(ctx, owner, NewClassPlan{Name: "Mine", Blocks: blocks})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	intruder := "cp-test-intruder"
	// PINNED TO ErrNotFound, not merely "an error" — this is the property
	// that makes PATCH/DELETE not an existence oracle, and the reason this
	// module has no ErrForbidden at all (see the package doc comment).
	if _, err := repo.Update(ctx, created.ID, intruder, ClassPlanUpdate{Name: ptr("Hijacked")}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update by a non-owner: want ErrNotFound, got %v", err)
	}
	if err := repo.Delete(ctx, created.ID, intruder); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete by a non-owner: want ErrNotFound, got %v", err)
	}
	// The other half: an id that never existed must answer identically.
	if _, err := repo.Update(ctx, "cp-test-never-existed", intruder, ClassPlanUpdate{Name: ptr("x")}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update of a nonexistent id: want ErrNotFound, got %v", err)
	}
	if err := repo.Delete(ctx, "cp-test-never-existed", intruder); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete of a nonexistent id: want ErrNotFound, got %v", err)
	}
	// And it really is untouched, rather than merely reporting an error.
	got, err := repo.Get(ctx, created.ID, owner)
	if err != nil {
		t.Fatalf("get after failed writes: %v", err)
	}
	if got.Name != "Mine" {
		t.Errorf("plan was modified by a non-owner: %q", got.Name)
	}
}

func TestDeleteCascadesBlocks(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)
	blocks := plan(t, pool)

	created, err := repo.Create(ctx, uid, NewClassPlan{Name: "Doomed", Blocks: blocks})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Delete(ctx, created.ID, uid); err != nil {
		t.Fatalf("delete: %v", err)
	}
	var left int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM class_plan_blocks WHERE class_plan_id = $1`, created.ID).Scan(&left); err != nil {
		t.Fatalf("count blocks: %v", err)
	}
	if left != 0 {
		t.Errorf("%d orphaned blocks survived the delete", left)
	}
	// And Get answers the same as any other unowned/nonexistent id.
	if _, err := repo.Get(ctx, created.ID, uid); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete: want ErrNotFound, got %v", err)
	}
}

func TestInvalidTechniqueIDIsRejectedAsInvalidInput(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	uid := user(t, pool)

	// A technique id that is not in the library. The FK catches it; the
	// point is that it surfaces as ErrInvalidInput and not a raw SQL error
	// — the module pattern's rule about what may escape a repository.
	_, err := repo.Create(ctx, uid, NewClassPlan{
		Name: "Bad ref",
		Blocks: []NewBlock{
			{Type: BlockTypeTechniqueDrill, DurationMinutes: 10, TechniqueID: ptr("no-such-technique")},
		},
	})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput for an unknown technique, got %v", err)
	}
	// And nothing was left behind by the failed create.
	list, err := repo.List(ctx, uid)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("a failed create left %d plan(s) behind; the transaction must roll back", len(list))
	}
}

// Pure logic, no database — these run even without TEST_DATABASE_URL, which
// is most of the time locally.

func TestValidateRejectsAnUnnamedPlan(t *testing.T) {
	if err := (NewClassPlan{Name: ""}).Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Error("an unnamed plan should be refused")
	}
}

func TestValidateBlocksRejectsTooManyBlocks(t *testing.T) {
	tooMany := make([]NewBlock, maxBlocks+1)
	for i := range tooMany {
		tooMany[i] = NewBlock{Type: BlockTypeWarmup, DurationMinutes: 1}
	}
	if err := ValidateBlocks(tooMany); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("a plan of %d blocks should be refused", len(tooMany))
	}
}

func TestValidateBlocksRejectsUnknownType(t *testing.T) {
	if err := ValidateBlocks([]NewBlock{{Type: "cooldown", DurationMinutes: 5}}); !errors.Is(err, ErrInvalidInput) {
		t.Error("an unknown block type should be refused")
	}
}

func TestValidateBlocksRejectsOutOfRangeDuration(t *testing.T) {
	if err := ValidateBlocks([]NewBlock{{Type: BlockTypeWarmup, DurationMinutes: 0}}); !errors.Is(err, ErrInvalidInput) {
		t.Error("a zero-minute block should be refused")
	}
	if err := ValidateBlocks([]NewBlock{{Type: BlockTypeWarmup, DurationMinutes: 181}}); !errors.Is(err, ErrInvalidInput) {
		t.Error("a 181-minute block should be refused")
	}
}

// The XOR is the one property worth naming: exactly one of technique_id/
// free_text on a technique_drill block, never both and never neither.
func TestValidateBlocksTechniqueDrillXOR(t *testing.T) {
	techID := ptr("some-technique")
	freeText := ptr("coach's own variant")

	if err := ValidateBlocks([]NewBlock{
		{Type: BlockTypeTechniqueDrill, DurationMinutes: 10, TechniqueID: techID, FreeText: freeText},
	}); !errors.Is(err, ErrInvalidInput) {
		t.Error("a technique_drill block with BOTH technique_id and free_text should be refused")
	}
	if err := ValidateBlocks([]NewBlock{
		{Type: BlockTypeTechniqueDrill, DurationMinutes: 10},
	}); !errors.Is(err, ErrInvalidInput) {
		t.Error("a technique_drill block with NEITHER technique_id nor free_text should be refused")
	}
	// Exactly one of each is legal.
	if err := ValidateBlocks([]NewBlock{
		{Type: BlockTypeTechniqueDrill, DurationMinutes: 10, TechniqueID: techID},
	}); err != nil {
		t.Errorf("a technique_drill block with only technique_id should validate: %v", err)
	}
	if err := ValidateBlocks([]NewBlock{
		{Type: BlockTypeTechniqueDrill, DurationMinutes: 10, FreeText: freeText},
	}); err != nil {
		t.Errorf("a technique_drill block with only free_text should validate: %v", err)
	}
	// And a non-technique_drill block may carry neither.
	if err := ValidateBlocks([]NewBlock{
		{Type: BlockTypeWarmup, DurationMinutes: 10, TechniqueID: techID},
	}); !errors.Is(err, ErrInvalidInput) {
		t.Error("a warmup block naming a technique_id should be refused — it does not apply")
	}
	if err := ValidateBlocks([]NewBlock{
		{Type: BlockTypeLiveRounds, DurationMinutes: 10, FreeText: freeText},
	}); !errors.Is(err, ErrInvalidInput) {
		t.Error("a live_rounds block naming free_text should be refused — it does not apply")
	}
}

func TestClientIDCharsetAndLength(t *testing.T) {
	if err := (NewClassPlan{ID: "short", Name: "n"}).Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Error("an under-length client id should be refused")
	}
	if err := (NewClassPlan{ID: "randomuuid-1234-5678", Name: "n"}).Validate(); err != nil {
		t.Errorf("a well-formed client id should validate: %v", err)
	}
	if err := (NewClassPlan{ID: "has a space", Name: "n"}).Validate(); !errors.Is(err, ErrInvalidInput) {
		t.Error("a client id with whitespace should be refused")
	}
}

func TestUpdateValidateLeavesNilBlocksAlone(t *testing.T) {
	if err := (ClassPlanUpdate{Name: ptr("ok")}).Validate(); err != nil {
		t.Errorf("an update that does not mention blocks should validate: %v", err)
	}
}
