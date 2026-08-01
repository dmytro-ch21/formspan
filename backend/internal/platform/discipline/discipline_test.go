package discipline

import (
	"strings"
	"testing"
)

// The registry's whole purpose is that nothing else keeps its own copy of this
// list. These tests are the tripwires for that promise — each one fails if a
// discipline is added here and not wired somewhere it has to be.

func TestRegistry_KeysAreUniqueAndNonEmpty(t *testing.T) {
	seen := map[string]bool{}
	for _, m := range All() {
		switch {
		case m.Key == "":
			t.Error("module with an empty key")
		case m.Label == "":
			t.Errorf("%s: empty label — the label carries the acronym (BJJ, not Bjj), so it cannot be derived", m.Key)
		case seen[m.Key]:
			t.Errorf("duplicate key %q — byKey would silently keep only one", m.Key)
		}
		seen[m.Key] = true
	}
}

func TestRegistry_SportsAreASubsetOfAll(t *testing.T) {
	for _, m := range Sports() {
		if !m.IsSport {
			t.Errorf("%s: returned by Sports() but IsSport is false", m.Key)
		}
		if !Valid(m.Key) || !ValidSport(m.Key) {
			t.Errorf("%s: a sport that fails its own validators", m.Key)
		}
	}
	// The distinction that makes the registry work: a module need not be a
	// sport. If this ever passes trivially, someone has collapsed the two
	// concepts and nutrition has quietly become a valid session sport.
	if _, ok := Get("nutrition"); !ok {
		t.Fatal("nutrition missing — it is the case that proves module != sport")
	}
	if ValidSport("nutrition") {
		t.Error("nutrition must not be a valid sport: there is no nutrition catalog, session or row")
	}
	if !Valid("nutrition") {
		t.Error("nutrition must be a valid module — it is togglable")
	}
}

func TestRegistry_UnknownKeysRejected(t *testing.T) {
	for _, k := range []string{"", "cycling", "Strength", "bjj ", "nutrition_enabled"} {
		if Valid(k) {
			t.Errorf("Valid(%q) = true, want false", k)
		}
		if ValidSport(k) {
			t.Errorf("ValidSport(%q) = true, want false", k)
		}
	}
}

func TestRegistry_SportListMatchesSportKeys(t *testing.T) {
	// SportList feeds five error messages that used to be hardcoded prose.
	got, keys := SportList(), SportKeys()
	if len(keys) == 0 {
		t.Fatal("no sports")
	}
	for _, k := range keys {
		if !contains(got, k) {
			t.Errorf("SportList() = %q, missing %q", got, k)
		}
	}
	if contains(got, "nutrition") {
		t.Error("SportList() names nutrition — that message tells a user to send a value the API rejects")
	}
}

func TestRegistry_DefaultsCoverEveryModule(t *testing.T) {
	d := Defaults()
	if len(d) != len(All()) {
		t.Fatalf("Defaults() has %d entries, registry has %d", len(d), len(All()))
	}
	for _, m := range All() {
		if d[m.Key] != m.DefaultOn {
			t.Errorf("%s: default %v, want %v", m.Key, d[m.Key], m.DefaultOn)
		}
	}
}

func TestRegistry_AllReturnsACopy(t *testing.T) {
	// A caller that sorts the result in place must not reorder the registry
	// for everyone else — display order is a product decision.
	first := All()[0].Key
	got := All()
	got[0] = Module{Key: "clobbered"}
	if All()[0].Key != first {
		t.Errorf("All() aliases package state: registry now starts with %q", All()[0].Key)
	}
}

func TestCapabilities_AreCoherent(t *testing.T) {
	for _, m := range All() {
		// A module with no catalog and no records has nothing to show; that's
		// legitimate today (nutrition) but should be a deliberate choice.
		if !m.IsSport && m.Caps.Catalog != "" {
			t.Errorf("%s: not a sport but declares catalog %q — what would list it?", m.Key, m.Caps.Catalog)
		}
		if m.Caps.HasProgression && !m.Caps.HasGoals {
			t.Errorf("%s: progression without goals — the progression UI reads the goal", m.Key)
		}
		if m.Caps.RecordKinds == nil {
			t.Errorf("%s: nil RecordKinds — use an empty slice so it serialises as [] not null", m.Key)
		}
		for _, f := range m.Caps.Facets {
			if f == "" {
				t.Errorf("%s: empty facet name", m.Key)
			}
		}
	}
}

func contains(haystack, needle string) bool { return strings.Contains(haystack, needle) }
