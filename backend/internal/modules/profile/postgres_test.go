package profile

import (
	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"

	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Requires a real Postgres with migrations already applied — set
// TEST_DATABASE_URL to run this (see docker-compose.yml for local dev, or
// the `backend` CI job for how it's wired there). Skips otherwise so
// `go test ./...` still works without a database configured. These fixtures
// OWN the catalog rows they run on — nothing here needs `cmd/seed`.

// The catalog ids this package's tests use. Namespaced, because they are this
// package's rows and not the shipped catalog's.
//
// They used to be `bench-press` and `back-squat`, which the package never
// seeded — so `TestExerciseUnits_SetClearAndScope` failed against a freshly
// migrated database and passed in a full run only because
// `internal/modules/exercise` seeds the whole catalog and sorts before
// `profile` under `-p 1`. Last of the three holdouts; `session` and `workout`
// went first.
//
// Suffixes keep the original names, per the convention those two settled on:
// some tests depend on the ids' relative LEXICAL ORDER, that dependency is
// invisible at the call site, and `session`'s re-wording inverted such a pair
// and silently disarmed two tests. **No test here has that dependency** —
// `ListExerciseUnits` returns a `map[string]string` and its query carries no
// `ORDER BY`, so nothing observes an order — which is why there is no
// `requireUnsorted` call in this package. Checked rather than assumed; the
// convention is followed anyway so the next reader does not have to re-derive
// that it was safe to break.
//
// What the scope test *does* need is that the two ids DIFFER, and that fails
// loudly rather than silently: make them equal and the leak assertion fires.
// (It fires on this athlete's OWN row under the now-shared key, not on the
// other athlete's — the test cannot tell those apart. The point is only that
// equal ids cannot slip through unnoticed.)
const (
	exBench = "pf_fx_bench_press"
	exSquat = "pf_fx_back_squat"
)

// fixtureExercise is a catalog row this package writes for itself. Nothing here
// reads any column but `id` — `exercise_unit_prefs` is keyed on it and the
// repository never joins the catalog — so the rest exist only to satisfy NOT
// NULLs. They are still set explicitly rather than defaulted: `feed` shipped the
// opposite, where an omitted `load_mode` let every fixture take the column
// default and the per-side path could have been deleted with the suite green.
type fixtureExercise struct {
	id       string
	sport    string
	pattern  string
	loadType string
}

var fixtureExercises = []fixtureExercise{
	{exBench, "strength", "horizontal_push", "weight_reps"},
	{exSquat, "strength", "squat", "weight_reps"},
}

// seedFixtureExercises writes this package's catalog rows and removes them
// again. Called from newTestRepo, so it runs before any test body and — since
// t.Cleanup is LIFO — its cleanup runs after every cleanup a test registers
// later.
//
// The removal is simpler than the session and workout helpers' deliberately,
// not by oversight. The only table here that references `exercises` is
// `exercise_unit_prefs`, which is ON DELETE CASCADE, so deleting the exercise
// takes its overrides with it and no parent-first step is needed. **If a test
// in this package ever writes a `session_sets` or `workout_items` row against
// these ids, that stops being true** — both are NO ACTION, the delete would
// fail the foreign key, and a discarded error would leak the fixture into the
// database every other package shares. Copy the parent-first cleanup from
// `session/postgres_test.go` if that day comes.
func seedFixtureExercises(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	ids := make([]string, 0, len(fixtureExercises))
	for _, e := range fixtureExercises {
		ids = append(ids, e.id)
	}

	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM exercises WHERE id = ANY($1)`, ids); err != nil {
			t.Logf("cleanup fixture exercises: %v", err)
		}
	})

	for _, e := range fixtureExercises {
		// Every column reconciled on conflict, not just inserted — a row left
		// behind by an interrupted run is repaired rather than trusted.
		if _, err := pool.Exec(ctx, `
			INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status)
			VALUES ($1, $1, $2, $3, $4, 'published')
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name,
				sport = EXCLUDED.sport,
				movement_pattern = EXCLUDED.movement_pattern,
				load_type = EXCLUDED.load_type,
				status = EXCLUDED.status`,
			e.id, e.sport, e.pattern, e.loadType); err != nil {
			t.Fatalf("seed fixture exercise %s: %v", e.id, err)
		}
	}
}

// newTestRepo matches the session module's helper. pool.Close is registered
// first so it runs *last* under LIFO cleanup — registering it later would
// close the pool before the per-test row cleanups could use it.
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
	t.Cleanup(pool.Close)
	seedFixtureExercises(t, pool)
	return NewPostgresRepository(pool), pool
}

func TestPostgresRepository_CreateGetUpdate(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}

	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered before the delete-row cleanup below so it runs *after* it:
	// t.Cleanup runs LIFO, and a plain `defer pool.Close()` here would run
	// before any t.Cleanup callback (defers run when the test function
	// returns; t.Cleanup runs afterward), closing the pool before the
	// delete could use it and silently leaking the row every run.
	t.Cleanup(func() { pool.Close() })

	repo := NewPostgresRepository(pool)
	userID := "test_user_create_get_update"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM profiles WHERE user_id = $1`, userID); err != nil {
			t.Logf("cleanup: delete profile: %v", err)
		}
	})

	name := "Test User"
	dob := "1990-01-01"
	sex := "male"
	created, err := repo.Create(ctx, userID, NewProfile{DisplayName: &name, DateOfBirth: &dob, Sex: &sex})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.UserID != userID || *created.DisplayName != name {
		t.Fatalf("unexpected created profile: %+v", created)
	}
	// Module toggles are no longer profile columns — see TestProfileModules.

	if _, err := repo.Create(ctx, userID, NewProfile{}); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("expected ErrAlreadyExists on duplicate create, got %v", err)
	}

	fetched, err := repo.Get(ctx, userID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if fetched.UserID != userID || *fetched.DateOfBirth != dob {
		t.Fatalf("unexpected fetched profile: %+v", fetched)
	}

	imperial := "imperial"
	updated, err := repo.Update(ctx, userID, ProfileUpdate{UnitSystem: &imperial})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.UnitSystem != imperial {
		t.Fatalf("expected unit_system imperial after update, got %+v", updated)
	}
	if *updated.DisplayName != name {
		t.Fatalf("update should leave untouched fields alone, got %+v", updated)
	}

	if _, err := repo.Get(ctx, "nonexistent_user_xyz"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for unknown user, got %v", err)
	}
}

