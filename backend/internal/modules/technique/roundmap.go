package technique

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

// The teaching map of a round: what the positions are, how you move between
// them, and which way is up.
//
// **Authored, not derived, and that is the decision worth defending.** The
// library already holds a real position graph — `Technique.ToPosition` records
// where a technique leaves you — and deriving the map from it was tried first.
// It produces the right spine (standing → guard → pass → side control) and then
// falls apart: only 170 of 542 techniques record a `to_position`. Measured
// against the catalog: the mount-to-back edge does not exist at all, the
// side-control-to-mount edge rests on a single technique, and **not one of the
// Escape-category techniques records where it leaves you** — so the whole loop
// back from the bad places is missing. A drawn map with holes in it is worse
// than no map, because a missing edge is invisible: it reads as "you cannot get
// there" rather than as "nobody wrote this down".
//
// So the structure is authored teaching content and the *contents* of each node
// are real: every node names a position the library can be filtered to, and
// every one of them resolves to techniques (8 at the thinnest, 139 at the
// widest). That split is checked by a test rather than trusted.
//
// **Nodes are sided; the glossary is not.** `Position` describes closed guard
// once, for both players, which is right for a glossary and useless for a route:
// a map has to be drawn from somebody's point of view or "sweep" and "get swept"
// are the same arrow. So a node carries both — `PositionID` for the glossary
// entry behind it, and `Position` for the library filter, which is the sided
// value ("Mount - Top"). Two nodes may share a `PositionID`; being mounted and
// mounting are one position and opposite places to be.
//
// **Not seeded, and deliberately not a table.** Every other content type here is
// a collection: rows get filtered, looked up by id, joined against. This is one
// document, referenced by nothing, and a table for it would mean a migration
// every time somebody rewrites a diagram. It rides along on the positions
// response instead — one fetch, one cache, and the node ids cannot be validated
// against a glossary the client fetched separately and might hold a different
// version of.
//
//go:embed roundmap.json
var roundMapJSON []byte

// RoundMap is the whole document.
type RoundMap struct {
	Title string `json:"title"`
	// Intro is the paragraph a beginner reads before the diagram means
	// anything. It belongs to the content rather than to either client,
	// because a typo in it should not need an App Store release.
	Intro string `json:"intro"`
	// Bands are the reading key: which stretch of the tier ladder counts as
	// ahead, even and behind, and what each one is teaching. Authored rather
	// than derived from the sign of `Tier` so the wording lives in one place
	// instead of being restated by every client that draws the ladder.
	//
	// Ordered from the top down, and a node belongs to the FIRST band whose
	// MinTier it clears — so they partition the nodes without needing an upper
	// bound each, and a gap between two bands is impossible by construction.
	Bands []MapBand `json:"bands"`
	Nodes []MapNode `json:"nodes"`
	Edges []MapEdge `json:"edges"`
}

// MapBand is one stretch of the ladder.
type MapBand struct {
	// MinTier is inclusive. The last band's value is deliberately far below the
	// lowest node rather than exactly equal to it, so adding a worse position
	// later cannot silently fall out of every band.
	MinTier int    `json:"min_tier"`
	Label   string `json:"label"`
	Note    string `json:"note"`
}

// MapNode is one place you can be.
type MapNode struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// PositionID is the glossary entry behind this node, and Position is the
	// sided value to filter the library by. See the package note above for why
	// a node needs both.
	PositionID string `json:"position_id"`
	Position   string `json:"position"`
	// Narrow the match within Position, exactly as the glossary's Position type
	// does within Family — and for the same reason, one level down.
	//
	// The library has NO knee-on-belly position value: those 8 techniques sit
	// under "Side Control - Top" carrying `position_detail` "Knee on Belly". So
	// a node that could only name a position had to borrow side control's 31,
	// which passes every test that asks "does this resolve to something" and
	// renders one list under two differently labelled boxes. Review caught it;
	// `TestNoTwoNodesResolveTheSameWay` is what stops the next one.
	//
	// Includes is a whitelist (empty means the whole position), Excludes a
	// blacklist. Never both — see the glossary's identical rule for why.
	DetailIncludes []string `json:"detail_includes"`
	DetailExcludes []string `json:"detail_excludes"`
	// Tier is what the position is worth FROM YOUR SIDE — 5 on their back, -3
	// with your own back taken, 0 standing. It is the whole hierarchy in one
	// integer, which is what lets a narrow screen render the map as a ladder
	// without needing the edges at all.
	//
	// Ordering, not arithmetic: the gap between two tiers means nothing, and
	// several nodes deliberately share one.
	Tier int    `json:"tier"`
	Note string `json:"note"`
}

// MapEdge is one way to get from somewhere to somewhere else.
type MapEdge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label"`
	// Kind is "route" (you advancing), "recover" (you getting out of a bad
	// place) or "concede" (you losing ground). Three rather than two because a
	// map with no concede edges leaves every bad position with nothing pointing
	// at it, which draws as unreachable — and "how do I end up here" is the
	// question a beginner is actually asking when they look at one.
	Kind string `json:"kind"`
}

var validEdgeKinds = map[string]bool{"route": true, "recover": true, "concede": true}

