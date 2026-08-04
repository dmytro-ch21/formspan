package plan

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
	// LIFO, so this closes last. Note it must also be registered before any
	// `defer` in a caller would fire, which is why it is not a defer here.
	t.Cleanup(pool.Close)

	return NewPostgresRepository(pool), pool
}

// cleanupPlans removes every plan for a user regardless of what the test did,
// so a test tidies up after itself even when the code under test refused the
// write it was checking.
func cleanupPlans(t *testing.T, pool *pgxpool.Pool, userID string) {
	t.Helper()
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM plans WHERE user_id = $1`, userID); err != nil {
			t.Logf("cleanup %s: %v", userID, err)
		}
	})
}

func TestCreateAndList(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "plan_test_create"
	cleanupPlans(t, pool, user)

	made, err := repo.Create(ctx, user, NewPlan{
		ID: "plan_test_1", Day: "2026-08-04", Sport: "strength", Notes: "heavy",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// The day must survive the round trip EXACTLY. A DATE scanned into a
	// time.Time and reformatted is where a plan silently moves to the previous
	// day, which is the whole reason the projection casts it to text.
	if made.Day != "2026-08-04" {
		t.Errorf("day = %q, want 2026-08-04", made.Day)
	}
	if made.WorkoutID != nil {
		t.Errorf("workout_id = %v, want nil", *made.WorkoutID)
	}

	got, err := repo.List(ctx, user, Range{From: "2026-08-03", To: "2026-08-09"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 || got[0].ID != "plan_test_1" {
		t.Fatalf("list = %+v, want the one plan", got)
	}
}

func TestListRangeIsInclusive(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "plan_test_range"
	cleanupPlans(t, pool, user)

	// Monday, Sunday, and the next Monday. A half-open range would drop the
	// Sunday — the day a week view most needs.
	for id, day := range map[string]string{
		"plan_range_mon":  "2026-08-03",
		"plan_range_sun":  "2026-08-09",
		"plan_range_next": "2026-08-10",
	} {
		if _, err := repo.Create(ctx, user, NewPlan{ID: id, Day: day, Sport: "strength"}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}

	got, err := repo.List(ctx, user, Range{From: "2026-08-03", To: "2026-08-09"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (Monday and Sunday, not the next Monday)", len(got))
	}
	if got[0].Day != "2026-08-03" || got[1].Day != "2026-08-09" {
		t.Errorf("days = %q, %q; want ascending 2026-08-03, 2026-08-09", got[0].Day, got[1].Day)
	}
}

func TestListIsScopedToTheCaller(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const mine, theirs = "plan_test_mine", "plan_test_theirs"
	cleanupPlans(t, pool, mine)
	cleanupPlans(t, pool, theirs)

	if _, err := repo.Create(ctx, theirs, NewPlan{
		ID: "plan_other_1", Day: "2026-08-04", Sport: "bjj",
	}); err != nil {
		t.Fatalf("create other: %v", err)
	}

	got, err := repo.List(ctx, mine, Range{From: "2026-08-01", To: "2026-08-31"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("len = %d, want 0 — one account must never see another's plans", len(got))
	}
}

// Ids are client-generated and therefore guessable, so every single-row
// operation has to be scoped by user as well. This is the IDOR this codebase
// has already closed twice in other modules.
func TestGetUpdateDeleteCannotCrossUsers(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const mine, theirs = "plan_test_idor_mine", "plan_test_idor_theirs"
	cleanupPlans(t, pool, theirs)

	made, err := repo.Create(ctx, theirs, NewPlan{
		ID: "plan_idor_1", Day: "2026-08-04", Sport: "bjj",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := repo.Get(ctx, mine, made.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get across users = %v, want ErrNotFound", err)
	}
	day := "2026-08-05"
	if _, err := repo.Update(ctx, mine, made.ID, PlanUpdate{Day: &day}); !errors.Is(err, ErrNotFound) {
		t.Errorf("Update across users = %v, want ErrNotFound", err)
	}
	if err := repo.Delete(ctx, mine, made.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Delete across users = %v, want ErrNotFound", err)
	}

	// And the row is untouched — a rejected write must not have half-applied.
	still, err := repo.Get(ctx, theirs, made.ID)
	if err != nil {
		t.Fatalf("owner Get: %v", err)
	}
	if still.Day != "2026-08-04" {
		t.Errorf("day = %q, want it unchanged at 2026-08-04", still.Day)
	}
}

func TestDeleteOfMissingPlanIsNotFound(t *testing.T) {
	repo, _ := newTestRepo(t)
	// Without the RowsAffected check this returns nil and tells the caller the
	// delete worked.
	if err := repo.Delete(context.Background(), "plan_test_nobody", "plan_does_not_exist"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Delete = %v, want ErrNotFound", err)
	}
}

func TestDuplicateIDConflicts(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "plan_test_dup"
	cleanupPlans(t, pool, user)

	in := NewPlan{ID: "plan_dup_1", Day: "2026-08-04", Sport: "strength"}
	if _, err := repo.Create(ctx, user, in); err != nil {
		t.Fatalf("first create: %v", err)
	}
	// The offline retry contract: a resent create must conflict rather than
	// make a second plan.
	if _, err := repo.Create(ctx, user, in); !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("second create = %v, want ErrAlreadyExists", err)
	}
}

// A day holds a list, not a single entry — two-a-days are normal here.
func TestADayHoldsMoreThanOnePlan(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "plan_test_twoaday"
	cleanupPlans(t, pool, user)

	for _, p := range []NewPlan{
		{ID: "plan_am", Day: "2026-08-04", Sport: "strength"},
		{ID: "plan_pm", Day: "2026-08-04", Sport: "bjj"},
	} {
		if _, err := repo.Create(ctx, user, p); err != nil {
			t.Fatalf("create %s: %v", p.ID, err)
		}
	}

	got, err := repo.List(ctx, user, Range{From: "2026-08-04", To: "2026-08-04"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	// Insertion order within a day, so the morning session stays first.
	if got[0].ID != "plan_am" || got[1].ID != "plan_pm" {
		t.Errorf("order = %q, %q; want plan_am then plan_pm", got[0].ID, got[1].ID)
	}
}

// The three-state WorkoutID: absent leaves it, a value sets it, an explicit
// null clears it. A single pointer collapses the last two and the clear
// silently does nothing.
func TestUpdateCanClearTheWorkoutButLeavesItWhenAbsent(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "plan_test_workout"
	cleanupPlans(t, pool, user)

	// A real workout, so the foreign key is satisfied. Created directly rather
	// than through the workout module to keep this test's dependencies to the
	// table it is about.
	const workoutID = "plan_test_workout_row"
	if _, err := pool.Exec(ctx,
		`INSERT INTO workouts (id, owner_user_id, sport, name)
		 VALUES ($1, $2, 'strength', 'Push Day')`, workoutID, user); err != nil {
		t.Fatalf("seed workout: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM workouts WHERE id = $1`, workoutID); err != nil {
			t.Logf("cleanup workout: %v", err)
		}
	})

	wid := workoutID
	made, err := repo.Create(ctx, user, NewPlan{
		ID: "plan_w_1", Day: "2026-08-04", Sport: "strength", WorkoutID: &wid,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if made.WorkoutID == nil || *made.WorkoutID != workoutID {
		t.Fatalf("workout_id = %v, want %q", made.WorkoutID, workoutID)
	}

	// Absent: unchanged.
	notes := "leg day"
	after, err := repo.Update(ctx, user, made.ID, PlanUpdate{Notes: &notes})
	if err != nil {
		t.Fatalf("update notes: %v", err)
	}
	if after.WorkoutID == nil || *after.WorkoutID != workoutID {
		t.Errorf("workout_id = %v after an unrelated update, want it unchanged", after.WorkoutID)
	}

	// Explicit null: cleared.
	var null *string
	cleared, err := repo.Update(ctx, user, made.ID, PlanUpdate{WorkoutID: &null})
	if err != nil {
		t.Fatalf("clear workout: %v", err)
	}
	if cleared.WorkoutID != nil {
		t.Errorf("workout_id = %v, want nil after an explicit null", *cleared.WorkoutID)
	}
}

// Deleting a template must not delete the days planned around it — the plan
// degrades to its discipline, which is still true and still startable.
func TestDeletingAWorkoutKeepsThePlan(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "plan_test_fk"
	cleanupPlans(t, pool, user)

	const workoutID = "plan_test_fk_workout"
	if _, err := pool.Exec(ctx,
		// `owner_user_id`, not `user_id`: a workout's owner is nullable, because
		// VOLA's own public templates have none — see workouts_official_is_public.
		`INSERT INTO workouts (id, owner_user_id, sport, name)
		 VALUES ($1, $2, 'strength', 'Doomed')`, workoutID, user); err != nil {
		t.Fatalf("seed workout: %v", err)
	}

	wid := workoutID
	if _, err := repo.Create(ctx, user, NewPlan{
		ID: "plan_fk_1", Day: "2026-08-04", Sport: "strength", WorkoutID: &wid,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM workouts WHERE id = $1`, workoutID); err != nil {
		t.Fatalf("delete workout: %v", err)
	}

	got, err := repo.Get(ctx, user, "plan_fk_1")
	if err != nil {
		t.Fatalf("get after workout delete: %v", err)
	}
	if got.WorkoutID != nil {
		t.Errorf("workout_id = %v, want nil (ON DELETE SET NULL)", *got.WorkoutID)
	}
}

func TestInvalidInput(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "plan_test_invalid"
	cleanupPlans(t, pool, user)

	t.Run("a timestamp is not a calendar date", func(t *testing.T) {
		// Accepting this would truncate it using the server's idea of the
		// zone, quietly moving the plan for anyone not on UTC.
		_, err := repo.Create(ctx, user, NewPlan{
			ID: "plan_bad_1", Day: "2026-08-04T00:00:00Z", Sport: "strength",
		})
		if !errors.Is(err, ErrInvalidInput) {
			t.Errorf("err = %v, want ErrInvalidInput", err)
		}
	})

	t.Run("unknown sport is rejected by the CHECK", func(t *testing.T) {
		_, err := repo.Create(ctx, user, NewPlan{
			ID: "plan_bad_2", Day: "2026-08-04", Sport: "quidditch",
		})
		if !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("err = %v, want ErrInvalidInput", err)
		}
		// The Postgres message must not leak — it names constraints and values.
		if strings.Contains(err.Error(), "plans_sport_valid") {
			t.Errorf("err leaks the constraint name: %v", err)
		}
	})

	t.Run("unknown workout is a 400, not a 500", func(t *testing.T) {
		missing := "no_such_workout"
		_, err := repo.Create(ctx, user, NewPlan{
			ID: "plan_bad_3", Day: "2026-08-04", Sport: "strength", WorkoutID: &missing,
		})
		if !errors.Is(err, ErrInvalidInput) {
			t.Errorf("err = %v, want ErrInvalidInput", err)
		}
	})

	t.Run("backwards range", func(t *testing.T) {
		_, err := repo.List(ctx, user, Range{From: "2026-08-09", To: "2026-08-03"})
		if !errors.Is(err, ErrInvalidInput) {
			t.Errorf("err = %v, want ErrInvalidInput", err)
		}
	})

	t.Run("an unbounded range is refused", func(t *testing.T) {
		_, err := repo.List(ctx, user, Range{From: "2000-01-01", To: "2030-01-01"})
		if !errors.Is(err, ErrInvalidInput) {
			t.Errorf("err = %v, want ErrInvalidInput", err)
		}
	})
}
