package session

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres integration tests, gated on TEST_DATABASE_URL. The exercise
// catalog must be seeded (`go run ./cmd/seed`).

const (
	exBench = "bench-press"
	exSquat = "back-squat"
	exBJJ   = "bear-crawl-forward"
)

func newTestRepo(t *testing.T) (*PostgresRepository, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	pool, err := database.NewPool(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered first so it closes last under LIFO cleanup.
	t.Cleanup(pool.Close)
	return NewPostgresRepository(pool), pool
}

func cleanup(t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM sessions WHERE id = $1`, id); err != nil {
			t.Logf("cleanup %s: %v", id, err)
		}
	})
}

func ptrInt(v int) *int       { return &v }
func ptrF(v float64) *float64 { return &v }

func strengthSession(id, user string, sets []Set) NewSession {
	return NewSession{
		ID: id, UserID: user, Sport: "strength", Name: "Test session",
		StartedAt: time.Now().UTC().Add(-time.Hour), Sets: sets,
	}
}

func TestCreateAndGet_RecordsEveryMeasure(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-1")

	in := strengthSession("ses-1", "user_a", []Set{
		{ExerciseID: exBench, SetType: SetTypeWarmup, Reps: ptrInt(10), WeightKg: ptrF(40)},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RIR: ptrInt(2)},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RPE: ptrF(8.5)},
	})
	s, err := repo.Create(ctx, in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(s.Sets) != 3 {
		t.Fatalf("expected 3 sets, got %d", len(s.Sets))
	}
	// Every recorded measure must survive the round trip — this is the whole
	// point of the module.
	got := s.Sets[1]
	if got.Reps == nil || *got.Reps != 5 {
		t.Errorf("reps lost: %+v", got.Reps)
	}
	if got.WeightKg == nil || *got.WeightKg != 100 {
		t.Errorf("weight lost: %+v", got.WeightKg)
	}
	if got.RIR == nil || *got.RIR != 2 {
		t.Errorf("RIR lost: %+v", got.RIR)
	}
	if s.Sets[2].RPE == nil || *s.Sets[2].RPE != 8.5 {
		t.Errorf("RPE lost or rounded: %+v", s.Sets[2].RPE)
	}
	// Position comes from array order, not the client.
	if s.Sets[0].Position != 0 || s.Sets[2].Position != 2 {
		t.Errorf("positions not assigned in order: %+v", s.Sets)
	}
}

// Warm-ups must not inflate working volume. Counting them would make a light
// day look like a hard one and poison anything built on top.
func TestSummarise_ExcludesWarmups(t *testing.T) {
	v := Summarise([]Set{
		{ExerciseID: exBench, SetType: SetTypeWarmup, Reps: ptrInt(10), WeightKg: ptrF(40)},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RPE: ptrF(8)},
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(3), WeightKg: ptrF(140), RPE: ptrF(9.5)},
	})
	if v.WorkingSets != 2 {
		t.Errorf("working sets counted warm-ups: got %d, want 2", v.WorkingSets)
	}
	if v.TotalReps != 8 {
		t.Errorf("total reps: got %d, want 8", v.TotalReps)
	}
	if v.TonnageKg != 5*100+3*140 {
		t.Errorf("tonnage: got %v, want %v", v.TonnageKg, 5*100+3*140)
	}
	if v.HardestRPE != 9.5 {
		t.Errorf("hardest RPE: got %v, want 9.5", v.HardestRPE)
	}
	// An exercise appearing in several sets is still one exercise.
	if len(v.ExerciseIDs) != 2 {
		t.Errorf("exercise ids: got %v, want 2 distinct", v.ExerciseIDs)
	}
}

// The same IDOR the activity and workout modules each had to close: IDs are
// client-generated, so the conflict lookup must be user-scoped.
func TestCreate_RejectsAnotherUsersID(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-collide")

	if _, err := repo.Create(ctx, strengthSession("ses-collide", "user_victim", nil)); err != nil {
		t.Fatalf("seed victim: %v", err)
	}
	got, err := repo.Create(ctx, strengthSession("ses-collide", "user_attacker", nil))
	if !errors.Is(err, ErrAlreadyExists) {
		t.Errorf("expected ErrAlreadyExists, got %v", err)
	}
	if got != nil {
		t.Errorf("attacker received a session: %+v", got)
	}
}

// A session is never shared, so "not yours" and "doesn't exist" must be
// indistinguishable — otherwise client-generated IDs are enumerable.
func TestOtherUsersSession_IsIndistinguishableFromMissing(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-private")

	if _, err := repo.Create(ctx, strengthSession("ses-private", "user_victim", nil)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := repo.Get(ctx, "user_attacker", "ses-private"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get leaked existence: %v", err)
	}
	if _, err := repo.ReplaceSets(ctx, "user_attacker", "ses-private", nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("ReplaceSets leaked existence: %v", err)
	}
	if err := repo.Delete(ctx, "user_attacker", "ses-private"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Delete leaked existence: %v", err)
	}
	if _, err := repo.Finish(ctx, "user_attacker", "ses-private", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Errorf("Finish leaked existence: %v", err)
	}
	// And nothing was mutated.
	victim, err := repo.Get(ctx, "user_victim", "ses-private")
	if err != nil || victim.EndedAt != nil {
		t.Errorf("victim's session was altered: %+v, err %v", victim, err)
	}
}

func TestCreate_RejectsSportMismatch(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-mixed")

	_, err := repo.Create(ctx, strengthSession("ses-mixed", "user_a", []Set{
		{ExerciseID: exBJJ, Reps: ptrInt(5)},
	}))
	if !errors.Is(err, ErrSportMismatch) {
		t.Errorf("expected ErrSportMismatch, got %v", err)
	}
	// And the whole create rolled back rather than leaving a bare session.
	if _, err := repo.Get(ctx, "user_a", "ses-mixed"); !errors.Is(err, ErrNotFound) {
		t.Errorf("failed create left a row behind: %v", err)
	}
}

// An out-of-range effort value is bad input, not an internal failure — and
// the message must not carry raw Postgres text.
func TestCreate_RejectsImpossibleEffortValues(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-badrpe")

	_, err := repo.Create(ctx, strengthSession("ses-badrpe", "user_a", []Set{
		{ExerciseID: exBench, Reps: ptrInt(5), RPE: ptrF(15)},
	}))
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
	for _, leak := range []string{"SQLSTATE", "violates", "session_sets_rpe_range"} {
		if err != nil && contains(err.Error(), leak) {
			t.Errorf("error leaks internal detail %q: %v", leak, err)
		}
	}
}

func contains(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func TestReplaceSets_AndFinish(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-edit")

	if _, err := repo.Create(ctx, strengthSession("ses-edit", "user_a", []Set{
		{ExerciseID: exBench, Reps: ptrInt(5), WeightKg: ptrF(100)},
	})); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Logging another set is a whole-list replace — and reordering must not
	// trip the (session_id, position) unique constraint.
	updated, err := repo.ReplaceSets(ctx, "user_a", "ses-edit", []Set{
		{ExerciseID: exSquat, Reps: ptrInt(3), WeightKg: ptrF(140), RIR: ptrInt(1)},
		{ExerciseID: exBench, Reps: ptrInt(5), WeightKg: ptrF(100)},
	})
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if len(updated.Sets) != 2 || updated.Sets[0].ExerciseID != exSquat {
		t.Errorf("replace did not apply the new order: %+v", updated.Sets)
	}

	if updated.EndedAt != nil {
		t.Error("session ended before it was finished")
	}
	done, err := repo.Finish(ctx, "user_a", "ses-edit", time.Now().UTC())
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	if done.EndedAt == nil {
		t.Error("finish did not set ended_at")
	}
}

// Deleting a template must not erase the sessions performed against it —
// history outlives the plan.
func TestDeletingWorkout_KeepsSessionHistory(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-orphan")

	wid := "wk-for-session-test"
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workouts WHERE id = $1`, wid)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO workouts (id, owner_user_id, name, sport, visibility)
		VALUES ($1, 'user_a', 'Temp', 'strength', 'private')
		ON CONFLICT (id) DO NOTHING`, wid); err != nil {
		t.Fatalf("seed workout: %v", err)
	}

	in := strengthSession("ses-orphan", "user_a", []Set{{ExerciseID: exBench, Reps: ptrInt(5)}})
	in.WorkoutID = &wid
	if _, err := repo.Create(ctx, in); err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM workouts WHERE id = $1`, wid); err != nil {
		t.Fatalf("delete workout: %v", err)
	}

	s, err := repo.Get(ctx, "user_a", "ses-orphan")
	if err != nil {
		t.Fatalf("session vanished with its template: %v", err)
	}
	if s.WorkoutID != nil {
		t.Errorf("expected workout_id nulled, got %v", *s.WorkoutID)
	}
	if len(s.Sets) != 1 {
		t.Errorf("sets lost with the template: %d", len(s.Sets))
	}
}

