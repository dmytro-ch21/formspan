package accomplishment

import "testing"

// TestEveryKindHasABasis is the reason `basisOf` is a map rather than a method
// with a default arm.
//
// A default would have to pick `measured` or `reported` for a kind nobody
// classified, and the flattering answer is the likely default — a self-reported
// award rendering as externally verified is the one wrong answer this module
// must never give. This test is what makes forgetting to classify a new kind a
// red suite instead of a quiet lie.
func TestEveryKindHasABasis(t *testing.T) {
	for _, k := range Kinds() {
		b, ok := BasisOf(k)
		if !ok {
			t.Errorf("%s has no basis", k)
			continue
		}
		if b != Measured && b != Reported {
			t.Errorf("%s has basis %q, which is neither measured nor reported", k, b)
		}
	}
	if len(Kinds()) != len(basisOf) {
		t.Errorf("Kinds() lists %d kinds but basisOf classifies %d — one has a kind the other does not",
			len(Kinds()), len(basisOf))
	}
}

// The competition/mat split is the whole point of carrying a basis at all, so
// it is pinned rather than left to the map's readability.
func TestCompetitionIsMeasuredAndTheMatIsReported(t *testing.T) {
	measured := []Kind{FirstCompetition, FirstMatchWon, FirstSubmissionWin, FirstPodium, FirstGold}
	reported := []Kind{FirstScored, FirstDrilledScored}

	for _, k := range measured {
		if b, _ := BasisOf(k); b != Measured {
			t.Errorf("%s: a bracket result is externally verifiable, want measured, got %q", k, b)
		}
	}
	for _, k := range reported {
		if b, _ := BasisOf(k); b != Reported {
			t.Errorf("%s: nobody checked this, want reported, got %q", k, b)
		}
	}
}

func TestKindsIsACopy(t *testing.T) {
	got := Kinds()
	got[0] = "tampered"
	if Kinds()[0] == "tampered" {
		t.Fatal("Kinds() hands out the package's own slice; a caller can rewrite the vocabulary")
	}
}

func day(s string) *string { return &s }

func TestSortIsChronologicalWithUndatedLast(t *testing.T) {
	list := []Accomplishment{
		{Kind: FirstGold, AchievedOn: nil},
		{Kind: FirstScored, AchievedOn: day("2025-06-01")},
		{Kind: FirstCompetition, AchievedOn: day("2026-03-14")},
		{Kind: FirstDrilledScored, AchievedOn: day("2025-09-20")},
	}
	sortChronologically(list)

	want := []Kind{FirstScored, FirstDrilledScored, FirstCompetition, FirstGold}
	for i, k := range want {
		if list[i].Kind != k {
			t.Errorf("position %d: want %s, got %s", i, k, list[i].Kind)
		}
	}
	// The undated one must be LAST, not first. Sorting a NULL as the beginning
	// of time would claim an undated contest preceded the mat awards that
	// genuinely came first, and the timeline would read wrong.
	if list[3].AchievedOn != nil {
		t.Error("the undated accomplishment should sort last")
	}
}

func TestSameDayFallsBackToDisplayOrder(t *testing.T) {
	// Genuinely possible: a first competition that was also a first gold. The
	// order must be stable rather than whatever the union happened to return.
	list := []Accomplishment{
		{Kind: FirstGold, AchievedOn: day("2026-03-14")},
		{Kind: FirstCompetition, AchievedOn: day("2026-03-14")},
		{Kind: FirstMatchWon, AchievedOn: day("2026-03-14")},
	}
	sortChronologically(list)

	want := []Kind{FirstCompetition, FirstMatchWon, FirstGold}
	for i, k := range want {
		if list[i].Kind != k {
			t.Errorf("position %d: want %s, got %s", i, k, list[i].Kind)
		}
	}
}

func TestAllUndatedStillOrderedByDisplayRank(t *testing.T) {
	list := []Accomplishment{
		{Kind: FirstGold},
		{Kind: FirstCompetition},
	}
	sortChronologically(list)
	if list[0].Kind != FirstCompetition {
		t.Errorf("want first_competition first, got %s", list[0].Kind)
	}
}

func TestParseZone(t *testing.T) {
	if _, ok := ParseZone("Europe/Berlin"); !ok {
		t.Error("a real IANA zone must parse")
	}
	for _, bad := range []string{"", "Local", "local", "Mars/Olympus", "GMT+1"} {
		if _, ok := ParseZone(bad); ok {
			t.Errorf("%q must be refused", bad)
		}
	}
}
