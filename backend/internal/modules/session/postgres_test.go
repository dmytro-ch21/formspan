package session

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres integration tests, gated on TEST_DATABASE_URL. The exercise
// catalog must be seeded (`go run ./cmd/seed`).

const (
	exBench = "bench-press"
	exSquat = "back-squat"
	exBJJ   = "bear-crawl-forward"
	exOHP   = "overhead-press"
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
		{ExerciseID: exBench, SetType: SetTypeWarmup, Reps: ptrInt(10), WeightKg: ptrF(40), Completed: true},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RIR: ptrInt(2), Completed: true},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RPE: ptrF(8.5), Completed: true},
	})
	s, err := repo.Create(ctx, in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(s.Sets) != 3 {
		t.Fatalf("expected 3 sets, got %d", len(s.Sets))
	}
	// Completion is a measure like any other and has to survive the round
	// trip. It didn't: the insert wrote it and attachSets never selected it
	// back, so every set read from Postgres came back not-completed. That
	// zeroed the volume on every response, and via the mobile pull-then-push
	// cycle would have written those false flags back over real ones.
	for i, set := range s.Sets {
		if !set.Completed {
			t.Errorf("set %d came back not completed", i)
		}
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
		{ExerciseID: exBench, SetType: SetTypeWarmup, Reps: ptrInt(10), WeightKg: ptrF(40), Completed: true},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), RPE: ptrF(8), Completed: true},
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(3), WeightKg: ptrF(140), RPE: ptrF(9.5), Completed: true},
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
		{ExerciseID: exBJJ, Reps: ptrInt(5), Completed: true},
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
		{ExerciseID: exBench, Reps: ptrInt(5), RPE: ptrF(15), Completed: true},
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
		{ExerciseID: exBench, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
	})); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Logging another set is a whole-list replace — and reordering must not
	// trip the (session_id, position) unique constraint.
	updated, err := repo.ReplaceSets(ctx, "user_a", "ses-edit", []Set{
		{ExerciseID: exSquat, Reps: ptrInt(3), WeightKg: ptrF(140), RIR: ptrInt(1), Completed: true},
		{ExerciseID: exBench, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
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

	in := strengthSession("ses-orphan", "user_a", []Set{{ExerciseID: exBench, Reps: ptrInt(5), Completed: true}})
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
		in := strengthSession("ses-oracle", "user_attacker", []Set{{ExerciseID: exBench, Reps: ptrInt(5), Completed: true}})
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

	in := strengthSession("ses-public-wk", "user_b", []Set{{ExerciseID: exBench, Reps: ptrInt(5), Completed: true}})
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

	mine := strengthSession("ses-list-mine", "user_list_a", []Set{{ExerciseID: exSquat, Reps: ptrInt(5), Completed: true}})
	if _, err := repo.Create(ctx, mine); err != nil {
		t.Fatalf("create mine: %v", err)
	}
	theirs := strengthSession("ses-list-theirs", "user_list_b", []Set{{ExerciseID: exBench, Reps: ptrInt(5), Completed: true}})
	if _, err := repo.Create(ctx, theirs); err != nil {
		t.Fatalf("create theirs: %v", err)
	}
	bjj := NewSession{
		ID: "ses-list-bjj", UserID: "user_list_a", Sport: "bjj", Name: "Rolling",
		StartedAt: time.Now().UTC().Add(-2 * time.Hour),
		Sets:      []Set{{ExerciseID: exBJJ, Seconds: ptrInt(300), Completed: true}},
	}
	if _, err := repo.Create(ctx, bjj); err != nil {
		t.Fatalf("create bjj: %v", err)
	}

	page, err := repo.List(ctx, "user_list_a", Filter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	all := page.Sessions
	if page.Total != 2 {
		t.Errorf("total: %d, want 2", page.Total)
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
	if len(bySport.Sessions) != 1 || bySport.Sessions[0].ID != "ses-list-bjj" {
		t.Fatalf("sport filter wrong: %+v", bySport.Sessions)
	}
	// The count has to describe the *filtered* set, not everything.
	if bySport.Total != 1 {
		t.Errorf("filtered total: %d, want 1", bySport.Total)
	}

	byExerciseP, err := repo.List(ctx, "user_list_a", Filter{ExerciseID: exSquat})
	if err != nil {
		t.Fatalf("list by exercise: %v", err)
	}
	byExercise := byExerciseP.Sessions
	if len(byExercise) != 1 || byExercise[0].ID != "ses-list-mine" {
		t.Fatalf("exercise filter wrong: %+v", byExercise)
	}

	// A limit over the cap must clamp rather than be honoured or rejected.
	if _, err := repo.List(ctx, "user_list_a", Filter{Limit: maxLimit + 1000}); err != nil {
		t.Fatalf("oversized limit: %v", err)
	}

	// Name search, which is how anyone actually finds an old session.
	byName, err := repo.List(ctx, "user_list_a", Filter{Query: "roll"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(byName.Sessions) != 1 || byName.Sessions[0].ID != "ses-list-bjj" {
		t.Fatalf("search wrong: %+v", byName.Sessions)
	}
	// Case-insensitive, and a wildcard is a literal rather than "match all".
	upper, _ := repo.List(ctx, "user_list_a", Filter{Query: "ROLL"})
	if len(upper.Sessions) != 1 {
		t.Errorf("search should be case-insensitive: %d", len(upper.Sessions))
	}
	wild, err := repo.List(ctx, "user_list_a", Filter{Query: "%"})
	if err != nil {
		t.Fatalf("wildcard search: %v", err)
	}
	if len(wild.Sessions) != 0 {
		t.Errorf("a literal %% matched %d sessions — LIKE escaping is off", len(wild.Sessions))
	}

	// Paging: every session appears exactly once across the pages, and the
	// total describes the whole filter rather than the page.
	seen := map[string]int{}
	for off := 0; off < 4; off += 1 {
		p, err := repo.List(ctx, "user_list_a", Filter{Limit: 1, Offset: off})
		if err != nil {
			t.Fatalf("page %d: %v", off, err)
		}
		if p.Total != 2 {
			t.Errorf("page %d total: %d, want 2", off, p.Total)
		}
		for _, s := range p.Sessions {
			seen[s.ID]++
		}
	}
	if len(seen) != 2 {
		t.Errorf("paging saw %d distinct sessions, want 2: %v", len(seen), seen)
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("%s appeared on %d pages — unstable ordering", id, n)
		}
	}
}

// ---------------------------------------------------------------------------
// History
//
// The rollup expresses Summarise's working-set rule in SQL, for the reasons in
// postgres.go. TestHistoryAgreesWithSummarise is what makes that safe: it runs
// both over the same rows and fails the moment they disagree.
// ---------------------------------------------------------------------------

// histAt builds a session at a fixed instant, so a range test isn't at the
// mercy of when it runs.
func histAt(id, user, sport string, at time.Time, dur time.Duration, sets []Set) NewSession {
	end := at.Add(dur)
	return NewSession{
		ID: id, UserID: user, Sport: sport, Name: "History fixture",
		StartedAt: at, EndedAt: &end, Sets: sets,
	}
}

func TestHistoryAgreesWithSummarise(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_hist_agree"

	// Deliberately awkward: warm-ups (excluded), incomplete sets (excluded),
	// a set with reps but no weight (reps count, tonnage doesn't), and the
	// same exercise across two days (one distinct exercise, not two).
	base := time.Date(2024, 3, 4, 12, 0, 0, 0, time.UTC)
	fixtures := []NewSession{
		histAt("ses-hist-a", user, "strength", base, time.Hour, []Set{
			{ExerciseID: exSquat, SetType: SetTypeWarmup, Reps: ptrInt(10), WeightKg: ptrF(20), Completed: true},
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: false},
			{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(8), Completed: true},
		}),
		histAt("ses-hist-b", user, "strength", base.AddDate(0, 0, 2), 90*time.Minute, []Set{
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(3), WeightKg: ptrF(120), Completed: true},
			{ExerciseID: exSquat, SetType: SetTypeFailure, Reps: ptrInt(1), WeightKg: ptrF(140), Completed: true},
			// Third exercise, warm-up only. Summarise counts it in ExerciseIDs
			// (they're collected before the completed/warm-up guards), so the
			// SQL's COUNT(DISTINCT exercise_id) must stay unfiltered. Without a
			// set like this the fixtures can't tell the two apart, and adding a
			// FILTER here to "match its neighbours" would pass green.
			{ExerciseID: exOHP, SetType: SetTypeWarmup, Reps: ptrInt(12), WeightKg: ptrF(20), Completed: true},
		}),
	}
	for _, f := range fixtures {
		cleanup(t, pool, f.ID)
		if _, err := repo.Create(ctx, f); err != nil {
			t.Fatalf("create %s: %v", f.ID, err)
		}
	}

	from := time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2024, 4, 1, 0, 0, 0, 0, time.UTC)

	got, err := repo.History(ctx, user, HistoryFilter{From: from, To: to, TZ: "UTC"})
	if err != nil {
		t.Fatalf("history: %v", err)
	}

	// The other half of the comparison: list the same window and fold
	// Summarise over it, exactly as a client would.
	listedPage, err := repo.List(ctx, user, Filter{From: from, To: to})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	listed := listedPage.Sessions
	if len(listed) != len(fixtures) {
		t.Fatalf("expected %d sessions in range, got %d", len(fixtures), len(listed))
	}
	var wantSets, wantReps int
	var wantTonnage float64
	distinct := map[string]bool{}
	for _, s := range listed {
		v := Summarise(s.Sets)
		wantSets += v.WorkingSets
		wantReps += v.TotalReps
		wantTonnage += v.TonnageKg
		for _, id := range v.ExerciseIDs {
			distinct[id] = true
		}
	}

	if got.Totals.WorkingSets != wantSets {
		t.Errorf("working sets: SQL %d, Summarise %d", got.Totals.WorkingSets, wantSets)
	}
	if got.Totals.TotalReps != wantReps {
		t.Errorf("total reps: SQL %d, Summarise %d", got.Totals.TotalReps, wantReps)
	}
	if !closeEnough(got.Totals.TonnageKg, wantTonnage) {
		t.Errorf("tonnage: SQL %v, Summarise %v", got.Totals.TonnageKg, wantTonnage)
	}
	if got.Totals.Exercises != len(distinct) {
		t.Errorf("exercises: SQL %d, Summarise %d", got.Totals.Exercises, len(distinct))
	}

	// And the fixtures' own arithmetic, so a bug that broke both identically
	// still gets caught: 5×100 + 8 reps unweighted + 3×120 + 1×140 = 1000.
	if wantSets != 4 || wantReps != 17 || !closeEnough(wantTonnage, 1000) {
		t.Fatalf("fixture expectations drifted: sets=%d reps=%d tonnage=%v", wantSets, wantReps, wantTonnage)
	}
	// Two sessions, two days, three distinct exercises — the third only
	// ever warmed up, which still counts as "what did I train".
	if got.Totals.Sessions != 2 || got.Totals.ActiveDays != 2 || got.Totals.Exercises != 3 {
		t.Errorf("totals: %+v", got.Totals)
	}
	// 60m + 90m.
	if got.Totals.DurationSeconds != 9000 {
		t.Errorf("duration: %d, want 9000", got.Totals.DurationSeconds)
	}
	// Only days with training are returned, not the whole month.
	if len(got.Days) != 2 {
		t.Fatalf("expected 2 active days, got %d: %+v", len(got.Days), got.Days)
	}
	if got.Days[0].Date != "2024-03-04" || got.Days[1].Date != "2024-03-06" {
		t.Errorf("day buckets: %s, %s", got.Days[0].Date, got.Days[1].Date)
	}
	// The warm-up is excluded from the day's working sets but its exercise
	// still counted above — the split Summarise makes.
	if got.Days[0].WorkingSets != 2 {
		t.Errorf("day 1 working sets: %d, want 2", got.Days[0].WorkingSets)
	}
	// Echoed range names the last *included* day, not the exclusive bound.
	if got.From != "2024-03-01" || got.To != "2024-03-31" {
		t.Errorf("echoed range: %s..%s", got.From, got.To)
	}

	assertDaysSumToTotals(t, got)
}

// assertDaysSumToTotals pins the two rollups to each other.
//
// Summarise can only vouch for `historyTotals`. The harder SQL is in
// `historyDays` — the per_session CTE, which exists so the LEFT JOIN doesn't
// repeat a session row once per set and multiply its duration. Summarise has
// no opinion about join shape, so it cannot catch that at all: flattening the
// CTE leaves working_sets and the dates untouched and reports four sessions
// and four hours for one session of one hour. Two independent SQL paths
// checked against each other is what closes it.
func assertDaysSumToTotals(t *testing.T, h *History) {
	t.Helper()
	var sessions, sets, reps, duration int
	var tonnage float64
	for _, d := range h.Days {
		sessions += d.Sessions
		sets += d.WorkingSets
		reps += d.TotalReps
		duration += d.DurationSeconds
		tonnage += d.TonnageKg
	}
	if sessions != h.Totals.Sessions {
		t.Errorf("sessions: days sum to %d, totals say %d", sessions, h.Totals.Sessions)
	}
	if sets != h.Totals.WorkingSets {
		t.Errorf("working sets: days sum to %d, totals say %d", sets, h.Totals.WorkingSets)
	}
	if reps != h.Totals.TotalReps {
		t.Errorf("reps: days sum to %d, totals say %d", reps, h.Totals.TotalReps)
	}
	if duration != h.Totals.DurationSeconds {
		t.Errorf("duration: days sum to %d, totals say %d", duration, h.Totals.DurationSeconds)
	}
	if !closeEnough(tonnage, h.Totals.TonnageKg) {
		t.Errorf("tonnage: days sum to %v, totals say %v", tonnage, h.Totals.TonnageKg)
	}
	// Active days is the count of days that had anything, by definition.
	if len(h.Days) != h.Totals.ActiveDays {
		t.Errorf("active days: %d day buckets, totals say %d", len(h.Days), h.Totals.ActiveDays)
	}
}

// closeEnough compares a Postgres NUMERIC sum against one accumulated
// set-by-set in Go. Exact equality holds for whole-number fixtures and stops
// holding the moment a realistic NUMERIC(6,2) weight isn't binary-exact — a
// flaky guard is one that gets loosened instead of trusted.
func closeEnough(a, b float64) bool {
	d := a - b
	return d < 0.001 && d > -0.001
}

func TestHistory_BucketsDaysInTheCallersTimezone(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_hist_tz"
	cleanup(t, pool, "ses-hist-tz")

	// 02:30 UTC on the 6th is 21:30 on the 5th in New York — an evening
	// session, which is when people train. Bucketing it in UTC would file it
	// under the wrong day on the one view whose whole job is which days.
	at := time.Date(2024, 3, 6, 2, 30, 0, 0, time.UTC)
	if _, err := repo.Create(ctx, histAt("ses-hist-tz", user, "strength", at, time.Hour, []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
	})); err != nil {
		t.Fatalf("create: %v", err)
	}

	from := time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2024, 4, 1, 0, 0, 0, 0, time.UTC)

	utc, err := repo.History(ctx, user, HistoryFilter{From: from, To: to, TZ: "UTC"})
	if err != nil {
		t.Fatalf("history utc: %v", err)
	}
	if len(utc.Days) != 1 || utc.Days[0].Date != "2024-03-06" {
		t.Fatalf("UTC bucket: %+v", utc.Days)
	}

	ny, err := repo.History(ctx, user, HistoryFilter{From: from, To: to, TZ: "America/New_York"})
	if err != nil {
		t.Fatalf("history ny: %v", err)
	}
	if len(ny.Days) != 1 || ny.Days[0].Date != "2024-03-05" {
		t.Fatalf("New York bucket: %+v, want 2024-03-05", ny.Days)
	}
	// Active days must agree with the calendar it sits next to.
	if ny.Totals.ActiveDays != 1 {
		t.Errorf("active days: %d", ny.Totals.ActiveDays)
	}
}

