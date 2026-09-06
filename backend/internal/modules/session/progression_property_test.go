package session

import (
	"math"
	"math/rand"
	"testing"
	"time"
)

// N514/#902, part of #867 (N497, phase 5 of #753). The three golden-fixture
// test files in this package (progression_test.go, progression_v2_test.go)
// pin specific reported bugs — #812's squat ramp, #494's upright-row/calves
// scenarios. Every one of them proves the engine got ONE input right. None
// of them proves anything about the input space around it, which is exactly
// what let the #812 bug ship in the first place: nothing generalized "never
// recombine reps at one weight with a top set at another" beyond the single
// fixture somebody happened to write.
//
// This file is property tests for the three invariants #753 names
// explicitly, run against RANDOMIZED, REALISTIC inputs rather than three
// more hardcoded scenarios:
//
//  1. Never mix load evidence and rep evidence across cohorts.
//  2. Never progress from incomplete or conflicting effort data.
//  3. Never output an unloadable weight.
//
// # Why a hand-rolled generator instead of testing/quick
//
// testing/quick generates arbitrary values of basic Go types with no way to
// express "a realistic rep count" or "a session shaped like a ramping squat
// day" short of writing a custom quick.Generator per type — which is most of
// the work of a hand-rolled generator anyway, with a less readable failure
// report (quick.Value has no equivalent of a labelled t.Fatalf). A plain
// seeded *rand.Rand plus an ordinary table-free loop reads like the rest of
// this package's tests and lets each generator shape its distribution to
// what an athlete could actually log — which point 2 of the ticket requires
// ("realistic... not adversarial garbage that could never occur in
// practice").
//
// # Reproducibility
//
// Every generator here is driven by ONE fixed seed (propertyTestSeed) and a
// fixed iteration count (propertyIterations). CLAUDE.md's own standing rule
// is explicit that a property test which sometimes passes for the wrong
// reason is worse than a golden fixture — so this is deliberately NOT
// go1.20+'s auto-seeded global math/rand (which would vary run to run and
// make a CI failure unreproducible locally), and every failure below prints
// the generated input so a red run is diagnosable without re-running it
// first.
const propertyTestSeed = 20260906
const propertyIterations = 300

func newPropRand() *rand.Rand {
	return rand.New(rand.NewSource(propertyTestSeed))
}

// propSet is this file's set constructor — set() and straightSet() (the two
// existing helpers) both hardcode SetTypeWorking, which is exactly the one
// dimension invariant 1's generator needs to vary.
func propSet(exerciseID string, setType SetType, reps int, kg float64, completed bool, rir *int, rpe *float64) Set {
	r, w := reps, kg
	return Set{
		ExerciseID: exerciseID,
		SetType:    setType,
		Completed:  completed,
		Reps:       &r,
		WeightKg:   &w,
		RIR:        rir,
		RPE:        rpe,
	}
}

// ---------------------------------------------------------------------------
// Invariant 1: never mix load evidence and rep evidence across cohorts.
//
// "Cohort" here follows the definition progression_v2.go's own header comment
// gives it (and N473/#812's "coherent cohort" concept it cites): the sets a
// rep-range decision may reason over are exactly the STRAIGHT WORKING sets
// (SetTypeWorking, completed, weighted) at the session's single heaviest such
// weight (the anchor) — never a different exercise, a different set role
// (warmup/backoff/drop/AMRAP/failure), or a different weight.
//
// This test deliberately does NOT call straightWorkingSetsWithWeight or
// sameWeightCohort (the functions actually under test) to compute what it
// expects — doing that would make the check true by construction, the exact
// "check-digit validating arithmetic the code had just performed itself"
// trap CLAUDE.md's "Verify that a check can fail" section names. Instead
// referenceCohort below is an independently-written re-implementation of the
// same specification, so a mutation to the real cohort logic is something
// this test can actually diverge from and catch.
//
// Exercise identity is deliberately NOT fuzzed as a fourth cohort dimension:
// straightWorkingSetsWithWeight and sameWeightCohort never read Set.ExerciseID
// at all (confirmed by reading progression_v2.go directly, not assumed), so
// there is no runtime guard here to exercise. That's because the boundary is
// architectural rather than a check inside this pure function:
// SessionEffort's own doc comment states it is "one past session's working
// sets for a single exercise", and RecentEfforts/RecentEffortsV2 (postgres.go)
// scope their SQL by `ss.exercise_id = ANY($2)` per exercise before a
// SessionEffort is ever built. See the history.md entry for this ticket for
// the fuller reasoning.
// ---------------------------------------------------------------------------

