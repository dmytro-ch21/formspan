package devengine

import (
	"strings"
	"testing"
	"time"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	cfg, err := LoadConfig("testdata/vola-agent")
	if err != nil {
		t.Fatalf("load test config: %v", err)
	}
	return cfg
}

const goodBody = `## Athlete outcome
Something observable.

## Scope
apps/mobile/lib/ and nothing else.

## Acceptance criteria
- [ ] the first observable thing
- [x] an already-ticked thing still counts as a criterion

## Risk
low
`

func TestHasAcceptanceCriteria(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{"heading with checkboxes", goodBody, true},
		{"no heading at all", "just prose\n- [ ] a checkbox outside any heading", false},
		{"heading but zero checkboxes", "## Acceptance criteria\n\nsome prose, no boxes\n\n## Risk\nlow", false},
		{"heading, boxes only in a LATER section", "## Acceptance criteria\n\nprose\n\n## Test plan\n- [ ] a box", false},
		{"ticked boxes count", "## Acceptance criteria\n- [x] done already", true},
		{"### depth and trailing colon tolerated", "### Acceptance criteria:\n- [ ] a thing", true},
		{"a suffixed heading is NOT a criteria section", "## Acceptance criteria (draft)\n- [ ] a thing", false},
		{"empty body", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := HasAcceptanceCriteria(tc.body); got != tc.want {
				t.Fatalf("HasAcceptanceCriteria = %t, want %t", got, tc.want)
			}
		})
	}
}

