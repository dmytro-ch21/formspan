// Package runstate is the dev engine's durable memory: runs, steps, events
// and artifacts in Postgres, with one active lease per issue. The GitHub
// board shows humans macro-states; this package holds the real workflow
// state, so a run survives a process restart and two engines can never work
// the same ticket.
//
// The engine database is SEPARATE from the product database — engine
// migrations live here (embedded, applied by Migrate), never in
// backend/migrations/.
package runstate

import "fmt"

// State is one node of the engine's internal state machine.
type State string

const (
	Queued       State = "QUEUED"
	Claimed      State = "CLAIMED"
	Context      State = "CONTEXT"
	Planning     State = "PLANNING"
	Implementing State = "IMPLEMENTING"
	LocalVerify  State = "LOCAL_VERIFY"
	SelfReview   State = "SELF_REVIEW"
	PROpen       State = "PR_OPEN"
	CIWait       State = "CI_WAIT"
	Fixing       State = "FIXING"
	ACVerify     State = "AC_VERIFY"
	ReadyToMerge State = "READY_TO_MERGE"
	Merging      State = "MERGING"
	EvidenceWait State = "EVIDENCE_WAIT"
	Done         State = "DONE"
	Blocked      State = "BLOCKED"
	Failed       State = "FAILED"
	Cancelled    State = "CANCELLED"
)

// transitions is the whole legal edge set. Every non-terminal state may also
// move to the three side terminals (added in init below) — a run can be
// blocked, failed or cancelled from anywhere mid-flight.
var transitions = map[State][]State{
	Queued:       {Claimed},
	Claimed:      {Context},
	Context:      {Planning},
	Planning:     {Implementing},
	Implementing: {LocalVerify},
	LocalVerify:  {SelfReview},
	SelfReview:   {PROpen},
	PROpen:       {CIWait},
	CIWait:       {Fixing, ACVerify},
	Fixing:       {LocalVerify},
	ACVerify:     {ReadyToMerge},
	ReadyToMerge: {Merging},
	Merging:      {EvidenceWait, Done},
	// EVIDENCE_WAIT resolves only through the evidence latch: the human's
	// /evidence comment closes the ticket, and the engine records Done.
	EvidenceWait: {Done},
	// Terminals have no outgoing edges. A BLOCKED run is not resumed — the
	// unblocking human action produces a NEW run, so history stays linear.
	Done: {}, Blocked: {}, Failed: {}, Cancelled: {},
}

var terminal = map[State]bool{Done: true, Blocked: true, Failed: true, Cancelled: true}

func init() {
	for s := range transitions {
		if terminal[s] {
			continue
		}
		transitions[s] = append(transitions[s], Blocked, Failed, Cancelled)
	}
}

// Terminal reports whether s ends a run. The one-active-lease-per-issue
// constraint keys on this: the partial unique index in the schema names
// exactly these states, and TestTerminalStatesMatchTheSchema pins the two
// lists together so neither can drift alone.
func Terminal(s State) bool { return terminal[s] }

// CanTransition reports whether from → to is a legal edge.
func CanTransition(from, to State) bool {
	for _, next := range transitions[from] {
		if next == to {
			return true
		}
	}
	return false
}

// ValidateTransition returns a descriptive error for an illegal edge.
func ValidateTransition(from, to State) error {
	if !CanTransition(from, to) {
		return fmt.Errorf("illegal transition %s → %s", from, to)
	}
	return nil
}

// States returns every declared state (for tests and diagnostics).
func States() []State {
	out := make([]State, 0, len(transitions))
	for s := range transitions {
		out = append(out, s)
	}
	return out
}