// referenceCohort independently re-derives the anchor weight and the cohort
// of sets at it, from the "straight working set" definition, using its own
// loop rather than the package's own helpers.
func referenceCohort(sets []Set) (anchor float64, cohort []Set) {
	var straight []Set
	for _, s := range sets {
		if s.SetType != SetTypeWorking {
			continue
		}
		if !s.Completed {
			continue
		}
		if s.WeightKg == nil || s.Reps == nil {
			continue
		}
		if *s.WeightKg <= 0 {
			continue
		}
		straight = append(straight, s)
	}
	if len(straight) == 0 {
		return 0, nil
	}
	anchor = *straight[0].WeightKg
	for _, s := range straight[1:] {
		if *s.WeightKg > anchor {
			anchor = *s.WeightKg
		}
	}
	const eps = 1e-9
	for _, s := range straight {
		if math.Abs(*s.WeightKg-anchor) < eps {
			cohort = append(cohort, s)
		}
	}
	return anchor, cohort
}

func referenceRepSpread(cohort []Set) (min, max int) {
	if len(cohort) == 0 {
		return 0, 0
	}
	min, max = cohort[0].SoloReps(), cohort[0].SoloReps()
	for _, s := range cohort[1:] {
		r := s.SoloReps()
		if r < min {
			min = r
		}
		if r > max {
			max = r
		}
	}
	return min, max
}

func referenceTopSet(cohort []Set) Set {
	best := cohort[0]
	for _, s := range cohort[1:] {
		if *s.WeightKg > *best.WeightKg || (*s.WeightKg == *best.WeightKg && *s.Reps > *best.Reps) {
			best = s
		}
	}
	return best
}

func TestProgressV2_Property_NeverMixesEvidenceAcrossCohorts(t *testing.T) {
	rnd := newPropRand()
	setTypes := []SetType{SetTypeWorking, SetTypeWarmup, SetTypeBackoff, SetTypeDrop, SetTypeAMRAP, SetTypeFailure}

	for i := 0; i < propertyIterations; i++ {
		// A ramp of 2-5 genuinely different weights in one session —
		// generalizing #812's exact shape (three sets of 12 at 228, one set
		// of 3 at 335) to an arbitrary number of loads, plus decoy set
		// roles and incomplete sets that must never leak into the cohort.
		numWeights := 2 + rnd.Intn(4)
		baseWeight := 20.0 + float64(rnd.Intn(180)) // 20..200kg, a realistic loaded range
		weights := make([]float64, numWeights)
		for w := range weights {
			weights[w] = baseWeight + float64(w)*(5.0+float64(rnd.Intn(20)))
		}

		var sets []Set
		numSets := 4 + rnd.Intn(10) // 4..13 sets, a realistic single-exercise session
		for s := 0; s < numSets; s++ {
			st := setTypes[rnd.Intn(len(setTypes))]
			w := weights[rnd.Intn(len(weights))]
			reps := 1 + rnd.Intn(20) // 1..20
			completed := rnd.Intn(10) != 0
			sets = append(sets, propSet("back-squat", st, reps, w, completed, nil, nil))
		}
		// Guarantee at least one genuine straight working set so this
		// iteration actually exercises cohort selection rather than the
		// (separately valid) "no cohort at all" abstain path.
		guaranteedReps := 3 + rnd.Intn(10)
		guaranteedWeight := weights[rnd.Intn(len(weights))]
		sets = append(sets, propSet("back-squat", SetTypeWorking, guaranteedReps, guaranteedWeight, true, nil, nil))

		in := ProgressionInput{
			ExerciseID:      "back-squat",
			LoadType:        "weight_reps",
			MovementPattern: "squat",
			Recent: []SessionEffort{
				finishedSess(time.Duration(1+rnd.Intn(19))*24*time.Hour, testNow, sets...),
			},
		}

		wantAnchor, wantCohort := referenceCohort(sets)
		if len(wantCohort) == 0 {
			t.Fatalf("iteration %d: generator produced no straight working set at all — the guaranteed set should have prevented this; sets=%+v", i, sets)
		}
		wantMin, wantMax := referenceRepSpread(wantCohort)
		wantTop := referenceTopSet(wantCohort)

		p := ProgressV2(in, testNow)

		if p.LastWeightKg == nil {
			t.Fatalf("iteration %d: engine found no cohort though a straight working set exists; sets=%+v", i, sets)
		}
		if math.Abs(*p.LastWeightKg-wantAnchor) > 1e-6 {
			t.Fatalf("iteration %d: cohort anchor mismatch — engine=%.4fkg reference=%.4fkg (load evidence leaked across a different weight); sets=%+v",
				i, *p.LastWeightKg, wantAnchor, sets)
		}
		if p.WorkingSets != len(wantCohort) {
			t.Fatalf("iteration %d: cohort size mismatch — engine=%d reference=%d (a non-working-set-type or wrong-weight set leaked into the cohort); sets=%+v",
				i, p.WorkingSets, len(wantCohort), sets)
		}
		if p.LastMinReps == nil || p.LastMaxReps == nil {
			t.Fatalf("iteration %d: rep spread missing though a cohort was found", i)
		}
		if *p.LastMinReps != wantMin || *p.LastMaxReps != wantMax {
			t.Fatalf("iteration %d: rep spread mismatch — engine=[%d,%d] reference=[%d,%d] (rep evidence from outside the cohort leaked in); sets=%+v",
				i, *p.LastMinReps, *p.LastMaxReps, wantMin, wantMax, sets)
		}
		if p.LastReps == nil || *p.LastReps != *wantTop.Reps {
			t.Fatalf("iteration %d: top-set reps mismatch — engine picked a different set than the cohort's own top set", i)
		}
	}
}

