package feed

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/modules/friend"
	"github.com/dmytro-ch21/vola/backend/internal/modules/session"
	"github.com/dmytro-ch21/vola/backend/internal/modules/sessioncard"
)

// NOTE ON THE IMPORTS. The `feed` package must never import `friend` or
// `session` — that inversion is the module's architecture. This TEST imports
// both, deliberately: it wires the same pairing `cmd/api/main.go` does, and it
// compares the SQL volume rule against `session.Summarise`, which is the only
// way to know the duplication has not drifted. A test against a stub would
// show only that the stub agrees with itself. `sessioncard` is imported for
// the same reason and only here — one client component renders both packages'
// `Detail`, so the wire shapes are pinned against each other rather than
// against a comment.
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
	return seedExerciseAs(t, pool, id, "total")
}

// seedExerciseAs seeds a catalog row with an explicit load_mode.
//
// It exists because `seedExercise` inserted without one, so every fixture in
// this file took the column default of 'total' — and the feed's volume query
// could have lost its per-side CASE entirely with the whole suite still green.
// That is exactly the trap the session module's parity test names: both sides
// agree trivially at a factor of one, and the comment claiming they were
// compared kept being true while meaning nothing.
func seedExerciseAs(t *testing.T, pool *pgxpool.Pool, id, loadMode string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status, load_mode)
		VALUES ($1, $1, 'strength', 'squat', 'weight_reps', 'published', $2)
		ON CONFLICT (id) DO UPDATE SET load_mode = EXCLUDED.load_mode`, id, loadMode); err != nil {
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
		// Counts toward TONNAGE but not toward the set count. Without a drop
		// here the feed's two rules are indistinguishable and a query using the
		// wrong one passes green — the same trap the session module's parity
		// fixture had to close.
		{ExerciseID: ex, Reps: &ten, WeightKg: &twenty, Completed: true,
			SetType: session.SetTypeDrop},
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
	//
	// ONE set and 700 kg is the pair that matters: 5x100 from the working set
	// plus 10x20 from the DROP, which adds its 200 to the tonnage and adds no
	// set. Written literally rather than computed, because a computed
	// expectation applies whatever rule the code applies and agrees with a bug.
	if want.WorkingSets != 1 || want.TonnageKg != 700 || want.TotalReps != 15 {
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

// ── The detail band: a second opt-in, and what it must not carry ─────────────

// wantsDetail flips the narrower switch. Separate from `person` on purpose:
// every existing test in this file was written against a feed that had no
// detail at all, and they must keep passing unchanged — which they only do if
// the new column defaults off and nothing seeds it silently.
func wantsDetail(t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE profiles SET share_training_details = true WHERE user_id = $1`, id); err != nil {
		t.Fatalf("set share_training_details for %s: %v", id, err)
	}
}

func TestDetailNeedsItsSecondOptIn(t *testing.T) {
	// The whole point of two switches. Bob is in the feed — master switch on,
	// accepted friend, finished session — and the numbers must arrive while the
	// exercise names do not.
	//
	// **BOTH HALVES IN ONE TEST, deliberately.** A negative-only test passes
	// against a feed that never attaches detail to anybody, which is exactly
	// the state this code was in yesterday; asserting the flag flips the
	// outcome is what makes it a test of the flag.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_da", "fd_da_h", true)
	bob := person(t, h.pool, "fd_db", "fd_db_h", true)
	befriend(t, h, alice, "fd_da_h", bob, "fd_db_h")
	ex := seedExercise(t, h.pool, "fd_d_squat")
	train(t, h, bob, "fd_d_s1", "Lower", true, []session.Set{
		{ExerciseID: ex, Position: 1, SetType: session.SetTypeWorking, Reps: iptr(5), WeightKg: fptr(140), Completed: true},
		{ExerciseID: ex, Position: 2, SetType: session.SetTypeWorking, Reps: iptr(8), WeightKg: fptr(100), Completed: true},
	})

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("want bob's session in the feed, got %+v", ids(page))
	}
	if got := page.Items[0].WorkingSets; got != 2 {
		t.Fatalf("the numbers should arrive regardless of the detail switch: working_sets = %d", got)
	}
	if d := page.Items[0].Detail; len(d) != 0 {
		t.Fatalf("detail crossed the wire without its opt-in: %+v", d)
	}

	wantsDetail(t, h.pool, bob)
	page, err = h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list after opting in: %v", err)
	}
	if len(page.Items) != 1 || len(page.Items[0].Detail) != 1 {
		t.Fatalf("opting in did not attach the detail: %+v", page.Items)
	}
	// The TOP set, paired with the reps done AT that weight. `MAX(reps)` would
	// say "140 kg × 8" — a set nobody performed.
	if got := page.Items[0].Detail[0]; got.Name != ex || got.Figure != "140 kg × 5" {
		t.Fatalf("wrong top set: %+v", got)
	}
}

