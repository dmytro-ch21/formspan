package devengine

import (
	"strings"
	"testing"
	"time"
)

// Every named rule gets a pass case and a refusal case, table-driven, so
// disabling any single rule turns exactly its refusal case red (the ticket's
// mutation-check criterion).
func TestEachRulePassesAndRefuses(t *testing.T) {
	cfg := testConfig(t)
	cases := []struct {
		rule   string
		pass   Item
		passE  Env
		refuse Item
		refE   Env
		reason string // substring the refusal must carry
	}{
		{
			rule:   "draft-item",
			pass:   Item{IssueNumber: 1, Body: goodBody},
			refuse: Item{IsDraft: true, Title: "an idea on a card"},
			reason: "draft project item",
		},
		{
			rule:   "acceptance-criteria",
			pass:   Item{IssueNumber: 1, Body: goodBody},
			refuse: Item{IssueNumber: 2, Body: "## Athlete outcome\nvibes\n"},
			reason: "no acceptance criteria",
		},
		{
			rule:   "already-claimed",
			pass:   Item{IssueNumber: 1, Body: goodBody},
			refuse: Item{IssueNumber: 3, Body: goodBody, Assignees: []string{"somebody"}},
			reason: "somebody",
		},
		{
			rule:   "product-decision",
			pass:   Item{IssueNumber: 1, Body: goodBody},
			refuse: Item{IssueNumber: 4, Body: goodBody + "\n## Non-goals\nTBD — pricing model is an open question\n"},
			reason: "unencoded product decision",
		},
		{
			rule:   "stale-base",
			pass:   Item{IssueNumber: 1, Body: goodBody},
			passE:  Env{BaseSHA: "abc123", RemoteHead: "abc123"},
			refuse: Item{IssueNumber: 5, Body: goodBody},
			refE:   Env{BaseSHA: "abc123def4567890", RemoteHead: "fed321abc7654321"},
			reason: "refresh the base",
		},
	}

	byName := map[string]Rule{}
	for _, r := range Rules() {
		byName[r.Name] = r
	}
	for _, tc := range cases {
		t.Run(tc.rule, func(t *testing.T) {
			rule, ok := byName[tc.rule]
			if !ok {
				t.Fatalf("no rule named %q — the rule set lost a name", tc.rule)
			}
			if got := rule.Check(tc.pass, cfg, tc.passE); got != "" {
				t.Fatalf("pass case refused: %q", got)
			}
			got := rule.Check(tc.refuse, cfg, tc.refE)
			if got == "" {
				t.Fatal("refusal case passed")
			}
			if !strings.Contains(got, tc.reason) {
				t.Fatalf("refusal %q does not carry %q", got, tc.reason)
			}
			// Refusals surface through Preflight unchanged in shape: plain
			// strings in Reasons (the shadow log's existing format).
			d := PreflightEnv(tc.refuse, cfg, tc.refE, time.Now(), "test")
			if d.WouldDispatch || !anyContains(d.Reasons, tc.reason) {
				t.Fatalf("rule %q not surfaced through PreflightEnv: %+v", tc.rule, d)
			}
		})
	}
}

func TestProductDecisionMarkerIsWordBounded(t *testing.T) {
	// A marker inside a word must not fire; these bodies carry none as a word.
	for _, body := range []string{
		goodBody + "\nresults obtained from the corpus\n",
		goodBody + "\nthe TBDx identifier is a field name\n",
	} {
		if m := decisionMarkerRe.FindString(body); m != "" {
			t.Fatalf("marker fired inside a word: %q", m)
		}
	}
	// Singular AND plural forms both fire — "## Open questions" is the
	// standard heading, and \b cannot sit before the trailing s, so the
	// plural has to be explicit in the pattern. Found in review.
	for _, text := range []string{
		"pricing is TBD.",
		"## Open question\nwhich provider?",
		"## Open questions\n- should we X or Y?",
		"this needs decisions from the user",
		"user decision required before shipping",
	} {
		if m := decisionMarkerRe.FindString(text); m == "" {
			t.Fatalf("real marker did not fire in %q", text)
		}
	}
}

func TestProductDecisionMarkerInTheTitleRefuses(t *testing.T) {
	d := PreflightEnv(Item{IssueNumber: 12, Title: "N999 — TBD provider choice", Body: goodBody},
		testConfig(t), Env{}, time.Now(), "test")
	if d.WouldDispatch {
		t.Fatal("a decision marker in the TITLE was dispatched")
	}
}