func TestExplicitRisk(t *testing.T) {
	if got := ExplicitRisk(goodBody); got != "low" {
		t.Fatalf("got %q, want low", got)
	}
	if got := ExplicitRisk("## Risk\nhigh\n"); got != "high" {
		t.Fatalf("got %q, want high", got)
	}
	if got := ExplicitRisk("no risk section"); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestPreflightDispatchesACleanTicket(t *testing.T) {
	d := Preflight(Item{IssueNumber: 42, Title: "clean", Body: goodBody}, testConfig(t), time.Now(), "test")
	if !d.WouldDispatch {
		t.Fatalf("clean ticket refused: %v", d.Reasons)
	}
	if len(d.Reasons) != 0 {
		t.Fatalf("dispatching decision carries reasons: %v", d.Reasons)
	}
	if d.Risk != "low" {
		t.Fatalf("risk = %q, want low", d.Risk)
	}
}

func TestPreflightRefusesNoAcceptanceCriteria(t *testing.T) {
	// This is ac-verifier's NO CRITERIA rule as a hard preflight refusal:
	// zero criteria yields zero unmet, which renders as a clean pass.
	d := Preflight(Item{IssueNumber: 7, Body: "## Athlete outcome\nvibes\n"}, testConfig(t), time.Now(), "test")
	if d.WouldDispatch {
		t.Fatal("ticket without acceptance criteria was dispatched")
	}
	if !anyContains(d.Reasons, "no acceptance criteria") {
		t.Fatalf("refusal does not name the missing criteria: %v", d.Reasons)
	}
}

func TestPreflightRefusesDraftItems(t *testing.T) {
	d := Preflight(Item{IsDraft: true, Title: "an idea on a card"}, testConfig(t), time.Now(), "test")
	if d.WouldDispatch {
		t.Fatal("draft project item was dispatched")
	}
	if !anyContains(d.Reasons, "draft project item") {
		t.Fatalf("refusal does not name the draft: %v", d.Reasons)
	}
}

func TestPreflightRefusesClaimedTickets(t *testing.T) {
	d := Preflight(Item{IssueNumber: 9, Body: goodBody, Assignees: []string{"somebody"}}, testConfig(t), time.Now(), "test")
	if d.WouldDispatch {
		t.Fatal("claimed ticket was dispatched — the engine must never contest a claim")
	}
	if !anyContains(d.Reasons, "somebody") {
		t.Fatalf("refusal does not name the claimant: %v", d.Reasons)
	}
}

func TestRiskIsRaisedByLabelAndNeverLowered(t *testing.T) {
	rules := testConfig(t).RiskRules

	// The security label raises an unstated risk to high.
	if got := ClassifyRisk("", []string{"security"}, nil, rules); got != "high" {
		t.Fatalf("label raise: got %q, want high", got)
	}
	// An explicit high stays high even when only medium rules match — rules
	// may never lower what a human wrote on the ticket.
	if got := ClassifyRisk("high", []string{"area: api"}, nil, rules); got != "high" {
		t.Fatalf("raise-only violated: got %q, want high", got)
	}
	// An explicit low is raised by a matching medium rule.
	if got := ClassifyRisk("low", []string{"area: api"}, nil, rules); got != "medium" {
		t.Fatalf("got %q, want medium", got)
	}
	// No explicit risk, no matching labels: the default.
	if got := ClassifyRisk("", nil, nil, rules); got != "low" {
		t.Fatalf("got %q, want the default low", got)
	}
}

func TestHumanGateLabelFlagsButDoesNotRefuse(t *testing.T) {
	d := Preflight(Item{IssueNumber: 11, Body: goodBody, Labels: []string{"security"}}, testConfig(t), time.Now(), "test")
	if !d.HumanGated {
		t.Fatal("security-labelled ticket not marked human-gated")
	}
	if !d.WouldDispatch {
		t.Fatalf("human-gated is a merge property, not a dispatch refusal: %v", d.Reasons)
	}
	if d.Risk != "high" {
		t.Fatalf("risk = %q, want high", d.Risk)
	}
}

func TestPlanContextSelectsByScopePathAndDeduplicates(t *testing.T) {
	cm := testConfig(t).ContextMap

	plan := PlanContext(goodBody, cm) // scope names apps/mobile/lib/
	if len(plan.Traps) != 2 || plan.Traps[0] != "T5" || plan.Traps[1] != "T6" {
		t.Fatalf("traps = %v, want [T5 T6]", plan.Traps)
	}
	if len(plan.Gates) != 2 {
		t.Fatalf("gates = %v, want [mobile offline-sync]", plan.Gates)
	}

	// Two entries share api-conventions.md; a body naming both paths gets it once.
	both := "## Scope\nbackend/internal and contracts/public.openapi.yaml\n"
	plan = PlanContext(both, cm)
	count := 0
	for _, doc := range plan.Docs {
		if doc == "docs/architecture/api-conventions.md" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("shared doc listed %d times, want once (docs: %v)", count, plan.Docs)
	}

	// A body naming no mapped path gets an empty plan, not a guess.
	plan = PlanContext("## Scope\ndocs only\n", cm)
	if len(plan.Docs)+len(plan.Traps)+len(plan.Gates) != 0 {
		t.Fatalf("unmapped scope produced a plan: %+v", plan)
	}

	// A path mentioned OUTSIDE the Scope section does not select context:
	// "does not touch backend/" is a disclaimer, not a claim of ownership.
	disclaimed := "## Scope\ndocs only\n\n## Non-regressions\n- [ ] does not touch backend/internal\n"
	plan = PlanContext(disclaimed, cm)
	if len(plan.Gates) != 0 {
		t.Fatalf("a path named outside Scope selected context: %+v", plan)
	}
}

func TestLoadConfigRefusesRaiseOnlyFalse(t *testing.T) {
	dir := t.TempDir()
	copyTestdata(t, dir)
	overwrite(t, dir+"/risk-rules.json",
		`{"version":1,"default_risk":"low","raise_only":false,"rules":[]}`)
	if _, err := LoadConfig(dir); err == nil {
		t.Fatal("config with raise_only=false was accepted")
	}
}

func TestLoadConfigRefusesMissingFile(t *testing.T) {
	dir := t.TempDir()
	copyTestdata(t, dir)
	rm(t, dir+"/context-map.json")
	if _, err := LoadConfig(dir); err == nil {
		t.Fatal("config with a missing file was accepted — a dispatcher on half a policy must refuse to start")
	}
}

func anyContains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}