func TestOneFriendsDetailSwitchDoesNotSpeakForAnother(t *testing.T) {
	// The flag is read per OWNER, per row. A page-level "does anyone want
	// detail" read would publish the whole page's exercises the moment one
	// friend opted in, and the shape that produces it (hoisting the flag out
	// of the row loop) is an easy simplification to make.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_ma", "fd_ma_h", true)
	open := person(t, h.pool, "fd_mo", "fd_mo_h", true)
	shy := person(t, h.pool, "fd_ms", "fd_ms_h", true)
	befriend(t, h, alice, "fd_ma_h", open, "fd_mo_h")
	befriend(t, h, alice, "fd_ma_h", shy, "fd_ms_h")
	wantsDetail(t, h.pool, open)
	ex := seedExercise(t, h.pool, "fd_m_squat")
	set := []session.Set{
		{ExerciseID: ex, Position: 1, SetType: session.SetTypeWorking, Reps: iptr(5), WeightKg: fptr(100), Completed: true},
	}
	train(t, h, open, "fd_m_open", "Open", true, set)
	train(t, h, shy, "fd_m_shy", "Shy", true, set)

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("want both sessions, got %+v", ids(page))
	}
	for _, it := range page.Items {
		switch it.ID {
		case "fd_m_open":
			if len(it.Detail) != 1 {
				t.Fatalf("the opted-in friend's detail is missing: %+v", it)
			}
		case "fd_m_shy":
			if len(it.Detail) != 0 {
				t.Fatalf("another athlete's switch published this one's session: %+v", it)
			}
		}
	}
}

func TestDetailIsCappedAndTheRestIsCounted(t *testing.T) {
	// "+4 more" is what stops a five-line card implying a five-exercise
	// session. The cap is server-side, so an opted-in athlete's whole
	// programme never crosses the wire to be trimmed on somebody else's phone.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_ca", "fd_ca_h", true)
	bob := person(t, h.pool, "fd_cb", "fd_cb_h", true)
	befriend(t, h, alice, "fd_ca_h", bob, "fd_cb_h")
	wantsDetail(t, h.pool, bob)

	sets := []session.Set{}
	for i := 0; i < MaxDetail+3; i++ {
		ex := seedExercise(t, h.pool, fmt.Sprintf("fd_c_ex%d", i))
		sets = append(sets, session.Set{
			ExerciseID: ex, Position: i + 1, SetType: session.SetTypeWorking,
			Reps: iptr(5), WeightKg: fptr(60), Completed: true,
		})
	}
	train(t, h, bob, "fd_c_s1", "Everything", true, sets)

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("want one session, got %+v", ids(page))
	}
	it := page.Items[0]
	if len(it.Detail) != MaxDetail {
		t.Fatalf("cap not applied: got %d lines, want %d", len(it.Detail), MaxDetail)
	}
	if it.More != 3 {
		t.Fatalf("the uncapped remainder was not counted: more = %d, want 3", it.More)
	}
}