func TestHistory_IsUserScopedAndComparesLikeForLike(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const mine, theirs = "user_hist_mine", "user_hist_theirs"

	// March is the window under test; February is the previous one. Both get
	// a session, so a broken previous-window calculation shows up as a wrong
	// number rather than a zero that could pass by accident.
	fixtures := []NewSession{
		histAt("ses-hist-mar", mine, "strength", time.Date(2024, 3, 10, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
		}),
		histAt("ses-hist-feb", mine, "strength", time.Date(2024, 2, 10, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(80), Completed: true},
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(80), Completed: true},
		}),
		// Same window, different athlete. Must not appear in either total.
		histAt("ses-hist-other", theirs, "strength", time.Date(2024, 3, 11, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(99), WeightKg: ptrF(999), Completed: true},
		}),
		// Same window, different sport. Must vanish under a sport filter.
		histAt("ses-hist-roll", mine, "bjj", time.Date(2024, 3, 12, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			{ExerciseID: exBJJ, SetType: SetTypeWorking, Seconds: ptrInt(300), Completed: true},
		}),
	}
	for _, f := range fixtures {
		cleanup(t, pool, f.ID)
		if _, err := repo.Create(ctx, f); err != nil {
			t.Fatalf("create %s: %v", f.ID, err)
		}
	}

	march := HistoryFilter{
		From: time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC),
		To:   time.Date(2024, 4, 1, 0, 0, 0, 0, time.UTC),
		TZ:   "UTC",
	}
	got, err := repo.History(ctx, mine, march)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	// Two of mine in March; the other athlete's 99×999 would be unmissable.
	if got.Totals.Sessions != 2 {
		t.Errorf("sessions: %d, want 2 (leaked another user?)", got.Totals.Sessions)
	}
	if got.Totals.TonnageKg != 500 {
		t.Errorf("tonnage: %v, want 500", got.Totals.TonnageKg)
	}
	// February is 28 days and March is 31, so the previous window is the 31
	// days before 1 March — not "last calendar month". February's session is
	// inside it either way.
	if got.Previous.Sessions != 1 || got.Previous.TonnageKg != 800 {
		t.Errorf("previous window: %+v, want 1 session / 800kg", got.Previous)
	}
	// Chips count every sport in range, unfiltered — that's what makes them
	// worth clicking.
	if len(got.Sports) != 2 {
		t.Errorf("sports: %+v, want strength and bjj", got.Sports)
	}

	filtered, err := repo.History(ctx, mine, HistoryFilter{
		Sport: "bjj", From: march.From, To: march.To, TZ: "UTC",
	})
	if err != nil {
		t.Fatalf("history filtered: %v", err)
	}
	if filtered.Totals.Sessions != 1 || filtered.Totals.TonnageKg != 0 {
		t.Errorf("bjj filter: %+v", filtered.Totals)
	}
	// A sport filter must narrow the comparison too, or BJJ gets measured
	// against last month's squats.
	if filtered.Previous.Sessions != 0 {
		t.Errorf("filtered previous should be BJJ-only: %+v", filtered.Previous)
	}
	assertDaysSumToTotals(t, got)
	assertDaysSumToTotals(t, filtered)
}

