package runstate

import (
	"context"
	"math"
	"testing"
	"time"
)

// setEventTime pins a transition event's timestamp so duration metrics are
// exact rather than tolerance-based — fixture time, not wall time.
func setEventTime(t *testing.T, store *Store, runID int64, toState string, at time.Time) {
	t.Helper()
	tag, err := store.pool.Exec(context.Background(), `
		UPDATE agent_events SET created_at = $3
		WHERE run_id = $1 AND event_type = 'transition' AND payload->>'to' = $2`,
		runID, toState, at)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() == 0 {
		t.Fatalf("no %s transition event for run %d — the fixture is not what this test believes", toState, runID)
	}
}

func setRunCreated(t *testing.T, store *Store, runID int64, at time.Time) {
	t.Helper()
	if _, err := store.pool.Exec(context.Background(),
		`UPDATE agent_runs SET created_at = $2 WHERE id = $1`, runID, at); err != nil {
		t.Fatal(err)
	}
}

func driveTo(t *testing.T, store *Store, runID int64, owner string, states ...State) {
	t.Helper()
	for _, s := range states {
		if err := store.Transition(context.Background(), runID, owner, s); err != nil {
			t.Fatalf("transition to %s: %v", s, err)
		}
	}
}

// approx is for SECONDS-scale durations only. Rates and per-run counts live
// on a 0–1-ish scale where a 0.5 tolerance cannot fail — review proved two
// broken filters survived it — so they use exact, which can.
func approx(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 0.5 {
		t.Fatalf("%s = %v, want %v", name, got, want)
	}
}

func exact(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("%s = %v, want exactly %v", name, got, want)
	}
}