func TestWhatWasDoneToYouIsNotPublished(t *testing.T) {
	// `conceded` is the most valuable half of the BJJ schema and the one thing
	// the feed must not carry: your own card reviews what you got caught in,
	// a friend's feed is not where that goes. This is the one screen where the
	// athlete is not the reader.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_ba", "fd_ba_h", true)
	bob := person(t, h.pool, "fd_bb", "fd_bb_h", true)
	befriend(t, h, alice, "fd_ba_h", bob, "fd_bb_h")
	wantsDetail(t, h.pool, bob)

	landed := seedTechnique(t, h.pool, "fd_b_armbar")
	caught := seedTechnique(t, h.pool, "fd_b_triangle")
	rollID := "fd_b_roll"
	started := time.Now().UTC().Add(-time.Hour)
	if _, err := h.sessions.Create(ctx, session.NewSession{
		ID: rollID, UserID: bob, Sport: "bjj", Name: "Open mat", StartedAt: started,
	}); err != nil {
		t.Fatalf("create bjj session: %v", err)
	}
	for _, tag := range []struct {
		technique, event string
		count            int
	}{
		{landed, "scored", 3},
		{caught, "conceded", 2},
	} {
		if _, err := h.pool.Exec(ctx, `
			INSERT INTO bjj_session_tags (session_id, user_id, category, event, technique_id, count)
			VALUES ($1, $2, 'submission', $3, $4, $5)`,
			rollID, bob, tag.event, tag.technique, tag.count); err != nil {
			t.Fatalf("tag %s: %v", tag.event, err)
		}
	}
	if _, err := h.sessions.Finish(ctx, bob, rollID, started.Add(90*time.Minute)); err != nil {
		t.Fatalf("finish roll: %v", err)
	}

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("want the roll in the feed, got %+v", ids(page))
	}
	it := page.Items[0]
	if len(it.Detail) != 1 {
		t.Fatalf("want exactly the scored technique, got %+v", it.Detail)
	}
	if it.Detail[0].Name != landed || it.Detail[0].Outcome != "scored" || it.Detail[0].Count != 3 {
		t.Fatalf("wrong technique line: %+v", it.Detail[0])
	}
	if it.More != 0 {
		// A `conceded` row counted into `more` would publish that it happened
		// while pretending not to name it — worse than either honest option.
		t.Fatalf("a concealed outcome leaked through the count: more = %d", it.More)
	}
}

// seedTechnique owns the library row this file depends on, following the rule
// the rest of the repo settled on after `exercise`'s catalog seeding made
// three packages pass only under `-p 1` in the right order.
func seedTechnique(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO techniques (id, name, category, position, function)
		VALUES ($1, $1, 'Submission', 'Guard - Bottom', 'finish')
		ON CONFLICT (id) DO NOTHING`, id); err != nil {
		t.Fatalf("seed technique %s: %v", id, err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM techniques WHERE id = $1`, id) })
	return id
}

func iptr(v int) *int         { return &v }
func fptr(v float64) *float64 { return &v }

