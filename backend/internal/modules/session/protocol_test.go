package session

import (
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/modules/workout"
)

func intPtr(i int) *int { return &i }

// TestResolveProtocol_PriorityOrder is the ticket's own required test: all
// FOUR levels of #753's priority order (program prescription → athlete
// config → exercise-profile default → abstain), each exercised directly
// rather than inferred from the others passing.
func TestResolveProtocol_PriorityOrder(t *testing.T) {
	programMin, programMax := 3, 5
	athleteMin, athleteMax := 8, 12
	program := &workout.ItemProtocol{RepRangeMin: intPtr(programMin), RepRangeMax: intPtr(programMax)}
	athlete := &workout.ItemProtocol{RepRangeMin: intPtr(athleteMin), RepRangeMax: intPtr(athleteMax)}
	profile := workout.ProfileIsolationAccessory

	t.Run("1: program prescription outranks athlete config and profile default", func(t *testing.T) {
		r := ResolveProtocol(program, athlete, profile)
		if r.Source != ProtocolSourceProgram {
			t.Fatalf("expected program source, got %s", r.Source)
		}
		if r.RepRange == nil || r.RepRange.Low != programMin || r.RepRange.High != programMax {
			t.Errorf("expected program's own range, got %+v", r.RepRange)
		}
	})

	t.Run("2: athlete config outranks profile default when no program answers", func(t *testing.T) {
		r := ResolveProtocol(nil, athlete, profile)
		if r.Source != ProtocolSourceAthleteConfig {
			t.Fatalf("expected athlete_config source, got %s", r.Source)
		}
		if r.RepRange == nil || r.RepRange.Low != athleteMin || r.RepRange.High != athleteMax {
			t.Errorf("expected athlete's own range, got %+v", r.RepRange)
		}
	})

	t.Run("3: exercise-profile default used when neither program nor athlete answers", func(t *testing.T) {
		r := ResolveProtocol(nil, nil, profile)
		if r.Source != ProtocolSourceProfileDefault {
			t.Fatalf("expected profile_default source, got %s", r.Source)
		}
		want := profileDefaults[profile]
		if r.RepRange == nil || *r.RepRange != want.RepRange {
			t.Errorf("expected profile default range %+v, got %+v", want.RepRange, r.RepRange)
		}
		if r.TargetSets == nil || *r.TargetSets != want.TargetSets {
			t.Errorf("expected profile default target_sets %v, got %v", want.TargetSets, r.TargetSets)
		}
	})

	t.Run("4: abstain when nothing at any level answers", func(t *testing.T) {
		r := ResolveProtocol(nil, nil, workout.ExerciseProfile("no-such-profile"))
		if r.Source != ProtocolSourceAbstain {
			t.Fatalf("expected abstain, got %s", r.Source)
		}
		if r.RepRange != nil || r.TargetSets != nil || r.TargetRIR != nil || r.EquipmentIncrementKg != nil {
			t.Errorf("abstain must invent nothing, got %+v", r)
		}
	})
}

// A program (or athlete config) that answers ONE question must not cause the
// resolver to fill in the rest from a lower priority level — that would be
// blending levels, which #753's priority order forbids. An unanswered field
// stays nil so the caller (ProgressV2's own fallbacks) decides what nil
// means, rather than this function inventing an answer nobody actually gave.
func TestResolveProtocol_DoesNotBlendLevels(t *testing.T) {
	sets := 4
	program := &workout.ItemProtocol{TargetSets: &sets} // no rep range at all
	athleteMin, athleteMax := 8, 12
	athlete := &workout.ItemProtocol{RepRangeMin: &athleteMin, RepRangeMax: &athleteMax}

	r := ResolveProtocol(program, athlete, workout.ProfileIsolationAccessory)
	if r.Source != ProtocolSourceProgram {
		t.Fatalf("expected program source, got %s", r.Source)
	}
	if r.TargetSets == nil || *r.TargetSets != sets {
		t.Errorf("expected the program's own target_sets, got %v", r.TargetSets)
	}
	if r.RepRange != nil {
		t.Errorf("program answered target_sets only; expected no rep range rather "+
			"than one blended in from athlete config or profile default, got %+v", r.RepRange)
	}
}

// A bare ExerciseProfile TAG on an ItemProtocol (no other field set) is
// still a real answer from that priority level — the athlete or program
// explicitly chose the profile, so it must not fall all the way through to
// ClassifyExerciseProfile's own guess.
func TestResolveProtocol_BareProfileTagIsAnAnswer(t *testing.T) {
	tag := workout.ProfileCalfHighRepAccessory
	athlete := &workout.ItemProtocol{ExerciseProfile: &tag}

	r := ResolveProtocol(nil, athlete, workout.ProfilePrimaryCompound)
	if r.Source != ProtocolSourceAthleteConfig {
		t.Fatalf("expected athlete_config source, got %s", r.Source)
	}
	want := profileDefaults[tag]
	if r.RepRange == nil || *r.RepRange != want.RepRange {
		t.Errorf("expected the TAGGED profile's range %+v, not the classifier's "+
			"guess, got %+v", want.RepRange, r.RepRange)
	}
}

// TestClassifyExerciseProfile pins the heuristic against the exact catalog
// shapes #753's report named — an upright row (movement_pattern
// vertical_pull) and calf raises (movement_pattern "isolation", which is
// shared with every other single-joint accessory — only
// movement_pattern_detail's "Plantar Flexion"/"Ankle Plantarflexion" tells
// them apart).
func TestClassifyExerciseProfile(t *testing.T) {
	cases := []struct {
		name, pattern, detail, loadType string
		want                            workout.ExerciseProfile
	}{
		{"upright row: vertical_pull compound", "vertical_pull", "Vertical Pull", "weight_reps", workout.ProfilePrimaryCompound},
		{"barbell calf raise: isolation + Plantar Flexion", "isolation", "Plantar Flexion", "weight_reps", workout.ProfileCalfHighRepAccessory},
		{"bodyweight calf raise: isolation + Ankle Plantarflexion", "isolation", "Ankle Plantarflexion", "weight_reps", workout.ProfileCalfHighRepAccessory},
		{"lateral raise: isolation, unrelated detail", "isolation", "Shoulder Abduction", "weight_reps", workout.ProfileIsolationAccessory},
		{"walking lunge", "lunge", "Lunge", "weight_reps", workout.ProfileSecondaryCompoundLunge},
		{"barbell squat: primary compound", "squat", "Back Squat", "weight_reps", workout.ProfilePrimaryCompound},
		{"plank: timed", "core", "Anti-Extension", "time", workout.ProfileTimedDistance},
		{"pull-up: reps-only load type", "vertical_pull", "Vertical Pull", "reps", workout.ProfileBodyweightDifficulty},
		{"run: distance_time", "locomotion", "", "distance_time", workout.ProfileTimedDistance},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyExerciseProfile(tc.pattern, tc.detail, tc.loadType)
			if got != tc.want {
				t.Errorf("ClassifyExerciseProfile(%q, %q, %q) = %s, want %s",
					tc.pattern, tc.detail, tc.loadType, got, tc.want)
			}
		})
	}
}
