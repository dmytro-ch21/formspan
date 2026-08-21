package runstate

import (
	"context"
	"fmt"
)

// GateOutcome mirrors one quality gate's result without importing devengine
// (the dependency points devengine → runstate, never back). Each outcome
// becomes its OWN step row, so two failing gates are two distinguishable
// failures in the run record rather than one opaque red.
type GateOutcome struct {
	Name     string
	Command  string // the invocation, so the audit row is self-describing
	Passed   bool
	Output   string
	ExitCode *int
}

// RecordGates appends one step per gate outcome under the run, in order.
// It requires the live lease (AppendStep enforces it), so a dispossessed
// engine cannot write gate history into a run somebody else now owns.
func (s *Store) RecordGates(ctx context.Context, runID int64, owner string, outcomes []GateOutcome) error {
	for _, o := range outcomes {
		verdict := "pass"
		if !o.Passed {
			verdict = "fail"
		}
		summary := verdict
		if o.Output != "" {
			summary = fmt.Sprintf("%s: %s", verdict, o.Output)
		}
		if err := s.AppendStep(ctx, runID, owner, "gate:"+o.Name, o.Command, summary, o.ExitCode); err != nil {
			return fmt.Errorf("record gate %s: %w", o.Name, err)
		}
	}
	return nil
}