func TestStaleBaseRefusesAHalfPopulatedEnv(t *testing.T) {
	// Exactly one side empty is a failed git read, and absence is not
	// evidence of freshness — it refuses rather than passing.
	cfg := testConfig(t)
	for _, env := range []Env{
		{BaseSHA: "abc123", RemoteHead: ""},
		{BaseSHA: "", RemoteHead: "abc123"},
	} {
		d := PreflightEnv(Item{IssueNumber: 13, Body: goodBody}, cfg, env, time.Now(), "test")
		if d.WouldDispatch {
			t.Fatalf("half-populated Env %+v dispatched", env)
		}
	}
	// Both empty stays shadow-mode pass.
	d := PreflightEnv(Item{IssueNumber: 13, Body: goodBody}, cfg, Env{}, time.Now(), "test")
	if !d.WouldDispatch {
		t.Fatalf("zero Env refused: %v", d.Reasons)
	}
}

func TestPathMatches(t *testing.T) {
	cases := []struct {
		pattern, path string
		want          bool
	}{
		{"backend/migrations/**", "backend/migrations/000076_x.up.sql", true},
		{"backend/migrations/**", "backend/migrations", true},
		{"backend/migrations/**", "backend/migrations_engine/000001.sql", false},
		{"backend/internal/platform/auth/**", "backend/internal/platform/auth/verify.go", true},
		{"backend/internal/platform/auth/**", "backend/internal/platform/authz/x.go", false},
		{"apps/mobile/eas.json", "apps/mobile/eas.json", true},
		{"apps/mobile/eas.json", "apps/mobile/eas.json.bak", false},
	}
	for _, tc := range cases {
		if got := PathMatches(tc.pattern, tc.path); got != tc.want {
			t.Fatalf("PathMatches(%q, %q) = %t, want %t", tc.pattern, tc.path, got, tc.want)
		}
	}
}

func TestRiskIsRaisedByTouchedPathAndNeverLowered(t *testing.T) {
	rules := testConfig(t).RiskRules // has a medium rule on apps/mobile/lib/db.ts

	// A touched sync file raises an unstated risk to medium.
	if got := ClassifyRisk("", nil, []string{"apps/mobile/lib/db.ts"}, rules); got != "medium" {
		t.Fatalf("path raise: got %q, want medium", got)
	}
	// An explicit high is never lowered by a matching medium path rule.
	if got := ClassifyRisk("high", nil, []string{"apps/mobile/lib/db.ts"}, rules); got != "high" {
		t.Fatalf("raise-only violated by path rule: got %q", got)
	}
	// An untouched path changes nothing.
	if got := ClassifyRisk("", nil, []string{"docs/readme.md"}, rules); got != "low" {
		t.Fatalf("unrelated path moved risk: got %q", got)
	}
}

func TestMigrationPresenceRaisesRiskThroughTheRealRules(t *testing.T) {
	// Against the REAL checked-in risk-rules.json, not the fixture: a new
	// migration file must classify high. This is the "migration presence"
	// criterion, encoded as the backend/migrations/** path rule.
	// Fatal, not Skip: .vola-agent is checked in at the repo root, so absence
	// is a broken checkout, and a silent skip here is the exact green-but-
	// never-ran pattern the repo's testing rules exist to prevent.
	cfg, err := LoadConfig("../../../.vola-agent")
	if err != nil {
		t.Fatalf(".vola-agent not readable from the repo root: %v", err)
	}
	got := ClassifyRisk("low", nil, []string{"backend/migrations/000099_new.up.sql"}, cfg.RiskRules)
	if got != "high" {
		t.Fatalf("a migration in the diff classified %q, want high", got)
	}
}

func TestTouchedHumanGatePathFlagsHumanGated(t *testing.T) {
	cfg := testConfig(t)
	d := PreflightEnv(Item{IssueNumber: 8, Body: goodBody},
		cfg, Env{TouchedPaths: []string{"backend/migrations/000099_x.up.sql"}}, time.Now(), "test")
	if !d.HumanGated {
		t.Fatal("a touched human-gate path did not mark the decision human-gated")
	}
	if !d.WouldDispatch {
		t.Fatalf("human-gated is a merge property, not a dispatch refusal: %v", d.Reasons)
	}
}
