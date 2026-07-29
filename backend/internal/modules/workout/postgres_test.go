package workout

import (
	"context"
	"errors"
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

func strengthWorkout(id, owner string, vis Visibility) NewWorkout {
	goal := GoalHypertrophy
	sets, reps := 5, 5
	return NewWorkout{
		ID: id, OwnerUserID: owner, Name: "Push Day A",
		Sport: SportStrength, Goal: &goal, Visibility: vis,
		Items: []Item{
			{ExerciseID: "barbell-bench-press", TargetSets: &sets, TargetReps: &reps},
			{ExerciseID: "barbell-overhead-press", TargetSets: &sets, TargetReps: &reps},
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
	if wk.Items[0].ExerciseID != "barbell-bench-press" || wk.Items[0].Position != 0 {
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
	in.Items = append(in.Items, Item{ExerciseID: "bjj-gi-rounds"})

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
		[]Item{{ExerciseID: "barbell-back-squat"}})
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("a stranger edited a public workout: %v", err)
	}
	if err := repo.Delete(ctx, "user_stranger", "wk-owner-1"); !errors.Is(err, ErrForbidden) {
		t.Errorf("a stranger deleted a public workout: %v", err)
	}

	// The owner can still do both.
	updated, err := repo.ReplaceItems(ctx, "user_owner", "wk-owner-1",
		[]Item{{ExerciseID: "barbell-back-squat"}})
	if err != nil {
		t.Fatalf("owner replace: %v", err)
	}
	if len(updated.Items) != 1 || updated.Items[0].ExerciseID != "barbell-back-squat" {
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
		{ExerciseID: "barbell-overhead-press"},
		{ExerciseID: "barbell-bench-press"},
	})
	if err != nil {
		t.Fatalf("reorder: %v", err)
	}
	if got.Items[0].ExerciseID != "barbell-overhead-press" {
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
	in.Items = []Item{{ExerciseID: "barbell-bench-press", TargetSets: &zero}}

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
