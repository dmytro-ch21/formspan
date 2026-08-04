package bjj

import (
	"context"
)

// Focus is one technique the athlete is deliberately working on.
//
// This exists to REMOVE capture, not add it. The reflection wizard was
// recording the same live event twice — once per-technique on the drilled step
// and once per-category in the live grid — and the earlier fix was a
// convention for which one a query should read. That was papering over the
// real problem: two capture paths for one event means the model is wrong.
//
// A short focus list resolves it structurally. These techniques appear as
// one-tap chips inside the live grid, so recording one IS the grid row rather
// than a second row beside it, and there is nowhere left to double-record.
//
// It also puts technique-level detail where it earns its cost. Naming a
// technique means searching 466 library entries; across the whole catalog that
// data is mostly noise, across the three-to-five things you are developing it
// is the most valuable evidence in the system.
type Focus struct {
	TechniqueID string `json:"technique_id"`
	// Name and Position come from the shared library so a client can render
	// the list without a second fetch.
	Name     string `json:"name"`
	Position string `json:"position"`
	Category string `json:"category"`
	// StartedOn is when this technique joined the list — the input to "you
	// have been on this five weeks, consider rotating". Preserved across
	// re-saves; see SetFocus.
	//
	// A STRING, matching Promotion.PromotedOn, because the column is a DATE and
	// a time.Time marshals it as a full RFC3339 instant — which contradicts the
	// contract's `format: date` and, worse, renders as the PREVIOUS DAY for any
	// athlete west of UTC once a client localises midnight-UTC. A bad look on a
	// field whose whole job is "how many weeks has this been here".
	StartedOn string `json:"started_on"`
}

// maxFocus bounds the list, and the bound is the feature.
//
// A focus list that holds twenty techniques is not a focus list — it is the
// library again, and it would put the wizard back to searching. Coaches
// structure development a few things at a time; this is that, enforced.
const maxFocus = 5

// maxFocusBody bounds the request. Five ids and their JSON scaffolding is a
// few hundred bytes; 8 KB is the same ceiling the other small writes here use.
const maxFocusBody = 8 << 10

// FocusRepository is the athlete's current working set.
type FocusRepository interface {
	// Focus returns the list in the athlete's own order.
	Focus(ctx context.Context, userID string) ([]Focus, error)
	// SetFocus replaces the list wholesale.
	//
	// Replace rather than merge, matching every other client-owned list here:
	// the client holds the desired state and re-sends it, so a retry after a
	// partial failure converges instead of duplicating.
	SetFocus(ctx context.Context, userID string, techniqueIDs []string) error
}