func TestHistory_EmptyRangeIsZeroNotAnError(t *testing.T) {
	repo, _ := newTestRepo(t)
	got, err := repo.History(context.Background(), "user_hist_nobody", HistoryFilter{
		From: time.Date(2019, 1, 1, 0, 0, 0, 0, time.UTC),
		To:   time.Date(2019, 2, 1, 0, 0, 0, 0, time.UTC),
		TZ:   "UTC",
	})
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	// An athlete with no history gets an empty page, not a 500 — and the
	// slices must be empty rather than nil so they marshal as [] not null.
	if got.Totals.Sessions != 0 || got.Totals.TonnageKg != 0 {
		t.Errorf("totals: %+v", got.Totals)
	}
	if got.Days == nil || len(got.Days) != 0 {
		t.Errorf("days should be empty, not nil: %+v", got.Days)
	}
	if got.Sports == nil || len(got.Sports) != 0 {
		t.Errorf("sports should be empty, not nil: %+v", got.Sports)
	}
}

// TestCancelledQueryIsRecognisedAsClientGone is the assumption the whole
// abort fix rests on: that a cancelled pgx query produces an error whose
// chain `errors.Is` can match against context.Canceled, *through* the
// `fmt.Errorf("%w")` wrapping every repository method applies.
//
// If pgx ever returns a bare "context canceled" string instead of the
// sentinel, this fails — and every aborted browser fetch silently goes back
// to being logged as a 500.
func TestCancelledQueryIsRecognisedAsClientGone(t *testing.T) {
	repo, _ := newTestRepo(t)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already gone by the time the query runs, as an aborted fetch is

	_, err := repo.List(ctx, "user_cancel_probe", Filter{})
	if err == nil {
		t.Fatal("expected a cancelled query to fail")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled query error is not recognisable as context.Canceled: %#v", err)
	}
	if !apihttp.ClientGone(err) {
		t.Fatalf("ClientGone did not classify a real cancelled query: %v", err)
	}

	// The same has to hold for the history rollup, which issues four queries.
	_, err = repo.History(ctx, "user_cancel_probe", HistoryFilter{
		From: time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC),
		To:   time.Date(2024, 4, 1, 0, 0, 0, 0, time.UTC),
		TZ:   "UTC",
	})
	if err == nil || !apihttp.ClientGone(err) {
		t.Fatalf("history: cancelled query not classified as client-gone: %v", err)
	}
}

