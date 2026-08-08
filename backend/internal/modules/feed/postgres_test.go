package feed

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/modules/friend"
	"github.com/dmytro-ch21/vola/backend/internal/modules/session"
)

// NOTE ON THE IMPORTS. The `feed` package must never import `friend` or
// `session` — that inversion is the module's architecture. This TEST imports
// both, deliberately: it wires the same pairing `cmd/api/main.go` does, and it
// compares the SQL volume rule against `session.Summarise`, which is the only
// way to know the duplication has not drifted. A test against a stub would
// show only that the stub agrees with itself.
//
// **What this file is really for.** A feed is the first athlete-to-athlete
// read of training data in this system, so the tests that matter are the ones
// asserting what does NOT appear. Every one of those is written so that
// deleting the condition it covers turns it red — the access rule has three
// clauses and each has its own test, because a rule that is only tested in
// aggregate can lose a clause and still pass.

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
	// Registered FIRST so LIFO runs it LAST — the CLAUDE.md pool gotcha.
	t.Cleanup(func() { pool.Close() })
	return pool
}

type harness struct {
	pool     *pgxpool.Pool
	repo     *PostgresRepository
	friends  *friend.PostgresRepository
	sessions *session.PostgresRepository
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	pool := testPool(t)
	friends := friend.NewPostgresRepository(pool)
	return &harness{
		pool:     pool,
		repo:     NewPostgresRepository(pool, friends),
		friends:  friends,
		sessions: session.NewPostgresRepository(pool),
	}
}

// person seeds a profile. `sharing` is the opt-in, and it is a required
// argument rather than defaulting: every caller has to state which side of the
// privacy switch it is testing, so no test can accidentally rely on it.
func person(t *testing.T, pool *pgxpool.Pool, id, handle string, sharing bool) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO profiles (user_id, username, display_name, share_training_with_friends)
		VALUES ($1, $2, $2, $3)
		ON CONFLICT (user_id) DO UPDATE
		SET username = $2, display_name = $2, share_training_with_friends = $3`,
		id, handle, sharing); err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM session_sets WHERE user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM friendships WHERE user_a = $1 OR user_b = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM profiles WHERE user_id = $1`, id)
	})
	return id
}

// seedExercise inserts the catalog row these tests reference, rather than
// borrowing one from `cmd/seed`.
//
// NOT fastidiousness. Depending on `back-squat` existing made this package
// pass only because `exercise/postgres_test.go` seeds the full catalog and,
// under `-p 1`, `exercise` sorts before `feed`. On a freshly migrated database
// it fails outright — reproduced. The repo documents this exact trap twice
// already (`exercise/content_postgres_test.go`, `bjj/proficiency_postgres_test.go`)
// and the rule it settled on is: own the library rows you depend on.
func seedExercise(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status)
		VALUES ($1, $1, 'strength', 'squat', 'weight_reps', 'published')
		ON CONFLICT (id) DO NOTHING`, id); err != nil {
		t.Fatalf("seed exercise %s: %v", id, err)
	}
	t.Cleanup(func() {
		// Sessions first: `session_sets.exercise_id` has no ON DELETE, so a
		// bare exercise delete fails on the foreign key and the fixture
		// survives into the shared database. Exactly the leak the share
		// module's fixtures shipped.
		if _, err := pool.Exec(ctx, `
			DELETE FROM sessions WHERE id IN (
				SELECT session_id FROM session_sets WHERE exercise_id = $1)`, id); err != nil {
			t.Logf("cleanup sessions referencing %s: %v", id, err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM exercises WHERE id = $1`, id); err != nil {
			t.Logf("cleanup exercise %s: %v", id, err)
		}
	})
	return id
}

// befriend goes through the real friend module, so no test can pass against a
// friendship shape the module would never produce.
func befriend(t *testing.T, h *harness, a, aHandle, b, bHandle string) {
	t.Helper()
	ctx := context.Background()
	if err := h.friends.Send(ctx, a, bHandle); err != nil {
		t.Fatalf("send request: %v", err)
	}
	if err := h.friends.Accept(ctx, b, aHandle); err != nil {
		t.Fatalf("accept request: %v", err)
	}
}

