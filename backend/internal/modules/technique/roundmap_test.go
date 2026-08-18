package technique

import (
	"encoding/json"
	"strings"
	"testing"
)

// The round map is authored, and everything it points at is not. These tests
// are the join between the two, and they run without a database on purpose —
// both sides are embedded content, so the check is as cheap as parsing and
// therefore cannot be the kind that skips in CI. See H1 in docs/TASKS.md for
// what that costs when it goes the other way.

func TestTheRoundMapLoadsAndIsShaped(t *testing.T) {
	m, err := LoadRoundMap()
	if err != nil {
		t.Fatalf("the embedded round map should load: %v", err)
	}
	if len(m.Nodes) == 0 || len(m.Edges) == 0 {
		t.Fatal("the round map is empty, so every check below would pass vacuously")
	}
}

func TestEveryRoundMapNodeNamesAKnownPosition(t *testing.T) {
	m, err := LoadRoundMap()
	if err != nil {
		t.Fatalf("load round map: %v", err)
	}
	positions, err := PositionSeedData()
	if err != nil {
		t.Fatalf("load positions: %v", err)
	}
	if len(positions) == 0 {
		t.Fatal("no positions, so this test would pass without checking anything")
	}

	known := make(map[string]bool, len(positions))
	for _, p := range positions {
		known[p.ID] = true
	}
	for _, n := range m.Nodes {
		if !known[n.PositionID] {
			t.Errorf("round map node %q names position %q, which is not in the glossary",
				n.ID, n.PositionID)
		}
	}

	// And the other direction: a position in the glossary with no node is a
	// place the map says you cannot be. That is a decision, not an oversight,
	// so adding a twelfth position should fail here until somebody makes it.
	used := make(map[string]bool, len(m.Nodes))
	for _, n := range m.Nodes {
		used[n.PositionID] = true
	}
	for _, p := range positions {
		if !used[p.ID] {
			t.Errorf("position %q is in the glossary but on no node of the map", p.ID)
		}
	}
}

// The check that keeps every node's link honest.
//
// A node offers "techniques from here", resolved client-side by the rule the
// contract documents: prefix-match the technique's position against the node's,
// which for a sided node ("Mount - Top") is an exact match against the same
// vocabulary. A node naming a value nothing matches renders as an empty list
// rather than an error — the failure the library's own `Edges` docstring
// records, where uneven coverage made links read as a feature that half-works.
func TestEveryRoundMapNodeResolvesToTechniques(t *testing.T) {
	m, err := LoadRoundMap()
	if err != nil {
		t.Fatalf("load round map: %v", err)
	}
	library, err := SeedData()
	if err != nil {
		t.Fatalf("load library: %v", err)
	}
	if len(library) == 0 {
		t.Fatal("the library is empty, so every node below would report zero and this test would be measuring nothing")
	}

	for _, n := range m.Nodes {
		count := 0
		for _, tech := range library {
			if strings.HasPrefix(tech.Position, n.Position) {
				count++
			}
		}
		if count == 0 {
			t.Errorf("round map node %q filters the library to %q, which matches no technique",
				n.ID, n.Position)
		}
	}
}

// A box with no arrows is a box a reader cannot get to or leave, and it draws
// as a mistake. Every node has to be attached to the map somewhere.
func TestNoRoundMapNodeIsOrphaned(t *testing.T) {
	m, err := LoadRoundMap()
	if err != nil {
		t.Fatalf("load round map: %v", err)
	}
	attached := make(map[string]bool, len(m.Nodes))
	for _, e := range m.Edges {
		attached[e.From] = true
		attached[e.To] = true
	}
	for _, n := range m.Nodes {
		if !attached[n.ID] {
			t.Errorf("round map node %q has no edges — nothing reaches it and nothing leaves it", n.ID)
		}
	}
}

// Every bad place has to be reachable, or the map answers "what do I do here"
// without ever answering "how did I get here" — which is the question a
// beginner looking at a diagram is usually asking.
func TestEveryLosingPositionCanBeArrivedAt(t *testing.T) {
	m, err := LoadRoundMap()
	if err != nil {
		t.Fatalf("load round map: %v", err)
	}
	incoming := make(map[string]bool, len(m.Nodes))
	for _, e := range m.Edges {
		incoming[e.To] = true
	}
	losing := 0
	for _, n := range m.Nodes {
		if n.Tier >= 0 {
			continue
		}
		losing++
		if !incoming[n.ID] {
			t.Errorf("node %q is a losing position (tier %d) with no edge into it", n.ID, n.Tier)
		}
	}
	if losing == 0 {
		t.Fatal("no node has a negative tier, so this test checked nothing — the map has lost its bad places")
	}
}

// Every node has to land in a band, and every band has to have something in
// it. A band with nothing under it draws as an empty heading; a node under no
// band vanishes from the map without any error being raised.
func TestTheBandsPartitionTheNodes(t *testing.T) {
	m, err := LoadRoundMap()
	if err != nil {
		t.Fatalf("load round map: %v", err)
	}
	counts := make([]int, len(m.Bands))
	for _, n := range m.Nodes {
		placed := false
		for i, b := range m.Bands {
			if n.Tier >= b.MinTier {
				counts[i]++
				placed = true
				break
			}
		}
		if !placed {
			t.Errorf("node %q (tier %d) falls into no band", n.ID, n.Tier)
		}
	}
	for i, c := range counts {
		if c == 0 {
			t.Errorf("band %d (%q) has no nodes in it", i, m.Bands[i].Label)
		}
	}
}

