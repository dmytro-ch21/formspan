// Package devengine holds the dev engine's core: board snapshots, the
// Todo → In Progress transition detector, the dispatch preflight, and the
// shadow-mode decision log.
//
// Phase 1 (N137) is SHADOW MODE: the engine observes the board and records
// what it WOULD do — it edits no code and writes nothing to GitHub. The
// Dispatcher interface is the seam where Phase 2 replaces the shadow logger
// with a real worker, and where a webhook gateway (N146) later replaces the
// polling source without touching anything downstream.
package devengine

import (
	"context"
	"time"
)

// Item is one board item as the engine sees it. A draft project item — a card
// typed straight onto the board with no backing issue — has IsDraft true and
// zero IssueNumber; the preflight refuses those rather than inventing work.
type Item struct {
	IssueNumber int
	Title       string
	Body        string
	Status      string
	Assignees   []string
	Labels      []string
	IsDraft     bool
}

// BoardSource produces the current board state. The polling GraphQL reader
// implements it today; a webhook-fed cache implements it in N146. Keeping the
// snapshot shape identical is what makes that swap invisible downstream.
type BoardSource interface {
	Snapshot(ctx context.Context) ([]Item, error)
}

// Decision is what the engine concluded about one transition. In shadow mode
// it is logged; in Phase 2 a WouldDispatch decision becomes a real run.
type Decision struct {
	Time          time.Time `json:"ts"`
	Issue         int       `json:"issue"`
	Title         string    `json:"title"`
	Event         string    `json:"event"`
	WouldDispatch bool      `json:"would_dispatch"`
	// Reasons is non-empty exactly when WouldDispatch is false: each entry is
	// one preflight refusal, phrased as the thing a human would need to fix.
	Reasons []string `json:"reasons,omitempty"`
	Risk    string   `json:"risk"`
	// HumanGated: the ticket can be worked but never auto-merged (policy
	// human_gate labels). Distinct from a refusal.
	HumanGated bool        `json:"human_gated,omitempty"`
	Context    ContextPlan `json:"context"`
	Engine     string      `json:"engine"`
}

// ContextPlan is what the context builder would load for this ticket:
// the docs, T traps and gate groups selected from context-map.json.
type ContextPlan struct {
	Docs  []string `json:"docs,omitempty"`
	Traps []string `json:"traps,omitempty"`
	Gates []string `json:"gates,omitempty"`
}

// Dispatcher consumes decisions. Shadow mode's implementation appends JSONL;
// Phase 2's implementation will create a durable run.
type Dispatcher interface {
	Dispatch(ctx context.Context, d Decision) error
}
