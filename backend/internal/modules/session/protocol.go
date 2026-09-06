package session

import (
	"context"
	"math"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/modules/workout"
)

// This file is N494/#864, phase 2 of #753 — the per-workout-item
// prescription model #812/N473 (phase 1, see progression_v2.go's own doc
// comment) deliberately stopped short of. See
// docs/decisions/history.md's N473 entry, "Where this leaves #753's phase
// 1/phase 2 boundary", before changing anything here.
//
// # The problem this closes
//
// Every exercise in a workout shared the same workout-wide rep range
// (repRangeForGoal(goal)) — so an accessory movement like an upright row
// was held to the same 5-8 "general training" range as a compound lift, and
// adding load reset it to the range floor exactly as double progression is
// supposed to for a PRIMARY lift, which is the wrong protocol for an
// accessory. There was no way to configure a different rep range,
// target-sets, target effort or progression strategy per workout item.
//
// # The four-level priority order (#753's own plan, verbatim)
//
//  1. Coach/program prescription.
//  2. Athlete's explicit exercise configuration.
//  3. Exercise-profile default.
//  4. Abstain.
//
// ResolveProtocol implements exactly this order and nothing else: it never
// blends two levels' numbers together, and a field left unset at one level
// falls through to the next ONLY as a whole "did this level answer
// anything at all" question — see resolveExplicit's own doc comment for why
// that, and not per-field fallthrough, is the right granularity.
//
// "Program" and "athlete config" both live in the identical Go type,
// workout.ItemProtocol — this codebase has no separate coach-assignment
// feature yet, so which one a given item's Protocol IS is decided by
// workout OWNERSHIP (see workout.PostgresRepository.ItemProtocols' own doc
// comment): a workout the athlete does not own (an official VOLA template,
// or another athlete's shared one) carries a program-level prescription;
// a workout they DO own carries their own explicit configuration. The
// handler resolves that distinction before calling ResolveProtocol, which
// is why the two parameters here are already sorted into the right slots
// rather than this function inspecting ownership itself.
//
// "Abstain" does NOT mean ProgressV2 returns SuggestAbstain — that would
// break every unconfigured item's existing behaviour, which N494/#864's own
// acceptance criteria forbids ("falling back to today's goal-based range
// when it isn't present"). It means this resolver has nothing to say, and
// the caller (ProgressV2's effectiveRepRange) falls back to the
// pre-existing, goal-based repRangeForGoal — the legacy behaviour, not a new
// abstention code.

// ProtocolSource records which of the four priority levels actually
// answered — mostly for tests (TestResolveProtocol_PriorityOrder exercises
// all four) and for anyone debugging why a suggestion used the range it did.
type ProtocolSource string

const (
	ProtocolSourceProgram        ProtocolSource = "program"
	ProtocolSourceAthleteConfig  ProtocolSource = "athlete_config"
	ProtocolSourceProfileDefault ProtocolSource = "profile_default"
	ProtocolSourceAbstain        ProtocolSource = "abstain"
)

// ResolvedProtocol is what ResolveProtocol hands back — already collapsed to
// a single winning source, so ProgressV2 never has to re-derive priority
// itself. Every field is optional; a nil field at ProtocolSourceProfileDefault
// or above simply means that level didn't have an opinion on THAT question
// (e.g. a program that sets a rep range but no equipment increment), and
// ProgressV2 keeps its own existing default for it.
type ResolvedProtocol struct {
	Source ProtocolSource

	RepRange             *RepRange
	TargetSets           *int
	TargetRIR            *float64
	EquipmentIncrementKg *float64
	Strategy             workout.ProgressionStrategy
}