// ---------------------------------------------------------------------------
// Invariant 2: never progress from incomplete or conflicting effort data.
//
// "Numeric progression" means the two codes that actually move the
// prescription forward: ProgressAddLoad and ProgressAddReps. Partial effort
// coverage must read as SuggestAbstain and a materially conflicting RIR/RPE
// pair must read as SuggestEffortConflict — never either of the two
// progress codes, and (reading the actual branches in progression_v2.go)
// never a numeric TargetWeightKg/TargetReps at all on either path.
// ---------------------------------------------------------------------------

// generateConflictingEffort picks an RIR/RPE pair that disagrees by
// noticeably more than the engine's OWN threshold (conflictThreshold,
// progression_v2.go) — reading the real threshold rather than inventing one,
// per the ticket's own design guidance, so a generator here can't
// accidentally stay inside whatever tolerance the code allows. The margin
// (at least 3.0 reserve-equivalent, against a 2.0 threshold) keeps every
// generated pair well clear of the boundary rather than flirting with float
// rounding at exactly 2.0.
func generateConflictingEffort(rnd *rand.Rand) (rir int, rpe float64) {
	rir = rnd.Intn(4) // 0..3 RIR — a realistic logged range
	rirReserve := float64(rir)
	gap := conflictThreshold + 1 + rnd.Float64()*2 // 3.0..5.0
	rpeReserve := rirReserve + gap
	if rpeReserve > 10 {
		rpeReserve = 10
	}
	rpe = 10 - rpeReserve
	return rir, rpe
}

func TestProgressV2_Property_NeverProgressesFromIncompleteOrConflictingEffort(t *testing.T) {
	rnd := newPropRand()
	patterns := []string{"squat", "hinge", "horizontal_push", "isolation", ""}
	scenarioName := map[int]string{0: "partial coverage", 1: "conflicting RIR/RPE"}

	for i := 0; i < propertyIterations; i++ {
		k := 2 + rnd.Intn(4) // 2..5 sets in the cohort — a realistic straight-set count
		weight := 20.0 + float64(rnd.Intn(180))
		reps := make([]int, k)
		for j := range reps {
			reps[j] = 3 + rnd.Intn(13) // 3..15
		}
		// Well inside staleAfter (28 days) — the stale check runs BEFORE the
		// conflict/coverage checks in ProgressV2, so a stale session here
		// would test SuggestRepeatStale instead of the invariant this test
		// is for.
		ago := time.Duration(1+rnd.Intn(20)) * 24 * time.Hour
		pattern := patterns[rnd.Intn(len(patterns))]

		scenario := rnd.Intn(2)
		var sets []Set
		var wantCode SuggestionCode
		if scenario == 0 {
			// Partial: at least one set carries RIR-or-RPE, at least one
			// carries neither. Every set gets AT MOST one of RIR/RPE, so
			// this scenario can never also trip hasEffortConflict by
			// accident.
			withEffort := 1 + rnd.Intn(k-1) // 1..k-1 — guarantees "some but not all"
			perm := rnd.Perm(k)
			effortIdx := make(map[int]bool, withEffort)
			for _, wi := range perm[:withEffort] {
				effortIdx[wi] = true
			}
			for idx := 0; idx < k; idx++ {
				var rir *int
				var rpe *float64
				if effortIdx[idx] {
					if rnd.Intn(2) == 0 {
						v := rnd.Intn(4)
						rir = &v
					} else {
						v := 5.0 + rnd.Float64()*4
						rpe = &v
					}
				}
				sets = append(sets, propSet("bench-press", SetTypeWorking, reps[idx], weight, true, rir, rpe))
			}
			wantCode = SuggestAbstain
		} else {
			// Conflicting: exactly one set materially disagrees; the rest
			// carry arbitrary effort coverage — irrelevant, since a
			// conflict is checked BEFORE the coverage question and wins
			// regardless of what that question would have answered.
			conflictIdx := rnd.Intn(k)
			for idx := 0; idx < k; idx++ {
				var rir *int
				var rpe *float64
				if idx == conflictIdx {
					r, p := generateConflictingEffort(rnd)
					rir, rpe = &r, &p
				} else if rnd.Intn(3) != 0 {
					v := rnd.Intn(4)
					rir = &v
				}
				sets = append(sets, propSet("bench-press", SetTypeWorking, reps[idx], weight, true, rir, rpe))
			}
			wantCode = SuggestEffortConflict
		}

		in := ProgressionInput{
			ExerciseID:      "bench-press",
			LoadType:        "weight_reps",
			MovementPattern: pattern,
			Recent: []SessionEffort{
				finishedSess(ago, testNow, sets...),
			},
		}

		p := ProgressV2(in, testNow)

		if p.Code != wantCode {
			t.Fatalf("iteration %d (%s): code=%s want=%s reason=%q sets=%+v",
				i, scenarioName[scenario], p.Code, wantCode, p.Reason, sets)
		}
		if p.Code == ProgressAddLoad || p.Code == ProgressAddReps {
			t.Fatalf("iteration %d: engine PROGRESSED (%s) from %s effort data", i, p.Code, scenarioName[scenario])
		}
		if p.TargetWeightKg != nil || p.TargetReps != nil {
			t.Fatalf("iteration %d: %s effort data still produced a numeric target: weight=%v reps=%v",
				i, scenarioName[scenario], p.TargetWeightKg, p.TargetReps)
		}
	}
}