// The validator's own rules, mutated one at a time. Each case is a map that
// would otherwise draw as something silently wrong rather than fail.
func TestTheRoundMapValidatorRefusesABrokenMap(t *testing.T) {
	good := func() *RoundMap {
		return &RoundMap{
			Title: "t", Intro: "i",
			Bands: []MapBand{
				{MinTier: 1, Label: "ahead", Note: "n"},
				{MinTier: -99, Label: "behind", Note: "n"},
			},
			Nodes: []MapNode{
				{ID: "a", Label: "A", PositionID: "standing", Position: "Standing", Note: "n"},
				{ID: "b", Label: "B", PositionID: "mount", Position: "Mount - Top", Note: "n"},
			},
			Edges: []MapEdge{{From: "a", To: "b", Label: "Takedown", Kind: "route"}},
		}
	}
	if err := validateRoundMap(good()); err != nil {
		t.Fatalf("the control map should be legal: %v", err)
	}

	bad := map[string]func(*RoundMap){
		"no nodes":                    func(m *RoundMap) { m.Nodes = nil },
		"no edges":                    func(m *RoundMap) { m.Edges = nil },
		"no bands":                    func(m *RoundMap) { m.Bands = nil },
		"a band with no label":        func(m *RoundMap) { m.Bands[0].Label = "" },
		"a band with no note":         func(m *RoundMap) { m.Bands[1].Note = "" },
		"bands that do not descend":   func(m *RoundMap) { m.Bands[1].MinTier = 1 },
		"a node below every band":     func(m *RoundMap) { m.Nodes[0].Tier = -1000 },
		"no intro":                    func(m *RoundMap) { m.Intro = "" },
		"no title":                    func(m *RoundMap) { m.Title = "" },
		"duplicate node id":           func(m *RoundMap) { m.Nodes[1].ID = "a" },
		"node with no label":          func(m *RoundMap) { m.Nodes[0].Label = "" },
		"node with no note":           func(m *RoundMap) { m.Nodes[0].Note = "" },
		"node with no glossary entry": func(m *RoundMap) { m.Nodes[0].PositionID = "" },
		"node with no filter":         func(m *RoundMap) { m.Nodes[0].Position = "" },
		"edge from nowhere":           func(m *RoundMap) { m.Edges[0].From = "ghost" },
		"edge to nowhere":             func(m *RoundMap) { m.Edges[0].To = "ghost" },
		"edge looping on self":        func(m *RoundMap) { m.Edges[0].To = "a" },
		"edge with no label":          func(m *RoundMap) { m.Edges[0].Label = "" },
		"edge of unknown kind":        func(m *RoundMap) { m.Edges[0].Kind = "sideways" },
	}
	for name, mutate := range bad {
		m := good()
		mutate(m)
		if err := validateRoundMap(m); err == nil {
			t.Errorf("%s should be refused", name)
		}
	}
}

// The wire shape, asserted against the names the contract publishes.
//
// A struct tag is invisible to the compiler and to every test above — rename
// `json:"position_id"` to `json:"positionId"` and Go is perfectly happy while
// both clients silently read undefined. This is the only place that mismatch
// can be caught without a running server.
func TestTheRoundMapSerialisesUnderTheNamesTheContractPublishes(t *testing.T) {
	m, err := LoadRoundMap()
	if err != nil {
		t.Fatalf("load round map: %v", err)
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, k := range []string{"title", "intro", "bands", "nodes", "edges"} {
		if _, ok := got[k]; !ok {
			t.Errorf("round map has no %q on the wire", k)
		}
	}

	var nodes []map[string]json.RawMessage
	if err := json.Unmarshal(got["nodes"], &nodes); err != nil || len(nodes) == 0 {
		t.Fatalf("nodes did not unmarshal to a non-empty list: %v", err)
	}
	for _, k := range []string{"id", "label", "position_id", "position", "tier", "note"} {
		if _, ok := nodes[0][k]; !ok {
			t.Errorf("round map node has no %q on the wire", k)
		}
	}

	var edges []map[string]json.RawMessage
	if err := json.Unmarshal(got["edges"], &edges); err != nil || len(edges) == 0 {
		t.Fatalf("edges did not unmarshal to a non-empty list: %v", err)
	}
	for _, k := range []string{"from", "to", "label", "kind"} {
		if _, ok := edges[0][k]; !ok {
			t.Errorf("round map edge has no %q on the wire", k)
		}
	}

	var bands []map[string]json.RawMessage
	if err := json.Unmarshal(got["bands"], &bands); err != nil || len(bands) == 0 {
		t.Fatalf("bands did not unmarshal to a non-empty list: %v", err)
	}
	for _, k := range []string{"min_tier", "label", "note"} {
		if _, ok := bands[0][k]; !ok {
			t.Errorf("round map band has no %q on the wire", k)
		}
	}
}