// ResolveProtocol is the whole of #753's four-level priority order. Pure and
// deterministic, per this codebase's standing rule for anything that tells
// an athlete what to do — see progression.go's own package doc comment.
func ResolveProtocol(program, athlete *workout.ItemProtocol, profile workout.ExerciseProfile) ResolvedProtocol {
	if r, ok := resolveExplicit(program); ok {
		r.Source = ProtocolSourceProgram
		return r
	}
	if r, ok := resolveExplicit(athlete); ok {
		r.Source = ProtocolSourceAthleteConfig
		return r
	}
	if def, ok := profileDefaults[profile]; ok {
		rng := def.RepRange
		sets := def.TargetSets
		rir := def.TargetRIR
		return ResolvedProtocol{
			Source:     ProtocolSourceProfileDefault,
			RepRange:   &rng,
			TargetSets: &sets,
			TargetRIR:  &rir,
			Strategy:   def.Strategy,
		}
	}
	return ResolvedProtocol{Source: ProtocolSourceAbstain}
}

// resolveExplicit reads whatever an ItemProtocol answers directly, ignoring
// any ExerciseProfile it tags (that shorthand is resolved by the caller
// falling through to profileDefaults itself — see ItemProtocol.ExerciseProfile's
// own doc comment for why a field explicitly set alongside a tagged profile
// still wins over that profile's default for the SAME question).
//
// ok=false means this ItemProtocol is nil or answers nothing at all — the
// signal ResolveProtocol needs to treat this whole priority level as though
// it had never been consulted, rather than returning a ResolvedProtocol
// whose every field is nil (which would be indistinguishable from a level
// that DID answer, just with nothing to say).
func resolveExplicit(p *workout.ItemProtocol) (ResolvedProtocol, bool) {
	if p == nil {
		return ResolvedProtocol{}, false
	}
	var r ResolvedProtocol
	have := false

	if p.RepRangeMin != nil && p.RepRangeMax != nil {
		r.RepRange = &RepRange{Low: *p.RepRangeMin, High: *p.RepRangeMax}
		have = true
	}
	if p.TargetSets != nil {
		v := *p.TargetSets
		r.TargetSets = &v
		have = true
	}
	if p.TargetRIR != nil {
		v := float64(*p.TargetRIR)
		r.TargetRIR = &v
		have = true
	} else if p.TargetRPE != nil {
		// Converted to reserve the same way session.reserveOf already does
		// for a logged set (progression.go) — RPE 8 is roughly 2 RIR.
		v := math.Max(0, 10-math.Min(*p.TargetRPE, 10))
		r.TargetRIR = &v
		have = true
	}
	if p.EquipmentIncrement != nil {
		v := *p.EquipmentIncrement
		r.EquipmentIncrementKg = &v
		have = true
	}
	if p.ProgressionStrategy != nil {
		r.Strategy = *p.ProgressionStrategy
		have = true
	}

	if !have && p.ExerciseProfile != nil {
		// A bare profile tag with nothing else configured — still a real
		// answer from this level (the athlete/program explicitly chose this
		// profile), so it must not read as "nothing here" and fall all the
		// way to the classifier's own guess. It resolves through the same
		// profileDefaults table the priority-3 fallback uses.
		if def, ok := profileDefaults[*p.ExerciseProfile]; ok {
			rng, sets, rir := def.RepRange, def.TargetSets, def.TargetRIR
			r.RepRange, r.TargetSets, r.TargetRIR = &rng, &sets, &rir
			r.Strategy = def.Strategy
			have = true
		}
	}
	return r, have
}

// profileDefault is what ResolveProtocol falls back to at priority level 3
// when neither a program nor the athlete supplied anything usable. Every
// number here is a DEFAULT, never an authority — #753's whole point.
type profileDefault struct {
	RepRange   RepRange
	TargetSets int
	TargetRIR  float64
	Strategy   workout.ProgressionStrategy
}

