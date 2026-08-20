package session

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres integration tests, gated on TEST_DATABASE_URL. These fixtures OWN
// the catalog rows they run on — nothing here needs `cmd/seed`.

// The catalog ids these tests use. Namespaced, because they are this package's
// rows and not the shipped catalog's.
//
// They used to be real ids — `bench-press`, `back-squat`, `run` — and the
// package seeded none of them. That worked only by accident: `exercise`'s tests
// call Seed(), loading the whole catalog and never removing it, and `exercise`
// sorts before `session` under `-p 1`. Run this package alone against a freshly
// migrated database and 22 tests failed with `unknown exercise "back-squat"`.
// CI never seeds either, so its green depended on that side effect too.
//
// The rule the rest of the repo settled on is: own the library rows you depend
// on. `exercise/content_postgres_test.go`, `bjj/proficiency_postgres_test.go`,
// `feed/postgres_test.go` and `share/postgres_test.go` all do. This was the
// last holdout.
const (
	exBench = "ses_fx_bench"
	exSquat = "ses_fx_squat"
	exOHP   = "ses_fx_ohp"
	// A non-strength exercise, for the sport-mismatch and cross-sport-filter
	// tests. Owning it also removes an old constraint the comment here used to
	// record: with borrowed ids this had to be `run`, because migration 000019
	// removed the BJJ drills and running was the only non-strength discipline
	// left with catalog rows. A fixture we write ourselves has no such problem.
	exRun = "ses_fx_run"
	// Bodyweight, so it is the only fixture that can carry a rep PR.
	exPullUp = "ses_fx_pullup"
	// PER_SIDE, and that is the whole reason it exists: the SQL-vs-domain
	// parity test needs a load factor other than 1, or both sides agree
	// trivially and a missing CASE in the SQL passes green. As a borrowed id
	// this property was the catalog's to change — #224 reclassified ~80 rows —
	// and the test would have gone quietly trivial. Now it is stated here.
	exDBBench = "ses_fx_db_bench"
)

// fixtureExercise is a catalog row this package writes for itself. Every column
// that any test depends on is set explicitly rather than taken from a default:
// `feed` learned that the hard way, where an omitted load_mode let every
// fixture default to 'total' and the per-side CASE could have been deleted with
// the suite still green.
type fixtureExercise struct {
	id       string
	sport    string
	pattern  string
	loadType string
	loadMode string
	// How many implements of the logged weight move. THIS is the tonnage
	// factor now (migration 000057); it used to be derived from `load_mode`
	// and `is_unilateral` together, a rule that could not express a movement
	// with two implements and one limb.
	//
	// Declared rather than defaulted, for the reason this whole struct exists:
	// left to the column default of 1, `exDBBench` stops doubling and the
	// parity test agrees trivially — the exact failure `feed` shipped with an
	// omitted `load_mode`.
	implements int
	// Whether one LIMB works at a time. No longer part of the tonnage rule —
	// it drives the "8 reps here means 8 each side" hint only — but still
	// declared, because a test that reads it must not read a default.
	unilateral bool
}

var fixtureExercises = []fixtureExercise{
	{exBench, "strength", "horizontal_push", "weight_reps", "total", 1, false},
	{exSquat, "strength", "squat", "weight_reps", "total", 1, false},
	{exOHP, "strength", "vertical_push", "weight_reps", "total", 1, false},
	{exRun, "running", "locomotion", "distance_time", "total", 1, false},
	// A PAIR of dumbbells — the one fixture whose tonnage doubles, and the
	// reason every parity test in this package can fail rather than agree at
	// factor 1.
	{exDBBench, "strength", "horizontal_push", "weight_reps", "per_side", 2, false},
	// REPS-ONLY, and that is the whole reason it exists: `RecordMostReps` is
	// produced for `load_type: 'reps'` and nothing else, so a rep-PR assertion
	// against a weighted exercise never runs at all. It is also the honest
	// shape for the case that motivates assisted reps — a band- or
	// machine-assisted pull-up is bodyweight work.
	{exPullUp, "strength", "vertical_pull", "reps", "total", 1, false},
}

