package share

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/modules/friend"
	"github.com/dmytro-ch21/vola/backend/internal/modules/sequence"
)

// NOTE ON THE IMPORTS. The share package itself must never import sequence or
// friend — that rule is the module's whole architecture. This TEST imports
// both, deliberately, because it wires the same registry cmd/api/main.go does
// and a test against a stub registry would prove only that the stub works.
// The dependency the rule forbids is a compile-time one in shipped code; a
// test assembling the real pairing is the thing that shows the pairing holds.

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

// harness builds the real wiring: the sequence repo as the registered Copier,
// the friend repo as the friendship test.
type harness struct {
	pool  *pgxpool.Pool
	repo  *PostgresRepository
	seqs  *sequence.PostgresRepository
	frnds *friend.PostgresRepository
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	pool := testPool(t)
	seqs := sequence.NewPostgresRepository(pool)
	frnds := friend.NewPostgresRepository(pool)
	reg := Registry{"sequence": seqs}
	return &harness{pool: pool, repo: NewPostgresRepository(pool, reg, frnds), seqs: seqs, frnds: frnds}
}

func person(t *testing.T, pool *pgxpool.Pool, id, handle string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO profiles (user_id, username) VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET username = $2`, id, handle); err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM shares WHERE from_user_id = $1 OR to_user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM bjj_sequences WHERE owner_user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM friendships WHERE user_a = $1 OR user_b = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM profiles WHERE user_id = $1`, id)
	})
	return id
}

// befriend puts two people in the accepted state through the real friend
// module, so the test cannot pass against a friendship shape the module would
// never produce.
func befriend(t *testing.T, h *harness, a, aHandle, b, bHandle string) {
	t.Helper()
	ctx := context.Background()
	if err := h.frnds.Send(ctx, a, bHandle); err != nil {
		t.Fatalf("send request: %v", err)
	}
	if err := h.frnds.Accept(ctx, b, aHandle); err != nil {
		t.Fatalf("accept request: %v", err)
	}
}

