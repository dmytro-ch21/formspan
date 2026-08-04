package workout

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres integration tests. They need TEST_DATABASE_URL (see
// docker-compose.yml or backend/.env.example) and skip gracefully without it.
// The exercise catalog must be seeded — `go run ./cmd/seed`.

func newTestRepo(t *testing.T) (*PostgresRepository, *pgxpool.Pool) {
	t.Helper()

	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}

	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered before any cleanup that still needs the pool — t.Cleanup is
	// LIFO, so this closes last.
	t.Cleanup(pool.Close)

	return NewPostgresRepository(pool), pool
}

// cleanupWorkout removes a workout by ID regardless of owner, so a test
// tidies up after itself even when the code under test refused the write.
func cleanupWorkout(t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM workouts WHERE id = $1`, id); err != nil {
			t.Logf("cleanup %s: %v", id, err)
		}
	})
}

// Catalog IDs used as fixtures. Named rather than inlined because the
// exercise catalog is generated from a spreadsheet now, so a content edit
// can rename one — and the failure then shows up in five tests at once.
const (
	exBench    = "bench-press"
	exOverhead = "overhead-press"
	exSquat    = "back-squat"
	// A non-strength entry, for the mismatch test. Was "bear-crawl-forward"
	// until migration 000019 removed the BJJ drills from the catalog.
	exRun = "run"
)

func strengthWorkout(id, owner string, vis Visibility) NewWorkout {
	goal := GoalHypertrophy
	sets, reps := 5, 5
	return NewWorkout{
		ID: id, OwnerUserID: owner, Name: "Push Day A",
		Sport: SportStrength, Goal: &goal, Visibility: vis,
		Items: []Item{
			{ExerciseID: exBench, TargetSets: &sets, TargetReps: &reps},
			{ExerciseID: exOverhead, TargetSets: &sets, TargetReps: &reps},
		},
	}
}

func TestCreateAndGet(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-create-1")

	wk, err := repo.Create(ctx, strengthWorkout("wk-create-1", "user_a", VisibilityPrivate))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(wk.Items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(wk.Items))
	}
	// Position comes from array order, not the client — so the stored order
	// always matches what was sent.
	if wk.Items[0].ExerciseID != exBench || wk.Items[0].Position != 0 {
		t.Errorf("unexpected first item: %+v", wk.Items[0])
	}
	if wk.Items[1].Position != 1 {
		t.Errorf("expected position 1, got %d", wk.Items[1].Position)
	}
	if wk.OwnerUserID == nil || *wk.OwnerUserID != "user_a" {
		t.Errorf("owner not set to the creating user: %+v", wk.OwnerUserID)
	}
}

// Same lesson as the activity module: IDs are client-generated, so a
// conflict fallback that isn't owner-scoped hands an attacker someone
// else's row.
func TestCreate_RejectsAnotherUsersID(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-collide-1")

	if _, err := repo.Create(ctx, strengthWorkout("wk-collide-1", "user_victim", VisibilityPrivate)); err != nil {
		t.Fatalf("seed victim: %v", err)
	}

	got, err := repo.Create(ctx, strengthWorkout("wk-collide-1", "user_attacker", VisibilityPrivate))
	if !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("expected ErrAlreadyExists, got %v", err)
	}
	if got != nil {
		t.Errorf("attacker received a workout back: %+v", got)
	}
}

func TestCreate_IsIdempotentForSameOwner(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-idem-1")

	first, err := repo.Create(ctx, strengthWorkout("wk-idem-1", "user_a", VisibilityPrivate))
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	second, err := repo.Create(ctx, strengthWorkout("wk-idem-1", "user_a", VisibilityPrivate))
	if err != nil {
		t.Fatalf("retry should be idempotent, got %v", err)
	}
	if !second.CreatedAt.Equal(first.CreatedAt) {
		t.Error("retry created a different row rather than returning the original")
	}
	if len(second.Items) != 2 {
		t.Errorf("retry duplicated or lost items: %d", len(second.Items))
	}
}

// "No mixed workouts" is a data-model guarantee, not a UI convention.
func TestCreate_RejectsSportMismatch(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-mixed-1")

	in := strengthWorkout("wk-mixed-1", "user_a", VisibilityPrivate)
	in.Items = append(in.Items, Item{ExerciseID: exRun})

	if _, err := repo.Create(ctx, in); !errors.Is(err, ErrSportMismatch) {
		t.Errorf("expected ErrSportMismatch, got %v", err)
	}

	// And the whole create must have rolled back, not left a partial row.
	if _, err := repo.Get(ctx, "user_a", "wk-mixed-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("failed create left a row behind: %v", err)
	}
}

func TestCreate_RejectsUnknownExercise(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-unknown-1")

	in := strengthWorkout("wk-unknown-1", "user_a", VisibilityPrivate)
	in.Items = []Item{{ExerciseID: "no-such-exercise"}}

	if _, err := repo.Create(ctx, in); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("expected ErrInvalidInput, got %v", err)
	}
}

func TestVisibility(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-private-1")
	cleanupWorkout(t, pool, "wk-public-1")

	if _, err := repo.Create(ctx, strengthWorkout("wk-private-1", "user_owner", VisibilityPrivate)); err != nil {
		t.Fatalf("create private: %v", err)
	}
	if _, err := repo.Create(ctx, strengthWorkout("wk-public-1", "user_owner", VisibilityPublic)); err != nil {
		t.Fatalf("create public: %v", err)
	}

	// A stranger sees the public one and not the private one — and gets
	// ErrNotFound rather than ErrForbidden for the private one, so they
	// can't tell a private workout from a nonexistent ID.
	if _, err := repo.Get(ctx, "user_stranger", "wk-private-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("private workout leaked to a stranger: %v", err)
	}
	if _, err := repo.Get(ctx, "user_stranger", "wk-public-1"); err != nil {
		t.Errorf("public workout not visible to a stranger: %v", err)
	}

	// scope=mine must never include someone else's public workout.
	mine, err := repo.List(ctx, "user_stranger", Filter{Mine: true})
	if err != nil {
		t.Fatalf("list mine: %v", err)
	}
	for _, w := range mine {
		if w.ID == "wk-public-1" {
			t.Error("scope=mine returned another user's public workout")
		}
	}
}

// Visible does not mean writable.
func TestWrites_AreOwnerOnly(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-owner-1")

	if _, err := repo.Create(ctx, strengthWorkout("wk-owner-1", "user_owner", VisibilityPublic)); err != nil {
		t.Fatalf("create: %v", err)
	}

	_, err := repo.ReplaceItems(ctx, "user_stranger", "wk-owner-1",
		[]Item{{ExerciseID: exSquat}})
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("a stranger edited a public workout: %v", err)
	}
	if err := repo.Delete(ctx, "user_stranger", "wk-owner-1"); !errors.Is(err, ErrForbidden) {
		t.Errorf("a stranger deleted a public workout: %v", err)
	}

	// The owner can still do both.
	updated, err := repo.ReplaceItems(ctx, "user_owner", "wk-owner-1",
		[]Item{{ExerciseID: exSquat}})
	if err != nil {
		t.Fatalf("owner replace: %v", err)
	}
	if len(updated.Items) != 1 || updated.Items[0].ExerciseID != exSquat {
		t.Errorf("replace did not swap the list: %+v", updated.Items)
	}
	if err := repo.Delete(ctx, "user_owner", "wk-owner-1"); err != nil {
		t.Errorf("owner delete: %v", err)
	}
}

func TestReplaceItems_Reorders(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-reorder-1")

	if _, err := repo.Create(ctx, strengthWorkout("wk-reorder-1", "user_a", VisibilityPrivate)); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Reordering must not trip the (workout_id, position) unique constraint —
	// the reason items are replaced wholesale rather than diffed.
	got, err := repo.ReplaceItems(ctx, "user_a", "wk-reorder-1", []Item{
		{ExerciseID: exOverhead},
		{ExerciseID: exBench},
	})
	if err != nil {
		t.Fatalf("reorder: %v", err)
	}
	if got.Items[0].ExerciseID != exOverhead {
		t.Errorf("order not applied: %+v", got.Items)
	}
}

// A stranger must not be able to tell a private workout apart from a
// nonexistent one on ANY path — reads and writes alike.
//
// The original requireOwner selected only owner and sport, so writing to a
// stranger's private workout returned ErrForbidden while a missing ID
// returned ErrNotFound. That pair of answers confirms the ID exists, and
// since IDs are client-generated they're often guessable ("push-day-a")
// rather than random — a practical enumeration oracle, not a theoretical
// one. It undid on the write paths exactly the guarantee Get already upheld.
//
// The original tests missed it because their fixture was public — the one
// case where ErrForbidden is the correct answer.
func TestPrivateWorkout_IsNotAnExistenceOracle(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-oracle-1")

	if _, err := repo.Create(ctx, strengthWorkout("wk-oracle-1", "user_victim", VisibilityPrivate)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := repo.ReplaceItems(ctx, "user_attacker", "wk-oracle-1", nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("ReplaceItems on a stranger's private workout: got %v, want ErrNotFound", err)
	}
	if err := repo.Delete(ctx, "user_attacker", "wk-oracle-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Delete on a stranger's private workout: got %v, want ErrNotFound", err)
	}

	// Refusing must also mean not mutating.
	victim, err := repo.Get(ctx, "user_victim", "wk-oracle-1")
	if err != nil {
		t.Fatalf("victim's workout gone: %v", err)
	}
	if len(victim.Items) != 2 {
		t.Errorf("attacker mutated the victim's workout: %d items left", len(victim.Items))
	}
}

// A *public* workout still returns ErrForbidden rather than ErrNotFound: the
// caller can already read it, so there's nothing left to hide, and a 404
// would be a lie that disguises a real permission problem as a missing row.
func TestPublicWorkout_WriteIsForbiddenNotHidden(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-public-write-1")

	if _, err := repo.Create(ctx, strengthWorkout("wk-public-write-1", "user_owner", VisibilityPublic)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := repo.ReplaceItems(ctx, "user_stranger", "wk-public-write-1", nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("got %v, want ErrForbidden", err)
	}
}

// A CHECK violation is bad client input, not an internal failure: it must
// surface as invalid_input, and the message must not carry raw Postgres
// text, which names constraints and sometimes values.
func TestInvalidTarget_IsInvalidInputNotInternal(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-badtarget-1")

	zero := 0
	in := strengthWorkout("wk-badtarget-1", "user_a", VisibilityPrivate)
	in.Items = []Item{{ExerciseID: exBench, TargetSets: &zero}}

	_, err := repo.Create(ctx, in)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("got %v, want ErrInvalidInput", err)
	}
	for _, leak := range []string{"workout_items_targets_positive", "SQLSTATE", "violates"} {
		if strings.Contains(err.Error(), leak) {
			t.Errorf("error leaks internal detail %q: %v", leak, err)
		}
	}
}

// The visible list mixes the caller's own workouts with EVERY user's public
// ones, so it is the one list on the platform whose size is driven by total
// user count. apihttp.ConditionalGet buffers response bodies to hash them,
// which made that a memory ceiling rather than a latency smell — hence the
// cap.
//
// A cap over a mixed-ownership list has a failure mode a plain count
// assertion cannot see: order alphabetically and a user's own workout named
// "Z…" is evicted by 500 strangers' workouts named "A…". Own rows sort first
// for exactly that reason.
func TestListCapDoesNotEvictTheCallersOwnWorkouts(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	const owner = "user_cap_owner"
	const stranger = "user_cap_stranger"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx,
			`DELETE FROM workouts WHERE owner_user_id = ANY($1)`,
			[]string{owner, stranger}); err != nil {
			t.Logf("cleanup: %v", err)
		}
	})

	// The caller's own workout sorts LAST alphabetically, so nothing but the
	// ownership term can keep it in.
	own := strengthWorkout("wk-cap-own", owner, VisibilityPrivate)
	own.Name = "zzz last by name"
	if _, err := repo.Create(ctx, own); err != nil {
		t.Fatalf("create own: %v", err)
	}

	// Enough public workouts from someone else to fill the cap on their own.
	for i := 0; i < maxWorkouts; i++ {
		w := strengthWorkout(fmt.Sprintf("wk-cap-pub-%04d", i), stranger, VisibilityPublic)
		w.Name = fmt.Sprintf("aaa public %04d", i)
		if _, err := repo.Create(ctx, w); err != nil {
			t.Fatalf("create public %d: %v", i, err)
		}
	}

	// A VOLA-authored official template: owner_user_id IS NULL, forced public
	// by the workouts_official_is_public CHECK. Created directly because
	// Create() takes an owner. This row is why the ownership term uses
	// IS NOT DISTINCT FROM: `NULL = $1` is NULL, and `ORDER BY ... DESC` is
	// NULLS FIRST, so `=` sorts every official template ABOVE the caller's own
	// — the same eviction, by the one row class that outranks them. A fixture
	// where every row has a real owner cannot see it.
	if _, err := pool.Exec(ctx, `
		INSERT INTO workouts (id, owner_user_id, name, sport, visibility)
		VALUES ('wk-cap-official', NULL, 'aaa official template', 'strength', 'public')`); err != nil {
		t.Fatalf("create official template: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM workouts WHERE id = 'wk-cap-official'`); err != nil {
			t.Logf("cleanup official: %v", err)
		}
	})

	got, err := repo.List(ctx, owner, Filter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != maxWorkouts {
		t.Fatalf("got %d workouts, want the ceiling of %d", len(got), maxWorkouts)
	}
	if got[0].ID != "wk-cap-own" {
		t.Errorf("the caller's own workout is not first: got %s", got[0].ID)
	}
	found := false
	for _, w := range got {
		if w.ID == "wk-cap-own" {
			found = true
		}
	}
	if !found {
		t.Error("the cap evicted the caller's own workout in favour of strangers' public ones")
	}
}