// requireUnsorted asserts that ids are NOT in ascending lexical order.
//
// Two tests here prove that a caller's chosen ORDER survives — Records keeping
// the asked order, and pinned exercises keeping the athlete's. Neither can fail
// unless the order it uses is one a stray `sort.Strings` (or an `ORDER BY` that
// lost its position column) would CHANGE. That requirement lives entirely in
// the relative spelling of two constants, which is invisible at the call site.
//
// Renaming the fixtures from `bench-press`/`back-squat` to `ses_fx_*` inverted
// it and silently disarmed both tests: `back-squat` < `bench-press`, so
// bench-first used to be the non-alphabetical case, while `ses_fx_bench` <
// `ses_fx_squat` made that same call sorted. Both went green with the bug they
// exist to catch. Caught in review, not by the suite — so the property is
// asserted now rather than described in a comment that a rename cannot break.
func requireUnsorted(t *testing.T, ids []string) {
	t.Helper()
	if sort.StringsAreSorted(ids) {
		t.Fatalf("this test needs an order a sort would change, but %v is already "+
			"in lexical order — it would pass with the bug it exists to catch. "+
			"Reorder the ids, or rename the fixtures so they differ.", ids)
	}
}

func fixtureExerciseIDs() []string {
	ids := make([]string, 0, len(fixtureExercises))
	for _, e := range fixtureExercises {
		ids = append(ids, e.id)
	}
	return ids
}

// --- the fixture rows belong to the PROCESS, not to a test -----------------
//
// They carry FIXED ids and every Postgres test in this package reads them, so
// TestMain seeds them once before anything runs and removes them once after
// everything has.
//
// It used to be per test: `newTestRepo` seeded them and registered a
// `t.Cleanup` that deleted them again, 34 times a run — so every test destroyed
// rows every other test depends on. Run sequentially that is merely wasteful,
// which is why this package has always passed on its own. It stops working the
// moment a SECOND copy of this binary is running against the same database, and
// that is the normal state of affairs here rather than an exotic one: CLAUDE.md
// names `vola_test` as the default target and a dozen worktrees share it. The
// other process's per-test cleanup then deletes the rows this process's
// in-flight test is using, and the test reports `unknown exercise
// "ses_fx_squat"` for a row it seeded itself milliseconds earlier — which is
// #426, and reads as a bug in whatever PR happened to be running.
//
// Measured, on one database (`-count` used throughout, because `go test`
// otherwise serves the whole suite from its cache and the measurement is of
// nothing at all — that mistake was made first here):
//
//   - ONE binary alone, 20 consecutive uncached runs of this package: green.
//   - TWO concurrent binaries: 10 of 10 lane-runs red, with exactly the
//     reported symptoms — `unknown exercise "ses_fx_squat"`, and
//     `index out of range [0] with length 0` where a LoadHistory returned no
//     points because the session under test had been deleted with them.
//   - FOUR concurrent full suites: this package failed 16 of 24 runs.
//
// Seeding once per process removes the churn. The advisory lock is what removes
// the race, because two processes still cannot share one set of fixed ids.

// fixtureLockKey identifies "this package's fixture rows". Arbitrary but fixed;
// it is the issue number.
const fixtureLockKey = 426

// fixtureLockWait bounds the wait rather than blocking to the test timeout, so
// the failure names its own cause instead of arriving as a 3-minute hang.
const fixtureLockWait = 60 * time.Second

// The lock's SECOND key is a hash of the database name. Advisory lock keys are
// CLUSTER-wide, not per-database, so without this two binaries running against
// their own `vola_test_<branch>` databases on the one local Postgres would
// serialise on each other for no reason — and per-branch databases are exactly
// what CLAUDE.md tells you to use.
const fixtureLockScope = `('x' || substr(md5(current_database()), 1, 8))::bit(32)::int`

