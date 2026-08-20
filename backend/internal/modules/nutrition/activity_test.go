package nutrition

import "testing"

// The daily-movement level had no home until N93: both clients held it in
// component state, so it reset on every navigation and took the derived calorie
// target with it. It lives on the profile now, and these cover the two halves
// the server owns — which level a derivation runs at, and whether the athlete
// is the one who picked it.

func TestResolveActivityPrefersAnExplicitParameter(t *testing.T) {
	// A client previewing "what if I had a desk job" must get that derivation
	// without first writing the choice to the account. If the stored value won
	// here, the pills would be inert for anyone who had ever chosen.
	stored := ActivityLight
	got, chosen := ResolveActivity("active", &stored)
	if got != ActivityActive {
		t.Fatalf("asked for active with light stored, got %q", got)
	}
	if !chosen {
		t.Fatal("an explicitly asked-for level is a choice, not an assumption")
	}
}

func TestResolveActivityFallsBackToTheStoredChoice(t *testing.T) {
	// The whole point of the ticket: with no parameter, the athlete's own
	// stored answer is what the derivation runs at. Before this, an absent
	// parameter meant `light` unconditionally, which is why the target reset.
	stored := ActivitySedentary
	got, chosen := ResolveActivity("", &stored)
	if got != ActivitySedentary {
		t.Fatalf("no parameter with sedentary stored, got %q", got)
	}
	if !chosen {
		t.Fatal("a stored level is the athlete's own choice")
	}
}

func TestResolveActivityDefaultsAndSaysItAssumed(t *testing.T) {
	got, chosen := ResolveActivity("", nil)
	// Pinned to the LITERAL rather than to ActivityLight. Asserting the
	// constant against itself is true by construction — it would stay green
	// the day somebody changed the default, which is exactly the change that
	// needs to be noticed. Two tests on this screen's web counterpart were
	// written that way and both survived a constant moving.
	if string(got) != "light" {
		t.Fatalf("documented default is light, got %q", got)
	}
	if chosen {
		t.Fatal("nobody chose this: `chosen` must be false so a client can " +
			"render the assumption as an assumption")
	}
}

func TestResolveActivityTreatsNilStoredAsNeverChosenRatherThanEmpty(t *testing.T) {
	// The distinction the nullable column exists for. A profile that has never
	// answered and a profile that answered "light" must not collapse: they
	// derive the same number and mean different things, and only `chosen`
	// tells them apart.
	assumed, assumedChosen := ResolveActivity("", nil)
	var light = ActivityLight
	picked, pickedChosen := ResolveActivity("", &light)

	if assumed != picked {
		t.Fatalf("both should derive at light: assumed %q, picked %q", assumed, picked)
	}
	if assumedChosen == pickedChosen {
		t.Fatal("never-chosen and chose-light produce the same level and must " +
			"still be distinguishable — that is the whole reason the column is nullable")
	}
}

// TestActivityVocabularyIsPinnedToLiterals is the other half of a deliberate
// duplication.
//
// `profile.ValidActivityLevel` holds a second copy of this list, because a
// module in this codebase never imports a sibling. Asserting one against the
// other would be true by construction and would go green the day somebody
// edited both; pinning EACH to string literals means whichever side drifts
// fails on its own. `profile` has the mirror of this test.
func TestActivityVocabularyIsPinnedToLiterals(t *testing.T) {
	want := []string{"sedentary", "light", "active"}
	if len(Activities) != len(want) {
		t.Fatalf("vocabulary is %v, wire contract says %v", Activities, want)
	}
	for i, w := range want {
		if string(Activities[i]) != w {
			t.Errorf("Activities[%d] = %q, wire contract says %q", i, Activities[i], w)
		}
	}
	// Order matters as well as membership: the clients render the pills in the
	// order this list arrives in, so a reshuffle silently reorders a control
	// people build muscle memory on.
	for _, w := range want {
		if !Activity(w).valid() {
			t.Errorf("%q is in the contract but has no ActivityFactor", w)
		}
	}
	if Activity("moderate").valid() {
		t.Error("`moderate` is exactly the textbook level the truncated ladder " +
			"exists to exclude — see the Activity type doc before adding it")
	}
}