func TestBestOneRMs_IsUserScopedAndIgnoresUnqualifyingSets(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const mine, theirs = "user_1rm_mine", "user_1rm_theirs"

	fixtures := []NewSession{
		strengthSession("ses-1rm-a", mine, []Set{
			// Heaviest set in the data, and a warm-up — must be ignored.
			{ExerciseID: exSquat, SetType: SetTypeWarmup, Reps: ptrInt(5), WeightKg: ptrF(300), Completed: true},
			// 5x100 = 112.5, which beats the 110 single below. The whole
			// reason this can't be "take the heaviest".
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(1), WeightKg: ptrF(110), Completed: true},
			// Planned, never performed.
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(3), WeightKg: ptrF(200), Completed: false},
		}),
		// Another athlete lifting far more. Must never leak into mine.
		strengthSession("ses-1rm-theirs", theirs, []Set{
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(500), Completed: true},
		}),
	}
	for _, f := range fixtures {
		cleanup(t, pool, f.ID)
		if _, err := repo.Create(ctx, f); err != nil {
			t.Fatalf("create %s: %v", f.ID, err)
		}
	}

	got, err := repo.BestOneRMs(ctx, mine, []string{exSquat, exBench})
	if err != nil {
		t.Fatalf("best 1rms: %v", err)
	}
	if !approx(got[exSquat], 112.5) {
		t.Errorf("squat best = %.2f, want 112.5 (warm-up, incomplete set, or another user leaked in?)", got[exSquat])
	}
	// An exercise with no qualifying history is absent, not zero.
	if _, ok := got[exBench]; ok {
		t.Errorf("bench should have no estimate, got %v", got[exBench])
	}
	// And nothing at all for an athlete with no history.
	empty, err := repo.BestOneRMs(ctx, "user_1rm_nobody", []string{exSquat})
	if err != nil {
		t.Fatalf("empty: %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("expected no estimates, got %v", empty)
	}
}