// ---------------------------------------------------------------------------
// Invariant 3: never output an unloadable weight.
//
// Every suggested TargetWeightKg must be an exact multiple of the athlete's
// real equipment increment — either a literal, athlete/program-configured
// one (ResolvedProtocol.EquipmentIncrementKg, always kg-denominated
// regardless of UnitSystem — read equipmentIncrementKg's and
// roundForProtocolV2's own doc comments in progression_v2.go, not assumed)
// or, when none is configured, the per-unit plate grid roundToPlateV2 uses —
// checked in whichever unit that grid is NATIVE to, since roundToPlateV2's
// own doc comment is explicit that an imperial value is only clean when
// checked in lb, not after converting back to kg (that round-trip is
// literally the reported 68.9lb bug this file's rounding exists to close).
// ---------------------------------------------------------------------------

// loadableEpsilon tolerates float round-trip noise (kg<->lb conversion,
// float64 division) without letting through a weight that is genuinely off
// the grid — many orders of magnitude below the smallest real increment
// tested here (1.0kg / roughly 1.1lb).
const loadableEpsilon = 1e-6

func assertLoadable(t *testing.T, iteration int, code SuggestionCode, kg float64, incrementKg *float64, unitSystem string) {
	t.Helper()
	if incrementKg != nil {
		ratio := kg / *incrementKg
		if math.Abs(ratio-math.Round(ratio)) > loadableEpsilon {
			t.Fatalf("iteration %d code=%s: %.6fkg is not a multiple of the configured %.6fkg equipment increment (ratio=%.9f)",
				iteration, code, kg, *incrementKg, ratio)
		}
		return
	}
	if unitSystem == "imperial" {
		lb := kgToLb(kg)
		ratio := lb / smallestPlateLb
		if math.Abs(ratio-math.Round(ratio)) > loadableEpsilon {
			t.Fatalf("iteration %d code=%s: %.6fkg (%.6flb) is not a multiple of the %vlb plate grid (ratio=%.9f)",
				iteration, code, kg, lb, smallestPlateLb, ratio)
		}
		return
	}
	ratio := kg / smallestPlateKg
	if math.Abs(ratio-math.Round(ratio)) > loadableEpsilon {
		t.Fatalf("iteration %d code=%s: %.6fkg is not a multiple of the %vkg plate grid (ratio=%.9f)",
			iteration, code, kg, smallestPlateKg, ratio)
	}
}

