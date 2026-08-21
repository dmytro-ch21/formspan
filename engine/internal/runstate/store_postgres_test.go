package runstate

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// newTestStore gives each test its own SCHEMA in the TEST_DATABASE_URL
// database, with search_path pinned to it — so two test binaries (this repo
// routinely runs several) can never trample each other's rows. That is why
// this package takes no advisory lock: the backend's testdb lock exists
// because its packages share TABLES; these tests share only a database.
// Skips without TEST_DATABASE_URL, mirroring the backend convention — CI's
// Backend (Go) job exports it, so the engine step there always runs these.
func newTestStore(t *testing.T) (*Store, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()

	var raw [6]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal(err)
	}
	schema := "engine_test_" + hex.EncodeToString(raw[:])

	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}

	// Registered BEFORE the store pool exists, so a t.Fatal between the
	// CREATE SCHEMA above and any later step still drops the schema — an
	// early failure must not leak a schema into the shared database. LIFO
	// puts the pool's own Close (registered below) ahead of this.
	t.Cleanup(func() {
		// The drop is verified: a schema that silently survives would leak
		// rows into the shared database run after run.
		if _, err := admin.Exec(context.Background(),
			"DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Errorf("drop schema %s: %v", schema, err)
		}
		admin.Close()
	})

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return NewStore(pool, 30*time.Second), pool
}

func TestConcurrentClaimersExactlyOneWins(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	const claimers = 8
	var wg sync.WaitGroup
	results := make([]error, claimers)
	start := make(chan struct{})
	for i := 0; i < claimers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, results[i] = store.Claim(ctx, 559, fmt.Sprintf("engine-%d", i), "")
		}(i)
	}
	close(start)
	wg.Wait()

	wins, leased := 0, 0
	for _, err := range results {
		switch {
		case err == nil:
			wins++
		case errors.Is(err, ErrAlreadyLeased):
			leased++
		default:
			t.Fatalf("unexpected claim error: %v", err)
		}
	}
	if wins != 1 || leased != claimers-1 {
		t.Fatalf("wins=%d leased=%d, want exactly one winner (the DB constraint decides, not app logic)", wins, leased)
	}
}