// Per-exercise unit overrides. A lifter who thinks in kilograms still faces a
// leg press marked in pounds; the override is per user *and* per exercise
// because it describes the equipment, not the person.
func TestExerciseUnits_SetClearAndScope(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()

	const me, other = "user_units_a", "user_units_b"
	// Clear before as well as after: the first assertion below is "this athlete
	// has no overrides", so a prefs row left by an interrupted run fails it
	// once before the cleanup below heals it. One red run for somebody else's
	// crash is avoidable, and the delete costs nothing.
	clearUnits := func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM exercise_unit_prefs WHERE user_id IN ($1, $2)`, me, other); err != nil {
			t.Errorf("cleanup exercise unit prefs: %v", err)
		}
	}
	clearUnits()
	t.Cleanup(clearUnits)

	// Absence means "use the profile default" — no third state.
	got, err := repo.ListExerciseUnits(ctx, me)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no overrides, got %v", got)
	}

	if err := repo.SetExerciseUnit(ctx, me, exBench, "imperial"); err != nil {
		t.Fatalf("set: %v", err)
	}
	// Upsert rather than a duplicate-key error.
	if err := repo.SetExerciseUnit(ctx, me, exBench, "metric"); err != nil {
		t.Fatalf("re-set: %v", err)
	}
	got, _ = repo.ListExerciseUnits(ctx, me)
	if got[exBench] != "metric" {
		t.Fatalf("want metric after re-set, got %q", got[exBench])
	}

	// Another user's override must never appear in mine.
	if err := repo.SetExerciseUnit(ctx, other, exSquat, "imperial"); err != nil {
		t.Fatalf("set other: %v", err)
	}
	got, _ = repo.ListExerciseUnits(ctx, me)
	if _, leaked := got[exSquat]; leaked {
		t.Fatal("another user's override leaked into this user's map")
	}

	// Clearing is a delete, so the key disappears rather than holding a
	// sentinel value.
	if err := repo.SetExerciseUnit(ctx, me, exBench, ""); err != nil {
		t.Fatalf("clear: %v", err)
	}
	got, _ = repo.ListExerciseUnits(ctx, me)
	if _, still := got[exBench]; still {
		t.Fatal("cleared override is still present")
	}
}

// An unknown exercise is bad input, not an internal error — the FK must be
// translated rather than escaping as a 500.
func TestExerciseUnits_RejectsUnknownExercise(t *testing.T) {
	repo, _ := newTestRepo(t)
	err := repo.SetExerciseUnit(context.Background(), "user_units_c", "no-such-exercise", "imperial")
	if err == nil {
		t.Fatal("expected an error for an unknown exercise")
	}
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
}

// TestProfileModules covers the behaviour that replaced four boolean columns.
//
// The properties worth protecting are not "a row round-trips" but the two that
// make adding a discipline free: an absent row means the REGISTRY's default,
// and a sparse PATCH leaves other modules alone.
func TestProfileModules(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	userID := "user_modules_test"

	cleanupProfile(t, pool, userID)
	if _, err := repo.Create(ctx, userID, NewProfile{}); err != nil {
		t.Fatalf("create: %v", err)
	}

	// A brand-new profile stores NOTHING. That is the point: defaults live in
	// the registry, so a discipline added later needs no backfill.
	stored, err := repo.ListModules(ctx, userID)
	if err != nil {
		t.Fatalf("list modules: %v", err)
	}
	if len(stored) != 0 {
		t.Errorf("a new profile stored %d module rows; defaults belong to the registry, not the database", len(stored))
	}

	// ...and the merged view still answers for every module.
	mods := ModulesFor(stored)
	if len(mods) != len(discipline.All()) {
		t.Fatalf("ModulesFor returned %d modules, registry has %d", len(mods), len(discipline.All()))
	}
	for _, m := range mods {
		if m.Enabled != m.DefaultOn {
			t.Errorf("%s: enabled=%v with nothing stored, want the registry default %v", m.Key, m.Enabled, m.DefaultOn)
		}
	}

	// A sparse PATCH must not disturb anything it didn't name.
	if err := repo.SetModules(ctx, userID, map[string]bool{"bjj": false}); err != nil {
		t.Fatalf("set modules: %v", err)
	}
	stored, err = repo.ListModules(ctx, userID)
	if err != nil {
		t.Fatalf("list modules after set: %v", err)
	}
	if len(stored) != 1 || stored["bjj"] != false {
		t.Fatalf("expected exactly one stored row bjj=false, got %+v", stored)
	}
	for _, m := range ModulesFor(stored) {
		want := m.DefaultOn
		if m.Key == "bjj" {
			want = false
		}
		if m.Enabled != want {
			t.Errorf("%s: enabled=%v, want %v (a one-key PATCH must leave the rest alone)", m.Key, m.Enabled, want)
		}
	}

	// Toggling back is an update, not a second row.
	if err := repo.SetModules(ctx, userID, map[string]bool{"bjj": true, "running": true}); err != nil {
		t.Fatalf("set modules again: %v", err)
	}
	stored, _ = repo.ListModules(ctx, userID)
	if len(stored) != 2 || !stored["bjj"] || !stored["running"] {
		t.Fatalf("expected bjj and running true, got %+v", stored)
	}

	// An empty PATCH is a no-op rather than an error or a wipe.
	if err := repo.SetModules(ctx, userID, map[string]bool{}); err != nil {
		t.Errorf("empty set should be a no-op, got %v", err)
	}
	after, _ := repo.ListModules(ctx, userID)
	if len(after) != 2 {
		t.Errorf("empty set changed stored rows: %+v", after)
	}

	// A user with no profile row cannot have modules — the FK is the guard.
	if err := repo.SetModules(ctx, "user_no_profile_xyz", map[string]bool{"bjj": true}); err == nil {
		t.Error("expected an error setting modules for a user with no profile")
	}
}

// cleanupProfile clears the row before the test AND registers its removal
// afterwards.
//
// It used to do only the first, which is a clean-BEFORE and not a cleanup: the
// row it created outlived every run, and the next run merely overwrote it. One
// stale `user_modules_test` profile therefore sat in the shared database
// permanently. Harmless in itself — same id every time, so it never
// accumulated — but it is a fixture this package does not own left in a
// database every other package reads, which is the habit this suite has been
// unpicking elsewhere. Found by checking what the package left behind after the
// fixture conversion, not by any test failing.
func cleanupProfile(t *testing.T, pool *pgxpool.Pool, userID string) {
	t.Helper()
	del := func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM profiles WHERE user_id = $1`, userID); err != nil {
			t.Errorf("cleanup profile %s: %v", userID, err)
		}
	}
	del()
	t.Cleanup(del)
}

