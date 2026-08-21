package runstate

import (
	"regexp"
	"sort"
	"strings"
	"testing"
)

func TestTheHappyPathIsLegalEndToEnd(t *testing.T) {
	chain := []State{Queued, Claimed, Context, Planning, Implementing,
		LocalVerify, SelfReview, PROpen, CIWait, ACVerify, ReadyToMerge,
		Merging, EvidenceWait, Done}
	for i := 0; i < len(chain)-1; i++ {
		if err := ValidateTransition(chain[i], chain[i+1]); err != nil {
			t.Fatalf("happy path broken: %v", err)
		}
	}
	// And the CI-repair loop.
	for _, edge := range [][2]State{{CIWait, Fixing}, {Fixing, LocalVerify}, {Merging, Done}} {
		if err := ValidateTransition(edge[0], edge[1]); err != nil {
			t.Fatalf("loop edge broken: %v", err)
		}
	}
}

func TestIllegalTransitionsAreRefused(t *testing.T) {
	for _, edge := range [][2]State{
		{Queued, Done},          // no skipping the whole pipeline
		{Done, Queued},          // terminals have no outgoing edges
		{Blocked, Claimed},      // unblocking is a NEW run, not a resume
		{Merging, Implementing}, // no going backwards
		{ACVerify, Merging},     // READY_TO_MERGE is not optional
	} {
		if err := ValidateTransition(edge[0], edge[1]); err == nil {
			t.Fatalf("illegal edge %s → %s was allowed", edge[0], edge[1])
		}
	}
}

func TestEveryNonTerminalCanReachEverySideTerminal(t *testing.T) {
	for _, s := range States() {
		if Terminal(s) {
			continue
		}
		for _, term := range []State{Blocked, Failed, Cancelled} {
			if !CanTransition(s, term) {
				t.Fatalf("%s cannot reach %s — a run stuck there could never be stopped", s, term)
			}
		}
	}
}

func TestTerminalsHaveNoOutgoingEdges(t *testing.T) {
	for _, s := range []State{Done, Blocked, Failed, Cancelled} {
		if len(transitions[s]) != 0 {
			t.Fatalf("terminal %s has outgoing edges %v", s, transitions[s])
		}
	}
}

func TestTerminalStatesMatchTheSchema(t *testing.T) {
	// The lease constraint is a partial unique index whose predicate names
	// the terminal states as SQL literals — one invariant written in two
	// languages. This test is the only thing holding them together: add a
	// terminal state in Go without touching the schema (or vice versa) and
	// this goes red.
	var fromGo []string
	for _, s := range States() {
		if Terminal(s) {
			fromGo = append(fromGo, string(s))
		}
	}
	var fromVar []string
	for _, s := range terminalStatesInSchema {
		fromVar = append(fromVar, string(s))
	}
	sort.Strings(fromGo)
	sort.Strings(fromVar)
	if strings.Join(fromGo, ",") != strings.Join(fromVar, ",") {
		t.Fatalf("Terminal() = %v but terminalStatesInSchema = %v", fromGo, fromVar)
	}

	// And the SQL itself: extract the NOT IN list from the index predicate
	// rather than trusting the Go variable beside it. Scan ALL migrations and
	// take the LAST match, so a future migration replacing the index moves
	// the pin with it instead of pinning the superseded predicate.
	re := regexp.MustCompile(`state NOT IN \(([^)]+)\)`)
	var m []string
	for _, mig := range migrations {
		if found := re.FindAllStringSubmatch(mig, -1); len(found) > 0 {
			m = found[len(found)-1]
		}
	}
	if m == nil {
		t.Fatal("lease index predicate not found in any migration")
	}
	var fromSQL []string
	for _, part := range strings.Split(m[1], ",") {
		fromSQL = append(fromSQL, strings.Trim(strings.TrimSpace(part), "'"))
	}
	sort.Strings(fromSQL)
	if strings.Join(fromGo, ",") != strings.Join(fromSQL, ",") {
		t.Fatalf("Terminal() = %v but the SQL predicate names %v", fromGo, fromSQL)
	}
}