// profileDefaults follows conventional strength-training loading zones per
// category — see workout.ExerciseProfile's own doc comment for what each
// category means. ProfileTimedDistance carries a RepRange that is never
// read: ProgressV2's own LoadType gate (in.LoadType != "weight_reps")
// already returns SuggestNotApplicable for anything timed or distance-based
// before a rep range would ever matter, the same way it always has.
var profileDefaults = map[workout.ExerciseProfile]profileDefault{
	workout.ProfilePrimaryCompound: {
		RepRange: RepRange{Low: 5, High: 8}, TargetSets: 3, TargetRIR: 2,
		Strategy: workout.StrategyDoubleProgression,
	},
	workout.ProfileSecondaryCompoundLunge: {
		RepRange: RepRange{Low: 6, High: 10}, TargetSets: 3, TargetRIR: 2,
		Strategy: workout.StrategyDoubleProgression,
	},
	workout.ProfileIsolationAccessory: {
		RepRange: RepRange{Low: 10, High: 15}, TargetSets: 3, TargetRIR: 1,
		Strategy: workout.StrategyDoubleProgression,
	},
	// Calves tolerate, and generally respond better to, a wider and higher
	// rep band than a general accessory — the profile default sits at the
	// top of #753's reported "10-15 or 10-20" range; an athlete who wants
	// the lower end configures it explicitly (priority 2), which outranks
	// this default.
	workout.ProfileCalfHighRepAccessory: {
		RepRange: RepRange{Low: 10, High: 20}, TargetSets: 3, TargetRIR: 1,
		Strategy: workout.StrategyDoubleProgression,
	},
	workout.ProfileBodyweightDifficulty: {
		RepRange: RepRange{Low: 5, High: 20}, TargetSets: 3, TargetRIR: 2,
		Strategy: workout.StrategyDifficultyProgression,
	},
	workout.ProfileTimedDistance: {
		RepRange: RepRange{}, TargetSets: 0, TargetRIR: 0,
		Strategy: workout.StrategyLinear,
	},
}

// ClassifyExerciseProfile infers a DEFAULT profile (priority level 3) from
// catalog data the progression engine already has on hand — MovementPattern,
// MovementPatternDetail and LoadType — when neither a program nor the
// athlete tagged one explicitly. A heuristic, not an authority: see
// ResolveProtocol, which only ever consults this AFTER both higher levels
// have had a chance to answer.
//
// movementPatternDetail is what tells a calf raise ("isolation" /
// "Plantar Flexion") apart from any other single-joint accessory
// ("isolation" / something else) — MovementPattern alone collapses both to
// the same coarse bucket. Only RecentEffortsV2 populates this field (see
// ProgressionInput.MovementPatternDetail's own doc comment); v1 never
// classifies anything.
func ClassifyExerciseProfile(movementPattern, movementPatternDetail, loadType string) workout.ExerciseProfile {
	switch loadType {
	case "time", "distance", "distance_time":
		return workout.ProfileTimedDistance
	case "reps":
		return workout.ProfileBodyweightDifficulty
	}
	if strings.Contains(strings.ToLower(movementPatternDetail), "plantar") {
		return workout.ProfileCalfHighRepAccessory
	}
	switch movementPattern {
	case "squat", "hinge", "olympic",
		"horizontal_push", "vertical_push", "horizontal_pull", "vertical_pull":
		return workout.ProfilePrimaryCompound
	case "lunge":
		return workout.ProfileSecondaryCompoundLunge
	}
	return workout.ProfileIsolationAccessory
}

// WorkoutProtocolSource is the one workout-module operation this package
// needs to resolve per-item protocol configuration — not the whole
// workout.Repository, the same narrow-interface pattern FlagSource already
// uses (handler.go) to keep this package from depending on that module's
// full shape.
//
// isProgram distinguishes #753's top two priority levels in terms this
// codebase's ownership model already has — see
// workout.PostgresRepository.ItemProtocols' own doc comment, which is the
// concrete implementation cmd/api/main.go wires up here.
type WorkoutProtocolSource interface {
	ItemProtocols(ctx context.Context, userID, workoutID string) (protocols map[string]workout.ItemProtocol, isProgram bool, err error)
}
