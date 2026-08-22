package runstate

import (
	"context"
	"fmt"
)

// Metrics are DERIVED from the tables the engine already writes — never from
// extra instrumentation calls in workers. If a metric needs something new,
// the event schema is what changes, not the worker (the ticket's explicit
// constraint). Rates are -1 when there is no data: an empty denominator must
// read as "no data", never as a perfect 0 or 100.
type MetricsSnapshot struct {
	// System health
	QueueDepth  int // runs in QUEUED
	ActiveRuns  int // runs in any non-terminal state
	StaleLeases int // non-terminal runs whose lease has expired (crashed engines)
	BlockedRuns int
	// duplicate_delivery events — zero until the webhook gateway (N146)
	// records refusals as events; the query is ready for it.
	WebhookDuplicates int
	TerminalCounts    map[string]int // DONE / BLOCKED / FAILED / CANCELLED totals

	// Delivery (seconds; -1 = no data)
	AvgDispatchLatency float64 // run created → CLAIMED transition
	AvgLeadTime        float64 // run created → terminal transition
	AvgCIWait          float64 // total time spent in CI_WAIT per run
	// merge → evidence-latch release: the machine enters EVIDENCE_WAIT at
	// merge (when the label is applied) and leaves at DONE (when the latch
	// clears it), so this interval IS the latch's definition of the state.
	AvgEvidenceWait float64

	// Quality (-1 = no data)
	FirstPassGateRate float64 // runs whose gate steps contain zero fails / runs with gate steps
	AvgFixingLoops    float64 // FIXING transitions per run
	// Issues with more than one run: rework — the engine-side proxy for
	// reverts/escaped defects, since a second run on a finished issue is
	// exactly what a revert or a reopened defect produces here.
	ReworkedIssues int

	// ── Query-ready metrics whose data arrives with future emitters ──
	// Each reads -1 (or 0 for counts) until the named emitter exists; the
	// queries are written NOW so the emitters only add events/steps, never
	// metric code. This is the same treatment WebhookDuplicates already has.
	//
	// AC miss rate: fails/total over `gate:ac-verifier` step rows — N141's
	// worker records the ac-verifier as a gate.
	ACMissRate float64
	// Diff size and token cost per run: averages over `pr_opened` events'
	// payload->>'diff_lines' and `usage` events' payload->>'tokens' — N141
	// emits both when it opens a PR / finishes a model call.
	AvgDiffLines  float64
	AvgCostTokens float64
	// Scope violations (unrelated-file touches): count of
	// `scope_violation` events — N141's self-review emits one per file
	// outside the ticket's owned paths.
	ScopeViolations int
	// GitHub API budget: the newest `api_rate` event's payload->>'remaining'
	// — N146's gateway samples it. -1 until then.
	APIRateRemaining float64
	// Issues whose BLOCKED run was followed by a DONE run: the block was
	// resolvable after the named human action — the engine-side PROXY for
	// "correct vs unnecessary blocks". True correctness needs a human label
	// (only a person can say a block was unnecessary); this is deliberately
	// the measurable half, not the judgment.
	BlockedThenDoneIssues int
}

