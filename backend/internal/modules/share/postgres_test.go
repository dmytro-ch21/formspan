package share

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/modules/friend"
	"github.com/dmytro-ch21/vola/backend/internal/modules/sequence"
	"github.com/dmytro-ch21/vola/backend/internal/modules/workout"
)

// NOTE ON THE IMPORTS. The share package itself must never import sequence,
// workout or friend — that rule is the module's whole architecture. This TEST
// imports all three, deliberately, because it wires the same registry
// cmd/api/main.go does and a test against a stub registry would prove only that
// the stub works. The dependency the rule forbids is a compile-time one in
// shipped code; a test assembling the real pairing is the thing that shows the
// pairing holds.

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

// harness builds the real wiring: the registered Copiers, and the friend repo
// as the friendship test.
//
// The registry mirrors cmd/api/main.go's, and that is the point of building it
// from real repositories — registering a stub here would show only that the
// stub satisfies the interface, which the compiler already says.
type harness struct {
	pool  *pgxpool.Pool
	repo  *PostgresRepository
	seqs  *sequence.PostgresRepository
	wrks  *workout.PostgresRepository
	frnds *friend.PostgresRepository
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	pool := testPool(t)
	seqs := sequence.NewPostgresRepository(pool)
	wrks := workout.NewPostgresRepository(pool)
	frnds := friend.NewPostgresRepository(pool)
	reg := Registry{"sequence": seqs, "workout": wrks}
	return &harness{
		pool: pool, repo: NewPostgresRepository(pool, reg, frnds),
		seqs: seqs, wrks: wrks, frnds: frnds,
	}
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
		// workout_items cascade. Includes the copies accepting produced, whose
		// ids the test never sees — they are server-generated.
		_, _ = pool.Exec(ctx, `DELETE FROM workouts WHERE owner_user_id = $1`, id)
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

// ── Workouts, the second registered kind ─────────────────────────────────────
//
// These live here rather than in the workout package because what is worth
// pinning is the PAIRING: the registry, the copier, and the transaction that
// makes accepting atomic. A test of `CopyTo` alone would call it outside the
// transaction the share module hands it, which is the one place its guarantees
// live.

// seedExercises inserts the catalog rows these tests reference, and — the part
// that took a review to notice — actually removes them again.
//
// **The obvious version of this leaks, silently.** `t.Cleanup` is LIFO, and this
// runs from `makeWorkout`, i.e. AFTER `person()` has registered its own cleanup
// — so a plain `DELETE FROM exercises` fires FIRST, while `workout_items` rows
// still reference the exercise. `workout_items.exercise_id` has **no ON DELETE**
// (migration 000006), so the delete fails on the foreign key, `_, _ =` discards
// the error, and the fixture survives into the database every other package
// shares. Measured at nine published `sh_ex_*` rows left behind per clean run.
//
// The sibling `seedTechniques` above gets away with the same shape only because
// `bjj_sequence_steps.technique_id` is ON DELETE CASCADE (000035). The foreign
// keys differ, so "it follows the neighbour" does not transfer — which is
// precisely how this was written wrong.
//
// So the cleanup clears whatever references the row rather than depending on
// registration order, and it LOGS a failure instead of swallowing it. Both
// halves are what `workout/postgres_test.go`'s `seedDraftExercise` records
// learning the hard way, after its own rows "had to be cleared out of the
// shared database by hand".
func seedExercises(t *testing.T, pool *pgxpool.Pool, ids ...string) []string {
	t.Helper()
	ctx := context.Background()
	for _, id := range ids {
		if _, err := pool.Exec(ctx, `
			INSERT INTO exercises (id, name, sport, movement_pattern, load_type, status)
			VALUES ($1, $1, 'strength', 'squat', 'weight_reps', 'published')
			ON CONFLICT (id) DO NOTHING`, id); err != nil {
			t.Fatalf("seed exercise %s: %v", id, err)
		}
		t.Cleanup(func() {
			// Order-independent: whatever still points at this exercise goes
			// first. `workout_items` cascades from `workouts`, so removing the
			// parent is enough — and that also catches the server-generated
			// copies accepting produced, whose ids no test ever sees.
			if _, err := pool.Exec(ctx, `
				DELETE FROM workouts
				WHERE id IN (SELECT workout_id FROM workout_items WHERE exercise_id = $1)`,
				id); err != nil {
				t.Logf("cleanup workouts referencing %s: %v", id, err)
			}
			if _, err := pool.Exec(ctx, `DELETE FROM exercises WHERE id = $1`, id); err != nil {
				t.Logf("cleanup exercise %s: %v", id, err)
			}
		})
	}
	return ids
}

func makeWorkout(t *testing.T, h *harness, owner, id, name string) string {
	t.Helper()
	ids := seedExercises(t, h.pool, "sh_ex_"+owner+"_1", "sh_ex_"+owner+"_2")
	five, eight, ninety := 5, 8, 90
	goal := workout.Goal("hypertrophy")
	if _, err := h.wrks.Create(context.Background(), workout.NewWorkout{
		ID: id, OwnerUserID: owner, Name: name, Sport: "strength",
		Goal: &goal, Notes: "as written", Visibility: "private",
		Items: []workout.Item{
			{ExerciseID: ids[0], TargetSets: &five, TargetReps: &eight, Notes: "first"},
			{ExerciseID: ids[1], TargetSets: &five, TargetSeconds: &ninety, Notes: "second"},
		},
	}); err != nil {
		t.Fatalf("create workout: %v", err)
	}
	return id
}

func TestSharedWorkoutBecomesAnIndependentCopy(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_wka", "sh_wka_h")
	bob := person(t, h.pool, "sh_wkb", "sh_wkb_h")
	befriend(t, h, alice, "sh_wka_h", bob, "sh_wkb_h")
	id := makeWorkout(t, h, alice, "sh_wk_push_a", "Push Day A")

	if err := h.repo.Create(ctx, alice,
		New{ToUsername: "sh_wkb_h", ResourceType: "workout", ResourceID: id}); err != nil {
		t.Fatalf("share: %v", err)
	}
	inbox, err := h.repo.Inbox(ctx, bob)
	if err != nil || len(inbox) != 1 {
		t.Fatalf("inbox: %+v %v", inbox, err)
	}
	// Describe is what puts a NAME on the card rather than an id.
	if inbox[0].ResourceType != "workout" || inbox[0].ResourceLabel != "Push Day A" {
		t.Fatalf("card: %+v", inbox[0])
	}

	got, err := h.repo.Accept(ctx, bob, inbox[0].ID)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	// A NEW id, never the sender's. Ids here are client-supplied, so reusing
	// one would collide on the primary key — and would hand the recipient's
	// template to the sender's offline sync retries, which `Create` treats as
	// idempotent replays of their own row.
	if got.ResourceID == id {
		t.Fatalf("the copy reused the sender's id %q", got.ResourceID)
	}
	copied, err := h.wrks.Get(ctx, bob, got.ResourceID)
	if err != nil {
		t.Fatalf("bob cannot read his copy: %v", err)
	}
	if copied.OwnerUserID == nil || *copied.OwnerUserID != bob {
		t.Fatalf("copy is not bob's: %+v", copied.OwnerUserID)
	}
	if copied.Name != "Push Day A" || copied.Notes != "as written" ||
		copied.Goal == nil || *copied.Goal != "hypertrophy" {
		t.Fatalf("copy lost its fields: %+v", copied)
	}
	if len(copied.Items) != 2 {
		t.Fatalf("copy has %d items, want 2", len(copied.Items))
	}
	// The TARGETS, not just the exercise ids — a copy that drops them is a
	// list of movements rather than a plan, and every field is separately
	// omittable from the INSERT ... SELECT.
	if copied.Items[0].TargetSets == nil || *copied.Items[0].TargetSets != 5 ||
		copied.Items[0].TargetReps == nil || *copied.Items[0].TargetReps != 8 ||
		copied.Items[0].Notes != "first" {
		t.Fatalf("first item lost its targets: %+v", copied.Items[0])
	}
	if copied.Items[1].TargetSeconds == nil || *copied.Items[1].TargetSeconds != 90 {
		t.Fatalf("second item lost its duration: %+v", copied.Items[1])
	}
	// Order preserved, and dense from zero — see the gapped fixture below for
	// why this assertion is not the whole of that claim.
	if copied.Items[0].Position != 0 || copied.Items[1].Position != 1 {
		t.Fatalf("positions are not dense from zero: %+v", copied.Items)
	}

	// SNAPSHOT SEMANTICS. Alice renaming hers must not reach into his.
	if _, err := h.wrks.Rename(ctx, alice, id, "Push Day A (v2)"); err != nil {
		t.Fatalf("rename original: %v", err)
	}
	after, err := h.wrks.Get(ctx, bob, got.ResourceID)
	if err != nil {
		t.Fatalf("re-read copy: %v", err)
	}
	if after.Name != "Push Day A" {
		t.Fatalf("the sender's rename propagated: %q", after.Name)
	}
}

// A copy of a VOLA Workout must not arrive marked as one, on either column
// that says so — and both are omissions from an INSERT, which is the kind of
// bug that reads as correct.
//
// `source` is the sharper of the two: `workouts_owned_rows_are_never_seeded`
// forbids ('seed', <owner>), so copying it through does not produce a subtly
// wrong row — it fails the accept transaction outright, and every share of a
// VOLA Workout 500s. `visibility` fails quietly instead, which is worse:
// accepting would publish the recipient's private copy to the whole platform.
func TestAcceptingAVolaWorkoutDoesNotCopyItsSourceOrVisibility(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_wva", "sh_wva_h")
	bob := person(t, h.pool, "sh_wvb", "sh_wvb_h")
	befriend(t, h, alice, "sh_wva_h", bob, "sh_wvb_h")
	ids := seedExercises(t, h.pool, "sh_ex_vola_1")

	// The shape `cmd/seed` writes: ownerless, public, and marked as the
	// deploy's to refresh.
	const volaID = "sh_wk_public_plan"
	if _, err := h.pool.Exec(ctx, `
		INSERT INTO workouts (id, owner_user_id, name, sport, goal, notes, visibility, source)
		VALUES ($1, NULL, 'VOLA Full Body', 'strength', 'general', '', 'public', 'seed')`,
		volaID); err != nil {
		t.Fatalf("seed VOLA workout: %v", err)
	}
	t.Cleanup(func() { _, _ = h.pool.Exec(ctx, `DELETE FROM workouts WHERE id = $1`, volaID) })
	if _, err := h.pool.Exec(ctx, `
		INSERT INTO workout_items (workout_id, exercise_id, position, target_sets)
		VALUES ($1, $2, 0, 3)`, volaID, ids[0]); err != nil {
		t.Fatalf("seed VOLA item: %v", err)
	}

	// Alice does not own it and can still pass it on: `Describe` tests
	// VISIBILITY, and "Copy to my workouts" already gives her the same copy.
	if err := h.repo.Create(ctx, alice,
		New{ToUsername: "sh_wvb_h", ResourceType: "workout", ResourceID: volaID}); err != nil {
		t.Fatalf("sharing a VOLA Workout: %v", err)
	}
	inbox, _ := h.repo.Inbox(ctx, bob)
	if len(inbox) != 1 {
		t.Fatalf("inbox: %+v", inbox)
	}
	got, err := h.repo.Accept(ctx, bob, inbox[0].ID)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}

	var source, visibility string
	var owner *string
	if err := h.pool.QueryRow(ctx,
		`SELECT source, visibility, owner_user_id FROM workouts WHERE id = $1`,
		got.ResourceID).Scan(&source, &visibility, &owner); err != nil {
		t.Fatalf("read copy: %v", err)
	}
	if source != "user" {
		t.Fatalf("the copy claims source %q — the next deploy would own it", source)
	}
	if visibility != "private" {
		t.Fatalf("accepting published bob's copy to everyone: visibility %q", visibility)
	}
	if owner == nil || *owner != bob {
		t.Fatalf("copy is not bob's: %+v", owner)
	}

	// And the original is untouched — still ownerless, still the deploy's.
	var stillSeed bool
	if err := h.pool.QueryRow(ctx, `
		SELECT owner_user_id IS NULL AND source = 'seed' AND visibility = 'public'
		FROM workouts WHERE id = $1`, volaID).Scan(&stillSeed); err != nil {
		t.Fatalf("check original: %v", err)
	}
	if !stillSeed {
		t.Fatalf("sharing mutated the VOLA original")
	}
}

