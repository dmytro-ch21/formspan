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
// technique means searching 542 library entries; across the whole catalog that
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
	// CurriculumIDs is which curricula currently claim this row — the read side
	// of bjj_focus_sources, joined by Focus(). Named to match FocusSource's own
	// CurriculumID/curriculum_id rather than the ticket's "roadmap_ids": the
	// column, the FK and the request body all already say "curriculum", and
	// "roadmap" is UI language for the same object.
	//
	// THIS EXISTS TO FIX N100. `proposeFocus`/`proposeOneFocus` used to compute
	// `unchanged` from the technique list alone, which is right for "would this
	// write change the SET" and wrong for "would this write change anything" —
	// a second roadmap whose techniques are already all in focus changes
	// nothing about the set but still needs to register its own claim, or its
	// techniques have no source and a later deactivation of the FIRST roadmap
	// takes them away while the second is still working them. A client can only
	// tell those two cases apart if the read exposes who already claims what,
	// which is what this field is for.
	//
	// Non-nil, matching Focus() 's own out := []Focus{} convention: an
	// athlete-only row marshals to [], never null, so a client's `.includes()`
	// never has to guard a possibly-missing array.
	CurriculumIDs []string `json:"curriculum_ids"`
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

// Provenance: why a focus row is there, and therefore who may take it away.
//
// A focus row used to record only WHAT the athlete was working on, never why,
// and that missing fact was a bug: enrolling in a roadmap writes its techniques
// into this list, un-enrolling left them behind, and "remove what that roadmap
// added" was not a question the table could answer. So it was answered the only
// way it could be — not at all.
//
// Three states, TWO behaviours. The third exists so the safe choice is legible
// rather than a backfilled guess:
//
//   - originAthlete — the athlete put this here. SOVEREIGN: no roadmap, ever,
//     may remove it. This is the whole safety property. A blunt "clear focus on
//     deactivate" is a data-loss bug wearing a fix's clothes, and this is what
//     rules it out structurally rather than by everyone remembering.
//   - originRoadmap — a roadmap put this here. Removed when the LAST roadmap
//     still asking for it lets go — see bjj_focus_sources, which is a set
//     because two syllabuses genuinely can want the same armbar.
//   - originUnknown — the row predates provenance (migration 000069). We do not
//     know, so it BEHAVES exactly like originAthlete: nothing deletes it.
//     Deliberately not backfilled to 'athlete', because that would record a
//     guess as a fact, and deliberately not to 'roadmap', because that guess
//     deletes an athlete's own choices.
//
// THE ONE RULE THAT MAKES THE BOTH-SOURCES CASE WORK: origin is set when a row
// is INSERTED and never rewritten by a re-save. So a technique hand-picked
// FIRST and later also named by a roadmap stays 'athlete' and survives that
// roadmap's deactivation — which is exactly the case the ticket calls the hard
// part. Same discipline as started_on below it, and for the same reason: an
// ordinary edit must not rewrite a column that answers a question about the
// past. See SetFocus, where both are absent from the ON CONFLICT SET clause.
const (
	originAthlete = "athlete"
	originRoadmap = "roadmap"
	originUnknown = "unknown"
)

// FocusSource attributes part of a focus write to the roadmap that asked for it.
//
// TechniqueIDs is a SUBSET of the write's own list rather than the whole of it,
// and that is the point: a roadmap write also re-sends whatever the athlete
// already had (roadmapFocus.ts rule 3, "the roadmap is not entitled to it"), and
// attributing those to the roadmap would hand it the power to delete them.
// The server therefore never infers which ids belong to the roadmap — the client
// says, because only the client is holding the curriculum's item list.
type FocusSource struct {
	CurriculumID string
	TechniqueIDs []string
}

// FocusRepository is the athlete's current working set.
type FocusRepository interface {
	// Focus returns the list in the athlete's own order.
	Focus(ctx context.Context, userID string) ([]Focus, error)
	// SetFocus replaces the list wholesale.
	//
	// Replace rather than merge, matching every other client-owned list here:
	// the client holds the desired state and re-sends it, so a retry after a
	// partial failure converges instead of duplicating.
	//
	// source is nil for a hand edit — the athlete reordering, adding or dropping
	// techniques themselves — and non-nil when a roadmap is being applied.
	SetFocus(ctx context.Context, userID string, techniqueIDs []string, source *FocusSource) error
	// ReleaseFocusSource withdraws one roadmap's claim on this athlete's focus
	// rows, and removes the rows left with no claim at all.
	//
	// This is the un-enrolment half of the loop, and it deliberately lives HERE
	// rather than in `curriculum`, whose package comment reserves the right to
	// never read or write bjj_focus so a curriculum cannot silently become a
	// prescription. That separation stands; what was missing was a home for the
	// cleanup, which belonged to neither side. The composition root calls this
	// alongside Archive — see cmd/api/enrollment.go.
	//
	// Idempotent, and safe to call for a curriculum the athlete was never
	// enrolled in: the only rows it can reach are ones that curriculum itself
	// placed.
	ReleaseFocusSource(ctx context.Context, userID, curriculumID string) error
}
