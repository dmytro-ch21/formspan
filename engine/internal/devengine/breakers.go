package devengine

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/dmytro-ch21/vola/engine/internal/runstate"
)

// A Breaker stops the engine and says EXACTLY what a human must do — a
// Blocked run that does not name its unblocking action is one nobody
// unblocks. Breakers derive from evidence where they can (body, labels,
// diff, budget); the flags in BreakerInput are for facts only the running
// worker can observe (a conflict it could not resolve, a provider that
// stopped answering).
type Breaker struct {
	Name string
	Trip func(in BreakerInput) (tripped bool, unblock string)
}

// BreakerInput carries everything the breakers inspect.
type BreakerInput struct {
	IssueTitle   string
	IssueBody    string
	Labels       []string
	TouchedPaths []string
	Diff         string
	// Budget nil means CI is not in play for this decision yet (pre-CI
	// phases) — the ci-budget breaker is deliberately inert then, NOT safe;
	// a caller in a CI phase that forgets to thread it disarms the breaker.
	Budget *FixBudget
	CI     CIVerdict
	// Worker-observed facts no artifact can derive:
	SemanticConflict bool // a rebase needed a choice the engine may not make
	RuntimeExceeded  bool
	ProviderDown     bool
}

// BlockReason is what lands in the run's Blocked comment.
type BlockReason struct {
	Breaker string `json:"breaker"`
	Unblock string `json:"unblock"`
}

// destructiveSQLRe matches UNANCHORED within an added line: this repo's
// column drops are written `ALTER TABLE x DROP COLUMN …` (measured — every
// DROP COLUMN in backend/migrations/ is an ALTER statement), so a
// line-start anchor made detection depend on the author's line-wrapping.
// No trailing-semicolon requirement either: DELETE FROM with its WHERE on
// the next line is the same statement.
var destructiveSQLRe = regexp.MustCompile(`(?i)\b(DROP\s+(TABLE|COLUMN|SCHEMA)|TRUNCATE|DELETE\s+FROM)\b`)

// Breakers is the full set. Every one runs; a run blocked three ways names
// all three actions.
func Breakers(cfg Config) []Breaker {
	return []Breaker{
		{Name: "no-acceptance-criteria", Trip: func(in BreakerInput) (bool, string) {
			if HasAcceptanceCriteria(in.IssueBody) {
				return false, ""
			}
			return true, "add an '## Acceptance criteria' section with at least one checkbox to the ticket"
		}},
		{Name: "product-decision-needed", Trip: func(in BreakerInput) (bool, string) {
			m := decisionMarkerRe.FindString(in.IssueTitle + "\n" + in.IssueBody)
			if m == "" {
				return false, ""
			}
			return true, fmt.Sprintf("resolve the product decision the ticket marks (%q) or encode the chosen answer as an acceptance criterion", m)
		}},
		{Name: "ci-budget-exhausted", Trip: func(in BreakerInput) (bool, string) {
			if in.Budget == nil {
				return false, ""
			}
			if in.Budget.CodeAttempts > in.Budget.Max {
				return true, "review the failing checks by hand — " + in.Budget.Diagnosis(in.CI)
			}
			if in.Budget.InfraRetries > in.Budget.MaxInfra {
				return true, fmt.Sprintf("CI infrastructure failed %d consecutive times — the runner, not the change; investigate the runner or re-run when it recovers", in.Budget.InfraRetries)
			}
			return false, ""
		}},
		{Name: "semantic-merge-conflict", Trip: func(in BreakerInput) (bool, string) {
			if !in.SemanticConflict {
				return false, ""
			}
			return true, "the rebase requires a choice between conflicting intents — resolve the conflict by hand; the engine may not pick a side"
		}},
		{Name: "credential-in-diff", Trip: func(in BreakerInput) (bool, string) {
			if err := scanDiffForSecrets(in.Diff); err != nil {
				return true, "remove the credential-shaped content from the change (" + err.Error() + ") — the engine never ships or handles live secrets"
			}
			return false, ""
		}},
		{Name: "destructive-migration", Trip: func(in BreakerInput) (bool, string) {
			// Scan ONLY added lines belonging to up.sql migration files —
			// tracked by the diff's own +++ headers, like the secrets gate.
			// A down file dropping what its up created is the NORMAL case
			// (measured: every table-adding migration's down opens with
			// DROP TABLE), so scanning downs blocked every schema-adding
			// ticket the engine would ever work — a breaker whose clean
			// path never occurs gets rubber-stamped or ripped out. Down
			// files stay covered by the migrations human gate at merge.
			currentFile := ""
			for _, line := range strings.Split(in.Diff, "\n") {
				if strings.HasPrefix(line, "+++ b/") {
					currentFile = strings.TrimPrefix(line, "+++ b/")
					continue
				}
				if !strings.HasPrefix(line, "+") || strings.HasPrefix(line, "+++") {
					continue
				}
				if !PathMatches("backend/migrations/**", currentFile) ||
					!strings.HasSuffix(currentFile, ".up.sql") {
					continue
				}
				if destructiveSQLRe.MatchString(line) {
					return true, "the migration drops or truncates data — a human must approve destructive schema changes and confirm the down-path and backups"
				}
			}
			return false, ""
		}},
		{Name: "auth-boundary-change", Trip: func(in BreakerInput) (bool, string) {
			if pathsIntersect(in.TouchedPaths, []string{"backend/internal/platform/auth/**"}) ||
				labelsIntersect(in.Labels, []string{"security"}) {
				return true, "the change touches the auth/security boundary — a human must review and merge it; the engine never self-approves security changes"
			}
			return false, ""
		}},
		{Name: "runtime-budget-exceeded", Trip: func(in BreakerInput) (bool, string) {
			if !in.RuntimeExceeded {
				return false, ""
			}
			return true, fmt.Sprintf("the run exceeded the policy's %d-minute budget — decide whether the ticket needs splitting or the budget raising", cfg.Policy.MaxRuntimeMinutes)
		}},
		{Name: "provider-outage", Trip: func(in BreakerInput) (bool, string) {
			if !in.ProviderDown {
				return false, ""
			}
			return true, "the model provider is unreachable — trustworthy execution is impossible; re-dispatch when it recovers"
		}},
	}
}