func TestStaleLeaseIsRecoverableAndALiveOneIsNot(t *testing.T) {
	store, pool := newTestStore(t)
	ctx := context.Background()

	run, err := store.Claim(ctx, 100, "engine-a", "")
	if err != nil {
		t.Fatal(err)
	}
	// A live lease cannot be taken over.
	if err := store.TakeOver(ctx, run.ID, "engine-b"); !errors.Is(err, ErrNotStale) {
		t.Fatalf("live lease taken over: %v", err)
	}
	// Expire it — the crashed-engine case: heartbeats simply stop.
	if _, err := pool.Exec(ctx,
		`UPDATE agent_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
		run.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.TakeOver(ctx, run.ID, "engine-b"); err != nil {
		t.Fatalf("stale lease not recoverable: %v", err)
	}
	// The dispossessed owner's heartbeat must fail, not resurrect the lease.
	if err := store.Heartbeat(ctx, run.ID, "engine-a"); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("old owner heartbeat: %v, want ErrLeaseLost", err)
	}
	if err := store.Heartbeat(ctx, run.ID, "engine-b"); err != nil {
		t.Fatalf("new owner heartbeat: %v", err)
	}
	events, err := store.Events(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(events, "lease_taken_over") {
		t.Fatalf("takeover not recorded: %v", events)
	}
}

func TestAnExpiredLeaseIsDeadToItsOwnOwnerEvenBeforeTakeover(t *testing.T) {
	// The window only the expiry guards cover: the lease has expired but
	// nobody has taken it over yet. The old owner's late heartbeat,
	// transition and step must ALL fail — without these tests, deleting the
	// `lease_expires_at > now()` guards passes the whole suite, because
	// after a takeover the owner check alone rejects the old owner. Found in
	// review; this is the "a guard whose outcome is redundant still needs a
	// test" rule made concrete.
	store, pool := newTestStore(t)
	ctx := context.Background()

	run, err := store.Claim(ctx, 600, "engine-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE agent_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
		run.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.Heartbeat(ctx, run.ID, "engine-a"); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("expired-owner heartbeat: %v, want ErrLeaseLost", err)
	}
	if err := store.Transition(ctx, run.ID, "engine-a", Claimed); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("expired-owner transition: %v, want ErrLeaseLost", err)
	}
	if err := store.AppendStep(ctx, run.ID, "engine-a", "verify", "", "", nil); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("expired-owner step: %v, want ErrLeaseLost", err)
	}
}

func TestATerminalRunCannotBeTakenOver(t *testing.T) {
	// A finished run's lease timestamp is inevitably in the past; "taking it
	// over" would mint a phantom lease beside whatever new active run exists.
	store, pool := newTestStore(t)
	ctx := context.Background()

	run, err := store.Claim(ctx, 700, "engine-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Transition(ctx, run.ID, "engine-a", Claimed); err != nil {
		t.Fatal(err)
	}
	if err := store.Transition(ctx, run.ID, "engine-a", Failed); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE agent_runs SET lease_expires_at = now() - interval '1 hour' WHERE id = $1`,
		run.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.TakeOver(ctx, run.ID, "engine-b"); !errors.Is(err, ErrNotStale) {
		t.Fatalf("terminal run taken over: %v", err)
	}
}

func TestBothConstraintsViolatedReadsAsDuplicateDelivery(t *testing.T) {
	// A webhook redelivery DURING an active run violates both constraints at
	// once; which sentinel wins is decided by Postgres index-check order,
	// which follows creation order in migration 1. ErrDuplicateDelivery is
	// the answer the webhook gateway (N146) needs — a redelivery must read
	// as an idempotent duplicate, not as lease contention. This ORDERING IS
	// LOAD-BEARING and this test is what pins it: a future migration that
	// recreates either index can flip it silently otherwise. Found in review.
	store, _ := newTestStore(t)
	ctx := context.Background()

	if _, err := store.Claim(ctx, 800, "engine-a", "dup-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(ctx, 800, "engine-b", "dup-1"); !errors.Is(err, ErrDuplicateDelivery) {
		t.Fatalf("double violation classified as %v, want ErrDuplicateDelivery", err)
	}
}

func TestIllegalTransitionIsASentinel(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	run, err := store.Claim(ctx, 900, "engine-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Transition(ctx, run.ID, "engine-a", Done); !errors.Is(err, ErrIllegalTransition) {
		t.Fatalf("refused edge not marked ErrIllegalTransition: %v", err)
	}
}

func TestDeliveryIDIsConsumedExactlyOnce(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	if _, err := store.Claim(ctx, 200, "engine-a", "delivery-123"); err != nil {
		t.Fatal(err)
	}
	// Same delivery, DIFFERENT issue — only the delivery constraint can
	// refuse this one (the lease index would not).
	if _, err := store.Claim(ctx, 201, "engine-a", "delivery-123"); !errors.Is(err, ErrDuplicateDelivery) {
		t.Fatalf("duplicate delivery accepted: %v", err)
	}
	// Empty delivery ids never collide (polling runs have none).
	if _, err := store.Claim(ctx, 202, "engine-a", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Claim(ctx, 203, "engine-a", ""); err != nil {
		t.Fatal(err)
	}
}

func TestTransitionsAreValidatedAndRefusalsRecorded(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	run, err := store.Claim(ctx, 300, "engine-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Transition(ctx, run.ID, "engine-a", Claimed); err != nil {
		t.Fatal(err)
	}
	// Illegal: CLAIMED → DONE skips the entire pipeline.
	if err := store.Transition(ctx, run.ID, "engine-a", Done); err == nil {
		t.Fatal("illegal transition accepted")
	}
	got, err := store.Get(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != Claimed {
		t.Fatalf("state moved to %s on a refused transition", got.State)
	}
	events, err := store.Events(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(events, "transition") || !contains(events, "transition_refused") {
		t.Fatalf("events = %v, want both the transition and the refusal recorded", events)
	}
	// A transition without the lease is refused outright.
	if err := store.Transition(ctx, run.ID, "engine-b", Context); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("transition without the lease: %v, want ErrLeaseLost", err)
	}
}

func TestATerminalStateFreesTheIssueForANewRun(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	run, err := store.Claim(ctx, 400, "engine-a", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Transition(ctx, run.ID, "engine-a", Claimed); err != nil {
		t.Fatal(err)
	}
	// Second claim while active: refused by the index.
	if _, err := store.Claim(ctx, 400, "engine-b", ""); !errors.Is(err, ErrAlreadyLeased) {
		t.Fatalf("second active claim: %v, want ErrAlreadyLeased", err)
	}
	if err := store.Transition(ctx, run.ID, "engine-a", Blocked); err != nil {
		t.Fatal(err)
	}
	// Blocked is terminal: the issue is claimable again (unblocking is a
	// NEW run), and the partial index no longer counts the old row.
	if _, err := store.Claim(ctx, 400, "engine-b", ""); err != nil {
		t.Fatalf("issue not claimable after terminal state: %v", err)
	}
}

func TestStepsAppendInSequence(t *testing.T) {
	store, pool := newTestStore(t)
	ctx := context.Background()

	run, err := store.Claim(ctx, 500, "engine-a", "")
	if err != nil {
		t.Fatal(err)
	}
	code := 0
	if err := store.AppendStep(ctx, run.ID, "engine-a", "verify", "pnpm run verify", "green", &code); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendStep(ctx, run.ID, "engine-a", "review", "ac-verifier", "4 MET", nil); err != nil {
		t.Fatal(err)
	}
	// A non-owner's step never lands.
	if err := store.AppendStep(ctx, run.ID, "engine-x", "sneak", "", "", nil); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("non-owner step: %v, want ErrLeaseLost", err)
	}
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM agent_steps WHERE run_id = $1`, run.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("steps = %d, want 2", n)
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

func TestRecordGatesWritesOneDistinguishableStepPerGate(t *testing.T) {
	store, pool := newTestStore(t)
	ctx := context.Background()
	run, err := store.Claim(ctx, 1000, "engine-a", "")
	if err != nil {
		t.Fatal(err)
	}
	code3 := 3
	outcomes := []GateOutcome{
		{Name: "verify", Passed: true, ExitCode: new(int)},
		{Name: "backend-tests", Passed: false, Output: "TestX failed", ExitCode: &code3},
		{Name: "secrets-in-diff", Passed: false, Output: "added diff line 4 matches a GitHub PAT"},
	}
	if err := store.RecordGates(ctx, run.ID, "engine-a", outcomes); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx,
		`SELECT step_type, summary FROM agent_steps WHERE run_id = $1 ORDER BY seq`, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var types, summaries []string
	for rows.Next() {
		var st, sum string
		if err := rows.Scan(&st, &sum); err != nil {
			t.Fatal(err)
		}
		types = append(types, st)
		summaries = append(summaries, sum)
	}
	if len(types) != 3 || types[0] != "gate:verify" || types[1] != "gate:backend-tests" || types[2] != "gate:secrets-in-diff" {
		t.Fatalf("step types = %v, want one per gate in order", types)
	}
	// Two failing gates are two distinguishable failures.
	if summaries[1] == summaries[2] || !contains(summaries, "fail: TestX failed") {
		t.Fatalf("summaries not distinguishable: %v", summaries)
	}
	// A dispossessed engine cannot write gate history.
	if err := store.RecordGates(ctx, run.ID, "engine-x", outcomes[:1]); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("non-owner RecordGates: %v, want ErrLeaseLost", err)
	}
}
