// Package technique holds the BJJ technique library.
//
// Deliberately separate from the exercise catalog, because a technique is a
// different *shape*, not merely a different sport:
//
//   - An exercise is a loggable unit measured by a load type. You never log
//     "3 sets of armbar at 60kg" — techniques aren't measured at all. They're
//     reference knowledge that gets tagged onto a session.
//   - A technique lives in a graph: it comes from a position, and it's
//     answered by counters. In the seeded library 444 of 450 techniques
//     carry setup_from edges and every one carries counters, so that graph
//     is the substance of the thing rather than a nice-to-have.
//
// Merging the two would leave half the columns null on both sides and make
// the graph inexpressible.
//
// Read-only over HTTP and seeded from version-controlled JSON, same
// discipline as the exercise catalog.
package technique

import (
	"context"
	"errors"
	"time"
)

var ErrNotFound = errors.New("technique: not found")

type Technique struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Aliases []string `json:"aliases"`

	// Submission | Sweep | Pass | Escape | Takedown | Control/Pin |
	// Transition | Guard Retention | Other.
	Category string `json:"category"`

	// Where it happens — "Guard - Bottom", "Standing", "Mount - Top".
	Position       string `json:"position"`
	PositionDetail string `json:"position_detail"`

	GiNoGi      string `json:"gi_no_gi"` // Both | Gi Only | No-Gi Only
	TypicalBelt string `json:"typical_belt"`
	Description string `json:"description"`

	// The graph edges: what this is set up from, and what answers it.
	// Names rather than IDs — see the migration for why.
	SetupFrom      []string `json:"setup_from"`
	CommonCounters []string `json:"common_counters"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Filter narrows a listing. A zero Filter lists everything.
type Filter struct {
	Position string // exact match; empty means any
	Category string // exact match; empty means any
	GiNoGi   string // "Gi Only"/"No-Gi Only" also match "Both"
	Query    string // case-insensitive substring of Name
}

type Repository interface {
	List(ctx context.Context, f Filter) ([]Technique, error)
	Get(ctx context.Context, id string) (*Technique, error)
	UpsertAll(ctx context.Context, techniques []Technique) error
}
