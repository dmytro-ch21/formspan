package devengine

import (
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/engine/internal/runstate"
)

// Every breaker gets a trip case and a non-trip case, table-driven, so
// disabling any single breaker turns exactly its trip case red.
func TestEveryBreakerTripsAndClears(t *testing.T) {
	cfg := testConfig(t)
	clean := BreakerInput{IssueBody: goodBody}

	cases := []struct {
		breaker string
		trip    BreakerInput
		unblock string // substring the comment must carry
	}{
		{"no-acceptance-criteria",
			BreakerInput{IssueBody: "## Athlete outcome\nvibes\n"},
			"Acceptance criteria"},
		{"product-decision-needed",
			BreakerInput{IssueBody: goodBody + "\n## Non-goals\npricing is TBD\n"},
			"product decision"},
		{"ci-budget-exhausted",
			BreakerInput{IssueBody: goodBody, Budget: &FixBudget{Max: 3, MaxInfra: 9, CodeAttempts: 4}},
			"failing checks"},
		{"semantic-merge-conflict",
			BreakerInput{IssueBody: goodBody, SemanticConflict: true},
			"may not pick a side"},
		{"credential-in-diff",
			BreakerInput{IssueBody: goodBody, Diff: "+++ b/x.go\n+key := \"sk-" + strings.Repeat("a", 24) + "\"\n"},
			"never ships or handles live secrets"},
		{"destructive-migration",
			BreakerInput{IssueBody: goodBody,
				TouchedPaths: []string{"backend/migrations/000099_drop.up.sql"},
				Diff:         "+++ b/backend/migrations/000099_drop.up.sql\n+DROP TABLE sessions;\n"},
			"destructive schema changes"},
		{"auth-boundary-change",
			BreakerInput{IssueBody: goodBody, TouchedPaths: []string{"backend/internal/platform/auth/verify.go"}},
			"never self-approves security changes"},
		{"runtime-budget-exceeded",
			BreakerInput{IssueBody: goodBody, RuntimeExceeded: true},
			"budget"},
		{"provider-outage",
			BreakerInput{IssueBody: goodBody, ProviderDown: true},
			"re-dispatch when it recovers"},
	}

	byName := map[string]Breaker{}
	for _, b := range Breakers(cfg) {
		byName[b.Name] = b
	}
	for _, tc := range cases {
		t.Run(tc.breaker, func(t *testing.T) {
			b, ok := byName[tc.breaker]
			if !ok {
				t.Fatalf("no breaker named %q — the set lost one", tc.breaker)
			}
			tripped, unblock := b.Trip(tc.trip)
			if !tripped {
				t.Fatal("trip case did not trip")
			}
			if unblock == "" || !strings.Contains(unblock, tc.unblock) {
				t.Fatalf("unblock does not name the human action: %q", unblock)
			}
			if tripped, _ := b.Trip(clean); tripped {
				t.Fatal("clean input tripped")
			}
		})
	}
	if len(cases) != len(Breakers(cfg)) {
		t.Fatalf("breaker set has %d entries, tests cover %d — every breaker needs a trip AND clear case", len(Breakers(cfg)), len(cases))
	}
}