// TestDetailMatchesTheCardsWireShape pins the one duplication this module
// chose to accept.
//
// `feed.Detail` and `sessioncard.Detail` are separate Go types because modules
// here do not import each other — but ONE mobile component renders both, so
// the JSON has to be identical. A comment saying so is not enforcement; this
// is. Add a field to either struct without the other and it goes red.
//
// NO DATABASE, so it runs on every machine rather than only where
// TEST_DATABASE_URL is set. That matters: the drift it guards against is a
// one-line edit somebody makes while the integration tests are skipping.
func TestDetailMatchesTheCardsWireShape(t *testing.T) {
	mine, err := json.Marshal(Detail{Name: "Back Squat", Figure: "140 kg × 5", Outcome: "scored", Count: 3})
	if err != nil {
		t.Fatalf("marshal feed detail: %v", err)
	}
	theirs, err := json.Marshal(sessioncard.Detail{
		Name: "Back Squat", Figure: "140 kg × 5", Outcome: "scored", Count: 3,
	})
	if err != nil {
		t.Fatalf("marshal card detail: %v", err)
	}
	if string(mine) != string(theirs) {
		t.Fatalf("the feed and the card disagree about a Detail on the wire:\n feed: %s\n card: %s",
			mine, theirs)
	}

	// And the empty case, which is where `omitempty` drift shows up: a field
	// the card omits and the feed sends as "" renders as a blank line rather
	// than no line, and only an empty value catches it.
	mine, err = json.Marshal(Detail{Name: "Roll"})
	if err != nil {
		t.Fatalf("marshal empty feed detail: %v", err)
	}
	theirs, err = json.Marshal(sessioncard.Detail{Name: "Roll"})
	if err != nil {
		t.Fatalf("marshal empty card detail: %v", err)
	}
	if string(mine) != string(theirs) {
		t.Fatalf("the two disagree once fields are empty:\n feed: %s\n card: %s", mine, theirs)
	}

	// The caps have to agree too — the client trims to whatever it is given,
	// so a feed that sent eight lines where the card sends five would silently
	// render a different card in the two places.
	if MaxDetail != sessioncard.MaxDetail {
		t.Fatalf("detail caps diverged: feed %d, card %d", MaxDetail, sessioncard.MaxDetail)
	}
}

func TestAFriendsDetailUsesTheOneDefinitionOfAWorkingSet(t *testing.T) {
	// The same rule `workingVolume` uses two functions above, and the same one
	// `session.Summarise` defines: `completed AND set_type <> 'warmup'`.
	//
	// The detail query said `set_type = 'working'` first, which was wrong in
	// both directions. A template opens with every set `completed = false`, so
	// a PLANNED set could be published as somebody's top lift — on the one
	// surface where the reader has no way to know it never happened. And an
	// exercise trained only on an AMRAP set vanished from the band while still
	// counting in `working_sets` and `tonnage_kg` on the very same row.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_wa", "fd_wa_h", true)
	bob := person(t, h.pool, "fd_wb", "fd_wb_h", true)
	befriend(t, h, alice, "fd_wa_h", bob, "fd_wb_h")
	wantsDetail(t, h.pool, bob)

	squat := seedExercise(t, h.pool, "fd_w_squat")
	row := seedExercise(t, h.pool, "fd_w_row")
	train(t, h, bob, "fd_w_s1", "Lower", true, []session.Set{
		{ExerciseID: squat, Position: 1, SetType: session.SetTypeWorking,
			Reps: iptr(5), WeightKg: fptr(120), Completed: true},
		// Planned, heavier than anything performed, never done.
		{ExerciseID: squat, Position: 2, SetType: session.SetTypeWorking,
			Reps: iptr(1), WeightKg: fptr(200), Completed: false},
		// An AMRAP finisher — performed, not a warm-up, so a working set.
		{ExerciseID: row, Position: 3, SetType: session.SetTypeAMRAP,
			Reps: iptr(20), WeightKg: fptr(60), Completed: true},
	})

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("want one session, got %+v", ids(page))
	}
	figures := map[string]string{}
	for _, d := range page.Items[0].Detail {
		figures[d.Name] = d.Figure
	}
	if got := figures[squat]; got != "120 kg × 5" {
		t.Fatalf("published %q — a planned set nobody performed reached a friend's feed", got)
	}
	if got, ok := figures[row]; !ok {
		t.Fatalf("an exercise trained on an AMRAP set is missing: %+v", page.Items[0].Detail)
	} else if got != "60 kg × 20" {
		t.Fatalf("AMRAP figure %q", got)
	}
	// And the band agrees with the numbers beside it on the same row — the
	// divergence this rule exists to prevent.
	if page.Items[0].WorkingSets != len(page.Items[0].Detail) {
		t.Fatalf("the row counts %d working sets but names %d exercises; one set per exercise "+
			"was logged, so these must agree",
			page.Items[0].WorkingSets, len(page.Items[0].Detail))
	}
}

