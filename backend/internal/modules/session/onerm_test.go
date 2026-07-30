package session

import (
	"math"
	"testing"
)

func approx(a, b float64) bool { return math.Abs(a-b) < 0.05 }

func TestEstimateOneRM(t *testing.T) {
	cases := []struct {
		name   string
		reps   int
		kg     float64
		rir    *int
		rpe    *float64
		want   float64
		wantOK bool
	}{
		// The boundary Epley gets wrong: a true single must estimate itself.
		{"a genuine single is its own max", 1, 100, nil, nil, 100, true},
		{"5 reps, effort unknown", 5, 100, nil, nil, 112.5, true},
		{"10 reps, effort unknown", 10, 100, nil, nil, 133.33, true},

		// Effort is the whole point: the same set means different things.
		{"5 reps with 3 in reserve is an 8-rep set", 5, 100, ptrInt(3), nil, 124.14, true},
		{"5 reps to failure is a 5-rep set", 5, 100, ptrInt(0), nil, 112.5, true},
		{"RPE 10 leaves nothing in reserve", 5, 100, nil, ptrF(10), 112.5, true},
		{"RPE 8 is about 2 in reserve", 5, 100, nil, ptrF(8), 120, true},
		// RIR is observed; RPE is converted. When both are given, trust RIR.
		{"RIR wins over RPE", 5, 100, ptrInt(0), ptrF(6), 112.5, true},

		// Past the ceiling the curve is fiction, so there's no answer.
		{"13 reps is beyond estimating", 13, 100, nil, nil, 0, false},
		{"10 reps with 3 in reserve exceeds the ceiling", 10, 100, ptrInt(3), nil, 0, false},
		{"12 effective reps is still in", 9, 100, ptrInt(3), nil, 144, true},

		// Half steps are real: the column is NUMERIC(3,1) because the scale is
		// used in halves, and rounding them away made 8.5 mean 8.
		{"RPE 8.5 sits between 8 and 9", 5, 100, nil, ptrF(8.5), 118.03, true},
		{"RPE 9.5 sits between 9 and 10", 5, 100, nil, ptrF(9.5), 114.29, true},
		{"RPE 9", 5, 100, nil, ptrF(9), 116.13, true},

		// Nonsense in, nothing out.
		{"no reps", 0, 100, nil, nil, 0, false},
		{"no weight", 5, 0, nil, nil, 0, false},
		{"negative weight", 5, -10, nil, nil, 0, false},
		// An impossible RPE must not invent reserve in the wrong direction.
		{"RPE above 10 is clamped", 5, 100, nil, ptrF(11), 112.5, true},
	}
	for _, c := range cases {
		got, ok := EstimateOneRM(c.reps, c.kg, c.rir, c.rpe)
		if ok != c.wantOK {
			t.Errorf("%s: ok = %v, want %v", c.name, ok, c.wantOK)
			continue
		}
		if ok && !approx(got, c.want) {
			t.Errorf("%s: %.2f, want %.2f", c.name, got, c.want)
		}
	}
}

// The estimate must rise with effort held constant, or it isn't measuring
// strength. Two sets of the same weight, the one with more reps wins.
func TestEstimateOneRM_MonotonicInRepsAndWeight(t *testing.T) {
	var prev float64
	for r := 1; r <= maxEstimableReps; r++ {
		got, ok := EstimateOneRM(r, 100, nil, nil)
		if !ok {
			t.Fatalf("%d reps should be estimable", r)
		}
		if got <= prev {
			t.Errorf("%d reps estimated %.2f, not above %.2f", r, got, prev)
		}
		prev = got
	}
	light, _ := EstimateOneRM(5, 100, nil, nil)
	heavy, _ := EstimateOneRM(5, 110, nil, nil)
	if heavy <= light {
		t.Errorf("more weight at the same reps must estimate higher: %.2f vs %.2f", heavy, light)
	}
}

// Half a point of RPE has to move the answer, or recording it is theatre.
func TestEstimateOneRM_HalfStepsAreDistinct(t *testing.T) {
	var prev float64
	// Descending RPE means more reserve, so the estimate must rise strictly.
	for _, rpe := range []float64{10, 9.5, 9, 8.5, 8, 7.5, 7} {
		v := rpe
		got, ok := EstimateOneRM(5, 100, nil, &v)
		if !ok {
			t.Fatalf("RPE %v should be estimable", rpe)
		}
		if got <= prev {
			t.Errorf("RPE %v estimated %.2f, not above the stricter RPE's %.2f", rpe, got, prev)
		}
		prev = got
	}
	// And a half step must never round up into the next whole point, which is
	// the direction that over-states strength.
	half, _ := EstimateOneRM(5, 100, nil, ptrF(8.5))
	whole, _ := EstimateOneRM(5, 100, nil, ptrF(8))
	if half >= whole {
		t.Errorf("RPE 8.5 (%.2f) must estimate below RPE 8 (%.2f)", half, whole)
	}
}

func TestBestOneRM(t *testing.T) {
	// The heaviest set is deliberately NOT the best estimate — this is why
	// the search can't be "take the biggest weight".
	sets := []Set{
		{ExerciseID: exSquat, SetType: SetTypeWarmup, Reps: ptrInt(5), WeightKg: ptrF(200), Completed: true},
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(1), WeightKg: ptrF(110), Completed: true},
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(5), WeightKg: ptrF(100), Completed: true},
		{ExerciseID: exSquat, SetType: SetTypeWorking, Reps: ptrInt(3), WeightKg: ptrF(130), Completed: false},
	}
	best, at, ok := BestOneRM(sets)
	if !ok {
		t.Fatal("expected an estimate")
	}
	// 5x100 = 112.5 beats the 110 single. A warm-up at 200 and an unticked
	// 3x130 must both be ignored entirely.
	if !approx(best, 112.5) {
		t.Errorf("best = %.2f, want 112.5", best)
	}
	if at == nil || *at.WeightKg != 100 {
		t.Errorf("best came from the wrong set: %+v", at)
	}

	if _, _, ok := BestOneRM(nil); ok {
		t.Error("no sets should yield no estimate")
	}
	// Sets that carry no weight (BJJ, a plank) simply don't produce one.
	timed := []Set{{ExerciseID: exBJJ, SetType: SetTypeWorking, Seconds: ptrInt(300), Completed: true}}
	if _, _, ok := BestOneRM(timed); ok {
		t.Error("a timed set should not produce a 1RM")
	}
}
