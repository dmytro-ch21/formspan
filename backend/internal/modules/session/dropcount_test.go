package session

import "testing"

func dp(v int) *int         { return &v }
func dw(v float64) *float64 { return &v }

// A drop is part of the set it came off — one approach to the bar, one rest
// period — so it does not add to the number the athlete counts. Its work still
// does: the weight was moved.
//
// Both halves in one test on purpose. Asserting only the count would pass
// against a change that excluded drops from the volume too, which is the
// mistake this split exists to prevent.
func TestADropIsNotASetButItsWorkCounts(t *testing.T) {
	sets := []Set{
		{ExerciseID: "bench", SetType: SetTypeWorking, Reps: dp(3), WeightKg: dw(100), Completed: true},
		{ExerciseID: "bench", SetType: SetTypeDrop, Reps: dp(8), WeightKg: dw(80), Completed: true},
		{ExerciseID: "bench", SetType: SetTypeWorking, Reps: dp(3), WeightKg: dw(100), Completed: true},
	}
	v := Summarise(sets)
	if v.WorkingSets != 2 {
		t.Fatalf("counted %d sets, want 2 — a drop is part of the set above it", v.WorkingSets)
	}
	// 3x100 + 8x80 + 3x100 = 1240. The drop's 640 is in there.
	if v.TonnageKg != 1240 {
		t.Fatalf("tonnage %v, want 1240 — the drop's work must still count", v.TonnageKg)
	}
	if v.TotalReps != 14 {
		t.Fatalf("reps %d, want 14 — the drop's reps were performed", v.TotalReps)
	}
}

// Every other set type still counts. The exclusion is drops specifically, not
// "anything unusual".
func TestOnlyDropsAreExcludedFromTheCount(t *testing.T) {
	for _, st := range []SetType{SetTypeWorking, SetTypeBackoff, SetTypeAMRAP, SetTypeFailure} {
		v := Summarise([]Set{{ExerciseID: "b", SetType: st, Reps: dp(5), WeightKg: dw(60), Completed: true}})
		if v.WorkingSets != 1 {
			t.Fatalf("%s counted %d, want 1", st, v.WorkingSets)
		}
	}
	// And a warm-up still contributes nothing at all.
	v := Summarise([]Set{{ExerciseID: "b", SetType: SetTypeWarmup, Reps: dp(10), WeightKg: dw(20), Completed: true}})
	if v.WorkingSets != 0 || v.TonnageKg != 0 {
		t.Fatalf("a warm-up contributed sets=%d tonnage=%v", v.WorkingSets, v.TonnageKg)
	}
}