// The username claim path. Every case here is one of the ways a unique handle
// goes wrong, and the case-collision one deliberately goes AROUND validation
// to prove the index holds on its own.
func TestUsernameClaimAndRename(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	a, b := "test_user_uname_a", "test_user_uname_b"
	for _, id := range []string{a, b} {
		// BEFORE the Create, not after. Registering the cleanup afterwards
		// makes this test permanently red rather than flaky: a row left by an
		// interrupted run fails `Create` with ErrAlreadyExists, the Fatalf
		// stops the function, the cleanup that would have removed the row is
		// therefore never registered, and every subsequent run repeats it.
		// Verified in review, not theorised.
		cleanupProfile(t, pool, id)
		if _, err := repo.Create(ctx, id, NewProfile{}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}

	u := "dmytro_bjj"
	p, err := repo.Update(ctx, a, ProfileUpdate{Username: &u})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if p.Username == nil || *p.Username != u {
		t.Fatalf("claim did not stick: %v", p.Username)
	}

	// Someone else wants it — exact error, not merely "an error". Accepting
	// any error is how a mis-mapped 409 sailed through review in the sequence
	// module; pinned here from the start.
	if _, err := repo.Update(ctx, b, ProfileUpdate{Username: &u}); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("want ErrUsernameTaken, got %v", err)
	}

	// CASE-INSENSITIVE at the DATABASE, not only in validation. The repository
	// does not validate — the handler does — so a future caller could hand it
	// mixed case. lower() in the index is what makes that safe, and this is
	// the test that fails if the index quietly becomes a plain unique.
	mixed := "DMYTRO_bjj"
	if _, err := repo.Update(ctx, b, ProfileUpdate{Username: &mixed}); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("case variant must collide: want ErrUsernameTaken, got %v", err)
	}

	// Re-setting your own handle is idempotent, not a conflict — the unique
	// index sees its own row.
	if _, err := repo.Update(ctx, a, ProfileUpdate{Username: &u}); err != nil {
		t.Fatalf("re-setting own username must succeed: %v", err)
	}

	// A rename frees the old handle for the next claimant.
	u2 := "dmytro_renamed"
	if _, err := repo.Update(ctx, a, ProfileUpdate{Username: &u2}); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if _, err := repo.Update(ctx, b, ProfileUpdate{Username: &u}); err != nil {
		t.Fatalf("freed username must be claimable: %v", err)
	}

	// Updating unrelated fields leaves the handle alone — the nil/COALESCE
	// contract every other profile field already lives by.
	dn := "Display Only"
	p, err = repo.Update(ctx, a, ProfileUpdate{DisplayName: &dn})
	if err != nil {
		t.Fatalf("unrelated update: %v", err)
	}
	if p.Username == nil || *p.Username != u2 {
		t.Fatalf("unrelated update moved the username: %v", p.Username)
	}
}