// Metrics computes the snapshot with plain SQL over agent_runs, agent_steps
// and agent_events.
func (s *Store) Metrics(ctx context.Context) (MetricsSnapshot, error) {
	m := MetricsSnapshot{TerminalCounts: map[string]int{},
		AvgDispatchLatency: -1, AvgLeadTime: -1, AvgCIWait: -1,
		AvgEvidenceWait: -1, FirstPassGateRate: -1, AvgFixingLoops: -1,
		ACMissRate: -1, AvgDiffLines: -1, AvgCostTokens: -1, APIRateRemaining: -1}

	terminalList := terminalSQL()

	// System health, one pass over agent_runs.
	rows, err := s.pool.Query(ctx, `
		SELECT state,
		       count(*),
		       count(*) FILTER (WHERE lease_expires_at <= now() AND state NOT IN (`+terminalList+`))
		FROM agent_runs GROUP BY state`)
	if err != nil {
		return m, fmt.Errorf("metrics: runs: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var state string
		var n, stale int
		if err := rows.Scan(&state, &n, &stale); err != nil {
			return m, err
		}
		switch State(state) {
		case Queued:
			m.QueueDepth += n
		}
		if Terminal(State(state)) {
			m.TerminalCounts[state] += n
		} else {
			m.ActiveRuns += n
			m.StaleLeases += stale
		}
		if State(state) == Blocked {
			m.BlockedRuns += n
		}
	}
	if err := rows.Err(); err != nil {
		return m, err
	}

	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM agent_events WHERE event_type = 'duplicate_delivery'`).
		Scan(&m.WebhookDuplicates); err != nil {
		return m, err
	}

	// Delivery: transition timestamps live in agent_events (payload->>'to').
	scanAvg := func(dst *float64, query string) error {
		var v *float64
		if err := s.pool.QueryRow(ctx, query).Scan(&v); err != nil {
			return err
		}
		if v != nil {
			*dst = *v
		}
		return nil
	}
	if err := scanAvg(&m.AvgDispatchLatency, `
		SELECT avg(EXTRACT(EPOCH FROM e.created_at - r.created_at))
		FROM agent_events e JOIN agent_runs r ON r.id = e.run_id
		WHERE e.event_type = 'transition' AND e.payload->>'to' = 'CLAIMED'`); err != nil {
		return m, err
	}
	if err := scanAvg(&m.AvgLeadTime, `
		SELECT avg(EXTRACT(EPOCH FROM e.created_at - r.created_at))
		FROM agent_events e JOIN agent_runs r ON r.id = e.run_id
		WHERE e.event_type = 'transition' AND e.payload->>'to' IN (`+terminalList+`)`); err != nil {
		return m, err
	}
	// CI wait: for each entry INTO CI_WAIT, the interval to that run's next
	// transition (lead() over the run's ordered transition events); summed
	// per run, averaged over runs that waited at all.
	if err := scanAvg(&m.AvgCIWait, `
		WITH t AS (
		    -- ORDER BY id, not created_at: within a run the single live
		    -- lease serializes inserts, so identity order IS transition
		    -- order, while created_at can tie at clock resolution and make
		    -- lead() nondeterministic.
		    SELECT run_id, payload->>'to' AS to_state, created_at,
		           lead(created_at) OVER (PARTITION BY run_id ORDER BY id) AS next_at
		    FROM agent_events WHERE event_type = 'transition'
		)
		SELECT avg(wait) FROM (
		    SELECT run_id, sum(EXTRACT(EPOCH FROM next_at - created_at)) AS wait
		    FROM t WHERE to_state = 'CI_WAIT' AND next_at IS NOT NULL
		    GROUP BY run_id
		) w`); err != nil {
		return m, err
	}
	if err := scanAvg(&m.AvgEvidenceWait, `
		WITH t AS (
		    SELECT run_id, payload->>'to' AS to_state, created_at,
		           lead(created_at) OVER (PARTITION BY run_id ORDER BY id) AS next_at
		    FROM agent_events WHERE event_type = 'transition'
		)
		SELECT avg(EXTRACT(EPOCH FROM next_at - created_at))
		FROM t WHERE to_state = 'EVIDENCE_WAIT' AND next_at IS NOT NULL`); err != nil {
		return m, err
	}

	// Quality: gates are `gate:%` step rows whose summary starts pass/fail
	// (RecordGates' format — one row per gate, distinguishable failures).
	var withGates, firstPass int
	if err := s.pool.QueryRow(ctx, `
		WITH g AS (
		    SELECT run_id,
		           count(*) FILTER (WHERE summary LIKE 'fail%') AS fails
		    FROM agent_steps WHERE step_type LIKE 'gate:%'
		    GROUP BY run_id
		)
		SELECT count(*), count(*) FILTER (WHERE fails = 0) FROM g`).
		Scan(&withGates, &firstPass); err != nil {
		return m, err
	}
	if withGates > 0 {
		m.FirstPassGateRate = float64(firstPass) / float64(withGates)
	}
	if err := scanAvg(&m.AvgFixingLoops, `
		SELECT avg(loops) FROM (
		    SELECT r.id, count(e.id) FILTER (WHERE e.payload->>'to' = 'FIXING') AS loops
		    FROM agent_runs r
		    LEFT JOIN agent_events e ON e.run_id = r.id AND e.event_type = 'transition'
		    GROUP BY r.id
		) l`); err != nil {
		return m, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM (
		    SELECT issue_number FROM agent_runs GROUP BY issue_number HAVING count(*) > 1
		) r`).Scan(&m.ReworkedIssues); err != nil {
		return m, err
	}

	// Future-emitter metrics: queries live, data arrives with N141/N146.
	var acTotal, acFail int
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE summary LIKE 'fail%')
		FROM agent_steps WHERE step_type = 'gate:ac-verifier'`).
		Scan(&acTotal, &acFail); err != nil {
		return m, err
	}
	if acTotal > 0 {
		m.ACMissRate = float64(acFail) / float64(acTotal)
	}
	if err := scanAvg(&m.AvgDiffLines, `
		SELECT avg((payload->>'diff_lines')::numeric)
		FROM agent_events WHERE event_type = 'pr_opened' AND payload ? 'diff_lines'`); err != nil {
		return m, err
	}
	if err := scanAvg(&m.AvgCostTokens, `
		SELECT avg((payload->>'tokens')::numeric)
		FROM agent_events WHERE event_type = 'usage' AND payload ? 'tokens'`); err != nil {
		return m, err
	}
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM agent_events WHERE event_type = 'scope_violation'`).
		Scan(&m.ScopeViolations); err != nil {
		return m, err
	}
	// Scalar subquery so zero events yields one NULL row (→ -1) rather than
	// zero rows (→ ErrNoRows).
	if err := scanAvg(&m.APIRateRemaining, `
		SELECT (SELECT (payload->>'remaining')::numeric FROM agent_events
		        WHERE event_type = 'api_rate' AND payload ? 'remaining'
		        ORDER BY id DESC LIMIT 1)`); err != nil {
		return m, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM (
		    SELECT b.issue_number
		    FROM agent_runs b
		    JOIN agent_runs d ON d.issue_number = b.issue_number AND d.id > b.id AND d.state = 'DONE'
		    WHERE b.state = 'BLOCKED'
		    GROUP BY b.issue_number
		) x`).Scan(&m.BlockedThenDoneIssues); err != nil {
		return m, err
	}
	return m, nil
}