// train creates a session and finishes it unless `finish` is false.
func train(t *testing.T, h *harness, owner, id, name string, finish bool, sets []session.Set) {
	t.Helper()
	ctx := context.Background()
	started := time.Now().UTC().Add(-time.Hour)
	if _, err := h.sessions.Create(ctx, session.NewSession{
		ID: id, UserID: owner, Sport: "strength", Name: name, StartedAt: started,
	}); err != nil {
		t.Fatalf("create session %s: %v", id, err)
	}
	if len(sets) > 0 {
		if _, err := h.sessions.ReplaceSets(ctx, owner, id, sets); err != nil {
			t.Fatalf("sets for %s: %v", id, err)
		}
	}
	if finish {
		if _, err := h.sessions.Finish(ctx, owner, id, started.Add(30*time.Minute)); err != nil {
			t.Fatalf("finish %s: %v", id, err)
		}
	}
}

func ids(p Page) []string {
	out := []string{}
	for _, it := range p.Items {
		out = append(out, it.ID)
	}
	return out
}

// ── The three clauses of the access rule, one test each ──────────────────────

func TestAStrangersTrainingNeverAppears(t *testing.T) {
	// The baseline this whole module is measured against: before the feed, NO
	// read of `sessions` was anything but `user_id = $1`. Opting in must not
	// broadcast — it must reach friends and stop there.
	//
	// **Alice must have a friend for this test to test anything.** With an
	// empty social graph `List` short-circuits before the query runs, so the
	// SQL filter is never reached and the assertion holds even if there is no
	// filter at all. Written that way first, and dropping `WHERE s.user_id =
	// ANY($1)` left it green.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_sa", "fd_sa_h", true)
	carol := person(t, h.pool, "fd_sc", "fd_sc_h", true)
	stranger := person(t, h.pool, "fd_ss", "fd_ss_h", true)
	befriend(t, h, alice, "fd_sa_h", carol, "fd_sc_h")
	train(t, h, carol, "fd_s_friend", "A friend's session", true, nil)
	train(t, h, stranger, "fd_s_open", "Stranger's session", true, nil)

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got := ids(page); len(got) != 1 || got[0] != "fd_s_friend" {
		t.Fatalf("a stranger's training reached the feed, or a friend's did not: %+v", got)
	}
	if page.Total != 1 {
		t.Fatalf("total counted a stranger: %d", page.Total)
	}
}

func TestAPendingFriendshipIsNotAFriendship(t *testing.T) {
	// Sending a request must not grant anything. This is the arm that a
	// `status <> 'declined'`-shaped mistake would open, and the friend module
	// only has two statuses, so it is easy to write the wrong one.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_pa", "fd_pa_h", true)
	bob := person(t, h.pool, "fd_pb", "fd_pb_h", true)
	if err := h.friends.Send(ctx, bob, "fd_pa_h"); err != nil {
		t.Fatalf("send: %v", err)
	}
	train(t, h, bob, "fd_p_open", "Not yet a friend", true, nil)

	// The error is CHECKED, not discarded. An errored `List` returns an empty
	// page, so `page, _ :=` makes every purely-negative privacy test here pass
	// vacuously the moment the query breaks — and these tests are the long-term
	// enforcement of the privacy boundary.
	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("a pending request granted feed access: %+v", ids(page))
	}
}

func TestOptingOutRetractsEverything(t *testing.T) {
	// The property that makes this a privacy control rather than a publish
	// button: the flag is read LIVE, so switching it off hides sessions that
	// were already visible. Stamping visibility onto each session at finish
	// time would pass a first-load test and fail this one.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_oa", "fd_oa_h", true)
	bob := person(t, h.pool, "fd_ob", "fd_ob_h", true)
	befriend(t, h, alice, "fd_oa_h", bob, "fd_ob_h")
	train(t, h, bob, "fd_o_seen", "Leg day", true, nil)

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("an opted-in friend's session should be visible: %+v", ids(page))
	}

	if _, err := h.pool.Exec(ctx,
		`UPDATE profiles SET share_training_with_friends = false WHERE user_id = $1`, bob); err != nil {
		t.Fatalf("opt out: %v", err)
	}
	page, err = h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list after opting out: %v", err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("opting out left training visible: %+v", ids(page))
	}
	if page.Total != 0 {
		t.Fatalf("the TOTAL still counts a retracted session: %d — a count that "+
			"disagrees with its list promises rows the list will not return", page.Total)
	}
}