// lockFixtures takes the session-level advisory lock that makes this process
// the sole owner of the fixture ids in this database. It is released when the
// connection closes, including when the binary dies, so a crashed run cannot
// wedge the next one.
func lockFixtures(ctx context.Context, conn *pgx.Conn) error {
	deadline := time.Now().Add(fixtureLockWait)
	for {
		var got bool
		if err := conn.QueryRow(ctx,
			`SELECT pg_try_advisory_lock($1::int, `+fixtureLockScope+`)`,
			fixtureLockKey).Scan(&got); err != nil {
			return fmt.Errorf("take the fixture lock: %w", err)
		}
		if got {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf(
				"another `session` test binary has held this database's fixture lock for %s.\n"+
					"These tests own catalog rows with FIXED ids (%s, %s, …) and cannot share a "+
					"database with a second copy of themselves — whichever finishes first deletes "+
					"the other's rows mid-test.\n"+
					"Give this branch its own database, as CLAUDE.md's \"use your own database\" "+
					"section describes:\n"+
					"  createdb -U vola vola_test_<branch> && TEST_DATABASE_URL=…vola_test_<branch>",
				fixtureLockWait, exBench, exSquat)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// seedFixtureExercises writes this package's catalog rows. Every column is
// reconciled on conflict, not just inserted: a row left behind by an interrupted
// run must be repaired rather than trusted, and a partial SET is how a stale
// value survives into a green suite.
func seedFixtureExercises(ctx context.Context, conn *pgx.Conn) error {
	for _, e := range fixtureExercises {
		if _, err := conn.Exec(ctx, `
			INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status, load_mode, implements, is_unilateral)
			VALUES ($1, $1, $2, $3, $4, 'published', $5, $6, $7)
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name,
				sport = EXCLUDED.sport,
				movement_pattern = EXCLUDED.movement_pattern,
				load_type = EXCLUDED.load_type,
				status = EXCLUDED.status,
				load_mode = EXCLUDED.load_mode,
				implements = EXCLUDED.implements,
				is_unilateral = EXCLUDED.is_unilateral`,
			e.id, e.sport, e.pattern, e.loadType, e.loadMode, e.implements, e.unilateral); err != nil {
			return fmt.Errorf("seed fixture exercise %s: %w", e.id, err)
		}
	}
	return nil
}

// removeFixtureExercises takes them out again, order-INDEPENDENTLY rather than
// relying on anything having run first. `session_sets.exercise_id` and
// `workout_items.exercise_id` are both NO ACTION, so a bare
// `DELETE FROM exercises` fails the foreign key; discard that error and the
// fixture survives into the database every other package shares. `feed` and
// `share` both shipped exactly that leak — `share` at nine rows per clean run.
// So whatever still references the row goes first, and the delete is VERIFIED:
// a cleanup that quietly failed would restore the pollution this exists to
// prevent, with nothing going red.
func removeFixtureExercises(ctx context.Context, conn *pgx.Conn) error {
	ids := fixtureExerciseIDs()
	// Parents first: both child tables cascade from their own parent
	// (session_sets from sessions, workout_items from workouts), so removing
	// the parent clears the reference.
	if _, err := conn.Exec(ctx, `
		DELETE FROM sessions WHERE id IN (
			SELECT session_id FROM session_sets WHERE exercise_id = ANY($1))`, ids); err != nil {
		return fmt.Errorf("remove sessions referencing the fixture exercises: %w", err)
	}
	if _, err := conn.Exec(ctx, `
		DELETE FROM workouts WHERE id IN (
			SELECT workout_id FROM workout_items WHERE exercise_id = ANY($1))`, ids); err != nil {
		return fmt.Errorf("remove workouts referencing the fixture exercises: %w", err)
	}
	if _, err := conn.Exec(ctx, `DELETE FROM exercises WHERE id = ANY($1)`, ids); err != nil {
		return fmt.Errorf("remove the fixture exercises: %w", err)
	}
	var left int
	if err := conn.QueryRow(ctx,
		`SELECT count(*) FROM exercises WHERE id = ANY($1)`, ids).Scan(&left); err != nil {
		return fmt.Errorf("confirm the fixture exercises were removed: %w", err)
	}
	if left != 0 {
		return fmt.Errorf("%d of %d fixture exercises survived cleanup, polluting the "+
			"database this suite shares", left, len(ids))
	}
	return nil
}

func TestMain(m *testing.M) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		// Every Postgres test skips; there are no rows to own and nothing to
		// lock. The pure-logic tests in this package still run.
		os.Exit(m.Run())
	}
	ctx := context.Background()
	// A dedicated connection rather than one borrowed from a pool: the advisory
	// lock lives on the SESSION that took it, and a pooled connection would be
	// handed back and could unlock or outlive the lock by accident.
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		fmt.Fprintf(os.Stderr, "session tests: connect to TEST_DATABASE_URL: %v\n", err)
		os.Exit(1)
	}
	if err := lockFixtures(ctx, conn); err != nil {
		fmt.Fprintf(os.Stderr, "session tests: %v\n", err)
		os.Exit(1)
	}
	if err := seedFixtureExercises(ctx, conn); err != nil {
		fmt.Fprintf(os.Stderr, "session tests: %v\n", err)
		os.Exit(1)
	}

	code := m.Run()

	if err := removeFixtureExercises(ctx, conn); err != nil {
		fmt.Fprintf(os.Stderr, "session tests: %v\n", err)
		if code == 0 {
			code = 1
		}
	}
	// Explicit, because os.Exit runs no deferred function. Closing releases the
	// advisory lock.
	_ = conn.Close(ctx)
	os.Exit(code)
}

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

	// The SESSION rows are still swept per test, unchanged. This is the net for
	// session rows whose ids a test did not hand to `cleanup`, and it has to
	// stay per-test: moved to package teardown it would let one test's rows
	// survive into the next, which is a different behaviour and not one this
	// change is trying to make. Only the EXERCISE rows moved to the process.
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `
			DELETE FROM sessions WHERE id IN (
				SELECT session_id FROM session_sets WHERE exercise_id = ANY($1))`,
			fixtureExerciseIDs()); err != nil {
			t.Logf("cleanup sessions referencing fixture exercises: %v", err)
		}
	})
	return NewPostgresRepository(pool), pool
}