// techniqueIDs borrows two real library rows — bjj_sequence_steps.technique_id
// is a foreign key, so invented ids cannot be inserted.
func techniqueIDs(t *testing.T, pool *pgxpool.Pool, n int) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT id FROM techniques ORDER BY id LIMIT $1`, n)
	if err != nil {
		t.Fatalf("techniques: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan technique: %v", err)
		}
		out = append(out, id)
	}
	if len(out) < n {
		t.Skipf("library has %d techniques, need %d", len(out), n)
	}
	return out
}

func makeSequence(t *testing.T, h *harness, owner, name string) sequence.Sequence {
	t.Helper()
	ids := techniqueIDs(t, h.pool, 2)
	seq, err := h.seqs.Create(context.Background(), owner, sequence.NewSequence{
		Name:        name,
		Description: "as taught",
		Steps: []sequence.NewStep{
			{TechniqueID: ids[0], Notes: "first"},
			{TechniqueID: ids[1], Notes: "second"},
		},
	})
	if err != nil {
		t.Fatalf("create sequence: %v", err)
	}
	return seq
}

func TestShareAcceptProducesAnIndependentCopy(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_ia", "sh_ia_h")
	bob := person(t, h.pool, "sh_ib", "sh_ib_h")
	befriend(t, h, alice, "sh_ia_h", bob, "sh_ib_h")
	seq := makeSequence(t, h, alice, "Knee cut chain")

	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_ib_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
		t.Fatalf("share: %v", err)
	}
	inbox, err := h.repo.Inbox(ctx, bob)
	if err != nil || len(inbox) != 1 {
		t.Fatalf("bob's inbox: %+v %v", inbox, err)
	}
	if inbox[0].From != "sh_ia_h" || inbox[0].ResourceLabel != "Knee cut chain" {
		t.Fatalf("card wrong: %+v", inbox[0])
	}

	got, err := h.repo.Accept(ctx, bob, inbox[0].ID)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	// A NEW id in the RECIPIENT's ownership — never the sender's row.
	if got.ResourceID == seq.ID {
		t.Fatalf("accept handed back the sender's own id: %s", got.ResourceID)
	}
	copied, err := h.seqs.Get(ctx, got.ResourceID, bob)
	if err != nil {
		t.Fatalf("bob cannot read his copy: %v", err)
	}
	if copied.Name != "Knee cut chain" || len(copied.Steps) != 2 {
		t.Fatalf("copy is not the chain: %+v", copied)
	}
	if copied.Steps[0].Notes != "first" || copied.Steps[1].Notes != "second" {
		t.Fatalf("steps did not copy in order: %+v", copied.Steps)
	}

	// SNAPSHOT SEMANTICS, the property the whole design exists for: the
	// sender's later edits do not reach the recipient, and deleting the
	// original does not take the copy with it.
	newName := "Renamed after sharing"
	if _, err := h.seqs.Update(ctx, seq.ID, alice, sequence.Update{Name: &newName, Steps: []sequence.NewStep{}}); err != nil {
		t.Fatalf("sender edit: %v", err)
	}
	if err := h.seqs.Delete(ctx, seq.ID, alice); err != nil {
		t.Fatalf("sender delete: %v", err)
	}
	still, err := h.seqs.Get(ctx, got.ResourceID, bob)
	if err != nil {
		t.Fatalf("copy did not survive the original: %v", err)
	}
	if still.Name != "Knee cut chain" || len(still.Steps) != 2 {
		t.Fatalf("sender's edits reached the copy: %+v", still)
	}
	// And the inbox is drained.
	if after, _ := h.repo.Inbox(ctx, bob); len(after) != 0 {
		t.Fatalf("accepted share still pending: %+v", after)
	}
}

func TestShareOnlyReachesFriends(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_fa", "sh_fa_h")
	person(t, h.pool, "sh_fb", "sh_fb_h") // a real account, not a friend
	seq := makeSequence(t, h, alice, "Not for strangers")

	// A stranger, a pending-but-unaccepted request, and a handle that does not
	// exist must all be the SAME miss — otherwise sharing answers questions
	// the friends API deliberately refuses to.
	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_fb_h", ResourceType: "sequence", ResourceID: seq.ID}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("share to non-friend: want ErrNotFound, got %v", err)
	}
	if err := h.frnds.Send(ctx, alice, "sh_fb_h"); err != nil {
		t.Fatalf("request: %v", err)
	}
	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_fb_h", ResourceType: "sequence", ResourceID: seq.ID}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("share to pending friend: want ErrNotFound, got %v", err)
	}
	if err := h.repo.Create(ctx, alice, New{ToUsername: "nobody_at_all", ResourceType: "sequence", ResourceID: seq.ID}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("share to absent handle: want ErrNotFound, got %v", err)
	}
}

func TestCannotShareWhatYouCannotSee(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_va", "sh_va_h")
	bob := person(t, h.pool, "sh_vb", "sh_vb_h")
	carol := person(t, h.pool, "sh_vc", "sh_vc_h")
	befriend(t, h, alice, "sh_va_h", bob, "sh_vb_h")
	// Carol's chain. Alice is friends with Bob but has no business passing on
	// somebody else's row, and must not be able to learn that it is real.
	foreign := makeSequence(t, h, carol, "Carol's private chain")

	err := h.repo.Create(ctx, alice, New{ToUsername: "sh_vb_h", ResourceType: "sequence", ResourceID: foreign.ID})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("sharing a foreign sequence: want ErrNotFound, got %v", err)
	}
	// Indistinguishable from an id that was never real — the existence-oracle
	// collapse this codebase has had to fix three times elsewhere.
	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_vb_h", ResourceType: "sequence", ResourceID: "no-such-sequence-id"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("sharing an unreal id: want ErrNotFound, got %v", err)
	}
	if _, err := h.repo.Inbox(ctx, bob); err != nil {
		t.Fatalf("inbox: %v", err)
	}
	if inbox, _ := h.repo.Inbox(ctx, bob); len(inbox) != 0 {
		t.Fatalf("a refused share still landed: %+v", inbox)
	}
}

func TestOnlyTheRecipientAcceptsAndOnlyOnce(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_aa", "sh_aa_h")
	bob := person(t, h.pool, "sh_ab", "sh_ab_h")
	mallory := person(t, h.pool, "sh_am", "sh_am_h")
	befriend(t, h, alice, "sh_aa_h", bob, "sh_ab_h")
	seq := makeSequence(t, h, alice, "One copy only")

	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_ab_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
		t.Fatalf("share: %v", err)
	}
	inbox, _ := h.repo.Inbox(ctx, bob)
	shareID := inbox[0].ID

	// The SENDER cannot accept their own share, and an OUTSIDER cannot accept
	// somebody else's — both the same ErrNotFound as a share that never was.
	if _, err := h.repo.Accept(ctx, alice, shareID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("sender accepting own share: want ErrNotFound, got %v", err)
	}
	if _, err := h.repo.Accept(ctx, mallory, shareID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider accepting: want ErrNotFound, got %v", err)
	}
	if _, err := h.repo.Accept(ctx, bob, "no-such-share"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("absent share: want ErrNotFound, got %v", err)
	}

	first, err := h.repo.Accept(ctx, bob, shareID)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	// ACCEPTING TWICE MUST NOT PRODUCE TWO COPIES. The status predicate in the
	// claim is what stops it; without it the second accept copies again.
	if _, err := h.repo.Accept(ctx, bob, shareID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("re-accept: want ErrNotFound, got %v", err)
	}
	var copies int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM bjj_sequences WHERE owner_user_id = $1`, bob).Scan(&copies); err != nil {
		t.Fatalf("count: %v", err)
	}
	if copies != 1 {
		t.Fatalf("want exactly 1 copy, got %d", copies)
	}
	if _, err := h.seqs.Get(ctx, first.ResourceID, bob); err != nil {
		t.Fatalf("the one copy is not readable: %v", err)
	}
}

