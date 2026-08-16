package session

import (
	"math"
	"testing"
)

func ap(v int) *int { return &v }

// The headline number, checked rather than asserted.
//
// Eight reps at 102.5 with a spotter on three is FIVE reps of demonstrated
// capability. Estimated off eight it reads about 127 kg; off five, about 115.
// That gap is roughly 10%, and it was being surfaced as a *record* — the one
// failure the Records doc says the feature cannot afford.
func TestASpottedSetIsEstimatedFromWhatYouDidAlone(t *testing.T) {
	weight := 102.5
	full := Set{Reps: ap(8), WeightKg: &weight}
	spotted := Set{Reps: ap(8), WeightKg: &weight, AssistedReps: ap(3)}

	fullEst, ok := EstimateSetOneRM(full)
	if !ok {
		t.Fatal("no estimate for an ordinary set")
	}
	spottedEst, ok := EstimateSetOneRM(spotted)
	if !ok {
		t.Fatal("no estimate for a set with five solo reps")
	}
	if spottedEst >= fullEst {
		t.Fatalf("spotted %.1f is not below unassisted %.1f", spottedEst, fullEst)
	}
	// The honest figure is Brzycki over five reps, not eight.
	want := weight * 36 / (37 - 5)
	if math.Abs(spottedEst-want) > 0.01 {
		t.Fatalf("estimated %.2f, want %.2f (five solo reps)", spottedEst, want)
	}
	// And the overstatement it replaces is the ~10% the task claimed.
	if gap := (fullEst - spottedEst) / spottedEst; gap < 0.08 || gap > 0.13 {
		t.Fatalf("the correction is %.1f%%, which is not the ~10%% this exists to fix", gap*100)
	}
}

// The half that is easy to get backwards, and would quietly undo the fix.
//
// An RIR on an assisted set describes the whole set, help included: "2 in
// reserve" means two more WITH the spotter. Adding it to the solo reps
// re-inflates the estimate — worse than the original bug, because it looks
// corrected. If help was needed on rep six, there was nothing left at rep five.
func TestTheRecordedEffortOnAnAssistedSetIsDiscarded(t *testing.T) {
	weight := 100.0
	withReserve := Set{Reps: ap(8), WeightKg: &weight, AssistedReps: ap(3), RIR: ap(2)}
	got, ok := EstimateSetOneRM(withReserve)
	if !ok {
		t.Fatal("refused a set with five solo reps")
	}
	// Five reps at zero reserve — NOT five plus two.
	want := weight * 36 / (37 - 5)
	if math.Abs(got-want) > 0.01 {
		t.Fatalf("estimated %.2f, want %.2f — the RIR describes the assisted set, not the solo reps", got, want)
	}
}

// Nothing was demonstrated unaided, so there is nothing to estimate from.
// Absent rather than zero, the same refusal the calorie model makes with no
// bodyweight.
func TestAFullyAssistedSetHasNoEstimate(t *testing.T) {
	weight := 60.0
	if _, ok := EstimateSetOneRM(Set{Reps: ap(5), WeightKg: &weight, AssistedReps: ap(5)}); ok {
		t.Fatal("estimated a 1RM from a set where every rep was assisted")
	}
}

// Every set logged before the column existed, and every set nobody spotted.
func TestUnassistedSetsAreUntouched(t *testing.T) {
	weight := 100.0
	rir := 2
	for _, s := range []Set{
		{Reps: ap(5), WeightKg: &weight},
		{Reps: ap(5), WeightKg: &weight, AssistedReps: ap(0)},
		{Reps: ap(5), WeightKg: &weight, RIR: &rir},
	} {
		got, ok := EstimateSetOneRM(s)
		if !ok {
			t.Fatalf("refused %+v", s)
		}
		want, _ := EstimateOneRM(*s.Reps, weight, s.RIR, s.RPE)
		if math.Abs(got-want) > 0.001 {
			t.Fatalf("got %.3f, want %.3f for %+v", got, want, s)
		}
	}
}

// Double progression advances reps to the top of a range before moving load.
// Counting spotted reps toward that lets a spotter walk the athlete up to a
// weight they cannot yet handle alone — a deterministic rule recommending a
// load the evidence does not support.
func TestRepProgressionMeasuresWhatYouDidAlone(t *testing.T) {
	w := 100.0
	sets := []Set{
		{Reps: ap(10), WeightKg: &w, AssistedReps: ap(3)}, // 7 alone
		{Reps: ap(10), WeightKg: &w},                      // 10 alone
	}
	min, max := repSpread(sets)
	if min != 7 {
		t.Fatalf("min solo reps %d, want 7 — the spotted set was counted at its full number", min)
	}
	if max != 10 {
		t.Fatalf("max solo reps %d, want 10", max)
	}
}