func TestAFriendWhoNeverOptedInIsInvisible(t *testing.T) {
	// The default. An athlete who installs an update and accepts a friend must
	// not thereby publish anything — `DEFAULT false` in the migration is what
	// this asserts, and it is the difference between opt-in and opt-out.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_da", "fd_da_h", true)
	bob := person(t, h.pool, "fd_db", "fd_db_h", false)
	befriend(t, h, alice, "fd_da_h", bob, "fd_db_h")
	train(t, h, bob, "fd_d_private", "Private session", true, nil)

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("a friend who never opted in was published: %+v", ids(page))
	}
}

func TestAnUnfinishedSessionIsNotInTheFeed(t *testing.T) {
	// "Training right now" is a live location and a different disclosure from
	// "trained on Tuesday". Also the practical reason: an in-progress session
	// has no end time to order by, so it would sort unpredictably forever.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_ua", "fd_ua_h", true)
	bob := person(t, h.pool, "fd_ub", "fd_ub_h", true)
	befriend(t, h, alice, "fd_ua_h", bob, "fd_ub_h")
	train(t, h, bob, "fd_u_live", "Mid workout", false, nil)
	train(t, h, bob, "fd_u_done", "Finished", true, nil)

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got := ids(page); len(got) != 1 || got[0] != "fd_u_done" {
		t.Fatalf("an in-progress session leaked, or the finished one did not appear: %+v", got)
	}
}

func TestYourOwnTrainingIsNotYourFeed(t *testing.T) {
	// The Today tab is where your own sessions live. Mixing them in makes the
	// one question this screen answers impossible to read at a glance.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_ma", "fd_ma_h", true)
	bob := person(t, h.pool, "fd_mb", "fd_mb_h", true)
	befriend(t, h, alice, "fd_ma_h", bob, "fd_mb_h")
	train(t, h, alice, "fd_m_mine", "My own session", true, nil)
	train(t, h, bob, "fd_m_theirs", "Their session", true, nil)

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got := ids(page); len(got) != 1 || got[0] != "fd_m_theirs" {
		t.Fatalf("own training appeared in own feed: %+v", got)
	}
}

// ── What a row carries ───────────────────────────────────────────────────────

func TestTheRowCarriesAHandleAndTheVolumeRule(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_va", "fd_va_h", true)
	bob := person(t, h.pool, "fd_vb", "fd_vb_h", true)
	befriend(t, h, alice, "fd_va_h", bob, "fd_vb_h")

	ex := seedExercise(t, h.pool, "fd_ex_squat")
	five, hundred := 5, 100.0
	ten, twenty := 10, 20.0
	sets := []session.Set{
		// Counts: completed, working.
		{ExerciseID: ex, Reps: &five, WeightKg: &hundred, Completed: true},
		// Does NOT count: a warm-up, even though it was completed.
		{ExerciseID: ex, Reps: &ten, WeightKg: &twenty, Completed: true,
			SetType: session.SetTypeWarmup},
		// Does NOT count: planned but never performed.
		{ExerciseID: ex, Reps: &five, WeightKg: &hundred, Completed: false},
	}
	train(t, h, bob, "fd_v_row", "Squat day", true, sets)

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("list: %+v %v", ids(page), err)
	}
	it := page.Items[0]

	// A HANDLE, never a user id — the rule the whole social API follows.
	if it.From != "fd_vb_h" {
		t.Fatalf("row carries %q as `from`; it must be the handle", it.From)
	}
	if it.From == bob {
		t.Fatalf("the row leaked a user id as the handle")
	}
	if it.Name != "Squat day" || it.Sport != "strength" {
		t.Fatalf("row lost its identity: %+v", it)
	}
	if it.EndedAt.IsZero() {
		t.Fatalf("a feed row must be finished, so ended_at is never zero")
	}

	// **The SQL volume rule against the domain's.** `session.Summarise` is
	// deliberately in Go so both clients agree; this module recomputes it in
	// SQL to avoid an N+1 over other people's training. Comparing them is the
	// only thing that keeps the duplication honest — asserting the SQL against
	// hand-written numbers would let the two drift while both stayed "right".
	full, err := h.sessions.Get(ctx, bob, "fd_v_row")
	if err != nil {
		t.Fatalf("read the session back: %v", err)
	}
	want := session.Summarise(full.Sets)
	if it.WorkingSets != want.WorkingSets {
		t.Fatalf("working sets: feed says %d, Summarise says %d", it.WorkingSets, want.WorkingSets)
	}
	if it.TonnageKg != want.TonnageKg {
		t.Fatalf("tonnage: feed says %v, Summarise says %v", it.TonnageKg, want.TonnageKg)
	}
	// And it is not vacuously equal — the fixture has to have produced work,
	// or two zeroes would satisfy the comparison above.
	if want.WorkingSets != 1 || want.TonnageKg != 500 {
		t.Fatalf("fixture produced no working volume to compare: %+v", want)
	}
}