// The negative wildcard assertion in TestList can't catch the other
// direction: dropping LikeTerm while keeping LikeClause passes it and fails
// this. Its own user, so the fixture doesn't perturb TestList's paging counts.
func TestSearch_FindsALiteralWildcardInAName(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-pct")

	in := strengthSession("ses-pct", "user_pct",
		[]Set{{ExerciseID: exSquat, Reps: ptrInt(5), Completed: true}})
	in.Name = "Deload 60% week"
	if _, err := repo.Create(ctx, in); err != nil {
		t.Fatalf("create: %v", err)
	}

	found, err := repo.List(ctx, "user_pct", Filter{Query: "60%"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(found.Sessions) != 1 || found.Sessions[0].ID != "ses-pct" {
		t.Errorf(`searching "60%%" should find the session named "Deload 60%% week", got %d`, len(found.Sessions))
	}
	// And an underscore is a literal too, not "any single character".
	none, err := repo.List(ctx, "user_pct", Filter{Query: "6_%"})
	if err != nil {
		t.Fatalf("underscore search: %v", err)
	}
	if len(none.Sessions) != 0 {
		t.Errorf(`"6_%%" should match nothing — _ is being treated as a wildcard`)
	}
}

func TestRecords_DerivesBestsAndIgnoresWhatDoesNotCount(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const mine, theirs = "user_rec_mine", "user_rec_theirs"

	fixtures := []NewSession{
		histAt("ses-rec-a", mine, "strength", time.Date(2024, 5, 1, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			// Heaviest set in the data, and a warm-up — must not be a record.
			{ExerciseID: exSquat, SetType: SetTypeWarmup, Reps: ptrInt(3), WeightKg: ptrF(300), Completed: true},
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
			// Planned, never performed — also not a record.
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(1), WeightKg: ptrF(250), Completed: false},
		}),
		histAt("ses-rec-b", mine, "strength", time.Date(2024, 6, 1, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			// Heavier single, but 5x100 estimates higher (112.5 vs 110) — so
			// the two record kinds must point at *different* sets.
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(1), WeightKg: ptrF(110), Completed: true},
		}),
		histAt("ses-rec-other", theirs, "strength", time.Date(2024, 6, 2, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(400), Completed: true},
		}),
	}
	for _, f := range fixtures {
		cleanup(t, pool, f.ID)
		if _, err := repo.Create(ctx, f); err != nil {
			t.Fatalf("create %s: %v", f.ID, err)
		}
	}

	got, err := repo.Records(ctx, mine, []string{exSquat, exBJJ})
	if err != nil {
		t.Fatalf("records: %v", err)
	}
	if len(got) != 1 || got[0].ExerciseID != exSquat {
		t.Fatalf("expected records for the squat only, got %+v", got)
	}

	byKind := map[RecordKind]Record{}
	for _, r := range got[0].Records {
		byKind[r.Kind] = r
	}
	heaviest, ok := byKind[RecordHeaviest]
	if !ok {
		t.Fatal("no heaviest-weight record")
	}
	// 110, not the 300 warm-up, the 250 never performed, or the other
	// athlete's 400.
	if heaviest.Value != 110 {
		t.Errorf("heaviest = %v, want 110 (warm-up, unticked set or another user leaked in?)", heaviest.Value)
	}
	if heaviest.SessionID != "ses-rec-b" {
		t.Errorf("heaviest came from %s, want ses-rec-b", heaviest.SessionID)
	}

	oneRM, ok := byKind[RecordOneRM]
	if !ok {
		t.Fatal("no estimated-1RM record")
	}
	// The point of having both: 5x100 estimates 112.5 and beats the 110
	// single, so this record cites a different set than the heaviest does.
	if !approx(oneRM.Value, 112.5) {
		t.Errorf("1RM = %v, want 112.5", oneRM.Value)
	}
	if oneRM.SessionID != "ses-rec-a" {
		t.Errorf("1RM cited %s, want ses-rec-a — the two kinds should differ here", oneRM.SessionID)
	}
	// Evidence travels with the number, or it can't be checked.
	if oneRM.Reps == nil || *oneRM.Reps != 5 || oneRM.WeightKg == nil || *oneRM.WeightKg != 100 {
		t.Errorf("1RM record lost its evidence: %+v", oneRM)
	}
	// Fixtures are from 2024; nothing here is new.
	if heaviest.IsRecent || oneRM.IsRecent {
		t.Error("two-year-old records should not be flagged recent")
	}

	// An athlete with no history has no records — not zeroes.
	none, err := repo.Records(ctx, "user_rec_nobody", []string{exSquat})
	if err != nil {
		t.Fatalf("empty: %v", err)
	}
	if len(none) != 0 {
		t.Errorf("expected no records, got %+v", none)
	}
}

