package devengine

import (
	"fmt"
	"regexp"
	"strings"
)

// Env carries dispatch-time facts that are not on the ticket itself. Shadow
// mode leaves it zero (it dispatches nothing, so it has no base to be stale);
// Phase 2 populates it from the run record before claiming.
type Env struct {
	BaseSHA    string // the base commit a run would branch from
	RemoteHead string // origin/main's current head at decision time
	// TouchedPaths is the diff's file list once one exists. Path-based risk
	// rules and human-gate paths apply through it; before any code is
	// written it is empty and only label/explicit risk can be known.
	TouchedPaths []string
}

// Rule is one named preflight refusal. Check returns "" to pass, or the
// refusal reason — always phrased as the human action that unblocks it,
// because a Blocked ticket that does not say what unblocks it is one nobody
// unblocks. Names exist so a test (and a decision-log reader) can point at
// exactly one rule; the Decision format itself is unchanged — rules only
// contribute strings to Reasons.
type Rule struct {
	Name  string
	Check func(item Item, cfg Config, env Env) string
}

// decisionMarkerRe finds an UNENCODED product decision left in a ticket:
// a marker a human wrote to say "somebody still has to choose". The engine
// must never make that choice by implementing one side of it. Case-
// insensitive, word-bounded — "the TBD field" fires, "TBDx" does not — and
// PLURALS are matched explicitly: "## Open questions" is the standard way
// this marker is written, and `\b` after "question" cannot sit before an "s",
// so without `s?` the most common form dispatches. Found in review, measured
// against the live issue corpus.
var decisionMarkerRe = regexp.MustCompile(
	`(?i)\b(TBD|open questions?|needs (a )?(product )?decisions?|(product|user) decisions? required)\b`)

// Rules is the ordered preflight rule set. Order matters only for how the
// reasons read; every rule runs, so a ticket failing three ways names all
// three.
func Rules() []Rule {
	return []Rule{
		{
			Name: "draft-item",
			Check: func(item Item, _ Config, _ Env) string {
				if !item.IsDraft {
					return ""
				}
				return "draft project item, not an issue — convert it to an issue with acceptance criteria"
			},
		},
		{
			Name: "acceptance-criteria",
			Check: func(item Item, cfg Config, _ Env) string {
				// A draft has no body to inspect; the draft-item rule owns
				// that refusal, and doubling it would just be noise.
				if item.IsDraft || !cfg.Policy.RequireAcceptanceCriteria {
					return ""
				}
				if HasAcceptanceCriteria(item.Body) {
					return ""
				}
				return "no acceptance criteria — add an '## Acceptance criteria' section with at least one checkbox (a ticket with zero criteria would pass the done-gate vacuously)"
			},
		},
		{
			Name: "already-claimed",
			Check: func(item Item, _ Config, _ Env) string {
				if len(item.Assignees) == 0 {
					return ""
				}
				return fmt.Sprintf(
					"already claimed by %s — the engine does not contest a claim; unassign to hand it over",
					strings.Join(item.Assignees, ", "))
			},
		},
		{
			Name: "product-decision",
			Check: func(item Item, _ Config, _ Env) string {
				if item.IsDraft {
					return ""
				}
				// Title too: "N142 — TBD provider choice" is a marker.
				m := decisionMarkerRe.FindString(item.Title + "\n" + item.Body)
				if m == "" {
					return ""
				}
				return fmt.Sprintf(
					"unencoded product decision (%q in the ticket) — resolve it, or encode the chosen answer as an acceptance criterion, before dispatch",
					m)
			},
		},
		{
			Name: "stale-base",
			Check: func(_ Item, _ Config, env Env) string {
				// Both empty is shadow mode (nothing to dispatch, nothing to
				// be stale). Exactly ONE empty is an apparatus failure — a
				// git read that produced nothing — and absence is not
				// evidence of freshness, so it refuses rather than passes.
				switch {
				case env.BaseSHA == "" && env.RemoteHead == "":
					return ""
				case env.BaseSHA == "" || env.RemoteHead == "":
					return "could not compare the base against origin/main (one side unreadable) — retry once the remote is reachable"
				case env.BaseSHA == env.RemoteHead:
					return ""
				}
				return fmt.Sprintf(
					"recorded base %.12s is not origin/main's head %.12s — refresh the base before dispatch",
					env.BaseSHA, env.RemoteHead)
			},
		},
	}
}

// PathMatches reports whether one touched file path falls under a risk-rule
// or human-gate pattern. Exactly the two pattern forms `.vola-agent` uses:
// a literal file path matches itself; a glob matches anything under its
// literal prefix. `backend/migrations/**` therefore matches every migration
// file — which is how "a migration is present" raises risk without a
// dedicated mechanism.
func PathMatches(pattern, path string) bool {
	prefix := globPrefix(pattern)
	if prefix == pattern {
		return path == pattern
	}
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}
