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
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Aliases  []string `json:"aliases"`
	Category string   `json:"category"`

	// The queryable axis; see Technique.Function. Carried on the summary
	// deliberately — clients resolve "every way to escape from here" against
	// the list they already hold, so leaving it to the detail payload would
	// mean a request per technique to answer one question.
	Function string `json:"function,omitempty"`

	Position       string `json:"position"`
	PositionDetail string `json:"position_detail"`

	// Where the technique LEAVES you, or empty when not recorded.
	//
	// Closes the half of the graph `position` and `function` cannot express:
	// where it starts and what it does, but not where it ends. Sparse by
	// design — see migration 000029 for the two measurements that made this
	// authoring work rather than derivation work.
	//
	// Empty means NOT RECORDED, never "goes nowhere". A technique that
	// genuinely leaves you where you started carries its own position, so
	// "stays put" is recorded as a fact rather than read out of an absence.
	ToPosition string `json:"to_position,omitempty"`

	GiNoGi string `json:"gi_no_gi"`

	// Presented as "commonly taught from", never as a recommendation. It sits
	// beside IBJJF legality, and two belt-shaped fields where one is advisory
	// and one is a rule you can be disqualified for breaking is a genuinely
	// confusing pairing. Drilling a technique and being allowed to compete it
	// are different questions.
	TypicalBelt string `json:"typical_belt"`

	IBJJFRulesetID string `json:"ibjjf_ruleset_id"`

	// The graph edge, carried on the SUMMARY and not only the detail row.
	//
	// This is what makes the library a traversable graph rather than 466
	// isolated entries. `setup_from` names what a technique comes FROM; a
	// client inverts it once over the list it already holds to get the far
	// more useful direction — what FOLLOWS from here — which is the question
	// a position screen and any "what should I learn next" answer are made of.
	//
	// Detail-only, it would cost one request per technique to walk a single
	// hop. On the summary it costs ~21 KB on a ~149 KB list (+14%), against
	// ~478 KB for shipping full rows. Names rather than ids, matching the
	// detail payload — see the migration for why.
	SetupFrom []string `json:"setup_from"`
}

// Position is one of the graph's nodes, made readable.
//
// The library models techniques as edges between positions (see the package
// comment, and docs/decisions/bjj-tracking-design.md §4). The edges have always
// been seeded; the nodes were only ever free-text tags on them, which is enough
// to filter a list and useless to a beginner. "Armbar from Closed Guard" means
// nothing until something says what closed guard is.
//
// Ten curated entries, so no filtering, paging or search — a client fetches
// them once, like Rulesets. Unlike Rulesets, the ids are hand-authored and
// stable rather than content-addressed, which is why there is no orphan-pruning
// step and no ordering constraint against UpsertAll: positions are referenced by
// nothing, and editing one updates its row instead of minting a new id.
type Position struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Aliases []string `json:"aliases"`

	// The join key back to the library, matching the family prefixes on
	// Technique.Position ("Guard", "Half Guard", "Side Control", "Back" — note
	// "Back", not "Back Control"). Clients resolve "techniques from here"
	// locally against the summaries they already hold, so this is what makes
	// the cross-link free. A wrong value produces an empty list rather than an
	// error, so seed validation checks it against the known set.
	Family string `json:"family"`

	// Narrow the cross-link within Family, using techniques.position_detail.
	//
	// Family alone cannot separate closed guard from open guard: the technique
	// rows say only "Guard - Bottom". PositionDetail can — it carries "Closed
	// Guard" on 35 and "Open Guard" on 37 — so these two express which side of
	// that split a position wants.
	//
	// Includes is a whitelist (empty means "the whole family"), Excludes a
	// blacklist applied after it. They are opposite operations because the two
	// positions that need them are opposite shapes: closed guard is a short
	// enumerable set, open guard is everything-but. A client MUST apply both,
	// or Open Guard silently lists closed-guard techniques again.
	//
	// Matching is exact and case-sensitive, and the library carries case
	// variants ("High Mount" alongside "High mount", "S-Mount" alongside
	// "S-mount"). Picking one silently drops the other's rows, and seed
	// validation cannot catch it because both spellings genuinely exist. Check
	// the distinct values before adding a detail here.
	DetailIncludes []string `json:"detail_includes"`
	DetailExcludes []string `json:"detail_excludes"`

	// Pedagogical, not alphabetical — alphabetical opens the glossary on Back
	// Control, which is the last thing a beginner needs. Spaced by 10 so an
	// entry can be inserted later without renumbering.
	OrderIndex int `json:"order_index"`

	// Description is what the position is and how you arrive in it; Priorities
	// is what you are trying to do while there, for both players. Split for the
	// same reason Technique splits Description from WhenToUse.
	Description string `json:"description"`
	Priorities  string `json:"priorities"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Technique struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Aliases []string `json:"aliases"`

	// Submission | Sweep | Pass | Escape | Takedown | Control/Pin |
	// Transition | Guard Retention | Other.
	//
	// Colloquial and deliberately kept: "Sweep" is the word a coach says. It
	// fuses two axes though — "Takedown" is Function advance at Position
	// standing — so it is the display label, not the queryable one. Use
	// Function for "every way to X from here".
	Category string `json:"category"`

	// What it does: advance | reverse | escape | control | finish.
	//
	// Empty for the handful of movement fundamentals (breakfalls, grappling
	// stance) that are library content rather than techniques — they have no
	// verb, and asserting one would be a lie. `omitempty` so those serialise
	// as absent rather than as an empty string a client would have to
	// special-case.
	//
	// Note for TypeScript callers: `function` is a reserved word, so read it
	// as `t.function` — it cannot be destructured as `const { function } = t`.
	Function string `json:"function,omitempty"`

	// Where it happens — "Guard - Bottom", "Standing", "Mount - Top".
	Position       string `json:"position"`
	PositionDetail string `json:"position_detail"`

	// Where it LEAVES you; see Summary.ToPosition. Empty means not recorded,
	// never "goes nowhere".
	ToPosition string `json:"to_position,omitempty"`

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

	// Positions returns all ten, ordered pedagogically. GetPosition reports a
	// missing id as ErrNotFound — the same sentinel Get uses, because the two
	// id namespaces are disjoint and a caller always knows which it asked for.
	Positions(ctx context.Context) ([]Position, error)
	GetPosition(ctx context.Context, id string) (*Position, error)

	// Unlike UpsertRulesets, this has no ordering constraint: nothing holds an
	// FK to positions, so it may run before or after UpsertAll.
	UpsertPositions(ctx context.Context, positions []Position) error

	// Rulesets must be upserted before techniques: the technique rows carry an
	// FK to them, so the reverse order fails on the constraint.
	UpsertRulesets(ctx context.Context, rulesets []Ruleset) error
	UpsertAll(ctx context.Context, techniques []Technique) error

	// Called after UpsertAll — rulesets are content-addressed, so editing a
	// rule mints a new id and leaves the old row unreferenced.
	DeleteOrphanRulesets(ctx context.Context) error
}