func TestProgressV2_Property_NeverOutputsUnloadableWeight(t *testing.T) {
	rnd := newPropRand()
	// Realistic increments this codebase already supports/tests elsewhere —
	// see incrementByPattern/incrementByPatternLb and smallestPlateKg/
	// smallestPlateLb in progression.go and progression_v2.go.
	kgIncrements := []float64{1.0, 1.25, 2.5, 5.0}
	lbIncrementsKg := []float64{lbToKg(1.25), lbToKg(2.5), lbToKg(5), lbToKg(10)}
	patterns := []string{"squat", "hinge", "horizontal_push", "vertical_pull", "isolation", ""}

	for i := 0; i < propertyIterations; i++ {
		unitSystem := "metric"
		if rnd.Intn(2) == 0 {
			unitSystem = "imperial"
		}

		rng := RepRange{Low: 5, High: 8}
		if rnd.Intn(2) == 0 {
			// An athlete/program-configured range (ResolvedProtocol.RepRange)
			// rather than always the goal-based default — the gap is kept
			// at least 2 so "one or two short of the top" (the deload
			// branch below) always stays inside [Low, High).
			lo := 3 + rnd.Intn(10)
			hi := lo + 2 + rnd.Intn(6)
			rng = RepRange{Low: lo, High: hi}
		}

		useExplicit := rnd.Intn(2) == 0
		var configuredIncrement *float64
		protocol := &ResolvedProtocol{RepRange: &rng}
		if useExplicit {
			var inc float64
			if rnd.Intn(2) == 0 {
				inc = kgIncrements[rnd.Intn(len(kgIncrements))]
			} else {
				inc = lbIncrementsKg[rnd.Intn(len(lbIncrementsKg))]
			}
			configuredIncrement = &inc
			protocol.EquipmentIncrementKg = &inc
		}

		// A weight the athlete could actually have lifted last time: an
		// exact multiple of whichever grid is in force, comfortably large
		// (40-159 steps) so a 10% deload always clears at least one
		// increment step regardless of rounding.
		var grid float64
		switch {
		case configuredIncrement != nil:
			grid = *configuredIncrement
		case unitSystem == "imperial":
			grid = lbToKg(smallestPlateLb)
		default:
			grid = smallestPlateKg
		}
		steps := 40 + rnd.Intn(120)
		weight := grid * float64(steps)

		pattern := patterns[rnd.Intn(len(patterns))]
		branch := rnd.Intn(2)
		var in ProgressionInput
		var wantCode SuggestionCode

		if branch == 0 {
			// ProgressAddLoad: cohort at the top of the range, reserve to
			// spare on every set.
			numSets := 2 + rnd.Intn(3)
			var sets []Set
			for s := 0; s < numSets; s++ {
				rir := 2 + rnd.Intn(3)
				setReps := rng.High + rnd.Intn(2)
				sets = append(sets, propSet("back-squat", SetTypeWorking, setReps, weight, true, &rir, nil))
			}
			in = ProgressionInput{
				ExerciseID: "back-squat", LoadType: "weight_reps",
				MovementPattern: pattern, UnitSystem: unitSystem, Protocol: protocol,
				Recent: []SessionEffort{finishedSess(time.Duration(1+rnd.Intn(10))*24*time.Hour, testNow, sets...)},
			}
			wantCode = ProgressAddLoad
		} else {
			// ProgressDeload: three IDENTICAL stalled sessions, one or two
			// reps short of the top of the range, so the plateau guard
			// fires (SessionsAtLoad >= stallSessions and !readyForLoad).
			numSets := 2 + rnd.Intn(3)
			setReps := rng.High - 1 - rnd.Intn(2) // High-1 or High-2, always >= rng.Low given the >=2 gap enforced above
			var recent []SessionEffort
			for sessIdx := 0; sessIdx < stallSessions; sessIdx++ {
				var sets []Set
				for s := 0; s < numSets; s++ {
					rir := 2 + rnd.Intn(3)
					sets = append(sets, propSet("back-squat", SetTypeWorking, setReps, weight, true, &rir, nil))
				}
				recent = append(recent, finishedSess(time.Duration((sessIdx+1)*3)*24*time.Hour, testNow, sets...))
			}
			in = ProgressionInput{
				ExerciseID: "back-squat", LoadType: "weight_reps",
				MovementPattern: pattern, UnitSystem: unitSystem, Protocol: protocol,
				Recent: recent,
			}
			wantCode = ProgressDeload
		}

		p := ProgressV2(in, testNow)

		if p.Code != wantCode {
			t.Fatalf("iteration %d (branch %d): generator did not reach the intended branch — code=%s reason=%q, so this iteration isn't exercising the rounding path it claims to",
				i, branch, p.Code, p.Reason)
		}
		if p.TargetWeightKg == nil {
			t.Fatalf("iteration %d: code=%s but no numeric target was set", i, p.Code)
		}

		assertLoadable(t, i, p.Code, *p.TargetWeightKg, configuredIncrement, unitSystem)
	}
}
