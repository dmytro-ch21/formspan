package worker

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// probeReadWrite is the "small real write/read against its own database"
// N150/#554's design guidance names for the 5-concurrent-workers
// reproduction — real Postgres traffic against the run's own ephemeral
// database and role, not a no-op connect.
func probeReadWrite(ctx context.Context, dbURL string) error {
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `CREATE TABLE worker_probe(x int)`); err != nil {
		return fmt.Errorf("create: %w", err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO worker_probe(x) VALUES (1)`); err != nil {
		return fmt.Errorf("insert: %w", err)
	}
	var x int
	if err := conn.QueryRow(ctx, `SELECT x FROM worker_probe`).Scan(&x); err != nil {
		return fmt.Errorf("select: %w", err)
	}
	if x != 1 {
		return fmt.Errorf("round-trip mismatch: got %d, want 1", x)
	}
	return nil
}

// TestFiveConcurrentWorkersProvisionWithoutSerializing is steps-to-test #1
// from N150/#554, reproduced the way its own design guidance says a
// sandboxed run without a live orchestrator actually can: 5 real
// goroutines, each provisioning its OWN ephemeral database via
// Runner.Provision and doing a real write/read against it, timed against a
// single-worker baseline. Provision never touches
// backend/internal/platform/testdb's advisory lock at all (grep the
// package — nothing here imports it), so there is structurally nothing to
// queue behind; this test's timing is the live proof of that, not just the
// import-graph argument.
//
// Pass: total wall clock stays close to the single-worker baseline (bounded
// generously below to absorb this host's own variance, not to prove
// perfect scaling). Fail: wall clock scales roughly linearly with worker
// count, which is exactly what the FLEET-AT-AI-SCALE problem this ticket
// exists to avoid would look like.
func TestFiveConcurrentWorkersProvisionWithoutSerializing(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	src, first, _ := makeSourceRepo(t)

	// Baseline: one worker's own full cycle, run alone first, as what "5
	// truly concurrent" is judged against below.
	rBaseline := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin}
	baselineStart := time.Now()
	wsBaseline, err := rBaseline.Provision(ctx, 9300, 1, "baseline", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := probeReadWrite(ctx, wsBaseline.DBURL); err != nil {
		t.Fatal(err)
	}
	if err := wsBaseline.Teardown(ctx); err != nil {
		t.Fatal(err)
	}
	baseline := time.Since(baselineStart)

	const n = 5
	var wg sync.WaitGroup
	errs := make([]error, n)
	durations := make([]time.Duration, n)
	start := time.Now()
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin}
			s := time.Now()
			ws, err := r.Provision(ctx, int64(9301+i), 1, fmt.Sprintf("worker-%d", i), first, nil, "")
			if err != nil {
				errs[i] = fmt.Errorf("provision: %w", err)
				return
			}
			defer ws.Teardown(context.Background())
			if err := probeReadWrite(ctx, ws.DBURL); err != nil {
				errs[i] = fmt.Errorf("probe: %w", err)
				return
			}
			durations[i] = time.Since(s)
		}(i)
	}
	wg.Wait()
	elapsed := time.Since(start)

	for i, err := range errs {
		if err != nil {
			t.Fatalf("worker %d failed: %v", i, err)
		}
	}

	t.Logf("single-worker baseline: %s", baseline)
	t.Logf("5 concurrent workers, total wall clock: %s (per-worker: %v)", elapsed, durations)

	// A generous multiple, not a tight bound: this host's own Docker/
	// Postgres load varies (CLAUDE.md's own "Known gotchas" names this
	// exact host's Colima VM as small and shared by every concurrent
	// session), and the claim under test is "not serialized", not "scales
	// perfectly". Linear-with-worker-count would put this at roughly 5x;
	// 3x is comfortably below that while still well above what genuine
	// parallelism costs in practice.
	if elapsed > baseline*3 {
		t.Fatalf("5 concurrent workers took %s, more than 3x the %s single-worker baseline — "+
			"this looks serialized (queued behind something shared), not parallel", elapsed, baseline)
	}
}
