package friend

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

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

// person seeds a profile with a claimed handle and cleans up its rows AND any
// friendships it participates in.
func person(t *testing.T, pool *pgxpool.Pool, id, handle string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO profiles (user_id, username) VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET username = $2`, id, handle); err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM friendships WHERE user_a = $1 OR user_b = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM profiles WHERE user_id = $1`, id)
	})
	return id
}

func TestRequestAcceptRoundTrip(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	alice := person(t, pool, "fr_alice", "fr_alice_h")
	bob := person(t, pool, "fr_bob", "fr_bob_h")

	if err := repo.Send(ctx, alice, "fr_bob_h"); err != nil {
		t.Fatalf("send: %v", err)
	}

	// Bob's inbox has Alice; Alice's outbox has Bob; neither is friends yet.
	reqs, err := repo.Pending(ctx, bob)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(reqs.Incoming) != 1 || reqs.Incoming[0].Username != "fr_alice_h" {
		t.Fatalf("bob's inbox wrong: %+v", reqs)
	}
	if len(reqs.Outgoing) != 0 {
		t.Fatalf("bob has no outgoing: %+v", reqs.Outgoing)
	}
	sent, _ := repo.Pending(ctx, alice)
	if len(sent.Outgoing) != 1 || sent.Outgoing[0].Username != "fr_bob_h" {
		t.Fatalf("alice's outbox wrong: %+v", sent)
	}

	if err := repo.Accept(ctx, bob, "fr_alice_h"); err != nil {
		t.Fatalf("accept: %v", err)
	}
	friends, err := repo.Friends(ctx, alice)
	if err != nil {
		t.Fatalf("friends: %v", err)
	}
	if len(friends) != 1 || friends[0].Username != "fr_bob_h" {
		t.Fatalf("alice's friends wrong: %+v", friends)
	}
	// Symmetric, and the pending lists are drained.
	fb, _ := repo.Friends(ctx, bob)
	if len(fb) != 1 || fb[0].Username != "fr_alice_h" {
		t.Fatalf("bob's friends wrong: %+v", fb)
	}
	left, _ := repo.Pending(ctx, bob)
	if len(left.Incoming)+len(left.Outgoing) != 0 {
		t.Fatalf("pending not drained: %+v", left)
	}
}

func TestCrossingRequestsCollapseToOneRow(t *testing.T) {
	// A asks B while B asks A: the canonical pair makes the second a 409, not
	// a second row — no state where both sit in each other's inboxes.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	alice := person(t, pool, "fr_ca", "fr_ca_h")
	bob := person(t, pool, "fr_cb", "fr_cb_h")

	if err := repo.Send(ctx, alice, "fr_cb_h"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if err := repo.Send(ctx, bob, "fr_ca_h"); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("crossing request: want ErrAlreadyExists, got %v", err)
	}
	// And the duplicate from the same side.
	if err := repo.Send(ctx, alice, "fr_cb_h"); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate request: want ErrAlreadyExists, got %v", err)
	}
}