func TestAFriendsVolumeCountsBothDumbbells(t *testing.T) {
	// The feed computes tonnage in its own SQL — a knowing duplication of
	// `session.Summarise`, kept because the alternative is loading every set of
	// every friend's session on the endpoint most likely to be polled.
	//
	// That duplication is only safe while something checks it, and until this
	// existed nothing did for the load factor: every fixture here seeded an
	// exercise at the default 'total', so the per-side CASE could have been
	// deleted with the whole suite green. A friend's row would then have
	// reported half the work of the session its owner was looking at.
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_lfa", "fd_lfa_h", true)
	bob := person(t, h.pool, "fd_lfb", "fd_lfb_h", true)
	befriend(t, h, alice, "fd_lfa_h", bob, "fd_lfb_h")

	// A PAIR of dumbbells: 30 is one of them.
	db := seedExerciseAs(t, h.pool, "fd_lf_db", "per_side")
	// A barbell, so the test cannot pass by doubling everything.
	bb := seedExerciseAs(t, h.pool, "fd_lf_bb", "total")
	train(t, h, bob, "fd_lf_s1", "Push", true, []session.Set{
		{ExerciseID: db, Position: 1, SetType: session.SetTypeWorking,
			Reps: iptr(10), WeightKg: fptr(30), Completed: true},
		{ExerciseID: bb, Position: 2, SetType: session.SetTypeWorking,
			Reps: iptr(5), WeightKg: fptr(100), Completed: true},
	})

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("want one session, got %+v", ids(page))
	}
	// 10 x 30 x 2 = 600, plus 5 x 100 = 500.
	if got := page.Items[0].TonnageKg; got != 1100 {
		t.Fatalf("tonnage %v, want 1100 — the dumbbell half must count both", got)
	}

	// And it agrees with the domain over the same session, which is the
	// property the duplication actually needs.
	full, err := h.sessions.Get(ctx, bob, "fd_lf_s1")
	if err != nil {
		t.Fatalf("read the session back: %v", err)
	}
	if want := session.Summarise(full.Sets).TonnageKg; page.Items[0].TonnageKg != want {
		t.Fatalf("feed says %v, Summarise says %v", page.Items[0].TonnageKg, want)
	}
}