func touchesMigration(paths []string) bool {
	for _, p := range paths {
		if PathMatches("backend/migrations/**", p) {
			return true
		}
	}
	return false
}

// RunBreakers evaluates every breaker; a non-empty result means Blocked, and
// the reasons ARE the comment.
func RunBreakers(cfg Config, in BreakerInput) []BlockReason {
	var out []BlockReason
	for _, b := range Breakers(cfg) {
		if tripped, unblock := b.Trip(in); tripped {
			out = append(out, BlockReason{Breaker: b.Name, Unblock: unblock})
		}
	}
	return out
}

// BlockedComment renders the reasons as the run comment. It must never open
// a line with the evidence gesture — the latch reads column zero, and once
// attested to its own instructions; the engine posts no attestations, ever.
func BlockedComment(reasons []BlockReason) string {
	var sb strings.Builder
	sb.WriteString("The engine blocked this run. To unblock, a human needs to:\n")
	for _, r := range reasons {
		fmt.Fprintf(&sb, "- [%s] %s\n", r.Breaker, r.Unblock)
	}
	return sb.String()
}

// ── Merge policy ──────────────────────────────────────────────────────────

// humanGatedCategories can NEVER auto-merge, in any phase, regardless of what
// policy.json's auto_merge block says — the category gate is independent of
// the flag on purpose: flipping `enabled` must never be sufficient to let an
// auth change self-approve. Paths and labels both express the categories.
var humanGatedCategories = struct {
	Labels []string
	Paths  []string
}{
	Labels: []string{"security", "destructive", "billing", "privacy"},
	Paths: []string{
		"backend/internal/platform/auth/**",
		"backend/migrations/**",
		"railway/**",
		".github/workflows/**",
		"apps/mobile/eas.json",
	},
}

// CanAutoMerge decides whether the engine may merge without a human. V1 is
// human-merge always (policy.json pins auto_merge.enabled=false, and
// scripts/check-agent-policy.py refuses true); this function is the SECOND
// lock: even a future phase that legitimately enables auto-merge cannot
// reach the human-gated categories or an evidence-owing ticket through it.
//
// The gate is the UNION of the hardcoded floor and policy.json's human_gate:
// config may ADD gates it can never REMOVE. Monotone-safe — every reachable
// config is at least as strict as the floor — and it keeps human_gate
// meaning the same thing at preflight and at merge. Found in review: the
// floor alone let a policy.json addition gate preflight while the merge
// decision silently ignored it.
func CanAutoMerge(cfg Config, risk string, labels, touched []string, evidenceOutstanding bool) (bool, string) {
	gateLabels := append(append([]string{}, humanGatedCategories.Labels...), cfg.Policy.HumanGate.Labels...)
	gatePaths := append(append([]string{}, humanGatedCategories.Paths...), cfg.Policy.HumanGate.Paths...)
	if labelsIntersect(labels, gateLabels) || pathsIntersect(touched, gatePaths) {
		return false, "human-gated category — never auto-merged in any phase"
	}
	if evidenceOutstanding {
		return false, "the ticket owes human evidence — merging is a human call until the latch releases"
	}
	if !cfg.Policy.AutoMerge.Enabled {
		return false, "auto_merge is disabled by policy (V1 is human-merge always)"
	}
	allowed := false
	for _, r := range cfg.Policy.AutoMerge.AllowedRisk {
		if r == risk {
			allowed = true
		}
	}
	if !allowed {
		return false, fmt.Sprintf("risk %q is outside auto_merge.allowed_risk", risk)
	}
	return true, ""
}

// FinalState picks the terminal for a merged run. While the ticket carries
// the evidence-outstanding label the machine's terminal is EVIDENCE_WAIT —
// DONE is unreachable, and the existing evidence latch (a human's /evidence
// comment, quoted here inline and never at column zero) is the SOLE releaser.
// The engine observes the label; it never ticks a criterion.
func FinalState(evidenceOutstanding bool) runstate.State {
	if evidenceOutstanding {
		return runstate.EvidenceWait
	}
	return runstate.Done
}

// GuardDone refuses the DONE transition while evidence is owed — the belt to
// FinalState's braces, for any caller that tries to transition directly.
func GuardDone(evidenceOutstanding bool) error {
	if evidenceOutstanding {
		return fmt.Errorf("the ticket carries evidence-outstanding — the machine's terminal is EVIDENCE_WAIT until the evidence latch releases it")
	}
	return nil
}