func TestDuplicatePendingShareIsRefusedButResharingAfterAcceptIsNot(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_da", "sh_da_h")
	bob := person(t, h.pool, "sh_db", "sh_db_h")
	befriend(t, h, alice, "sh_da_h", bob, "sh_db_h")
	seq := makeSequence(t, h, alice, "Sent twice")
	send := func() error {
		return h.repo.Create(ctx, alice, New{ToUsername: "sh_db_h", ResourceType: "sequence", ResourceID: seq.ID})
	}

	if err := send(); err != nil {
		t.Fatalf("first share: %v", err)
	}
	if err := send(); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second share while pending: want ErrAlreadyExists, got %v", err)
	}
	inbox, _ := h.repo.Inbox(ctx, bob)
	if _, err := h.repo.Accept(ctx, bob, inbox[0].ID); err != nil {
		t.Fatalf("accept: %v", err)
	}
	// The uniqueness is PARTIAL — on pending rows only — precisely so an
	// author can send an updated version after the first was accepted.
	if err := send(); err != nil {
		t.Fatalf("re-share after accept should be allowed, got %v", err)
	}
}

func TestDeclineDeletesAndOutsidersCannot(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_xa", "sh_xa_h")
	bob := person(t, h.pool, "sh_xb", "sh_xb_h")
	mallory := person(t, h.pool, "sh_xm", "sh_xm_h")
	befriend(t, h, alice, "sh_xa_h", bob, "sh_xb_h")
	seq := makeSequence(t, h, alice, "Declined")

	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_xb_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
		t.Fatalf("share: %v", err)
	}
	inbox, _ := h.repo.Inbox(ctx, bob)
	shareID := inbox[0].ID

	if err := h.repo.Delete(ctx, mallory, shareID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider delete: want ErrNotFound, got %v", err)
	}
	if left, _ := h.repo.Inbox(ctx, bob); len(left) != 1 {
		t.Fatalf("outsider disturbed the share: %+v", left)
	}
	// Decline is delete — and re-sharing afterwards is legal, same residual
	// as declining a friend request, recorded rather than hidden.
	if err := h.repo.Delete(ctx, bob, shareID); err != nil {
		t.Fatalf("decline: %v", err)
	}
	if left, _ := h.repo.Inbox(ctx, bob); len(left) != 0 {
		t.Fatalf("decline did not delete: %+v", left)
	}
	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_xb_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
		t.Fatalf("re-share after decline: %v", err)
	}
	// The SENDER can also take one back.
	again, _ := h.repo.Inbox(ctx, bob)
	if err := h.repo.Delete(ctx, alice, again[0].ID); err != nil {
		t.Fatalf("sender cancel: %v", err)
	}
	if left, _ := h.repo.Inbox(ctx, bob); len(left) != 0 {
		t.Fatalf("cancel did not delete: %+v", left)
	}
}