// LoadRoundMap parses and validates the embedded map. Exported so a test can
// check it against the embedded library with no database — the same reason
// SeedData is exported, and the same failure it prevents: a node naming a
// position nothing matches would render as an empty list rather than an error.
func LoadRoundMap() (*RoundMap, error) {
	var m RoundMap
	if err := json.Unmarshal(roundMapJSON, &m); err != nil {
		return nil, fmt.Errorf("technique: parse round map: %w", err)
	}
	// Nil slices marshal as `null`, and the contract marks both required. Same
	// normalisation the glossary does at its own parse boundary, and for the
	// same reason: a client should never have to special-case absent-versus-
	// empty for a list that is empty on most entries.
	for i := range m.Nodes {
		if m.Nodes[i].DetailIncludes == nil {
			m.Nodes[i].DetailIncludes = []string{}
		}
		if m.Nodes[i].DetailExcludes == nil {
			m.Nodes[i].DetailExcludes = []string{}
		}
	}
	if err := validateRoundMap(&m); err != nil {
		return nil, err
	}
	return &m, nil
}

func validateRoundMap(m *RoundMap) error {
	// An empty map is a parse or embed failure wearing a success, exactly as
	// with the glossary: the clients would draw "no map yet" and nothing would
	// report an error.
	if len(m.Nodes) == 0 {
		return fmt.Errorf("technique: round map has no nodes")
	}
	if len(m.Edges) == 0 {
		return fmt.Errorf("technique: round map has no edges")
	}
	if m.Title == "" || m.Intro == "" {
		return fmt.Errorf("technique: round map needs a title and an intro")
	}
	if len(m.Bands) == 0 {
		return fmt.Errorf("technique: round map has no bands")
	}
	for i, b := range m.Bands {
		if b.Label == "" || b.Note == "" {
			return fmt.Errorf("technique: round map band %d needs a label and a note", i)
		}
		// Strictly descending, because a node takes the first band it clears:
		// equal or rising thresholds make a later band unreachable, which draws
		// as a heading with nothing under it.
		if i > 0 && b.MinTier >= m.Bands[i-1].MinTier {
			return fmt.Errorf(
				"technique: round map band %d (min_tier %d) does not sit below band %d (min_tier %d)",
				i, b.MinTier, i-1, m.Bands[i-1].MinTier)
		}
	}

	seen := make(map[string]bool, len(m.Nodes))
	for _, n := range m.Nodes {
		switch {
		case n.ID == "":
			return fmt.Errorf("technique: round map node %q has no id", n.Label)
		case seen[n.ID]:
			return fmt.Errorf("technique: duplicate round map node id %q", n.ID)
		case n.Label == "" || n.Note == "":
			return fmt.Errorf("technique: round map node %q needs a label and a note", n.ID)
		case n.PositionID == "" || n.Position == "":
			return fmt.Errorf("technique: round map node %q needs position_id and position", n.ID)
		case len(n.DetailIncludes) > 0 && len(n.DetailExcludes) > 0:
			// A whitelist already excludes everything not on it, so pairing the
			// two means one of them does nothing and which one is not obvious
			// from reading the entry. Same rule as the glossary's.
			return fmt.Errorf("technique: round map node %q sets both detail_includes and detail_excludes", n.ID)
		}
		seen[n.ID] = true

		// A node below every band renders nowhere at all — not as an error,
		// just as a position quietly missing from the map.
		if n.Tier < m.Bands[len(m.Bands)-1].MinTier {
			return fmt.Errorf("technique: round map node %q has tier %d, below every band", n.ID, n.Tier)
		}
	}

	// Two nodes resolving identically is the borrowed-filter bug: one list of
	// techniques presented under two differently labelled boxes, with every
	// "does it resolve to anything" check passing. Keyed on the whole rule, not
	// on Position alone, since side control and knee-on-belly legitimately share
	// a Position and are separated by the detail lists.
	rule := make(map[string]string, len(m.Nodes))
	for _, n := range m.Nodes {
		k := fmt.Sprintf("%s|%v|%v", n.Position, n.DetailIncludes, n.DetailExcludes)
		if prev, dup := rule[k]; dup {
			return fmt.Errorf(
				"technique: round map nodes %q and %q resolve to the same techniques", prev, n.ID)
		}
		rule[k] = n.ID
	}

	// Reachability, both directions. A node nothing points at is a place the map
	// says you cannot arrive; a node with nothing leaving it is a room with no
	// exit. Exactly one node is allowed no exit — the summit, which is where the
	// round ends.
	incoming := make(map[string]bool, len(m.Nodes))
	outgoing := make(map[string]bool, len(m.Nodes))
	for _, e := range m.Edges {
		incoming[e.To] = true
		outgoing[e.From] = true
	}
	summit := m.Nodes[0].ID
	best := m.Nodes[0].Tier
	for _, n := range m.Nodes {
		if n.Tier > best {
			best, summit = n.Tier, n.ID
		}
	}
	for _, n := range m.Nodes {
		if !incoming[n.ID] {
			return fmt.Errorf("technique: nothing on the map arrives at node %q", n.ID)
		}
		if !outgoing[n.ID] && n.ID != summit {
			return fmt.Errorf("technique: node %q has no way out of it", n.ID)
		}
	}

	for i, e := range m.Edges {
		switch {
		case !seen[e.From]:
			return fmt.Errorf("technique: round map edge %d starts at unknown node %q", i, e.From)
		case !seen[e.To]:
			return fmt.Errorf("technique: round map edge %d ends at unknown node %q", i, e.To)
		case e.From == e.To:
			// A self loop draws as an arrow leaving a box and returning to it,
			// which says nothing a beginner can act on. Retention and
			// maintenance are the node's own job, described in its note.
			return fmt.Errorf("technique: round map edge %d loops %q back to itself", i, e.From)
		case e.Label == "":
			return fmt.Errorf("technique: round map edge %d (%s → %s) has no label", i, e.From, e.To)
		case !validEdgeKinds[e.Kind]:
			return fmt.Errorf("technique: round map edge %d (%s → %s) has unknown kind %q", i, e.From, e.To, e.Kind)
		}
	}
	return nil
}