func TestSenderCannotAcceptOwnRequest(t *testing.T) {
	// Pinned to ErrNotFound, indistinguishable from "no request at all" — a
	// distinct error would confirm to the sender that their request exists.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	alice := person(t, pool, "fr_sa", "fr_sa_h")
	person(t, pool, "fr_sb", "fr_sb_h")

	if err := repo.Send(ctx, alice, "fr_sb_h"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if err := repo.Accept(ctx, alice, "fr_sb_h"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("self-accept: want ErrNotFound, got %v", err)
	}
}

func TestOutsiderSeesAndTouchesNothing(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	alice := person(t, pool, "fr_oa", "fr_oa_h")
	person(t, pool, "fr_ob", "fr_ob_h")
	mallory := person(t, pool, "fr_om", "fr_om_h")

	if err := repo.Send(ctx, alice, "fr_ob_h"); err != nil {
		t.Fatalf("send: %v", err)
	}
	// Mallory cannot accept a request between two other people…
	if err := repo.Accept(ctx, mallory, "fr_oa_h"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider accept: want ErrNotFound, got %v", err)
	}
	// …cannot remove their relationship…
	if err := repo.Remove(ctx, mallory, "fr_oa_h"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider remove: want ErrNotFound, got %v", err)
	}
	// …and sees none of it.
	reqs, err := repo.Pending(ctx, mallory)
	if err != nil {
		// Not pedantry: the zero value is an EMPTY inbox, so an ignored error
		// makes "the outsider sees nothing" pass by failing.
		t.Fatalf("mallory's pending: %v", err)
	}
	if len(reqs.Incoming)+len(reqs.Outgoing) != 0 {
		t.Fatalf("outsider sees pending rows: %+v", reqs)
	}
	// The original request is untouched by the failed meddling.
	reqs, _ = repo.Pending(ctx, alice)
	if len(reqs.Outgoing) != 1 {
		t.Fatalf("request was disturbed: %+v", reqs)
	}
}

func TestDeclineDeletesAndAllowsReRequest(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	alice := person(t, pool, "fr_da", "fr_da_h")
	bob := person(t, pool, "fr_db", "fr_db_h")

	if err := repo.Send(ctx, alice, "fr_db_h"); err != nil {
		t.Fatalf("send: %v", err)
	}
	// Bob declines — Remove from the recipient's side.
	if err := repo.Remove(ctx, bob, "fr_da_h"); err != nil {
		t.Fatalf("decline: %v", err)
	}
	// DECLINE IS DELETE: re-requesting works. The harassment residual this
	// creates is recorded in the migration and history, not hidden.
	if err := repo.Send(ctx, alice, "fr_db_h"); err != nil {
		t.Fatalf("re-request after decline: %v", err)
	}
}

func TestUnfriendAndUnnamedAndSelf(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	alice := person(t, pool, "fr_ua", "fr_ua_h")
	bob := person(t, pool, "fr_ub", "fr_ub_h")

	if err := repo.Send(ctx, alice, "fr_ub_h"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if err := repo.Accept(ctx, bob, "fr_ua_h"); err != nil {
		t.Fatalf("accept: %v", err)
	}
	if err := repo.Remove(ctx, alice, "fr_ub_h"); err != nil {
		t.Fatalf("unfriend: %v", err)
	}
	fb, err := repo.Friends(ctx, bob)
	if err != nil {
		t.Fatalf("bob's friends after unfriend: %v", err)
	}
	if len(fb) != 0 {
		t.Fatalf("unfriend is symmetric, bob still has: %+v", fb)
	}

	// A caller with no handle cannot send — the inbox would show nothing.
	ctxNoName := person(t, pool, "fr_unnamed", "fr_tmp_h")
	if _, err := pool.Exec(ctx, `UPDATE profiles SET username = NULL WHERE user_id = $1`, ctxNoName); err != nil {
		t.Fatalf("unset handle: %v", err)
	}
	if err := repo.Send(ctx, ctxNoName, "fr_ua_h"); !errors.Is(err, ErrNoUsername) {
		t.Fatalf("unnamed sender: want ErrNoUsername, got %v", err)
	}

	// Self-request is a 400-class error, not a row.
	if err := repo.Send(ctx, alice, "fr_ua_h"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("self request: want ErrInvalidInput, got %v", err)
	}

	// A target that does not exist is a plain not-found.
	if err := repo.Send(ctx, alice, "nobody_by_this_name"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("absent target: want ErrNotFound, got %v", err)
	}
}

func TestRenamePropagatesToInbox(t *testing.T) {
	// Cards join profiles LIVE rather than denormalising the handle, so a
	// rename shows immediately. This is the test that goes red if someone
	// "optimises" the join into a stored column.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	alice := person(t, pool, "fr_ra", "fr_ra_old")
	bob := person(t, pool, "fr_rb", "fr_rb_h")

	if err := repo.Send(ctx, alice, "fr_rb_h"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE profiles SET username = 'fr_ra_new' WHERE user_id = $1`, alice); err != nil {
		t.Fatalf("rename: %v", err)
	}
	reqs, err := repo.Pending(ctx, bob)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(reqs.Incoming) != 1 || reqs.Incoming[0].Username != "fr_ra_new" {
		t.Fatalf("rename did not propagate: %+v", reqs.Incoming)
	}
}

// The `status = 'pending'` half of Accept's WHERE had no test: the reviewer
// deleted it and all seven stayed green. It is load-bearing for a quiet
// reason — re-accepting an ALREADY accepted friendship would return success
// and re-stamp accepted_at, silently rewriting the "friends since" date every
// list renders. So: accept twice, and the second must be indistinguishable
// from a request that was never there.
func TestReAcceptIsNotFoundAndLeavesSinceAlone(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo := NewPostgresRepository(pool)

	alice := person(t, pool, "fr_re_alice", "fr_re_alice_h")
	bob := person(t, pool, "fr_re_bob", "fr_re_bob_h")

	if err := repo.Send(ctx, alice, "fr_re_bob_h"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if err := repo.Accept(ctx, bob, "fr_re_alice_h"); err != nil {
		t.Fatalf("accept: %v", err)
	}
	before, err := repo.Friends(ctx, bob)
	if err != nil || len(before) != 1 {
		t.Fatalf("friends after accept: %+v %v", before, err)
	}

	// Same recipient, same pair, already accepted.
	if err := repo.Accept(ctx, bob, "fr_re_alice_h"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("re-accept should be ErrNotFound, got %v", err)
	}
	// And the sender re-accepting is the same miss, for the same reason.
	if err := repo.Accept(ctx, alice, "fr_re_bob_h"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("sender re-accept should be ErrNotFound, got %v", err)
	}

	after, err := repo.Friends(ctx, bob)
	if err != nil || len(after) != 1 {
		t.Fatalf("friends after re-accept: %+v %v", after, err)
	}
	if !after[0].Since.Equal(before[0].Since) {
		t.Fatalf("accepted_at moved: %v -> %v", before[0].Since, after[0].Since)
	}
}

// The badge count is INCOMING only.
//
// An outgoing request is `status='pending'` too, and counting it would send
// somebody to the Friends screen to look at something they already did. The
// distinction is one predicate — `requested_by <> $1` — and it is the whole
// thing this test exists for.
func TestPendingCountIsIncomingOnly(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo := NewPostgresRepository(pool)

	me := person(t, pool, "fr_pc_me", "fr_pc_me_h")
	asker := person(t, pool, "fr_pc_ask", "fr_pc_ask_h")
	asked := person(t, pool, "fr_pc_asked", "fr_pc_asked_h")
	friend := person(t, pool, "fr_pc_fr", "fr_pc_fr_h")

	// Someone asked me: counts.
	if err := repo.Send(ctx, asker, "fr_pc_me_h"); err != nil {
		t.Fatalf("incoming: %v", err)
	}
	// I asked someone: must NOT count.
	if err := repo.Send(ctx, me, "fr_pc_asked_h"); err != nil {
		t.Fatalf("outgoing: %v", err)
	}
	// An accepted friendship: must not count either.
	if err := repo.Send(ctx, friend, "fr_pc_me_h"); err != nil {
		t.Fatalf("to-accept: %v", err)
	}
	if err := repo.Accept(ctx, me, "fr_pc_fr_h"); err != nil {
		t.Fatalf("accept: %v", err)
	}

	n, err := repo.PendingCount(ctx, me)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("want 1 incoming request, got %d", n)
	}
	// And the person I asked sees exactly one waiting on them — the mirror,
	// which goes red if the predicate is inverted rather than merely dropped.
	if n, err := repo.PendingCount(ctx, asked); err != nil || n != 1 {
		t.Fatalf("the person I asked should have 1 waiting, got %d (%v)", n, err)
	}
	// An outsider has nothing.
	if n, err := repo.PendingCount(ctx, asker); err != nil || n != 0 {
		t.Fatalf("the asker has nothing waiting on them, got %d (%v)", n, err)
	}
}
