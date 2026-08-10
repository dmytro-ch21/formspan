package curriculum

import "testing"

// ValidateContent mirrors the CHECK constraints so a client hears which item is
// wrong rather than a constraint name. These run without a database on purpose:
// every rule here is the shape of the content, not the behaviour of SQL.

func TestAConceptItemIsTextAndNothingElse(t *testing.T) {
	// The legal concept: a title, optionally notes, nothing else.
	ok := []NewItem{{Kind: "concept", Title: "Position before submission", Notes: "The rule under everything."}}
	if err := ValidateContent(nil, ok); err != nil {
		t.Fatalf("a titled concept should be legal: %v", err)
	}

	bad := map[string][]NewItem{
		"a concept with no title": {{Kind: "concept"}},
		"a concept pointing at a technique": {
			{Kind: "concept", Title: "x", TechniqueID: "arm-drag"}},
		"a concept carrying criteria": {
			{Kind: "concept", Title: "x", Criteria: &Criteria{TargetScored: intp(5)}}},
		"a technique carrying its own title": {
			{TechniqueID: "arm-drag", Title: "My Arm Drag"}},
		"an unknown kind": {{Kind: "reading", TechniqueID: "arm-drag"}},
	}
	for name, items := range bad {
		if err := ValidateContent(nil, items); err == nil {
			t.Errorf("%s should be refused", name)
		}
	}
}

func TestAnItemCannotNameAPhaseThatDoesNotExist(t *testing.T) {
	phases := []NewPhase{{Title: "Survive"}}
	if err := ValidateContent(phases, []NewItem{{TechniqueID: "arm-drag", Phase: intp(0)}}); err != nil {
		t.Fatalf("an in-range phase index should be legal: %v", err)
	}
	for _, idx := range []int{-1, 1} {
		if err := ValidateContent(phases, []NewItem{{TechniqueID: "arm-drag", Phase: intp(idx)}}); err == nil {
			t.Errorf("phase index %d against one phase should be refused", idx)
		}
	}
	// No phases at all makes every index out of range — the case a client
	// hits by sending items with stale indexes and forgetting the array.
	if err := ValidateContent(nil, []NewItem{{TechniqueID: "arm-drag", Phase: intp(0)}}); err == nil {
		t.Error("a phase index with no phases should be refused")
	}
}

func TestAPhaseNeedsATitle(t *testing.T) {
	if err := ValidateContent([]NewPhase{{Description: "untitled"}}, nil); err == nil {
		t.Error("an untitled phase should be refused")
	}
}

func TestADrilledOnlyCriterionIsAnchored(t *testing.T) {
	// The movement-fundamentals case: no live targets at all, only spread.
	items := []NewItem{{TechniqueID: "breakfall-backward",
		Criteria: &Criteria{TargetDrilledSessions: intp(6)}}}
	if err := ValidateContent(nil, items); err != nil {
		t.Fatalf("a drilled-only criterion should be legal: %v", err)
	}
	// But it anchors nothing else: a rate still needs the offensive target it
	// divides.
	items[0].Criteria.MinHitRate = f64p(0.4)
	if err := ValidateContent(nil, items); err == nil {
		t.Error("min_hit_rate anchored only on a drilled target should be refused")
	}
	// And it must be positive like every other target.
	if err := ValidateContent(nil, []NewItem{{TechniqueID: "x",
		Criteria: &Criteria{TargetDrilledSessions: intp(0)}}}); err == nil {
		t.Error("a zero drilled target should be refused")
	}
}

func TestMetGatesOnTheDrilledSpread(t *testing.T) {
	c := Criteria{TargetDrilledSessions: intp(6)}
	p := Progress{DrilledSessions: 5}
	if p.Met(c) {
		t.Error("five drilled sessions should not clear a target of six")
	}
	p.DrilledSessions = 6
	if !p.Met(c) {
		t.Error("six drilled sessions should clear a target of six")
	}
}
