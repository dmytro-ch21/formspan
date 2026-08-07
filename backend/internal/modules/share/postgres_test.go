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

// seedTechniques inserts the library rows these tests need, rather than
// borrowing whatever the catalog happens to hold.
//
// THIS IS NOT FASTIDIOUSNESS. The first version selected two rows from
// `techniques` and skipped when it found fewer than two — and CI runs
// `migrate up` WITHOUT `cmd/seed`, so that table is empty there and all six
// sequence-based tests below would have skipped green in the one environment
// they were supposed to be proving anything in. A test that silently skips is
// indistinguishable from a test that passes, which is the exact trap CLAUDE.md
// documents for TEST_DATABASE_URL itself. The sibling sequence tests already
// seed their own rows; this follows them.
func seedTechniques(t *testing.T, pool *pgxpool.Pool, ids ...string) []string {
	t.Helper()
	ctx := context.Background()
	for _, id := range ids {
		if _, err := pool.Exec(ctx, `
			INSERT INTO techniques (id, name, category, position, function)
			VALUES ($1, $1, 'Submission', 'Guard - Bottom', 'finish')
			ON CONFLICT (id) DO NOTHING`, id); err != nil {
			t.Fatalf("seed technique %s: %v", id, err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM techniques WHERE id = $1`, id) })
	}
	return ids
}

func makeSequence(t *testing.T, h *harness, owner, name string) sequence.Sequence {
	t.Helper()
	// Namespaced per owner so two sequences in one test do not fight over
	// cleanup of the same rows.
	ids := seedTechniques(t, h.pool, "sh_tech_"+owner+"_1", "sh_tech_"+owner+"_2")
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
	// AIMED AT A HANDLE THAT DOES NOT EXIST, and that is the entire point.
	// This test previously sent to a friend, where BOTH orderings answer
	// ErrInvalidInput — so it asserted its own name without testing it, and
	// review proved as much by moving the registry check after the friendship
	// lookup and watching the suite stay green. Against an unknown handle the
	// two orderings diverge: check-first is ErrInvalidInput, resolve-first is
	// ErrNotFound. A bogus type must not become a probe for whether a handle
	// is real.
	err := h.repo.Create(ctx, alice, New{ToUsername: "nobody_at_all", ResourceType: "spaceship", ResourceID: "x"})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown type to an unknown handle: want ErrInvalidInput, got %v", err)
	}
	// And the friend case still answers the same way.
	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_tb_h", ResourceType: "spaceship", ResourceID: "x"}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown type to a friend: want ErrInvalidInput, got %v", err)
	}
	if err := (New{ToUsername: "a", ResourceType: "sequence"}).Validate(Registry{"sequence": h.seqs}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("missing resource id: want ErrInvalidInput, got %v", err)
	}
}

// ── The two arms review found unpinned ──────────────────────────────────────

// VOLA-authored content is shareable, and that is the whole reason Describe
// tests VISIBILITY rather than ownership.
//
// Every other test here shares a user-owned row, so narrowing the predicate to
// `owner_user_id = $2` left the suite green — the day reference chains ship,
// someone could delete that arm and nothing would go red while legitimate
// shares of library content silently started 404ing.
func TestVolaAuthoredContentCanBeShared(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_wa", "sh_wa_h")
	bob := person(t, h.pool, "sh_wb", "sh_wb_h")
	befriend(t, h, alice, "sh_wa_h", bob, "sh_wb_h")
	ids := seedTechniques(t, h.pool, "sh_tech_vola_1")

	// An ownerless chain — nobody's, everybody's to read.
	var refID string
	// `source` must agree with ownership — bjj_sequences_source_matches_owner
	// enforces `(owner_user_id IS NULL) = (source <> 'user')`, so an ownerless
	// row has to declare itself seeded. Discovered by the constraint rejecting
	// the first attempt, which is the schema doing its job.
	if err := h.pool.QueryRow(ctx, `
		INSERT INTO bjj_sequences (owner_user_id, source, name, description)
		VALUES (NULL, 'seed', 'VOLA reference chain', 'shipped with the app')
		RETURNING id`).Scan(&refID); err != nil {
		t.Fatalf("seed reference sequence: %v", err)
	}
	t.Cleanup(func() { _, _ = h.pool.Exec(ctx, `DELETE FROM bjj_sequences WHERE id = $1`, refID) })
	if _, err := h.pool.Exec(ctx, `
		INSERT INTO bjj_sequence_steps (sequence_id, technique_id, sort_order, notes)
		VALUES ($1, $2, 0, 'reference step')`, refID, ids[0]); err != nil {
		t.Fatalf("seed reference step: %v", err)
	}

	// Alice does not own it and can still pass it on.
	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_wb_h", ResourceType: "sequence", ResourceID: refID}); err != nil {
		t.Fatalf("sharing VOLA content: %v", err)
	}
	inbox, _ := h.repo.Inbox(ctx, bob)
	if len(inbox) != 1 || inbox[0].ResourceLabel != "VOLA reference chain" {
		t.Fatalf("inbox: %+v", inbox)
	}
	got, err := h.repo.Accept(ctx, bob, inbox[0].ID)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	// Bob's copy is HIS — the ownerless original stays ownerless.
	copied, err := h.seqs.Get(ctx, got.ResourceID, bob)
	if err != nil {
		t.Fatalf("bob cannot read his copy: %v", err)
	}
	if !copied.Editable {
		t.Fatalf("a copy of reference content should be the recipient's to edit: %+v", copied)
	}
	var stillNull bool
	if err := h.pool.QueryRow(ctx,
		`SELECT owner_user_id IS NULL FROM bjj_sequences WHERE id = $1`, refID).Scan(&stillNull); err != nil {
		t.Fatalf("check original: %v", err)
	}
	if !stillNull {
		t.Fatalf("copying reference content took ownership of the original")
	}
}

// The copy re-derives sort_order densely rather than carrying the source's.
//
// Sources are dense in practice because insertSteps assigns from a slice index,
// so a verbatim copy passes every other test here. Gaps are reachable through
// bjj_sequence_steps.technique_id ON DELETE CASCADE, which migration 000035
// flags as latent — this makes the gap by hand and pins the property.
func TestCopyRedensifiesStepOrder(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_oa", "sh_oa_h")
	bob := person(t, h.pool, "sh_ob", "sh_ob_h")
	befriend(t, h, alice, "sh_oa_h", bob, "sh_ob_h")
	seq := makeSequence(t, h, alice, "Chain with a hole in it")

	// Punch out the FIRST step, leaving the survivor at sort_order 1.
	if _, err := h.pool.Exec(ctx,
		`DELETE FROM bjj_sequence_steps WHERE sequence_id = $1 AND sort_order = 0`, seq.ID); err != nil {
		t.Fatalf("make a gap: %v", err)
	}
	var srcOrder int
	if err := h.pool.QueryRow(ctx,
		`SELECT sort_order FROM bjj_sequence_steps WHERE sequence_id = $1`, seq.ID).Scan(&srcOrder); err != nil {
		t.Fatalf("read source order: %v", err)
	}
	if srcOrder != 1 {
		t.Fatalf("fixture wrong: expected a lone step at 1, got %d", srcOrder)
	}

	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_ob_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
		t.Fatalf("share: %v", err)
	}
	inbox, _ := h.repo.Inbox(ctx, bob)
	got, err := h.repo.Accept(ctx, bob, inbox[0].ID)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	var copyOrder int
	if err := h.pool.QueryRow(ctx,
		`SELECT sort_order FROM bjj_sequence_steps WHERE sequence_id = $1`, got.ResourceID).Scan(&copyOrder); err != nil {
		t.Fatalf("read copy order: %v", err)
	}
	if copyOrder != 0 {
		t.Fatalf("copy did not re-densify: source was %d, copy is %d", srcOrder, copyOrder)
	}
}

// ── The sent list ───────────────────────────────────────────────────────────

func TestSentListShowsWhatIsUnansweredAndOnlyToTheSender(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_sa", "sh_sa_h")
	bob := person(t, h.pool, "sh_sb", "sh_sb_h")
	mallory := person(t, h.pool, "sh_sm", "sh_sm_h")
	befriend(t, h, alice, "sh_sa_h", bob, "sh_sb_h")
	seq := makeSequence(t, h, alice, "Waiting on bob")

	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_sb_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
		t.Fatalf("share: %v", err)
	}

	sent, err := h.repo.Sent(ctx, alice)
	if err != nil {
		t.Fatalf("sent: %v", err)
	}
	if len(sent) != 1 {
		t.Fatalf("alice's sent list: %+v", sent)
	}
	// The counterpart is the RECIPIENT here, not the sender — the mirror of
	// the inbox, and the thing a shared query gets wrong by copying.
	if sent[0].To != "sh_sb_h" || sent[0].ResourceLabel != "Waiting on bob" {
		t.Fatalf("sent card wrong: %+v", sent[0])
	}

	// The RECIPIENT does not see it in their sent list, and an outsider sees
	// nothing at all. Errors checked, because the zero value is an empty list
	// and an ignored error would make both assertions pass BY FAILING.
	bobSent, err := h.repo.Sent(ctx, bob)
	if err != nil {
		t.Fatalf("bob's sent: %v", err)
	}
	if len(bobSent) != 0 {
		t.Fatalf("recipient sees the share in their SENT list: %+v", bobSent)
	}
	malSent, err := h.repo.Sent(ctx, mallory)
	if err != nil {
		t.Fatalf("mallory's sent: %v", err)
	}
	if len(malSent) != 0 {
		t.Fatalf("outsider sees a sent list: %+v", malSent)
	}
	// And the sender's own inbox stays empty — the two directions do not leak
	// into each other.
	if own, err := h.repo.Inbox(ctx, alice); err != nil || len(own) != 0 {
		t.Fatalf("sender's inbox: %+v %v", own, err)
	}
}

// The list answers "what have they not answered", never "what did they say".
//
// Accepted rows must NOT appear: declining deletes, so if accepting left a
// visible row then a VANISHED row would mean declined — the exact inference
// decline-is-delete exists to prevent. Both outcomes have to look identical
// from the sender's side, and this pins that they do.
func TestAcceptedAndDeclinedLookTheSameToTheSender(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_qa", "sh_qa_h")
	bob := person(t, h.pool, "sh_qb", "sh_qb_h")
	carol := person(t, h.pool, "sh_qc", "sh_qc_h")
	befriend(t, h, alice, "sh_qa_h", bob, "sh_qb_h")
	befriend(t, h, alice, "sh_qa_h", carol, "sh_qc_h")
	accepted := makeSequence(t, h, alice, "Bob will take it")
	declined := makeSequence(t, h, alice, "Carol will not")

	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_qb_h", ResourceType: "sequence", ResourceID: accepted.ID}); err != nil {
		t.Fatalf("share to bob: %v", err)
	}
	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_qc_h", ResourceType: "sequence", ResourceID: declined.ID}); err != nil {
		t.Fatalf("share to carol: %v", err)
	}
	if sent, _ := h.repo.Sent(ctx, alice); len(sent) != 2 {
		t.Fatalf("both should be waiting: %+v", sent)
	}

	bobInbox, _ := h.repo.Inbox(ctx, bob)
	if _, err := h.repo.Accept(ctx, bob, bobInbox[0].ID); err != nil {
		t.Fatalf("bob accepts: %v", err)
	}
	carolInbox, _ := h.repo.Inbox(ctx, carol)
	if err := h.repo.Delete(ctx, carol, carolInbox[0].ID); err != nil {
		t.Fatalf("carol declines: %v", err)
	}

	sent, err := h.repo.Sent(ctx, alice)
	if err != nil {
		t.Fatalf("sent: %v", err)
	}
	if len(sent) != 0 {
		t.Fatalf("an answered share is still visible to the sender: %+v", sent)
	}
	// The accept really did happen — this is not passing because nothing worked.
	var copies int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM bjj_sequences WHERE owner_user_id = $1`, bob).Scan(&copies); err != nil {
		t.Fatalf("count: %v", err)
	}
	if copies != 1 {
		t.Fatalf("bob's accept did not copy: %d", copies)
	}
}

func TestSenderCancelsFromTheSentList(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_ca", "sh_ca_h")
	bob := person(t, h.pool, "sh_cb", "sh_cb_h")
	befriend(t, h, alice, "sh_ca_h", bob, "sh_cb_h")
	seq := makeSequence(t, h, alice, "Sent by mistake")

	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_cb_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
		t.Fatalf("share: %v", err)
	}
	sent, _ := h.repo.Sent(ctx, alice)
	// The id on the sent card is the one DELETE takes — a card carrying an id
	// its own cancel button cannot use would be worse than no card.
	if err := h.repo.Delete(ctx, alice, sent[0].ID); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if after, _ := h.repo.Sent(ctx, alice); len(after) != 0 {
		t.Fatalf("cancel left it waiting: %+v", after)
	}
	if inbox, _ := h.repo.Inbox(ctx, bob); len(inbox) != 0 {
		t.Fatalf("cancel did not take it out of the recipient's inbox: %+v", inbox)
	}
	// Cancelled, so it can be sent again.
	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_cb_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
		t.Fatalf("re-share after cancel: %v", err)
	}
}

