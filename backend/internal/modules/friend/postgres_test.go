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
	reqs, _ := repo.Pending(ctx, mallory)
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
	if friends, _ := repo.Friends(ctx, bob); len(friends) != 0 {
		t.Fatalf("unfriend is symmetric, bob still has: %+v", friends)
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