// Rename is the third write verb, and it needs the same ownership gate the
// other two have — the ids are client-supplied, so without it any id you can
// guess is renameable. This module has already had to close that hole once.
func TestRename_IsOwnerOnlyAndKeepsItems(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanupWorkout(t, pool, "wk-rename-1")

	if _, err := repo.Create(ctx, strengthWorkout("wk-rename-1", "user_owner", VisibilityPublic)); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Public, so a stranger can READ it — the refusal has to come from the
	// write gate, not from the row being invisible.
	if _, err := repo.Get(ctx, "user_stranger", "wk-rename-1"); err != nil {
		t.Fatalf("a public workout should be readable by a stranger: %v", err)
	}
	if _, err := repo.Rename(ctx, "user_stranger", "wk-rename-1", "Stolen"); !errors.Is(err, ErrForbidden) {
		t.Errorf("a stranger renamed a public workout: %v", err)
	}
	// And the name genuinely did not move.
	after, err := repo.Get(ctx, "user_owner", "wk-rename-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if after.Name == "Stolen" {
		t.Error("the refused rename was written anyway")
	}

	before := after
	renamed, err := repo.Rename(ctx, "user_owner", "wk-rename-1", "Maestro Push Day")
	if err != nil {
		t.Fatalf("owner rename: %v", err)
	}
	if renamed.Name != "Maestro Push Day" {
		t.Errorf("name = %q, want %q", renamed.Name, "Maestro Push Day")
	}
	// The whole point of a separate verb: renaming must not disturb the item
	// list. Folded into ReplaceItems, a rename would have to resend it.
	if len(renamed.Items) != len(before.Items) {
		t.Errorf("rename changed the item list: %d items, want %d", len(renamed.Items), len(before.Items))
	}
	// Against the PRE-RENAME value, not against CreatedAt. Both columns default
	// to now() and Postgres now() is transaction time, so straight after the
	// insert they are identical and `UpdatedAt.Before(CreatedAt)` can never be
	// true — the assertion that was here passed with `updated_at = now()`
	// deleted from the UPDATE, which is exactly the mutation it claimed to catch.
	if !renamed.UpdatedAt.After(before.UpdatedAt) {
		t.Errorf("updated_at was not touched: %v then %v", before.UpdatedAt, renamed.UpdatedAt)
	}
}

// A workout that does not exist must not be distinguishable from one that
// exists and is not yours — same reasoning as TestPrivateWorkout_IsNotAnExistenceOracle.
func TestRename_UnknownIDIsNotFound(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	if _, err := repo.Rename(ctx, "user_a", "wk-does-not-exist", "X"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}

	// The half that actually matters, and which the unknown-id case alone does
	// not cover: someone else's PRIVATE workout must answer the same way an
	// absent one does. ErrForbidden here would confirm the id exists, turning
	// the endpoint into an enumeration oracle over other people's templates.
	// (A PUBLIC one is different on purpose — you can already see it, so the
	// honest answer is "not yours", and TestRename_IsOwnerOnlyAndKeepsItems
	// pins that.)
	cleanupWorkout(t, pool, "wk-rename-private")
	if _, err := repo.Create(ctx, strengthWorkout("wk-rename-private", "user_owner", VisibilityPrivate)); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := repo.Rename(ctx, "user_stranger", "wk-rename-private", "X"); !errors.Is(err, ErrNotFound) {
		t.Errorf("a stranger's private workout leaked its existence: err = %v, want ErrNotFound", err)
	}
}