func TestPinnedExercises_RoundTripAndOrder(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_pin"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM pinned_exercises WHERE user_id = $1`, user) //nolint:errcheck
	})

	if got, err := repo.PinnedExercises(ctx, user); err != nil || len(got) != 0 {
		t.Fatalf("a new athlete should have no pins: %v %v", got, err)
	}

	want := []string{exBench, exSquat}
	if err := repo.SetPinnedExercises(ctx, user, want); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, err := repo.PinnedExercises(ctx, user)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	// Order is the athlete's choice, not alphabetical — bench was pinned first.
	if len(got) != 2 || got[0] != exBench || got[1] != exSquat {
		t.Errorf("pins came back as %v, want %v", got, want)
	}

	// Replace wholesale, including reordering.
	if err := repo.SetPinnedExercises(ctx, user, []string{exSquat}); err != nil {
		t.Fatalf("replace: %v", err)
	}
	got, _ = repo.PinnedExercises(ctx, user)
	if len(got) != 1 || got[0] != exSquat {
		t.Errorf("replace left %v", got)
	}

	// Clearing is an empty list, not a special case.
	if err := repo.SetPinnedExercises(ctx, user, nil); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if got, _ := repo.PinnedExercises(ctx, user); len(got) != 0 {
		t.Errorf("clear left %v", got)
	}

	// An unknown exercise is the caller's mistake, surfaced as invalid input.
	err = repo.SetPinnedExercises(ctx, user, []string{"not-an-exercise"})
	if !errors.Is(err, ErrInvalidInput) {
		t.Errorf("unknown exercise gave %v, want ErrInvalidInput", err)
	}
}