// TestTheRuleIsSharedNotCopied is the guard that makes N8's refactor mean
// something a year from now.
//
// The pinning test above compares this module's NUMBERS against
// `session.Summarise` over a fixture. That is necessary and not sufficient: it
// passed for months while this file's count included drops and the session
// module's did not, because the fixture had no drop in it. A fixture only
// catches a divergence it happens to contain an example of. It is also
// `TEST_DATABASE_URL`-gated; this one runs everywhere.
//
// **It counts occurrences rather than testing containment, and that is the
// whole design.** `SQLWorkingSet` is a literal PREFIX of `SQLCountsAsSet`, so
// `strings.Contains(workingVolume, SQLWorkingSet)` is satisfied by the count
// subquery alone — the tonnage filter could say anything at all and a
// containment check would still pass. The first version of this test did
// exactly that, and review demonstrated it by swapping the tonnage predicate
// for `SQLCountsAsSet`: the precise "collapse deletes a drop's tonnage" failure
// this module is supposed to be protected against, and the test stayed green.
//
// The arithmetic, on correct code: `SQLWorkingSet` appears twice — once standalone
// as the tonnage filter, once inside `SQLCountsAsSet` — and `SQLCountsAsSet` once.
//
//	correct                                 2 / 1
//	tonnage filter collapsed to countsAsSet  2 / 2  -> fails
//	tonnage filter restated as anything else 1 / 1  -> fails
//	count predicate restated                 1 / 0  -> fails
//
// What it still cannot catch is a VERBATIM re-inline — a hand-typed copy
// identical to the constant is indistinguishable from the constant by any
// string test. That needs the AST, which is a lot of machinery for a rewrite
// that is harmless right up until it drifts, at which point the counts move and
// this fires. Said plainly so nobody reads more safety into it than it has.
func TestTheRuleIsSharedNotCopied(t *testing.T) {
	// Two: the tonnage filter, plus the copy nested inside SQLCountsAsSet.
	if got := strings.Count(workingVolume, session.SQLWorkingSet); got != 2 {
		t.Errorf("expected `session.SQLWorkingSet` twice in workingVolume, found %d — "+
			"the tonnage filter or the count predicate has been restated, or the "+
			"two have collapsed into one rule", got)
	}
	// One: the count predicate, and only the count predicate. Two would mean the
	// tonnage filter had become the narrow rule, silently deleting every drop's
	// weight from the feed.
	if got := strings.Count(workingVolume, session.SQLCountsAsSet); got != 1 {
		t.Errorf("expected `session.SQLCountsAsSet` exactly once in workingVolume, "+
			"found %d — a drop is not a set, but its weight was still moved", got)
	}
	// The per-side doubling, which has no prefix relationship to worry about.
	if !strings.Contains(workingVolume, session.SQLTonnage) {
		t.Error("the per-side doubling is no longer the session module's own SQL — " +
			"a friend's card will report half the work for every dumbbell session")
	}
	// And the asymmetry itself, at the source.
	if session.SQLCountsAsSet == session.SQLWorkingSet {
		t.Fatal("the count and the tonnage rules have become identical; a drop " +
			"is not a set, but its weight was still moved")
	}
}