// THE ORACLE, closed and pinned.
//
// Review found this and it is this feature's own doing: accepting leaves the
// row and declining deletes it, so a status-blind DELETE answers 204 for one
// and 404 for the other. Before the sent list a sender could not learn a share
// id at all — POST returns 204 with no body, the inbox is recipient-scoped,
// and the ids are random UUIDs — so the asymmetry existed and was unreachable.
// Handing senders their own ids is what would have armed it.
//
// Everything the sender can observe about an answered share must be identical
// whichever way it was answered. This walks the full set.
func TestSenderCannotTellAcceptFromDeclineThroughAnyChannel(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_oa2", "sh_oa2_h")
	bob := person(t, h.pool, "sh_ob2", "sh_ob2_h")
	carol := person(t, h.pool, "sh_oc2", "sh_oc2_h")
	befriend(t, h, alice, "sh_oa2_h", bob, "sh_ob2_h")
	befriend(t, h, alice, "sh_oa2_h", carol, "sh_oc2_h")
	toAccept := makeSequence(t, h, alice, "Bob accepts this")
	toDecline := makeSequence(t, h, alice, "Carol declines this")

	share := func(handle, resourceID string) string {
		t.Helper()
		if err := h.repo.Create(ctx, alice, New{ToUsername: handle, ResourceType: "sequence", ResourceID: resourceID}); err != nil {
			t.Fatalf("share to %s: %v", handle, err)
		}
		sent, err := h.repo.Sent(ctx, alice)
		if err != nil {
			t.Fatalf("sent: %v", err)
		}
		for _, c := range sent {
			if c.ResourceLabel == "Bob accepts this" && handle == "sh_ob2_h" {
				return c.ID
			}
			if c.ResourceLabel == "Carol declines this" && handle == "sh_oc2_h" {
				return c.ID
			}
		}
		t.Fatalf("share not in the sent list: %+v", sent)
		return ""
	}
	acceptedID := share("sh_ob2_h", toAccept.ID)
	declinedID := share("sh_oc2_h", toDecline.ID)

	bobInbox, _ := h.repo.Inbox(ctx, bob)
	if _, err := h.repo.Accept(ctx, bob, bobInbox[0].ID); err != nil {
		t.Fatalf("bob accepts: %v", err)
	}
	carolInbox, _ := h.repo.Inbox(ctx, carol)
	if err := h.repo.Delete(ctx, carol, carolInbox[0].ID); err != nil {
		t.Fatalf("carol declines: %v", err)
	}

	// 1. DELETE — the channel review found. Both must be the same miss.
	errAccepted := h.repo.Delete(ctx, alice, acceptedID)
	errDeclined := h.repo.Delete(ctx, alice, declinedID)
	if !errors.Is(errAccepted, ErrNotFound) || !errors.Is(errDeclined, ErrNotFound) {
		t.Fatalf("DELETE is an oracle: accepted=%v declined=%v", errAccepted, errDeclined)
	}
	// And the accepted row is still THERE — the sender was refused, not
	// silently allowed to erase the recipient's record of where it came from.
	var alive int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM shares WHERE id = $1`, acceptedID).Scan(&alive); err != nil {
		t.Fatalf("count: %v", err)
	}
	if alive != 1 {
		t.Fatalf("the sender's refused delete removed the row anyway")
	}

	// 2. Accept, as the sender.
	_, aErr := h.repo.Accept(ctx, alice, acceptedID)
	_, dErr := h.repo.Accept(ctx, alice, declinedID)
	if !errors.Is(aErr, ErrNotFound) || !errors.Is(dErr, ErrNotFound) {
		t.Fatalf("accept is an oracle: accepted=%v declined=%v", aErr, dErr)
	}

	// 3. Both lists, both directions.
	sent, err := h.repo.Sent(ctx, alice)
	if err != nil || len(sent) != 0 {
		t.Fatalf("sent list after answers: %+v %v", sent, err)
	}
	if inbox, err := h.repo.Inbox(ctx, alice); err != nil || len(inbox) != 0 {
		t.Fatalf("sender's inbox: %+v %v", inbox, err)
	}

	// 4. Re-sharing succeeds after BOTH — the channel that was already clean,
	//    pinned so it stays that way.
	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_ob2_h", ResourceType: "sequence", ResourceID: toAccept.ID}); err != nil {
		t.Fatalf("re-share after accept: %v", err)
	}
	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_oc2_h", ResourceType: "sequence", ResourceID: toDecline.ID}); err != nil {
		t.Fatalf("re-share after decline: %v", err)
	}

	// The RECIPIENT keeps full control of their own row, which is the half the
	// asymmetry must not break.
	if err := h.repo.Delete(ctx, bob, acceptedID); err != nil {
		t.Fatalf("recipient clearing their accepted row: %v", err)
	}
}

// Newest first, in both directions — promised by both Repository docs and the
// contract, and surviving deletion of the ORDER BY until now.
func TestBothListsAreNewestFirst(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_na", "sh_na_h")
	bob := person(t, h.pool, "sh_nb", "sh_nb_h")
	befriend(t, h, alice, "sh_na_h", bob, "sh_nb_h")

	labels := []string{"first sent", "second sent", "third sent"}
	for _, name := range labels {
		seq := makeSequence(t, h, alice, name)
		if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_nb_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
			t.Fatalf("share %s: %v", name, err)
		}
		// created_at defaults to now() at microsecond resolution; three inserts
		// in one statement-burst can land on the same timestamp, and then the
		// id tiebreak decides rather than the clock. Force distinct instants.
		if _, err := h.pool.Exec(ctx,
			`UPDATE shares SET created_at = now() WHERE resource_label = $1`, name); err != nil {
			t.Fatalf("stamp: %v", err)
		}
	}

	sent, err := h.repo.Sent(ctx, alice)
	if err != nil || len(sent) != 3 {
		t.Fatalf("sent: %+v %v", sent, err)
	}
	if sent[0].ResourceLabel != "third sent" || sent[2].ResourceLabel != "first sent" {
		t.Fatalf("sent list is not newest-first: %v, %v, %v",
			sent[0].ResourceLabel, sent[1].ResourceLabel, sent[2].ResourceLabel)
	}
	inbox, err := h.repo.Inbox(ctx, bob)
	if err != nil || len(inbox) != 3 {
		t.Fatalf("inbox: %+v %v", inbox, err)
	}
	if inbox[0].ResourceLabel != "third sent" || inbox[2].ResourceLabel != "first sent" {
		t.Fatalf("inbox is not newest-first: %v, %v, %v",
			inbox[0].ResourceLabel, inbox[1].ResourceLabel, inbox[2].ResourceLabel)
	}
}

// The badge count is the INBOX, never the sent list.
//
// What you are waiting on is not waiting on you — and a badge over the sent
// list would tick down as other people answered, which slowly leaks the very
// thing that list refuses to say.
func TestPendingCountIsTheInboxNotTheSentList(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_pc_a", "sh_pc_a_h")
	bob := person(t, h.pool, "sh_pc_b", "sh_pc_b_h")
	befriend(t, h, alice, "sh_pc_a_h", bob, "sh_pc_b_h")
	seq := makeSequence(t, h, alice, "For bob")

	if err := h.repo.Create(ctx, alice, New{ToUsername: "sh_pc_b_h", ResourceType: "sequence", ResourceID: seq.ID}); err != nil {
		t.Fatalf("share: %v", err)
	}

	// It is waiting for BOB, not for alice who sent it.
	if n, err := h.repo.PendingCount(ctx, bob); err != nil || n != 1 {
		t.Fatalf("bob should have 1 waiting, got %d (%v)", n, err)
	}
	if n, err := h.repo.PendingCount(ctx, alice); err != nil || n != 0 {
		t.Fatalf("the sender has nothing waiting on them, got %d (%v)", n, err)
	}

	// Answering clears it — there is no read flag, so this is the ONLY thing
	// that can, which is what makes the count impossible to get out of sync.
	inbox, _ := h.repo.Inbox(ctx, bob)
	if _, err := h.repo.Accept(ctx, bob, inbox[0].ID); err != nil {
		t.Fatalf("accept: %v", err)
	}
	if n, err := h.repo.PendingCount(ctx, bob); err != nil || n != 0 {
		t.Fatalf("accepting did not clear the count, got %d (%v)", n, err)
	}
	// And the accepted row does not resurface on the sender's side either.
	if n, err := h.repo.PendingCount(ctx, alice); err != nil || n != 0 {
		t.Fatalf("sender count after accept: %d (%v)", n, err)
	}
}