// TestCreate_PrivateWorkoutIsNotAnExistenceOracle is the regression test for
// a real bug found in review: workout_id was written straight from the
// request body with no visibility check, so naming someone else's private
// template succeeded (200) while naming a nonexistent one tripped the
// foreign key (400). Workout IDs are client-generated and often guessable,
// which made that split a practical way to enumerate private templates.
//
// Both cases must now be the same 400, with the same message.
func TestCreate_PrivateWorkoutIsNotAnExistenceOracle(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-oracle")

	victimWorkout := "wk-victim-private"
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workouts WHERE id = $1`, victimWorkout)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO workouts (id, owner_user_id, name, sport, visibility)
		VALUES ($1, 'user_victim', 'Secret', 'strength', 'private')
		ON CONFLICT (id) DO NOTHING`, victimWorkout); err != nil {
		t.Fatalf("seed workout: %v", err)
	}

	attempt := func(t *testing.T, workoutID string) error {
		t.Helper()
		in := strengthSession("ses-oracle", "user_attacker", []Set{{ExerciseID: exBench, Reps: ptrInt(5)}})
		in.WorkoutID = &workoutID
		_, err := repo.Create(ctx, in)
		return err
	}

	existing := attempt(t, victimWorkout)
	missing := attempt(t, "wk-definitely-not-a-real-id")

	if !errors.Is(existing, ErrInvalidInput) {
		t.Fatalf("someone else's private workout was accepted (or errored differently): %v", existing)
	}
	if !errors.Is(missing, ErrInvalidInput) {
		t.Fatalf("nonexistent workout: want ErrInvalidInput, got %v", missing)
	}
	if existing.Error() != missing.Error() {
		t.Errorf("responses distinguish existing from missing:\n  existing: %q\n  missing:  %q",
			existing.Error(), missing.Error())
	}

	// And nothing was written on either attempt.
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id = 'ses-oracle'`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("a refused create still wrote a session")
	}
}

// A public template is genuinely usable by anyone — the check must gate on
// visibility, not simply on ownership, or performing a shared workout breaks.
func TestCreate_AcceptsAPublicWorkoutFromAnotherOwner(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-public-wk")

	sharedWorkout := "wk-shared-public"
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workouts WHERE id = $1`, sharedWorkout)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO workouts (id, owner_user_id, name, sport, visibility)
		VALUES ($1, 'user_author', 'Shared', 'strength', 'public')
		ON CONFLICT (id) DO NOTHING`, sharedWorkout); err != nil {
		t.Fatalf("seed workout: %v", err)
	}

	in := strengthSession("ses-public-wk", "user_b", []Set{{ExerciseID: exBench, Reps: ptrInt(5)}})
	in.WorkoutID = &sharedWorkout
	s, err := repo.Create(ctx, in)
	if err != nil {
		t.Fatalf("a public workout must be performable by anyone: %v", err)
	}
	if s.WorkoutID == nil || *s.WorkoutID != sharedWorkout {
		t.Errorf("workout_id not recorded: %v", s.WorkoutID)
	}
}

// A session's sport is denormalised from its workout with nothing in the
// schema keeping them honest, so it's checked on the way in.
func TestCreate_RejectsWorkoutOfAnotherSport(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-wk-sport")

	bjjWorkout := "wk-bjj-for-session-test"
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workouts WHERE id = $1`, bjjWorkout)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO workouts (id, owner_user_id, name, sport, visibility)
		VALUES ($1, 'user_a', 'Rolling', 'bjj', 'private')
		ON CONFLICT (id) DO NOTHING`, bjjWorkout); err != nil {
		t.Fatalf("seed workout: %v", err)
	}

	in := strengthSession("ses-wk-sport", "user_a", nil)
	in.WorkoutID = &bjjWorkout
	if _, err := repo.Create(ctx, in); !errors.Is(err, ErrSportMismatch) {
		t.Fatalf("want ErrSportMismatch, got %v", err)
	}
}

// List is the one endpoint that could leak someone else's history wholesale,
// and it had no test at all.
func TestList_IsUserScopedAndFiltered(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-list-mine")
	cleanup(t, pool, "ses-list-theirs")
	cleanup(t, pool, "ses-list-bjj")

	mine := strengthSession("ses-list-mine", "user_list_a", []Set{{ExerciseID: exSquat, Reps: ptrInt(5)}})
	if _, err := repo.Create(ctx, mine); err != nil {
		t.Fatalf("create mine: %v", err)
	}
	theirs := strengthSession("ses-list-theirs", "user_list_b", []Set{{ExerciseID: exBench, Reps: ptrInt(5)}})
	if _, err := repo.Create(ctx, theirs); err != nil {
		t.Fatalf("create theirs: %v", err)
	}
	bjj := NewSession{
		ID: "ses-list-bjj", UserID: "user_list_a", Sport: "bjj", Name: "Rolling",
		StartedAt: time.Now().UTC().Add(-2 * time.Hour),
		Sets:      []Set{{ExerciseID: exBJJ, Seconds: ptrInt(300)}},
	}
	if _, err := repo.Create(ctx, bjj); err != nil {
		t.Fatalf("create bjj: %v", err)
	}

	all, err := repo.List(ctx, "user_list_a", Filter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, s := range all {
		if s.UserID != "user_list_a" {
			t.Fatalf("list returned another user's session: %s", s.ID)
		}
	}
	if len(all) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(all))
	}
	// Newest first.
	if all[0].ID != "ses-list-mine" {
		t.Errorf("expected newest first, got %s", all[0].ID)
	}
	// Sets travel with the listing.
	if len(all[0].Sets) != 1 {
		t.Errorf("sets not attached in list: %d", len(all[0].Sets))
	}

	bySport, err := repo.List(ctx, "user_list_a", Filter{Sport: "bjj"})
	if err != nil {
		t.Fatalf("list by sport: %v", err)
	}
	if len(bySport) != 1 || bySport[0].ID != "ses-list-bjj" {
		t.Fatalf("sport filter wrong: %+v", bySport)
	}

	byExercise, err := repo.List(ctx, "user_list_a", Filter{ExerciseID: exSquat})
	if err != nil {
		t.Fatalf("list by exercise: %v", err)
	}
	if len(byExercise) != 1 || byExercise[0].ID != "ses-list-mine" {
		t.Fatalf("exercise filter wrong: %+v", byExercise)
	}

	// A limit over the cap must clamp rather than be honoured or rejected.
	if _, err := repo.List(ctx, "user_list_a", Filter{Limit: maxLimit + 1000}); err != nil {
		t.Fatalf("oversized limit: %v", err)
	}
}
