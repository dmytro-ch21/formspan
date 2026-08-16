package session

import (
	"reflect"
	"testing"
)

// The split exists so progression has something to aim at. "225 for 5, then 3
// with a spotter" is 8 reps of work and 5 reps of capability, and the athlete's
// own goal — need the spotter for one or two instead of three — is only
// expressible if both numbers survive.
func TestSoloRepsSeparatesWhatYouDidAloneFromTheHelp(t *testing.T) {
	s := Set{Reps: ptrInt(8), AssistedReps: ptrInt(3)}
	if got := s.SoloReps(); got != 5 {
		t.Fatalf("solo reps %d, want 5", got)
	}
	// `Reps` still holds the FULL count, so every figure that already existed
	// keeps reading the number it always did.
	if *s.Reps != 8 {
		t.Fatalf("reps was rewritten to %d — assisted reps are still reps", *s.Reps)
	}
}

// NULL is unrecorded, 0 is "none of them", and they are not the same claim.
// Every set logged before this column existed is the first case, and reading it
// as "0 solo" would silently revise an athlete's whole history downward.
func TestUnrecordedAssistanceMeansAllOfThemWereSolo(t *testing.T) {
	if got := (Set{Reps: ptrInt(8)}).SoloReps(); got != 8 {
		t.Fatalf("a set with no assistance recorded reported %d solo reps, want 8", got)
	}
	if got := (Set{Reps: ptrInt(8), AssistedReps: ptrInt(0)}).SoloReps(); got != 8 {
		t.Fatalf("an explicit zero reported %d, want 8", got)
	}
}

func TestSoloRepsNeverGoesNegative(t *testing.T) {
	// The database CHECK forbids assisted > reps, so this is a client's
	// in-memory row mid-edit. A negative rep count must never reach a chart.
	if got := (Set{Reps: ptrInt(3), AssistedReps: ptrInt(5)}).SoloReps(); got != 0 {
		t.Fatalf("got %d, want 0", got)
	}
	if got := (Set{}).SoloReps(); got != 0 {
		t.Fatalf("a set with no reps reported %d", got)
	}
}

// A drop set is genuinely two efforts at two weights, so it is two rows. What
// was missing is which set a drop came off, and that is adjacency — forced by
// `ReplaceSets` regenerating every row id on save.
func TestDropsAttachToTheSetTheyCameOff(t *testing.T) {
	sets := []Set{
		{ExerciseID: "bench", SetType: SetTypeWorking, Reps: ptrInt(3), WeightKg: ptrF(102.5)},
		{ExerciseID: "bench", SetType: SetTypeDrop, Reps: ptrInt(8), WeightKg: ptrF(84)},
		{ExerciseID: "bench", SetType: SetTypeDrop, Reps: ptrInt(6), WeightKg: ptrF(60)},
		{ExerciseID: "bench", SetType: SetTypeWorking, Reps: ptrInt(3), WeightKg: ptrF(102.5)},
	}
	drops := DropsOf(sets, 0)
	if len(drops) != 2 {
		t.Fatalf("want both drops off the first set, got %d", len(drops))
	}
	if *drops[0].WeightKg != 84 || *drops[1].WeightKg != 60 {
		t.Fatalf("wrong drops: %+v", drops)
	}
	// The second working set has none — the run stops at the first non-drop.
	if got := DropsOf(sets, 3); got != nil {
		t.Fatalf("the later set picked up %+v", got)
	}
	// A drop is never a parent.
	if got := DropsOf(sets, 1); got != nil {
		t.Fatalf("a drop claimed drops of its own: %+v", got)
	}
}

// An orphaned drop must not attach itself to somebody else's lift. Skipping it
// is the safe reading: a stray row is a client bug, and inventing a parent for
// it would put reps under an exercise they were never performed on.
func TestADropNeverAttachesToADifferentExercise(t *testing.T) {
	sets := []Set{
		{ExerciseID: "squat", SetType: SetTypeWorking, Reps: ptrInt(5)},
		{ExerciseID: "bench", SetType: SetTypeDrop, Reps: ptrInt(8)},
	}
	if got := DropsOf(sets, 0); got != nil {
		t.Fatalf("a bench drop attached to a squat: %+v", got)
	}
}

func TestDropsOfIsSafeAtTheEdges(t *testing.T) {
	sets := []Set{{ExerciseID: "bench", SetType: SetTypeWorking}}
	for _, i := range []int{-1, 1, 99} {
		if got := DropsOf(sets, i); got != nil {
			t.Fatalf("index %d returned %+v", i, got)
		}
	}
	if got := DropsOf(nil, 0); !reflect.DeepEqual(got, []Set(nil)) {
		t.Fatalf("nil sets returned %+v", got)
	}
}
