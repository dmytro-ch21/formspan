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

// Ruleset is one IBJJF competition ruling, shared by every technique it
// applies to. 25 of these cover all 466 techniques — see the migration for why
// they are a table rather than columns.
type Ruleset struct {
	ID       string `json:"id"`
	AgeScope string `json:"age_scope"`

	// "Generally legal — Adult", "Brown/Black only — Adult", "Prohibited", …
	RuleClass string `json:"rule_class"`

	// Empty means "this division does not apply" (a gi-only technique has no
	// no-gi belts), NOT "allowed at no belt". The reason is in the note.
	GiAllowedBelts   []string `json:"gi_allowed_belts"`
	GiNote           string   `json:"gi_note"`
	NoGiAllowedBelts []string `json:"no_gi_allowed_belts"`
	NoGiNote         string   `json:"no_gi_note"`

	// Whether this is a genuine restriction rather than the shape of IBJJF's
	// divisions. Adult no-gi has no white belt division, so a no-gi listing of
	// "Blue, Purple, Brown, Black" is the baseline. Do not re-derive this by
	// comparing belt lists — that reads ~130 ordinary techniques as restricted
	// when the true number is 20.
	IsRestricted bool `json:"is_restricted"`

	Notes   string   `json:"notes"`
	Sources []string `json:"sources"`
}

// Summary is the list row: everything needed to render, filter and search the
// library, and nothing else.
//
// The library is 466 techniques and the long prose fields dominate its size —
// returning full rows from the list endpoint ships ~550 KB to draw a scrolling
// list. This is ~70 KB. Aliases are included deliberately: the client searches
// locally, and "kesa gatame" has to find "Scarf Hold".
type Summary struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Aliases        []string `json:"aliases"`
	Category       string   `json:"category"`
	Position       string   `json:"position"`
	PositionDetail string   `json:"position_detail"`
	GiNoGi         string   `json:"gi_no_gi"`

	// Presented as "commonly taught from", never as a recommendation. It sits
	// beside IBJJF legality, and two belt-shaped fields where one is advisory
	// and one is a rule you can be disqualified for breaking is a genuinely
	// confusing pairing. Drilling a technique and being allowed to compete it
	// are different questions.
	TypicalBelt string `json:"typical_belt"`

	IBJJFRulesetID string `json:"ibjjf_ruleset_id"`
}

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

	// Description is mechanics; WhenToUse is the decision about when the
	// mechanics apply. Keeping them apart is the point — merging them produces
	// a paragraph that answers neither question well.
	Description string `json:"description"`
	WhenToUse   string `json:"when_to_use"`

	// The graph edges: what this is set up from, what follows it, and what
	// answers it. Names rather than IDs — see the migration for why.
	//
	// Only setup_from is reliably a graph (~80% of its entries name a real
	// technique). CommonNextMoves resolves ~29% and CommonCounters ~6%; the
	// rest is prose like "establish grips or inside ties". A client may link
	// the ones that resolve but must render the others as plain text.
	SetupFrom       []string `json:"setup_from"`
	CommonNextMoves []string `json:"common_next_moves"`
	CommonCounters  []string `json:"common_counters"`

	VideoReference string `json:"video_reference"`
	SourceNotes    string `json:"source_notes"`

	IBJJFRulesetID string `json:"ibjjf_ruleset_id"`
	// Resolved on Get so a technique detail is one request, not two.
	IBJJF *Ruleset `json:"ibjjf,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Filter narrows a listing. A zero Filter lists everything.
type Filter struct {
	Position string // exact match; empty means any
	Category string // exact match; empty means any
	GiNoGi   string // "Gi Only"/"No-Gi Only" also match "Both"
	Query    string // case-insensitive substring of Name or any alias
}

type Repository interface {
	// List returns summaries, never full rows — see Summary.
	List(ctx context.Context, f Filter) ([]Summary, error)
	Get(ctx context.Context, id string) (*Technique, error)
	Rulesets(ctx context.Context) ([]Ruleset, error)

	// Rulesets must be upserted before techniques: the technique rows carry an
	// FK to them, so the reverse order fails on the constraint.
	UpsertRulesets(ctx context.Context, rulesets []Ruleset) error
	UpsertAll(ctx context.Context, techniques []Technique) error
}