func TestMetricsOverFixtureRunHistories(t *testing.T) {
	store, pool := newTestStore(t)
	ctx := context.Background()
	t0 := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)

	// Run A: full happy path, 10s dispatch latency, 60s in CI_WAIT with one
	// FIXING loop (40s + 20s), 300s evidence wait, DONE at t0+600s.
	a, err := store.Claim(ctx, 1, "e", "")
	if err != nil {
		t.Fatal(err)
	}
	// Gate history first, while the lease is live (AppendStep requires it):
	// one fail then all pass — NOT a first-pass run.
	code := 1
	if err := store.RecordGates(ctx, a.ID, "e", []GateOutcome{
		{Name: "verify", Passed: false, Output: "TestX failed", ExitCode: &code},
		{Name: "verify", Passed: true},
	}); err != nil {
		t.Fatal(err)
	}
	driveTo(t, store, a.ID, "e", Claimed, Context, Planning, Implementing,
		LocalVerify, SelfReview, PROpen, CIWait, Fixing, LocalVerify,
		SelfReview, PROpen, CIWait, ACVerify, ReadyToMerge, Merging, EvidenceWait, Done)
	setRunCreated(t, store, a.ID, t0)
	setEventTime(t, store, a.ID, "CLAIMED", t0.Add(10*time.Second))
	// First CI_WAIT entry → FIXING after 40s; second → AC_VERIFY after 20s.
	if _, err := pool.Exec(ctx, `
		UPDATE agent_events SET created_at = CASE
		    WHEN id = (SELECT min(id) FROM agent_events WHERE run_id=$1 AND payload->>'to'='CI_WAIT') THEN $2::timestamptz
		    WHEN id = (SELECT max(id) FROM agent_events WHERE run_id=$1 AND payload->>'to'='CI_WAIT') THEN $3::timestamptz
		    ELSE created_at END
		WHERE run_id = $1 AND payload->>'to' = 'CI_WAIT'`,
		a.ID, t0.Add(100*time.Second), t0.Add(200*time.Second)); err != nil {
		t.Fatal(err)
	}
	setEventTime(t, store, a.ID, "FIXING", t0.Add(140*time.Second))    // 40s after first CI_WAIT
	setEventTime(t, store, a.ID, "AC_VERIFY", t0.Add(220*time.Second)) // 20s after second
	setEventTime(t, store, a.ID, "EVIDENCE_WAIT", t0.Add(300*time.Second))
	setEventTime(t, store, a.ID, "DONE", t0.Add(600*time.Second))

	// Run B: blocked immediately after claim; first-pass gates.
	b, err := store.Claim(ctx, 2, "e", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RecordGates(ctx, b.ID, "e", []GateOutcome{{Name: "verify", Passed: true}}); err != nil {
		t.Fatal(err)
	}
	driveTo(t, store, b.ID, "e", Claimed, Blocked)
	setRunCreated(t, store, b.ID, t0)
	setEventTime(t, store, b.ID, "CLAIMED", t0.Add(30*time.Second))
	setEventTime(t, store, b.ID, "BLOCKED", t0.Add(90*time.Second))

	// Run C: a SECOND run on issue 1 — rework — still queued, stale lease.
	c, err := store.Claim(ctx, 1, "e2", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE agent_runs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, c.ID); err != nil {
		t.Fatal(err)
	}
	// A duplicate-delivery event (what N146's gateway will record).
	if _, err := pool.Exec(ctx,
		`INSERT INTO agent_events (run_id, event_type, payload) VALUES ($1, 'duplicate_delivery', '{}')`, c.ID); err != nil {
		t.Fatal(err)
	}

	m, err := store.Metrics(ctx)
	if err != nil {
		t.Fatal(err)
	}

	if m.QueueDepth != 1 || m.ActiveRuns != 1 || m.StaleLeases != 1 {
		t.Fatalf("health: %+v", m)
	}
	if m.TerminalCounts["DONE"] != 1 || m.TerminalCounts["BLOCKED"] != 1 || m.BlockedRuns != 1 {
		t.Fatalf("terminals: %+v", m)
	}
	if m.WebhookDuplicates != 1 {
		t.Fatalf("dupes = %d", m.WebhookDuplicates)
	}
	approx(t, "dispatch latency", m.AvgDispatchLatency, 20)    // (10+30)/2
	approx(t, "lead time", m.AvgLeadTime, (600+90)/2.0)        // A 600s, B 90s
	approx(t, "ci wait", m.AvgCIWait, 60)                      // A: 40+20, only run with CI_WAIT
	approx(t, "evidence wait", m.AvgEvidenceWait, 300)         // A only
	exact(t, "first-pass gate rate", m.FirstPassGateRate, 0.5) // B yes, A no
	exact(t, "fixing loops", m.AvgFixingLoops, 1.0/3.0)        // A:1, B:0, C:0
	if m.ReworkedIssues != 1 {
		t.Fatalf("reworked = %d, want issue 1 counted once", m.ReworkedIssues)
	}
	// Issue 1: run A DONE after... no BLOCKED run precedes a DONE here, so
	// the blocked-then-done proxy reads zero on this fixture.
	if m.BlockedThenDoneIssues != 0 {
		t.Fatalf("blocked-then-done = %d", m.BlockedThenDoneIssues)
	}
}

func TestFutureEmitterMetricsComputeOnceTheirEventsExist(t *testing.T) {
	// The six query-ready metrics must be real queries, not compiling
	// placeholders: synthetic emitter rows (exactly what N141/N146 will
	// write) must produce the expected numbers.
	store, pool := newTestStore(t)
	ctx := context.Background()
	r, err := store.Claim(ctx, 900, "e", "")
	if err != nil {
		t.Fatal(err)
	}
	// ac-verifier recorded as a gate: 1 fail of 2 → 0.5.
	if err := store.RecordGates(ctx, r.ID, "e", []GateOutcome{
		{Name: "ac-verifier", Passed: false, Output: "1 NOT MET"},
		{Name: "ac-verifier", Passed: true},
	}); err != nil {
		t.Fatal(err)
	}
	for _, ins := range []string{
		`INSERT INTO agent_events (run_id, event_type, payload) VALUES ($1, 'pr_opened', '{"diff_lines": 120}')`,
		`INSERT INTO agent_events (run_id, event_type, payload) VALUES ($1, 'pr_opened', '{"diff_lines": 80}')`,
		`INSERT INTO agent_events (run_id, event_type, payload) VALUES ($1, 'usage', '{"tokens": 5000}')`,
		`INSERT INTO agent_events (run_id, event_type, payload) VALUES ($1, 'scope_violation', '{"path": "apps/web/x.ts"}')`,
		`INSERT INTO agent_events (run_id, event_type, payload) VALUES ($1, 'api_rate', '{"remaining": 4200}')`,
		`INSERT INTO agent_events (run_id, event_type, payload) VALUES ($1, 'api_rate', '{"remaining": 3900}')`,
	} {
		if _, err := pool.Exec(ctx, ins, r.ID); err != nil {
			t.Fatal(err)
		}
	}
	// Blocked-then-done proxy: issue 901 blocks, then a second run finishes.
	b1, err := store.Claim(ctx, 901, "e", "")
	if err != nil {
		t.Fatal(err)
	}
	driveTo(t, store, b1.ID, "e", Claimed, Blocked)
	b2, err := store.Claim(ctx, 901, "e", "")
	if err != nil {
		t.Fatal(err)
	}
	driveTo(t, store, b2.ID, "e", Claimed, Context, Planning, Implementing,
		LocalVerify, SelfReview, PROpen, CIWait, ACVerify, ReadyToMerge, Merging, Done)

	m, err := store.Metrics(ctx)
	if err != nil {
		t.Fatal(err)
	}
	exact(t, "ac miss rate", m.ACMissRate, 0.5)
	exact(t, "diff lines", m.AvgDiffLines, 100)
	exact(t, "cost tokens", m.AvgCostTokens, 5000)
	if m.ScopeViolations != 1 {
		t.Fatalf("scope violations = %d", m.ScopeViolations)
	}
	exact(t, "api rate remaining (newest)", m.APIRateRemaining, 3900)
	if m.BlockedThenDoneIssues != 1 {
		t.Fatalf("blocked-then-done = %d, want issue 901", m.BlockedThenDoneIssues)
	}
}