// The lock IS the fix, so it gets an assertion rather than a comment. Delete
// the `lockFixtures` call from TestMain and this test is the thing that goes
// red — without it the removal is silent, and the package goes back to passing
// alone and failing in a fleet, which is the exact shape of #426.
//
// A second connection is what makes this a real probe: advisory locks are held
// per SESSION, so if TestMain's connection holds it, no other connection can
// take it. It is taken from the pool explicitly rather than through
// `pool.QueryRow`, because a pooled connection is handed straight back and the
// unlock below would then run on a different session and do nothing.
func TestTheFixtureLockIsHeldForTheWholeProcess(t *testing.T) {
	_, pool := newTestRepo(t) // skips when TEST_DATABASE_URL is unset
	ctx := context.Background()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire a second connection: %v", err)
	}
	defer conn.Release()

	var got bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock($1::int, `+fixtureLockScope+`)`,
		fixtureLockKey).Scan(&got); err != nil {
		t.Fatalf("probe the fixture lock: %v", err)
	}
	if got {
		if _, err := conn.Exec(ctx,
			`SELECT pg_advisory_unlock($1::int, `+fixtureLockScope+`)`,
			fixtureLockKey); err != nil {
			t.Logf("release the probe lock: %v", err)
		}
		t.Fatal("a second connection was able to take this package's fixture lock, so " +
			"nothing stops a second `session` test binary deleting these fixtures out " +
			"from under an in-flight test. TestMain must hold it for the lifetime of " +
			"the process — see #426.")
	}
}

// And the other half: that TestMain actually SEEDED, with the values the rest of
// the package reads off these rows. Every other test would fail loudly on a
// missing row, but not on a wrong `implements` — that one goes quiet, and it is
// the mistake `feed` shipped, where an omitted `load_mode` let the per-side CASE
// be deleted with the suite still green.
func TestMainSeededTheFixtureExercises(t *testing.T) {
	_, pool := newTestRepo(t)
	ctx := context.Background()

	for _, want := range fixtureExercises {
		var sport, pattern, loadType, loadMode, status string
		var implements int
		var unilateral bool
		err := pool.QueryRow(ctx, `
			SELECT sport, movement_pattern, load_type, load_mode, status, implements, is_unilateral
			FROM exercises WHERE id = $1`, want.id).
			Scan(&sport, &pattern, &loadType, &loadMode, &status, &implements, &unilateral)
		if err != nil {
			t.Fatalf("fixture %s is not in the database: %v", want.id, err)
		}
		if sport != want.sport || pattern != want.pattern || loadType != want.loadType ||
			loadMode != want.loadMode || status != "published" ||
			implements != want.implements || unilateral != want.unilateral {
			t.Errorf("fixture %s was seeded as {%s %s %s %s %s implements=%d unilateral=%v}, "+
				"want {%s %s %s %s published implements=%d unilateral=%v}",
				want.id, sport, pattern, loadType, loadMode, status, implements, unilateral,
				want.sport, want.pattern, want.loadType, want.loadMode,
				want.implements, want.unilateral)
		}
	}
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
		{ExerciseID: exRun, Reps: ptrInt(5), Completed: true},
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
	cleanup(t, pool, "ses-list-run")

	mine := strengthSession("ses-list-mine", "user_list_a", []Set{{ExerciseID: exSquat, Reps: ptrInt(5), Completed: true}})
	if _, err := repo.Create(ctx, mine); err != nil {
		t.Fatalf("create mine: %v", err)
	}
	theirs := strengthSession("ses-list-theirs", "user_list_b", []Set{{ExerciseID: exBench, Reps: ptrInt(5), Completed: true}})
	if _, err := repo.Create(ctx, theirs); err != nil {
		t.Fatalf("create theirs: %v", err)
	}
	run := NewSession{
		ID: "ses-list-run", UserID: "user_list_a", Sport: "running", Name: "Easy run",
		StartedAt: time.Now().UTC().Add(-2 * time.Hour),
		Sets:      []Set{{ExerciseID: exRun, Seconds: ptrInt(300), Completed: true}},
	}
	if _, err := repo.Create(ctx, run); err != nil {
		t.Fatalf("create running: %v", err)
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

	bySport, err := repo.List(ctx, "user_list_a", Filter{Sport: "running"})
	if err != nil {
		t.Fatalf("list by sport: %v", err)
	}
	if len(bySport.Sessions) != 1 || bySport.Sessions[0].ID != "ses-list-run" {
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
	byName, err := repo.List(ctx, "user_list_a", Filter{Query: "easy"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(byName.Sessions) != 1 || byName.Sessions[0].ID != "ses-list-run" {
		t.Fatalf("search wrong: %+v", byName.Sessions)
	}
	// Case-insensitive, and a wildcard is a literal rather than "match all".
	upper, _ := repo.List(ctx, "user_list_a", Filter{Query: "EASY"})
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
			// A PAIR of dumbbells: 30 is one of them, so this contributes
			// 10 x 30 x 2 = 600, not 300. Both sides of the comparison have to
			// agree about that, which is the only reason it is in this fixture.
			{ExerciseID: exDBBench, SetType: SetTypeWorking, Reps: ptrInt(10), WeightKg: ptrF(30), Completed: true},
			// A DROP off it. Counted in reps and tonnage, NOT in the set count —
			// and both sides of this comparison have to agree about that, which
			// is the only reason it is in the fixture. Without one, `workingSet`
			// and `countsAsSet` are indistinguishable here and a SQL site using
			// the wrong one passes green.
			//
			// Per-side as well, so it also proves the two rules compose: a drop
			// on a pair of dumbbells contributes doubled tonnage while adding no
			// set.
			{ExerciseID: exDBBench, SetType: SetTypeDrop, Reps: ptrInt(12), WeightKg: ptrF(20), Completed: true},
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
	// still gets caught:
	//   5×100 (barbell)          =  500
	//   8 reps unweighted        =    0
	//   3×120 + 1×140 (barbell)  =  500
	//   10×30 PER HAND, doubled  =  600
	//   12×20 PER HAND, DROP      =  480
	//                              -----
	//                              2080
	//
	// The drop adds its 480 and adds NO set — five sets, not six. That pair is
	// the whole of W2, and asserting only one half would pass against a change
	// that dropped its volume too.
	//
	// The dumbbell line is why this number moved. Written literally rather than
	// computed, because a computed expectation would apply whatever factor the
	// code applies and agree with a bug.
	if wantSets != 5 || wantReps != 39 || !closeEnough(wantTonnage, 2080) {
		t.Fatalf("fixture expectations drifted: sets=%d reps=%d tonnage=%v", wantSets, wantReps, wantTonnage)
	}
	// Two sessions, two days, four distinct exercises — one of them only
	// ever warmed up, which still counts as "what did I train".
	if got.Totals.Sessions != 2 || got.Totals.ActiveDays != 2 || got.Totals.Exercises != 4 {
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
		histAt("ses-hist-run", mine, "running", time.Date(2024, 3, 12, 12, 0, 0, 0, time.UTC), time.Hour, []Set{
			{ExerciseID: exRun, SetType: SetTypeWorking, Seconds: ptrInt(300), Completed: true},
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
		Sport: "running", From: march.From, To: march.To, TZ: "UTC",
	})
	if err != nil {
		t.Fatalf("history filtered: %v", err)
	}
	if filtered.Totals.Sessions != 1 || filtered.Totals.TonnageKg != 0 {
		t.Errorf("running filter: %+v", filtered.Totals)
	}
	// A sport filter must narrow the comparison too, or a run gets measured
	// against last month's squats.
	if filtered.Previous.Sessions != 0 {
		t.Errorf("filtered previous should be running-only: %+v", filtered.Previous)
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

	got, err := repo.Records(ctx, mine, []string{exSquat, exRun})
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

	// The read is `ORDER BY position, exercise_id`, so the pinned order only
	// proves anything if it differs from the alphabetical tiebreak — otherwise
	// dropping `position` from that clause passes green.
	want := []string{exSquat, exBench}
	requireUnsorted(t, want)

	if err := repo.SetPinnedExercises(ctx, user, want); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, err := repo.PinnedExercises(ctx, user)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	// Order is the athlete's choice, not alphabetical — squat was pinned first.
	if len(got) != 2 || got[0] != exSquat || got[1] != exBench {
		t.Errorf("pins came back as %v, want %v", got, want)
	}

	// Replace wholesale, including reordering.
	if err := repo.SetPinnedExercises(ctx, user, []string{exBench}); err != nil {
		t.Fatalf("replace: %v", err)
	}
	got, _ = repo.PinnedExercises(ctx, user)
	if len(got) != 1 || got[0] != exBench {
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

// The API's order is the caller's order — the pinned `position` an athlete
// chose, or most-trained-first for scope=all. Sorting in place returned
// everything alphabetically instead, which looked fine and silently made the
// reorder UI do nothing.
func TestRecords_PreservesTheCallersOrder(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_rec_order"

	cleanup(t, pool, "ses-rec-order")
	if _, err := repo.Create(ctx, strengthSession("ses-rec-order", user, []Set{
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(80), Completed: true},
	})); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Must be an order a sort would *change*, or the test cannot fail —
	// asserted rather than asserted-in-a-comment, because the last rename
	// inverted it and nothing noticed. Squat-first is the non-alphabetical
	// case for the current ids.
	asked := []string{exSquat, exBench}
	requireUnsorted(t, asked)

	got, err := repo.Records(ctx, user, asked)
	if err != nil {
		t.Fatalf("records: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected both exercises, got %d", len(got))
	}
	if got[0].ExerciseID != exSquat || got[1].ExerciseID != exBench {
		t.Errorf("order was %s, %s — want %s, %s (sorted in place?)",
			got[0].ExerciseID, got[1].ExerciseID, exSquat, exBench)
	}
	// And the caller's own slice must come back untouched.
	if asked[0] != exSquat || asked[1] != exBench {
		t.Errorf("Records mutated the caller's slice: %v", asked)
	}
}

// A set that survives the SQL candidate filter but cannot be estimated must
// not set the bar the other candidates are pruned against.
//
// The prefilter keeps rows whose weight × 1.44 reaches `heaviest`, and
// `heaviest` is a MAX over the candidate pool. The pool used to be chosen on
// reps alone, while EstimateOneRM refuses on *effective* reps — so a set of 10
// at 3 RIR (13 effective) became a candidate, set `heaviest` to its own
// weight, contributed no estimate of its own, and pruned every lighter set in
// favour of a row that could never score.
//
// The result was a personal best that silently stopped existing. Found by
// review; this is the data that reproduced it.
func TestBestOneRMs_KeepsTheWinnerWhenTheHeaviestSetIsNotEstimable(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-unestimable")

	sets := []Set{
		// 13 effective reps: passes `reps <= 12`, estimates nothing.
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(10), WeightKg: ptrF(100), RIR: ptrInt(3), Completed: true},
		// The real best: 60 × 12 at 0 RIR estimates 60 × 36/25 = 86.4.
		// Its weight is below 100/1.44, so the old pool pruned it.
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(12), WeightKg: ptrF(60), RIR: ptrInt(0), Completed: true},
	}
	s := strengthSession("ses-unestimable", "user_unestimable", sets)
	if _, err := repo.Create(ctx, s); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.BestOneRMs(ctx, "user_unestimable", []string{exSquat})
	if err != nil {
		t.Fatalf("best 1rms: %v", err)
	}

	best, ok := got[exSquat]
	if !ok {
		t.Fatal("no 1RM at all for an athlete whose log supports 86.4kg — " +
			"the unestimable set pruned the winner")
	}
	// And it must agree with the Go implementation over the same sets, which
	// is the invariant the two share.
	want, _, hasGo := BestOneRM(sets)
	if !hasGo {
		t.Fatal("fixture problem: Go found no estimate either")
	}
	if math.Abs(best-want) > 0.01 {
		t.Errorf("SQL says %.4f, Go says %.4f", best, want)
	}
	if math.Abs(best-86.4) > 0.01 {
		t.Errorf("want 86.4 from the 12 × 60, got %.4f", best)
	}
}

// The same poisoning through the RPE path, plus the two seams around it.
//
// The RIR case above is the one that was reported; this is the one that would
// have been missed. Effort reaches the filter by two routes and they have to
// agree, because the SQL expresses as COALESCE what Go expresses as a switch —
// and a COALESCE that skipped a real zero, or an RPE conversion that rounded,
// would each be invisible to a RIR-only fixture.
func TestBestOneRMs_EffortPathsMatchTheEstimator(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	cleanup(t, pool, "ses-effort-paths")

	sets := []Set{
		// RPE 7 is 3 in reserve: 13 effective. Poisons the pool exactly as
		// the RIR row does, by a different route.
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(10), WeightKg: ptrF(100), RPE: ptrF(7), Completed: true},
		// RPE 10 is nothing in reserve: 12 effective, estimates 86.4.
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(12), WeightKg: ptrF(60), RPE: ptrF(10), Completed: true},
		// RIR 0 *with* an RPE present. The classic COALESCE trap: zero is a
		// real value, so RIR must win and this is 12 effective, not 17. If
		// COALESCE skipped it, this row would be excluded and its estimate lost.
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(12), WeightKg: ptrF(70), RIR: ptrInt(0), RPE: ptrF(5), Completed: true},
		// Fractional RPE at the boundary: 8.5 is 1.5 reserve, so 12.5
		// effective — over the ceiling. Rounding it away would wrongly admit
		// this row and re-inflate the bar.
		{ExerciseID: exBench, SetType: SetTypeWorking, Reps: ptrInt(11), WeightKg: ptrF(200), RPE: ptrF(8.5), Completed: true},
	}
	if _, err := repo.Create(ctx, strengthSession("ses-effort-paths", "user_effort_paths", sets)); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.BestOneRMs(ctx, "user_effort_paths", []string{exSquat, exBench})
	if err != nil {
		t.Fatalf("best 1rms: %v", err)
	}

	// Squat: the RPE-path poisoner must not prune the 12 × 60.
	squat, ok := got[exSquat]
	if !ok {
		t.Error("RPE path: no 1RM, the unestimable 10 @ RPE 7 pruned the winner")
	} else if math.Abs(squat-86.4) > 0.01 {
		t.Errorf("RPE path: want 86.4, got %.4f", squat)
	}

	// Bench: the 200kg row is 12.5 effective and must be excluded, so the
	// answer comes from the RIR-0 row — 12 × 70 = 100.8.
	bench, ok := got[exBench]
	if !ok {
		t.Fatal("bench: no 1RM — RIR 0 alongside an RPE was skipped by COALESCE, " +
			"or the fractional RPE row was admitted and pruned it")
	}
	if math.Abs(bench-100.8) > 0.01 {
		t.Errorf("bench: want 100.8 from the RIR-0 row, got %.4f", bench)
	}

	// And both must agree with the Go implementation over the same sets.
	for id, want := range map[string][]Set{exSquat: sets[:2], exBench: sets[2:]} {
		expected, _, hasGo := BestOneRM(want)
		if !hasGo {
			t.Fatalf("%s: fixture problem, Go found no estimate", id)
		}
		if math.Abs(got[id]-expected) > 0.01 {
			t.Errorf("%s: SQL %.4f, Go %.4f", id, got[id], expected)
		}
	}
}

// Renaming, and the boundary it has to respect.
//
// The name defaults to the workout or, for BJJ, the kind — "Class" — which is
// right until the session was a seminar or an open mat. This exists because
// the phone could rename locally and then silently drop the change: the
// create is ON CONFLICT DO NOTHING, so replaying it does NOT carry a later
// rename, and the outbox marked the row clean regardless.
func TestRenameChangesOnlyTheNameAndOnlyForTheOwner(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const id, owner, attacker = "ses-rename", "user_rename_owner", "user_rename_attacker"
	// Without this the test stops testing the rename after its first run:
	// Create is ON CONFLICT DO NOTHING and returns the EXISTING row, so on a
	// second run `before` is already the renamed name and the assertion below
	// can no longer fail. Deleting the UPDATE from Rename passes on a dirty
	// database and fails only on a fresh one.
	cleanup(t, pool, id)

	before, err := repo.Create(ctx, strengthSession(id, owner, nil))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	after, err := repo.Rename(ctx, owner, id, "Tuesday no-gi open mat")
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if after.Name != "Tuesday no-gi open mat" {
		t.Fatalf("name is %q", after.Name)
	}
	// Only the name. A general update would make these editable by accident,
	// and sport in particular decides which screen renders the session at all.
	if after.Sport != before.Sport || !after.StartedAt.Equal(before.StartedAt) {
		t.Errorf("rename changed more than the name: sport %q->%q, started %v->%v",
			before.Sport, after.Sport, before.StartedAt, after.StartedAt)
	}

	// Ids are client-generated, so a foreign id is guessable — the same IDOR
	// this module has already had to close once.
	// This assertion alone does NOT detect a missing ownership gate: without
	// requireOwner the attacker's UPDATE commits and the user-scoped re-Get
	// still returns ErrNotFound. The owner re-read below is what catches it —
	// do not "simplify" this test by dropping it.
	if _, err := repo.Rename(ctx, attacker, id, "PWNED"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-user rename gave %v, want ErrNotFound", err)
	}
	still, err := repo.Get(ctx, owner, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if still.Name != "Tuesday no-gi open mat" {
		t.Errorf("owner's name was changed by another user: %q", still.Name)
	}
}

// seedDraftExercise inserts an unpublished catalog row and removes it again.
// Same fixture discipline as the workout module's copy: the row lands in the
// database every other package shares, so cleanup is registered first — and
// this must be called BEFORE `cleanup`, because t.Cleanup is LIFO and the
// exercise has to outlive the session whose sets reference it.
func seedDraftExercise(t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM exercises WHERE id = $1`, id); err != nil {
			t.Logf("cleanup exercise %s: %v", id, err)
		}
	})
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status)
		 VALUES ($1, 'Draft Fixture', 'strength', 'squat', 'weight_reps', 'draft')`,
		id); err != nil {
		t.Fatalf("seed draft exercise: %v", err)
	}
}

// A logged set may not reference an unfinished exercise, for the same reason a
// workout item may not — and it must fail as an unknown id rather than as a
// draft, so the endpoint stays silent about what exists unpublished.
func TestCreate_RejectsADraftExerciseAsUnknown(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	seedDraftExercise(t, pool, "ses-draft-fixture-exercise")
	cleanup(t, pool, "ses-draft-1")

	_, err := repo.Create(ctx, strengthSession("ses-draft-1", "user_a", []Set{
		{ExerciseID: "ses-draft-fixture-exercise", Reps: ptrInt(5), Completed: true},
	}))
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("a draft exercise was accepted into a session: err = %v, want ErrInvalidInput", err)
	}
	// Not ErrSportMismatch: the fixture IS strength, so a missing filter gives
	// no error and a leaky one names the sport, which confirms the row exists.
	if errors.Is(err, ErrSportMismatch) {
		t.Errorf("draft rejected as a sport mismatch, which confirms it exists: %v", err)
	}
	if _, err := repo.Get(ctx, "user_a", "ses-draft-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("failed create left a session behind: %v", err)
	}
}

// The published half, so the test above cannot pass by refusing everything.
func TestCreate_AcceptsTheSameExerciseOncePublished(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	seedDraftExercise(t, pool, "ses-published-fixture-exercise")
	cleanup(t, pool, "ses-draft-2")

	if _, err := pool.Exec(ctx,
		`UPDATE exercises SET status = 'published' WHERE id = $1`,
		"ses-published-fixture-exercise"); err != nil {
		t.Fatalf("publish fixture: %v", err)
	}

	if _, err := repo.Create(ctx, strengthSession("ses-draft-2", "user_a", []Set{
		{ExerciseID: "ses-published-fixture-exercise", Reps: ptrInt(5), Completed: true},
	})); err != nil {
		t.Fatalf("a published exercise was refused: %v", err)
	}
}