// A private workout is not somebody else's to pass on, and the refusal is the
// same 404 as an unknown handle — because workout ids are CLIENT-SUPPLIED and
// therefore guessable ("push-day-a"), which makes any distinguishable answer
// an existence oracle over every athlete's private templates.
func TestAStrangersPrivateWorkoutCannotBeShared(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_wpa", "sh_wpa_h")
	bob := person(t, h.pool, "sh_wpb", "sh_wpb_h")
	carol := person(t, h.pool, "sh_wpc", "sh_wpc_h")
	befriend(t, h, alice, "sh_wpa_h", bob, "sh_wpb_h")
	// Carol's, and she is friends with neither.
	hers := makeWorkout(t, h, carol, "sh_wk_carol", "Carol's Push")

	err := h.repo.Create(ctx, alice,
		New{ToUsername: "sh_wpb_h", ResourceType: "workout", ResourceID: hers})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("sharing a stranger's private workout: want ErrNotFound, got %v", err)
	}
	// Indistinguishable from an id that never existed — the whole point.
	err = h.repo.Create(ctx, alice,
		New{ToUsername: "sh_wpb_h", ResourceType: "workout", ResourceID: "sh_wk_no_such_thing"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("sharing an unknown id: want ErrNotFound, got %v", err)
	}
	if inbox, _ := h.repo.Inbox(ctx, bob); len(inbox) != 0 {
		t.Fatalf("bob received something: %+v", inbox)
	}
}