func TestDestructiveSQLBranchesEachTrip(t *testing.T) {
	// Review gutted the regex to DROP TABLE only and the suite stayed green —
	// every branch needs its own trip case, in the repo's ACTUAL idioms:
	// column drops here are ALTER TABLE statements (measured), and DELETE
	// FROM carries its WHERE on the next line.
	cfg := testConfig(t)
	var b Breaker
	for _, cand := range Breakers(cfg) {
		if cand.Name == "destructive-migration" {
			b = cand
		}
	}
	if b.Name == "" {
		t.Fatal("destructive-migration breaker not found")
	}
	up := func(sql string) BreakerInput {
		return BreakerInput{IssueBody: goodBody,
			TouchedPaths: []string{"backend/migrations/000099_x.up.sql"},
			Diff:         "+++ b/backend/migrations/000099_x.up.sql\n+" + sql + "\n"}
	}
	for _, sql := range []string{
		"ALTER TABLE profiles DROP COLUMN IF EXISTS activity_level;",
		"DROP TABLE sessions;",
		"drop schema engine cascade;",
		"TRUNCATE profiles, sessions;",
		"DELETE FROM sessions",
	} {
		if tripped, _ := b.Trip(up(sql)); !tripped {
			t.Fatalf("destructive up.sql line not caught: %q", sql)
		}
	}
	// A down file dropping what its up created is the NORMAL case and must
	// not trip — otherwise every schema-adding ticket blocks forever.
	down := BreakerInput{IssueBody: goodBody,
		TouchedPaths: []string{"backend/migrations/000099_x.up.sql", "backend/migrations/000099_x.down.sql"},
		Diff: "+++ b/backend/migrations/000099_x.up.sql\n+CREATE TABLE widgets (id int);\n" +
			"+++ b/backend/migrations/000099_x.down.sql\n+DROP TABLE widgets;\n"}
	if tripped, _ := b.Trip(down); tripped {
		t.Fatal("a down file dropping its own up's table tripped the breaker")
	}
	// A NON-migration file in the same diff carrying a SQL literal (the
	// fixture-cleanup idiom) must not trip either.
	mixed := BreakerInput{IssueBody: goodBody,
		TouchedPaths: []string{"backend/migrations/000099_x.up.sql", "backend/internal/modules/x/fixture_test.go"},
		Diff: "+++ b/backend/migrations/000099_x.up.sql\n+CREATE TABLE widgets (id int);\n" +
			"+++ b/backend/internal/modules/x/fixture_test.go\n+\tDELETE FROM widgets WHERE id = $1\n"}
	if tripped, _ := b.Trip(mixed); tripped {
		t.Fatal("a test file's SQL literal tripped the migration breaker")
	}
}

func TestCIBudgetUnderBothLimitsDoesNotTrip(t *testing.T) {
	cfg := testConfig(t)
	var b Breaker
	for _, cand := range Breakers(cfg) {
		if cand.Name == "ci-budget-exhausted" {
			b = cand
		}
	}
	in := BreakerInput{IssueBody: goodBody, Budget: &FixBudget{Max: 3, MaxInfra: 9, CodeAttempts: 2, InfraRetries: 4}}
	if tripped, _ := b.Trip(in); tripped {
		t.Fatal("an under-limit budget tripped the breaker")
	}
}

func TestPolicyHumanGateAdditionsAlsoRefuseAutoMerge(t *testing.T) {
	// The gate is the UNION of the hardcoded floor and policy.json's
	// human_gate: config may ADD gates it can never REMOVE. Against the REAL
	// checked-in policy (Fatal-not-Skip), every entry must refuse even with
	// the flag simulated on — a policy addition the Go floor lacks must not
	// gate preflight while the merge decision silently ignores it.
	cfg, err := LoadConfig("../../../.vola-agent")
	if err != nil {
		t.Fatalf(".vola-agent not readable from the repo root: %v", err)
	}
	cfg.Policy.AutoMerge.Enabled = true
	cfg.Policy.AutoMerge.AllowedRisk = []string{"low"}
	for _, label := range cfg.Policy.HumanGate.Labels {
		if ok, _ := CanAutoMerge(cfg, "low", []string{label}, nil, false); ok {
			t.Fatalf("policy human_gate label %q auto-merged", label)
		}
	}
	for _, pattern := range cfg.Policy.HumanGate.Paths {
		touched := globPrefix(pattern)
		if touched != pattern {
			touched = touched + "/somefile.go"
		}
		if ok, _ := CanAutoMerge(cfg, "low", nil, []string{touched}, false); ok {
			t.Fatalf("policy human_gate path %q auto-merged", pattern)
		}
	}
}

func TestABlockedRunNamesEveryReason(t *testing.T) {
	cfg := testConfig(t)
	in := BreakerInput{
		IssueBody:        "## Athlete outcome\nvibes with TBD choices\n",
		SemanticConflict: true,
	}
	reasons := RunBreakers(cfg, in)
	if len(reasons) != 3 { // no AC + product decision + conflict
		t.Fatalf("reasons = %+v, want all three named", reasons)
	}
	comment := BlockedComment(reasons)
	for _, want := range []string{"no-acceptance-criteria", "product-decision-needed", "semantic-merge-conflict", "human"} {
		if !strings.Contains(comment, want) {
			t.Fatalf("comment missing %q:\n%s", want, comment)
		}
	}
}