func TestAcceptingSomethingTheSenderDeletedIsGone(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_ga", "sh_ga_h")
	bob := person(t, h.pool, "sh_gb", "sh_gb_h")
	befriend(t, h, alice, "sh_ga_h", bob, "sh_gb_h")
	seq := makeSequence(t, h, alice, "Deleted before you looked")

	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_gb_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
		t.Fatalf("share: %v", err)
	}
	inbox, _ := h.repo.Inbox(ctx, bob)
	if err := h.seqs.Delete(ctx, seq.ID, alice); err != nil {
		t.Fatalf("sender deletes: %v", err)
	}

	// resource_id is polymorphic and can carry no foreign key, so this is the
	// case the schema cannot prevent and the code must handle.
	if _, err := h.repo.Accept(ctx, bob, inbox[0].ID); !errors.Is(err, ErrGone) {
		t.Fatalf("accepting a deleted source: want ErrGone, got %v", err)
	}
	// The dead share is cleared rather than left to fail identically forever.
	if left, _ := h.repo.Inbox(ctx, bob); len(left) != 0 {
		t.Fatalf("dead share still in the inbox: %+v", left)
	}
	var copies int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM bjj_sequences WHERE owner_user_id = $1`, bob).Scan(&copies); err != nil {
		t.Fatalf("count: %v", err)
	}
	if copies != 0 {
		t.Fatalf("a ghost was copied: %d", copies)
	}
}

func TestInboxIsScopedAndTheHandleIsLive(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_la", "sh_la_h")
	bob := person(t, h.pool, "sh_lb", "sh_lb_h")
	mallory := person(t, h.pool, "sh_lm", "sh_lm_h")
	befriend(t, h, alice, "sh_la_h", bob, "sh_lb_h")
	seq := makeSequence(t, h, alice, "Only bob's")

	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_lb_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
		t.Fatalf("share: %v", err)
	}
	got, err := h.repo.Inbox(ctx, mallory)
	if err != nil {
		// Not pedantry: the zero value is an EMPTY inbox, so an ignored error
		// would make this assertion pass BY FAILING.
		t.Fatalf("mallory's inbox: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("outsider sees another inbox: %+v", got)
	}
	// The SENDER does not see their own share in their inbox either.
	if own, err := h.repo.Inbox(ctx, alice); err != nil || len(own) != 0 {
		t.Fatalf("sender's inbox: %+v %v", own, err)
	}

	// The handle is JOINED, not stored: a rename propagates to every inbox it
	// appears in. Goes red if the join is ever replaced by a denormalised copy.
	if _, err := h.pool.Exec(ctx,
		`UPDATE profiles SET username = $2 WHERE user_id = $1`, alice, "sh_la_new"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	after, err := h.repo.Inbox(ctx, bob)
	if err != nil || len(after) != 1 {
		t.Fatalf("bob's inbox after rename: %+v %v", after, err)
	}
	if after[0].From != "sh_la_new" {
		t.Fatalf("stale handle in inbox: %s", after[0].From)
	}
	// The LABEL, by contrast, is a snapshot of what was said — see the
	// migration. Renaming the sequence must NOT rewrite an already-sent card.
	renamed := "Renamed since"
	if _, err := h.seqs.Update(ctx, seq.ID, alice, sequence.Update{Name: &renamed}); err != nil {
		t.Fatalf("rename sequence: %v", err)
	}
	final, _ := h.repo.Inbox(ctx, bob)
	if final[0].ResourceLabel != "Only bob's" {
		t.Fatalf("label is not a snapshot: %s", final[0].ResourceLabel)
	}
}

func TestUnknownResourceTypeIsRefusedBeforeAnythingIsResolved(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_ta", "sh_ta_h")
	bob := person(t, h.pool, "sh_tb", "sh_tb_h")
	befriend(t, h, alice, "sh_ta_h", bob, "sh_tb_h")

	// ErrInvalidInput, not ErrNotFound: an unregistered type is the client
	// sending something this build cannot copy, and rejecting it before the
	// handle is resolved keeps a bogus type from being used as a probe.
	err := h.repo.Create(ctx, alice, New{ToUsername: "sh_tb_h", ResourceType: "spaceship", ResourceID: "x"})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown type: want ErrInvalidInput, got %v", err)
	}
	if err := (New{ToUsername: "a", ResourceType: "sequence"}).Validate(Registry{"sequence": h.seqs}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("missing resource id: want ErrInvalidInput, got %v", err)
	}
}