// Deleting the template between sending and accepting is ErrGone, not a 404:
// the recipient genuinely was sent something, and a silent miss would read as
// a bug in the app rather than as the sender changing their mind.
func TestAcceptingADeletedWorkoutIsGone(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_wga", "sh_wga_h")
	bob := person(t, h.pool, "sh_wgb", "sh_wgb_h")
	befriend(t, h, alice, "sh_wga_h", bob, "sh_wgb_h")
	id := makeWorkout(t, h, alice, "sh_wk_doomed", "Doomed Plan")

	if err := h.repo.Create(ctx, alice,
		New{ToUsername: "sh_wgb_h", ResourceType: "workout", ResourceID: id}); err != nil {
		t.Fatalf("share: %v", err)
	}
	inbox, _ := h.repo.Inbox(ctx, bob)
	if len(inbox) != 1 {
		t.Fatalf("inbox: %+v", inbox)
	}
	if err := h.wrks.Delete(ctx, alice, id); err != nil {
		t.Fatalf("delete original: %v", err)
	}
	if _, err := h.repo.Accept(ctx, bob, inbox[0].ID); !errors.Is(err, ErrGone) {
		t.Fatalf("accepting a deleted workout: want ErrGone, got %v", err)
	}
}

// The copy's positions are RE-DERIVED, not carried over.
//
// This test exists because the obvious version of it cannot fail. `Create` and
// `ReplaceItems` both assign positions from the array index, so every workout
// the API can produce is already dense from zero — and against such a fixture,
// copying `position` verbatim and re-deriving it with `row_number()` are
// indistinguishable. Mutating the query to the verbatim copy left the suite
// green, which is the whole reason this exists: the guard was shaped around
// the code rather than around the failure.
//
// So the gap is made directly in SQL. It is not reachable through today's write
// paths, which is exactly why the defensive `row_number()` is worth keeping and
// worth pinning: `workout_items_position_unique` turns a positions bug into a
// hard insert failure rather than a cosmetic one, and the next write path to
// arrive is not obliged to be dense.
func TestCopiedItemPositionsAreDensifiedRatherThanCarried(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_wda", "sh_wda_h")
	bob := person(t, h.pool, "sh_wdb", "sh_wdb_h")
	befriend(t, h, alice, "sh_wda_h", bob, "sh_wdb_h")
	id := makeWorkout(t, h, alice, "sh_wk_gapped", "Gapped Plan")

	// 0,1 → 7,3, i.e. the gap is INVERTED as well as opened.
	//
	// Left in ascending order (3 then 7), the fixture's exercise ids happen to
	// sort the same way as its positions, so a mutant ordering by `exercise_id`
	// — or one with no ORDER BY at all, scanning in insert order — produces the
	// same output and the order half of this test proves nothing. Swapping them
	// makes "first" genuinely have to come from `position`.
	//
	// Applied via a temporary slot because `workout_items_position_unique` is
	// enforced per statement: a straight swap collides with the row it is about
	// to overwrite.
	if _, err := h.pool.Exec(ctx,
		`UPDATE workout_items SET position = -1 WHERE workout_id = $1 AND position = 0`, id); err != nil {
		t.Fatalf("park first item: %v", err)
	}
	if _, err := h.pool.Exec(ctx,
		`UPDATE workout_items SET position = 3 WHERE workout_id = $1 AND position = 1`, id); err != nil {
		t.Fatalf("gap second item: %v", err)
	}
	if _, err := h.pool.Exec(ctx,
		`UPDATE workout_items SET position = 7 WHERE workout_id = $1 AND position = -1`, id); err != nil {
		t.Fatalf("gap first item: %v", err)
	}

	if err := h.repo.Create(ctx, alice,
		New{ToUsername: "sh_wdb_h", ResourceType: "workout", ResourceID: id}); err != nil {
		t.Fatalf("share: %v", err)
	}
	inbox, _ := h.repo.Inbox(ctx, bob)
	if len(inbox) != 1 {
		t.Fatalf("inbox: %+v", inbox)
	}
	got, err := h.repo.Accept(ctx, bob, inbox[0].ID)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	copied, err := h.wrks.Get(ctx, bob, got.ResourceID)
	if err != nil {
		t.Fatalf("read copy: %v", err)
	}
	if len(copied.Items) != 2 {
		t.Fatalf("copy has %d items, want 2", len(copied.Items))
	}
	if copied.Items[0].Position != 0 || copied.Items[1].Position != 1 {
		t.Fatalf("gapped positions were carried over: %d, %d",
			copied.Items[0].Position, copied.Items[1].Position)
	}
	// And the order came from POSITION while the gap was closed.
	//
	// Note the expectation is inverted relative to how the fixture was built:
	// the item created first sits at position 7 now, so it must come SECOND.
	// That is the whole point of inverting the gap — with the ids and the
	// positions agreeing, ordering by either produces this same list.
	if copied.Items[0].Notes != "second" || copied.Items[1].Notes != "first" {
		t.Fatalf("densifying did not order by position: %+v", copied.Items)
	}
}