// ── Ordering and paging ──────────────────────────────────────────────────────

func TestNewestFinishedFirstAndPagingIsStable(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_ga", "fd_ga_h", true)
	bob := person(t, h.pool, "fd_gb", "fd_gb_h", true)
	befriend(t, h, alice, "fd_ga_h", bob, "fd_gb_h")

	// Deliberately finished OUT of the order they were started, because the
	// feed orders by `ended_at`: a session begun first but finished last
	// becomes visible last, and a feed whose rows appear below what you have
	// already scrolled past is a feed that hides things.
	base := time.Now().UTC().Add(-6 * time.Hour)
	for i, id := range []string{"fd_g_1", "fd_g_2", "fd_g_3"} {
		if _, err := h.sessions.Create(ctx, session.NewSession{
			ID: id, UserID: bob, Sport: "strength", Name: id,
			StartedAt: base.Add(time.Duration(i) * time.Minute),
		}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	// fd_g_1 started first and finishes LAST.
	for id, mins := range map[string]int{"fd_g_2": 10, "fd_g_3": 20, "fd_g_1": 30} {
		if _, err := h.sessions.Finish(ctx, bob, id, base.Add(time.Duration(mins)*time.Minute)); err != nil {
			t.Fatalf("finish %s: %v", id, err)
		}
	}

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got := ids(page); len(got) != 3 || got[0] != "fd_g_1" || got[2] != "fd_g_2" {
		t.Fatalf("not newest-FINISHED-first: %+v", got)
	}

	// Paging: two pages, no overlap, no gap.
	first, _ := h.repo.List(ctx, alice, 2, 0)
	second, _ := h.repo.List(ctx, alice, 2, 2)
	if len(first.Items) != 2 || len(second.Items) != 1 {
		t.Fatalf("page sizes: %d and %d", len(first.Items), len(second.Items))
	}
	if first.Total != 3 || second.Total != 3 {
		t.Fatalf("totals disagree with the list: %d, %d", first.Total, second.Total)
	}
	seen := map[string]bool{}
	for _, id := range append(ids(first), ids(second)...) {
		if seen[id] {
			t.Fatalf("id %s appeared on both pages", id)
		}
		seen[id] = true
	}
	if len(seen) != 3 {
		t.Fatalf("paging lost a row: %+v", seen)
	}
}

func TestAnAthleteWithNoFriendsGetsAnEmptyListNotAnError(t *testing.T) {
	// `items` must serialise as [] rather than null, and the short-circuit for
	// an empty friend set must not look like a failure.
	h := newHarness(t)
	alice := person(t, h.pool, "fd_na", "fd_na_h", true)

	page, err := h.repo.List(context.Background(), alice, 30, 0)
	if err != nil {
		t.Fatalf("an empty social graph is not an error: %v", err)
	}
	if page.Items == nil {
		t.Fatalf("items must be an empty slice, never nil")
	}
	if len(page.Items) != 0 || page.Total != 0 {
		t.Fatalf("unexpected rows: %+v", page)
	}
}

func TestClampLimit(t *testing.T) {
	// Pure, and the whole of the paging contract — the handler cannot be
	// tested around it, since `auth`'s context key is unexported and a handler
	// test cannot get past the first line.
	if n, ok := ClampLimit(0); !ok || n != DefaultLimit {
		t.Fatalf("unspecified should take the default: %d %v", n, ok)
	}
	if n, ok := ClampLimit(7); !ok || n != 7 {
		t.Fatalf("a reasonable ask should be honoured: %d %v", n, ok)
	}
	if n, ok := ClampLimit(MaxLimit + 1); !ok || n != MaxLimit {
		t.Fatalf("over the cap should clamp, not fail: %d %v", n, ok)
	}
	// Negative is a client bug. Clamping it to page one would hide that.
	if _, ok := ClampLimit(-1); ok {
		t.Fatalf("a negative limit must be rejected, not clamped")
	}
}

// The TOTAL is counted under the same access rule as the list.
//
// Nothing else here reaches that query. `List` skips the count entirely when a
// first page does not fill — which is every other test in this file — so the
// count can drop the access rule and stay green. Mutated to `SELECT count(*)
// FROM sessions WHERE user_id = ANY($1)` and the whole suite passed.
//
// The failure it hides is not cosmetic: a total larger than the list means a
// client asks for a page that does not exist, and worse, it reports how much
// training a friend has done that the reader is not allowed to see.
func TestTheTotalCountsOnlyWhatTheListWouldReturn(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_ta", "fd_ta_h", true)
	bob := person(t, h.pool, "fd_tb", "fd_tb_h", true)
	befriend(t, h, alice, "fd_ta_h", bob, "fd_tb_h")

	// Three visible, and two that must not be counted: one unfinished, and one
	// belonging to a friend who has not opted in.
	for _, id := range []string{"fd_t_1", "fd_t_2", "fd_t_3"} {
		train(t, h, bob, id, id, true, nil)
	}
	train(t, h, bob, "fd_t_live", "Still going", false, nil)

	dave := person(t, h.pool, "fd_td", "fd_td_h", false)
	befriend(t, h, alice, "fd_ta_h", dave, "fd_td_h")
	train(t, h, dave, "fd_t_private", "Not shared", true, nil)

	// limit < visible, so the page FILLS and the count query actually runs.
	page, err := h.repo.List(ctx, alice, 2, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("the page must fill, or the count is skipped and this proves nothing: %+v", ids(page))
	}
	if page.Total != 3 {
		t.Fatalf("total is %d, want 3 — the count is not applying the access rule "+
			"(an unfinished session and an opted-out friend's are being counted)", page.Total)
	}
}

// The friendship lookup works in BOTH directions of the canonical pair.
//
// `friendships` stores one row per pair with `user_a < user_b`, so `FriendIDs`
// has to pick the opposite column depending on which side the caller is on.
// Every other test here happens to have the caller sort FIRST (`fd_sa` before
// `fd_sc`, and `pairOf` is lexical), so the `ELSE user_a` arm — roughly half of
// all real callers — was never executed by anything, in this package or in the
// friend module's own suite. A directional bug there renders the feed silently
// empty for those athletes and nothing goes red.
func TestTheFeedWorksWhicheverSideOfThePairYouAreOn(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	// `fd_zz` sorts AFTER `fd_aa`, so the caller is `user_b` in the stored row.
	later := person(t, h.pool, "fd_zz_caller", "fd_zz_h", true)
	earlier := person(t, h.pool, "fd_aa_friend", "fd_aa_h", true)
	if later <= earlier {
		t.Fatalf("fixture does not exercise the other arm: %q must sort after %q", later, earlier)
	}
	befriend(t, h, later, "fd_zz_h", earlier, "fd_aa_h")
	train(t, h, earlier, "fd_pair_theirs", "Their session", true, nil)

	page, err := h.repo.List(ctx, later, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got := ids(page); len(got) != 1 || got[0] != "fd_pair_theirs" {
		t.Fatalf("the caller is user_b in the stored pair and saw nothing: %+v", got)
	}
}
