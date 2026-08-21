package devengine

import (
	"fmt"
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
// would load. Every refusal is a Reason phrased as the human action that
// unblocks it — a Blocked ticket that does not say what unblocks it is one
// nobody unblocks.
func Preflight(item Item, cfg Config, now time.Time, engineID string) Decision {
	d := Decision{
		Time:   now.UTC(),
		Issue:  item.IssueNumber,
		Title:  item.Title,
		Event:  "todo_to_in_progress",
		Engine: engineID,
	}

	if item.IsDraft {
		d.Reasons = append(d.Reasons,
			"draft project item, not an issue — convert it to an issue with acceptance criteria")
	}
	if cfg.Policy.RequireAcceptanceCriteria && !item.IsDraft && !HasAcceptanceCriteria(item.Body) {
		d.Reasons = append(d.Reasons,
			"no acceptance criteria — add an '## Acceptance criteria' section with at least one checkbox (a ticket with zero criteria would pass the done-gate vacuously)")
	}
	if len(item.Assignees) > 0 {
		// Shadow mode has no lease table yet (N139); an assignee is the
		// human claim convention, and the engine never contests a claim.
		d.Reasons = append(d.Reasons, fmt.Sprintf(
			"already claimed by %s — the engine does not contest a claim; unassign to hand it over",
			strings.Join(item.Assignees, ", ")))
	}

	d.Risk = ClassifyRisk(ExplicitRisk(item.Body), item.Labels, cfg.RiskRules)
	d.HumanGated = labelsIntersect(item.Labels, cfg.Policy.HumanGate.Labels)
	d.Context = PlanContext(item.Body, cfg.ContextMap)
	d.WouldDispatch = len(d.Reasons) == 0
	return d
}
