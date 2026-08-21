package devengine

import (
	"regexp"
	"strings"
	"time"
)

// checkboxRe matches an unticked or ticked criterion line. Ticked boxes count
// as criteria too — a fully ticked list is still a definition of done.
var checkboxRe = regexp.MustCompile(`(?m)^\s*-\s*\[[ xX]\]`)

// riskLineRe pulls the ticket's explicit risk from its ## Risk section: the
// first bare low/medium/high on a line of its own after the heading.
var riskLineRe = regexp.MustCompile(`(?mi)^#{2,3}\s*Risk\s*:?\s*\n+\s*(low|medium|high)\b`)

// HasAcceptanceCriteria reports whether the body carries an
// "## Acceptance criteria" heading with at least one checkbox anywhere after
// it. The heading alone is not enough — zero criteria yields zero unmet,
// which renders as a clean pass; that is ac-verifier's NO CRITERIA rule and
// the engine adopts it as a hard preflight refusal.
func HasAcceptanceCriteria(body string) bool {
	idx := findHeading(body, "acceptance criteria")
	if idx < 0 {
		return false
	}
	section := sectionAfter(body, idx)
	return checkboxRe.MatchString(section)
}

// findHeading tolerates `###` depth and a trailing colon — real ticket bodies
// vary, and a false "no acceptance criteria" refusal on a formatting quirk
// would overstate the shadow week's refusal rate. Anything looser (suffix
// text) stays unmatched on purpose: "## Acceptance criteria (draft)" is a
// ticket that has not committed to its criteria.
func findHeading(body, name string) int {
	re := regexp.MustCompile(`(?mi)^#{2,3}\s*` + regexp.QuoteMeta(name) + `\s*:?\s*$`)
	loc := re.FindStringIndex(body)
	if loc == nil {
		return -1
	}
	return loc[1]
}

// sectionAfter returns the text from idx to the next heading (or EOF).
func sectionAfter(body string, idx int) string {
	rest := body[idx:]
	next := regexp.MustCompile(`(?m)^#{2,3}\s`).FindStringIndex(rest)
	if next == nil {
		return rest
	}
	return rest[:next[0]]
}

// ScopeSection returns the ticket's ## Scope section, or the whole body when
// it has none. The context plan matches path prefixes against this rather
// than the full body, because prose elsewhere legitimately names paths it
// does NOT touch ("does not touch backend/") — the Scope section is the half
// of the ticket contract that claims ownership.
func ScopeSection(body string) string {
	idx := findHeading(body, "scope")
	if idx < 0 {
		return body
	}
	return sectionAfter(body, idx)
}

// ExplicitRisk returns the ticket's own ## Risk value, or "" when absent.
func ExplicitRisk(body string) string {
	m := riskLineRe.FindStringSubmatch(body)
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1])
}

// Preflight decides whether the engine would take this ticket, and what it
// would load, with no dispatch-time environment — the shadow-mode form.
// (Shadow mode dispatches nothing, so it has no base to be stale and no diff
// to classify by path; an assignee stands in for a lease until N139.)
func Preflight(item Item, cfg Config, now time.Time, engineID string) Decision {
	return PreflightEnv(item, cfg, Env{}, now, engineID)
}

// PreflightEnv runs every named rule (see Rules) and classifies risk. Every
// rule runs — a ticket failing three ways names all three — and every refusal
// is phrased as the human action that unblocks it.
func PreflightEnv(item Item, cfg Config, env Env, now time.Time, engineID string) Decision {
	d := Decision{
		Time:   now.UTC(),
		Issue:  item.IssueNumber,
		Title:  item.Title,
		Event:  "todo_to_in_progress",
		Engine: engineID,
	}

	for _, rule := range Rules() {
		if reason := rule.Check(item, cfg, env); reason != "" {
			d.Reasons = append(d.Reasons, reason)
		}
	}

	d.Risk = ClassifyRisk(ExplicitRisk(item.Body), item.Labels, env.TouchedPaths, cfg.RiskRules)
	d.HumanGated = labelsIntersect(item.Labels, cfg.Policy.HumanGate.Labels) ||
		pathsIntersect(env.TouchedPaths, cfg.Policy.HumanGate.Paths)
	d.Context = PlanContext(item.Body, cfg.ContextMap)
	d.WouldDispatch = len(d.Reasons) == 0
	return d
}