// TestTheWindowIsASeekNotASift reads the query PLAN, because correctness tests
// cannot see this bug at all.
//
// Every other test in this file passes identically with and without
// `sessions_user_ended_idx` — the rows returned are the same rows. What
// changes is how many are touched to find them, and the old plan touched every
// finished session a friend had EVER logged, then discarded the ones outside
// three days. Measured before the index, on 200k sessions across 500 users:
// 4000 rows fetched, 3919 Rows Removed by Filter, to return 81. The cost grew
// with an athlete's training history rather than with their week, which for a
// "what are my friends doing" query is the one scaling property that is not
// allowed.
//
// So this asserts two things the plan makes visible and nothing else does:
// that the index is the one chosen, and that the 3-day window is an Index Cond
// rather than a Filter. The second is the load-bearing half — a plan can use
// the index for the friend list alone and still sift the window, which is
// precisely what `sessions_user_started_idx` was already doing.
func TestTheWindowIsASeekNotASift(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	me := person(t, h.pool, "plan-me", "planme", true)
	mate := person(t, h.pool, "plan-mate", "planmate", true)
	befriend(t, h, me, "planme", mate, "planmate")

	// Enough history to make a Seq Scan the wrong answer, and skewed the way
	// real training is: a long tail outside the window, a handful inside it.
	// With a few rows Postgres reads the whole table whatever indexes exist,
	// and the test would assert the planner's small-table shortcut instead of
	// the fix.
	if _, err := h.pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, sport, name, started_at, ended_at, created_at, updated_at)
		SELECT gen_random_uuid(), $1, 'strength', 'history '||g,
		       now() - (g || ' hours')::interval,
		       now() - (g || ' hours')::interval + interval '1 hour',
		       now(), now()
		FROM generate_series(1, 4000) g`, mate); err != nil {
		t.Fatalf("seed history: %v", err)
	}
	// `person()` already deletes this user's sessions, but it discards the
	// error. That is tolerable for the handful of rows every other test here
	// seeds and not for 4000: a cleanup that silently fails leaves the next
	// package a table it did not expect. Registered AFTER person()'s, so LIFO
	// runs it FIRST, and it fails the test rather than logging.
	t.Cleanup(func() {
		if _, err := h.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, mate); err != nil {
			t.Errorf("cleanup history: %v", err)
		}
		var left int
		if err := h.pool.QueryRow(ctx,
			`SELECT count(*) FROM sessions WHERE user_id = $1`, mate).Scan(&left); err != nil {
			t.Errorf("verify cleanup: %v", err)
		} else if left != 0 {
			t.Errorf("cleanup left %d sessions behind", left)
		}
	})
	// ANALYZE, or the planner works from stats that predate these rows and
	// picks a plan for a table it thinks is empty.
	if _, err := h.pool.Exec(ctx, `ANALYZE sessions`); err != nil {
		t.Fatalf("analyze: %v", err)
	}

	// The repository's OWN SQL — see pageQuery. A restated query here would
	// only prove the restatement is fast.
	since := time.Now().UTC().Add(-FeedWindow)
	rows, err := h.pool.Query(ctx,
		"EXPLAIN (ANALYZE, COSTS OFF) "+pageQuery,
		[]string{mate}, since, 20, 0)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	defer rows.Close()
	var plan strings.Builder
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatalf("scan plan: %v", err)
		}
		plan.WriteString(line)
		plan.WriteString("\n")
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("plan rows: %v", err)
	}
	got := plan.String()

	if !strings.Contains(got, "sessions_user_ended_idx") {
		t.Errorf("the feed is not using sessions_user_ended_idx; plan was:\n%s", got)
	}

	// BOTH halves of the index have to be doing work, and each fails in its own
	// direction. Asserting only one of them is not a weaker guard, it is a
	// guard that blesses the opposite bug:
	//
	//   - lose `ended_at`  → the friend list seeks, the WINDOW sifts. Every
	//     friend's lifetime is read. This is the bug the index was added for.
	//   - lose `user_id`   → the window seeks, the FRIEND LIST sifts. Every
	//     user on the platform's last three days is read and thinned down to
	//     your friends — cost proportional to how busy VOLA is, which is worse
	//     than the original as the product grows.
	//
	// The second was found by review, against an earlier version of this test
	// that checked the window only: an index named `sessions_user_ended_idx` on
	// `(ended_at DESC)` alone passed all three of its assertions. Reproduced
	// before fixing.
	//
	// Both are therefore expressed the same way: the column must appear in an
	// `Index Cond:` and must NOT appear in a `Filter:`.
	//
	// Matched on the line's PREFIX, not with Contains, because `Join Filter:`
	// and `Rows Removed by Filter:` both contain "Filter:" and neither means
	// the predicate was sifted at this node.
	filtered := func(col string) bool {
		for _, line := range strings.Split(got, "\n") {
			l := strings.TrimSpace(line)
			if strings.HasPrefix(l, "Filter:") && strings.Contains(l, col) {
				return true
			}
		}
		return false
	}
	indexed := func(col string) bool {
		for _, line := range strings.Split(got, "\n") {
			l := strings.TrimSpace(line)
			// Bitmap plans print `Recheck Cond:` on the heap node and
			// `Index Cond:` on the index node; the index node is the one that
			// proves a seek, so only that prefix counts.
			if strings.HasPrefix(l, "Index Cond:") && strings.Contains(l, col) {
				return true
			}
		}
		return false
	}

	if filtered("ended_at") {
		t.Errorf("the 3-day window is a Filter, not a seek — every lifetime row is being read:\n%s", got)
	}
	if !indexed("ended_at") {
		t.Errorf("no Index Cond carries ended_at; the window is not a boundary seek:\n%s", got)
	}
	// NOT "user_id appears in some Index Cond" — the join's own probe into
	// profiles prints `Index Cond: (user_id = s.user_id)` and would satisfy
	// that even when the sessions scan is sifting. Only its ABSENCE from every
	// Filter distinguishes the two plans.
	if filtered("user_id") {
		t.Errorf("the friend list is a Filter — every user's window is being read, not just your friends':\n%s", got)
	}
}