func TestEngineCommentsNeverOpenALineWithTheEvidenceGesture(t *testing.T) {
	// The latch reads column zero and once attested to its own instructions.
	// The engine posts no attestation gestures: no generated comment may
	// start a line with the slash-evidence token.
	cfg := testConfig(t)
	in := BreakerInput{IssueBody: "no criteria here", SemanticConflict: true, ProviderDown: true,
		Budget: &FixBudget{Max: 3, MaxInfra: 9, CodeAttempts: 4}}
	texts := []string{
		BlockedComment(RunBreakers(cfg, in)),
		(&FixBudget{Max: 3, CodeAttempts: 4}).Diagnosis(CIVerdict{State: CIFailed, Reason: "failed: X"}),
	}
	gesture := "/" + "evidence" // built by concatenation so THIS file cannot arm anything either
	for _, text := range texts {
		for _, line := range strings.Split(text, "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), gesture) && strings.HasPrefix(line, gesture) {
				t.Fatalf("generated comment opens a line with the evidence gesture:\n%s", text)
			}
		}
	}
}

func TestHumanGatedCategoriesNeverAutoMergeEvenWithTheFlagOn(t *testing.T) {
	// The category gate is INDEPENDENT of policy.json's auto_merge block:
	// flipping `enabled` must never be sufficient to let an auth change
	// self-approve. Simulated future phase: enabled=true, risk allowed.
	cfg := testConfig(t)
	cfg.Policy.AutoMerge.Enabled = true
	cfg.Policy.AutoMerge.AllowedRisk = []string{"low"}

	cases := []struct {
		name    string
		labels  []string
		touched []string
	}{
		{"security label", []string{"security"}, nil},
		{"billing label", []string{"billing"}, nil},
		{"auth path", nil, []string{"backend/internal/platform/auth/verify.go"}},
		{"migration path", nil, []string{"backend/migrations/000099_x.up.sql"}},
		{"deploy config", nil, []string{"railway/api.toml"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, why := CanAutoMerge(cfg, "low", tc.labels, tc.touched, false)
			if ok {
				t.Fatal("human-gated category auto-merged")
			}
			if !strings.Contains(why, "never auto-merged") {
				t.Fatalf("reason does not state the category gate: %q", why)
			}
		})
	}

	// And an ungated low-risk change WOULD pass under that future phase —
	// the gate can open, so it is a gate and not a wall.
	if ok, why := CanAutoMerge(cfg, "low", nil, []string{"apps/web/src/app/page.tsx"}, false); !ok {
		t.Fatalf("ungated low-risk change refused under enabled policy: %s", why)
	}
}

func TestV1PolicyRefusesAutoMergeForEverything(t *testing.T) {
	cfg := testConfig(t) // fixture pins auto_merge.enabled=false
	if ok, why := CanAutoMerge(cfg, "low", nil, []string{"apps/web/src/x.tsx"}, false); ok || !strings.Contains(why, "human-merge always") {
		t.Fatalf("V1 auto-merged: ok=%t why=%q", ok, why)
	}
}

func TestEvidenceOwingTicketsCannotAutoMergeOrReachDone(t *testing.T) {
	cfg := testConfig(t)
	cfg.Policy.AutoMerge.Enabled = true
	if ok, _ := CanAutoMerge(cfg, "low", nil, nil, true); ok {
		t.Fatal("evidence-owing ticket auto-merged")
	}

	// At the state machine: while the label is present the terminal is
	// EVIDENCE_WAIT, DONE is refused, and the machine itself has no
	// EVIDENCE_WAIT→anything edge except →DONE (latch releases, run ends).
	if FinalState(true) != runstate.EvidenceWait || FinalState(false) != runstate.Done {
		t.Fatal("FinalState mapping wrong")
	}
	if err := GuardDone(true); err == nil {
		t.Fatal("DONE reachable while evidence-outstanding")
	}
	if err := GuardDone(false); err != nil {
		t.Fatalf("DONE refused with no evidence owed: %v", err)
	}
	if !runstate.CanTransition(runstate.Merging, runstate.EvidenceWait) ||
		!runstate.CanTransition(runstate.EvidenceWait, runstate.Done) {
		t.Fatal("the machine's evidence edges are wrong")
	}
	if runstate.CanTransition(runstate.EvidenceWait, runstate.Merging) {
		t.Fatal("EVIDENCE_WAIT has an edge back into the pipeline")
	}
}

func TestRiskOutsideAllowedListNeverAutoMerges(t *testing.T) {
	cfg := testConfig(t)
	cfg.Policy.AutoMerge.Enabled = true
	cfg.Policy.AutoMerge.AllowedRisk = []string{"low"}
	for _, risk := range []string{"medium", "high"} {
		if ok, _ := CanAutoMerge(cfg, risk, nil, nil, false); ok {
			t.Fatalf("risk %s auto-merged", risk)
		}
	}
}