func TestMetricsOnAnEmptyDatabaseSayNoDataNotPerfect(t *testing.T) {
	store, _ := newTestStore(t)
	m, err := store.Metrics(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// An empty denominator must read as "no data" (-1), never as a perfect
	// score — a dashboard congratulating an engine that has done nothing is
	// the absence-reads-as-answer failure with a graph on it.
	for name, v := range map[string]float64{
		"dispatch": m.AvgDispatchLatency, "lead": m.AvgLeadTime,
		"ci": m.AvgCIWait, "evidence": m.AvgEvidenceWait,
		"first-pass": m.FirstPassGateRate, "fixing-loops": m.AvgFixingLoops,
		"ac-miss": m.ACMissRate, "diff-lines": m.AvgDiffLines,
		"cost-tokens": m.AvgCostTokens, "api-rate": m.APIRateRemaining,
	} {
		if v != -1 {
			t.Fatalf("%s = %v on empty data, want -1", name, v)
		}
	}
	if m.QueueDepth != 0 || m.ActiveRuns != 0 || m.ReworkedIssues != 0 {
		t.Fatalf("counts nonzero on empty data: %+v", m)
	}
}

func TestEvidenceWaitMatchesTheLatchWindow(t *testing.T) {
	// The machine enters EVIDENCE_WAIT at merge (label applied) and leaves at
	// DONE (latch released) — so the metric's window IS the latch's state, by
	// construction. This pins the two transitions the window hangs on.
	store, _ := newTestStore(t)
	ctx := context.Background()
	r, err := store.Claim(ctx, 700, "e", "")
	if err != nil {
		t.Fatal(err)
	}
	driveTo(t, store, r.ID, "e", Claimed, Context, Planning, Implementing,
		LocalVerify, SelfReview, PROpen, CIWait, ACVerify, ReadyToMerge, Merging, EvidenceWait, Done)
	t0 := time.Date(2026, 8, 21, 15, 0, 0, 0, time.UTC)
	setEventTime(t, store, r.ID, "EVIDENCE_WAIT", t0)
	setEventTime(t, store, r.ID, "DONE", t0.Add(48*time.Hour))
	m, err := store.Metrics(ctx)
	if err != nil {
		t.Fatal(err)
	}
	approx(t, "evidence wait", m.AvgEvidenceWait, 48*3600)
}

// Guard against the fixture-vs-belief trap: driveTo fails loudly on an
// illegal chain, so a machine edit that reshapes the path breaks these
// fixtures visibly instead of leaving them measuring a different history.
func TestDriveToRefusesAnIllegalChain(t *testing.T) {
	store, _ := newTestStore(t)
	r, err := store.Claim(context.Background(), 800, "e", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Transition(context.Background(), r.ID, "e", Done); err == nil {
		t.Fatal("illegal chain accepted")
	}
}