func TestValidUsername(t *testing.T) {
	// Pure logic — runs without TEST_DATABASE_URL, which is most local runs.
	ok := []string{"abc", "dmytro", "dmytro_bjj", "a12345", "x_______x"}
	for _, u := range ok {
		if !ValidUsername(u) {
			t.Errorf("%q should be claimable", u)
		}
	}
	bad := map[string]string{
		"ab":                    "under 3",
		"Dmytro":                "uppercase — handles are canonical lowercase",
		"1dmytro":               "starts with a digit",
		"_dmytro":               "starts with underscore",
		"dmytro bjj":            "whitespace",
		"dmytro-bjj":            "hyphen outside the charset",
		"dmytró":                "unicode outside the charset",
		"admin":                 "reserved: impersonation",
		"vola":                  "reserved: the product",
		"me":                    "reserved: future route/pronoun collision",
		"settings":              "reserved: route collision",
		strings.Repeat("a", 31): "over 30",
	}
	for u, why := range bad {
		if ValidUsername(u) {
			t.Errorf("%q should be refused (%s)", u, why)
		}
	}
}

func TestGetByUsername(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	id := "test_user_lookup"
	// Before the Create — same reason as TestUsernameClaimAndRename above.
	cleanupProfile(t, pool, id)
	if _, err := repo.Create(ctx, id, NewProfile{}); err != nil {
		t.Fatalf("create: %v", err)
	}

	u := "lookup_target"
	dn := "Lookup Target"
	if _, err := repo.Update(ctx, id, ProfileUpdate{Username: &u, DisplayName: &dn}); err != nil {
		t.Fatalf("claim: %v", err)
	}

	got, err := repo.GetByUsername(ctx, u)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if got.Username != u || got.DisplayName == nil || *got.DisplayName != dn {
		t.Fatalf("wrong card: %+v", got)
	}

	// Case-insensitive through the lower() expression — the same index that
	// enforces uniqueness serves the lookup, and this is the test that goes
	// red if the WHERE clause stops matching the index expression.
	if _, err := repo.GetByUsername(ctx, "LOOKUP_TARGET"); err != nil {
		t.Fatalf("case-insensitive lookup: %v", err)
	}

	if _, err := repo.GetByUsername(ctx, "no_such_handle"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}
