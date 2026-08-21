package devengine

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// BuiltContext is the assembled, bounded context for one run: what the
// context-map selected for the touched paths — never CLAUDE.md, never the
// full history log (see Assemble, which refuses both structurally).
type BuiltContext struct {
	Docs  []string
	Traps []string
	Gates []string
	// Unmapped lists touched paths no context-map entry covers. It is
	// RECORDED on the decision/run rather than silently contributing
	// nothing — an unmapped path is a context-map gap somebody should see.
	Unmapped []string
	// DefaultApplied is true when no entry matched at all and DefaultDocs
	// was substituted: the run still gets the core conventions rather than
	// an empty context that reads like "no rules apply here".
	DefaultApplied bool
}

// DefaultDocs is the defined fallback for a wholly unmapped diff — the two
// current-state docs every change in this repo answers to.
var DefaultDocs = []string{
	"docs/architecture/api-conventions.md",
	"docs/architecture/deployment.md",
}

// forbiddenBulk are the files the design's non-goal names: dumping them into
// every model call is exactly what the context map exists to replace, so
// Assemble refuses them even if a future context-map lists one.
var forbiddenBulk = map[string]bool{
	"CLAUDE.md":                 true,
	"docs/decisions/history.md": true,
}

// BuildContext maps a diff's touched paths through the context map. Output
// order is ENTRY order, not touched order — iterate the map's entries and
// collect from each that matches — so the result is deterministic and
// identical however the caller ordered (or shuffled) the touched list; only
// Unmapped preserves touched order, since it reports the caller's input back.
func BuildContext(touched []string, cm ContextMap) BuiltContext {
	var bc BuiltContext
	anyMatched := false
	matchedPath := map[string]bool{}
	seenDoc := map[string]bool{}
	seenTrap := map[string]bool{}
	seenGate := map[string]bool{}

	for _, entry := range cm.Entries {
		entryMatched := false
		for _, pattern := range entry.Paths {
			for _, p := range touched {
				if PathMatches(pattern, p) {
					matchedPath[p] = true
					entryMatched = true
				}
			}
		}
		if !entryMatched {
			continue
		}
		anyMatched = true
		for _, d := range entry.Docs {
			if !seenDoc[d] {
				seenDoc[d] = true
				bc.Docs = append(bc.Docs, d)
			}
		}
		for _, t := range entry.Traps {
			if !seenTrap[t] {
				seenTrap[t] = true
				bc.Traps = append(bc.Traps, t)
			}
		}
		for _, g := range entry.Gates {
			if !seenGate[g] {
				seenGate[g] = true
				bc.Gates = append(bc.Gates, g)
			}
		}
	}

	for _, p := range touched {
		if !matchedPath[p] {
			bc.Unmapped = append(bc.Unmapped, p)
		}
	}
	// The default keys on NO ENTRY MATCHED — including an empty touched list,
	// which would otherwise be the one input producing a wholly empty,
	// unrecorded context ("no rules apply here"). An entry that matched but
	// carries empty lists is a deliberate map authoring choice and does NOT
	// trip the default.
	if !anyMatched {
		bc.DefaultApplied = true
		bc.Docs = append(bc.Docs, DefaultDocs...)
	}
	return bc
}

// Assemble reads the selected context from disk: doc contents keyed by path,
// and each trap's text from docs/TASKS.md keyed "trap:<id>". Pure file reads
// — no network, by contract. It ERRORS on a forbidden bulk file rather than
// including it: the non-goal ("never CLAUDE.md + 39k lines of history per
// call") is enforced here structurally, not by convention.
func Assemble(repoRoot string, bc BuiltContext) (map[string]string, error) {
	out := make(map[string]string, len(bc.Docs)+len(bc.Traps))
	for _, doc := range bc.Docs {
		// The path must be its own clean, repo-local spelling. Anything else
		// — "./CLAUDE.md", "docs/decisions/../decisions/history.md",
		// "../../outside" — is refused outright rather than normalized and
		// re-checked, because an alias that needs normalizing is either an
		// attempt to slip past forbiddenBulk or a traversal out of repoRoot;
		// review demonstrated all three walking through an exact-string
		// compare. filepath.IsLocal rejects the escape, Clean-equality
		// rejects every alias of a local path.
		if filepath.Clean(doc) != doc || !filepath.IsLocal(doc) {
			return nil, fmt.Errorf("context doc %q is not a clean repo-relative path", doc)
		}
		if forbiddenBulk[doc] {
			return nil, fmt.Errorf("context-map selects %q — bulk files are the thing the context map exists to replace", doc)
		}
		b, err := os.ReadFile(filepath.Join(repoRoot, doc))
		if err != nil {
			return nil, fmt.Errorf("assemble context: %w", err)
		}
		out[doc] = string(b)
	}
	if len(bc.Traps) > 0 {
		tasks, err := os.ReadFile(filepath.Join(repoRoot, "docs", "TASKS.md"))
		if err != nil {
			return nil, fmt.Errorf("assemble context: traps: %w", err)
		}
		for _, trap := range bc.Traps {
			text := TrapText(string(tasks), trap)
			if text == "" {
				return nil, fmt.Errorf("assemble context: trap %s not found in docs/TASKS.md", trap)
			}
			out["trap:"+trap] = text
		}
	}
	return out, nil
}

// TrapText extracts one trap's bullet from the TASKS.md archive: the list
// item whose bold marker is the id, through to the next list item or blank
// line. That end rule assumes SINGLE-PHYSICAL-LINE bullets — which is the
// archive's actual, frozen format (every T entry is one long line; the file
// may not be appended to) — so a hypothetical reflow into multi-paragraph
// list form would silently truncate at the first blank line. Returns "" when
// the trap is not present — Assemble turns that into an error, because a
// context plan pointing at a trap that does not exist is a pointer the agent
// would silently never read.
func TrapText(tasksMD, id string) string {
	re := regexp.MustCompile(`(?m)^- \[[ x]\] \*\*` + regexp.QuoteMeta(id) + `\*\*`)
	loc := re.FindStringIndex(tasksMD)
	if loc == nil {
		return ""
	}
	rest := tasksMD[loc[0]:]
	// End at the next top-level bullet or a blank line, whichever first.
	end := len(rest)
	if m := regexp.MustCompile(`(?m)^(- \[|\s*$)`).FindStringIndex(rest[1:]); m != nil {
		end = m[0] + 1
	}
	return strings.TrimSpace(rest[:end])
}