// Revoking a workout's visibility between sending and accepting stops the copy.
//
// This is the arm `CopyTo` re-applies `visibleTo` for, and NOTHING ELSE HERE
// REACHES IT. Every other test either shares a row that stays visible, or
// deletes it outright — and against a deleted row a bare `WHERE id = $1` finds
// nothing either, so the deletion test passes with the predicate removed. It
// was mutated to a bare id and the suite stayed green.
//
// The failure it hides: Carol publishes a plan, Alice passes it on, Carol makes
// it private again, and Bob accepts — walking away with an owned copy of a
// private template that was never his to read. Authorization happened when the
// share was SENT; this is what makes it hold at the moment the copy is made.
func TestAcceptingStopsWhenTheWorkoutStopsBeingVisible(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "sh_wra", "sh_wra_h")
	bob := person(t, h.pool, "sh_wrb", "sh_wrb_h")
	carol := person(t, h.pool, "sh_wrc", "sh_wrc_h")
	befriend(t, h, alice, "sh_wra_h", bob, "sh_wrb_h")

	// Carol's, and published — so Alice may pass it on without owning it.
	id := makeWorkout(t, h, carol, "sh_wk_published", "Carol's Published Plan")
	if _, err := h.pool.Exec(ctx,
		`UPDATE workouts SET visibility = 'public' WHERE id = $1`, id); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if err := h.repo.Create(ctx, alice,
		New{ToUsername: "sh_wrb_h", ResourceType: "workout", ResourceID: id}); err != nil {
		t.Fatalf("share a published plan: %v", err)
	}
	inbox, _ := h.repo.Inbox(ctx, bob)
	if len(inbox) != 1 {
		t.Fatalf("inbox: %+v", inbox)
	}

	// Carol changes her mind. The row still exists; it is simply no longer
	// Alice's to hand out.
	if _, err := h.pool.Exec(ctx,
		`UPDATE workouts SET visibility = 'private' WHERE id = $1`, id); err != nil {
		t.Fatalf("unpublish: %v", err)
	}

	if _, err := h.repo.Accept(ctx, bob, inbox[0].ID); !errors.Is(err, ErrGone) {
		t.Fatalf("accepting a now-private workout: want ErrGone, got %v", err)
	}
	// And no copy was left behind by a half-committed transaction.
	var copies int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM workouts WHERE owner_user_id = $1`, bob).Scan(&copies); err != nil {
		t.Fatalf("count bob's workouts: %v", err)
	}
	if copies != 0 {
		t.Fatalf("bob ended up with %d copies of a private plan", copies)
	}
}
