package session

import "testing"

func f(v float64) *float64 { return &v }
func i(v int) *int         { return &v }

// TestTonnageCountsBothDumbbells is the whole point of `LoadFactor`.
//
// `weight_kg` holds what is stamped on the implement, because that is what an
// athlete reads and types. For a barbell it is the entire load; for a PAIR of
// dumbbells it is one of the two. The number was being taken literally
// everywhere, so a 30 kg dumbbell press counted 30 — half of what was moved —
// and every figure built on tonnage inherited it: the session summary, the
// week's volume, the share card, the friends' feed, the 1RM estimate and the
// progression suggestion that decides what to load next time.
func TestTonnageCountsBothDumbbells(t *testing.T) {
	barbell := Set{ExerciseID: "bench", SetType: SetTypeWorking, Completed: true,
		Reps: i(5), WeightKg: f(100), LoadFactor: 1}
	dumbbells := Set{ExerciseID: "db-press", SetType: SetTypeWorking, Completed: true,
		Reps: i(5), WeightKg: f(30), LoadFactor: 2}

	if got := Summarise([]Set{barbell}).TonnageKg; got != 500 {
		t.Fatalf("barbell: 5 x 100 = %v, want 500", got)
	}
	// 5 x 30 in EACH hand is 300, not 150.
	if got := Summarise([]Set{dumbbells}).TonnageKg; got != 300 {
		t.Fatalf("dumbbells: 5 x 30 per hand = %v, want 300", got)
	}
}

// TestASingleArmSetIsNotDoubled guards the half that is easy to get wrong in
// the other direction.
//
// A one-arm dumbbell row is `per_side` — the number is one dumbbell — but only
// ONE is moving, so its factor is 1. Deriving the factor from `load_mode` alone
// would double it and invent a second dumbbell the athlete never picked up.
func TestASingleArmSetIsNotDoubled(t *testing.T) {
	oneArm := Set{ExerciseID: "one-arm-row", SetType: SetTypeWorking, Completed: true,
		Reps: i(10), WeightKg: f(40), LoadFactor: 1}
	if got := Summarise([]Set{oneArm}).TonnageKg; got != 400 {
		t.Fatalf("one-arm row: 10 x 40 = %v, want 400", got)
	}
}

// TestAMissingFactorMeansOneNotZero is why the zero value is safe.
//
// Every set written before this column existed has no factor. Reading zero as
// zero would multiply their tonnage to nothing — turning an under-report on
// dumbbell work into the total erasure of every session ever logged. It also
// keeps every hand-built `Set` in the rest of this suite reporting what it did.
func TestAMissingFactorMeansOneNotZero(t *testing.T) {
	legacy := Set{ExerciseID: "bench", SetType: SetTypeWorking, Completed: true,
		Reps: i(5), WeightKg: f(100)} // LoadFactor unset — the zero value
	if got := Summarise([]Set{legacy}).TonnageKg; got != 500 {
		t.Fatalf("a set with no factor reported %v, want 500 — zero must mean one", got)
	}
}

// A warm-up still contributes nothing, factor or not: the doubling must not
// sneak volume past the rule that excludes it.
func TestTheFactorDoesNotResurrectAWarmUp(t *testing.T) {
	warm := Set{ExerciseID: "db-press", SetType: SetTypeWarmup, Completed: true,
		Reps: i(10), WeightKg: f(20), LoadFactor: 2}
	if got := Summarise([]Set{warm}).TonnageKg; got != 0 {
		t.Fatalf("a warm-up contributed %v tonnage", got)
	}
}
