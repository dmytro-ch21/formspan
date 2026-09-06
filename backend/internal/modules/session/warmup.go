package session

import "github.com/dmytro-ch21/vola/backend/internal/modules/workout"

// This file is N495/#865, phase 3 of #753 — see docs/decisions/history.md's
// N473 and N494 entries for phases 1 and 2, which this one depends on:
// GenerateWarmupRamp is only ever called (from Handler.Suggestions) once
// ProgressV2 has already produced a working-set prescription, using N494's
// resolved protocol to know whether an exercise is a heavy compound.
//
// # Why this is a SEPARATE engine, not a branch inside ProgressV2
//
// #753's own plan phase 3 is explicit: "warm-ups must be generated only
// after the first working-set prescription is known." A warm-up ramp is a
// function of an ALREADY-DECIDED target weight — it has nothing to compute
// until Progress/ProgressV2 has already answered "what should today's
// working weight be." Folding ramp generation into ProgressV2 itself would
// make that dependency implicit and risk it running on a code path
// (abstain, effort_conflict, no_history, not_applicable) that carries no
// target at all. Keeping it a separate function that the HANDLER calls only
// when `TargetWeightKg != nil` makes "no automatic warm-up when the working
// target is unknown" a property of the call site, not a branch to remember
// inside the progression engine.
//
// # Why every band is a PERCENTAGE, never an absolute weight
//
// #753, verbatim: "the exact ramp (e.g. 45/135/225/275/305) must remain
// configurable — this is a starting policy, not a fixed universal ramp."
// WarmupPolicy expresses every step as a fraction of the working weight plus
// a rep window, so the identical policy produces a sane ramp for a 60kg OHP
// and a 200kg squat alike — there is no absolute number anywhere in this
// file for a test to pin against, which is the point: pinning one would be
// re-introducing the fixed universal ramp #753 explicitly rejected.
//
// # Fatigue detection is advisory, and stays advisory structurally
//
// DetectWarmupFatigue returns a slice of reasons — pure data, no side
// effect, no mutation. There is no "reclassify" function in this package
// because reclassification is not a computation this engine performs: it is
// the athlete editing a completed warm-up set's OWN SetType field (already a
// first-class value, session.SetTypeWarmup / SetTypeWorking) through the
// existing ReplaceSets path, exactly the way any other correction to a
// logged set is made. Detecting a flag can never, by itself, change what
// Summarise counts as working volume — see the warmup_test.go golden test,
// which asserts the volume split is identical whether or not a flag fired,
// and changes only once the set's own SetType is edited.

// WarmupStep is one rung of a generated ramp — a percentage of the working
// weight, the weight that percentage resolves to (already rounded by
// whatever the caller passed as `round`), and the rep window #753's starting
// policy prescribes at that intensity.
type WarmupStep struct {
	// Label is a human-readable name for this rung ("technique", "light",
	// "moderate", "heavy") — never parsed, only displayed; a client that
	// wants to branch on position uses the slice index instead.
	Label         string  `json:"label"`
	PercentOfWork float64 `json:"percent_of_work"`
	WeightKg      float64 `json:"weight_kg"`
	RepMin        int     `json:"rep_min"`
	RepMax        int     `json:"rep_max"`
}

// WarmupBand is one configurable rung of WarmupPolicy's ramp, expressed
// entirely as a fraction of the working weight — see this file's own doc
// comment on why nothing here is an absolute number.
type WarmupBand struct {
	Label            string
	PercentOfWorkMin float64
	PercentOfWorkMax float64
	RepMin           int
	RepMax           int
	// HeavyCompoundOnly restricts this band to workout.ProfilePrimaryCompound
	// exercises — #753's own wording: "for heavy compounds, ~80-90%: 1-2
	// reps." A secondary compound, an isolation accessory or anything else
	// never reaches this rung; a squat or a deadlift does.
	HeavyCompoundOnly bool
}

// WarmupPolicy is the whole configurable starting policy this engine ramps
// from — #753's "this is a starting policy, not a fixed universal ramp,"
// made literal: a Go value, not a hardcoded sequence, so a future caller can
// supply a different one (per-sport, per-athlete, whatever the next ticket
// needs) without touching GenerateWarmupRamp itself.
//
// The technique rung is called out separately from Bands because it is
// unconditional — #753 lists it first and without a heavy-compound
// qualifier ("light technique set: 5-10 reps") — while every other rung is
// one entry in an ordered, filterable list.
type WarmupPolicy struct {
	TechniqueLabel         string
	TechniquePercentOfWork float64
	TechniqueRepMin        int
	TechniqueRepMax        int
	// Bands MUST be ordered by ascending percent-of-work — GenerateWarmupRamp
	// does not sort them, it walks them in the order given, and the ramp's
	// "reps decrease as load approaches the working weight" property (#753)
	// depends on that order matching decreasing rep windows.
	Bands []WarmupBand
}

// DefaultWarmupPolicy follows #753's own starting policy exactly:
//
//   - Light technique set: 5-10 reps.
//   - ~40-60% of work weight: 3-5 reps.
//   - ~65-80%: 2-3 reps.
//   - For heavy compounds, ~80-90%: 1-2 reps.
//
// A DEFAULT, never an authority — the same posture profileDefaults
// (protocol.go) already takes for exercise profiles, and for the identical
// reason: research on warm-up ramps is limited and heterogeneous (#753's own
// citations), so this is a reasonable starting point a future ticket can
// override, not a claim that it is the one correct ramp.
var DefaultWarmupPolicy = WarmupPolicy{
	TechniqueLabel:         "technique",
	TechniquePercentOfWork: 0.20,
	TechniqueRepMin:        5,
	TechniqueRepMax:        10,
	Bands: []WarmupBand{
		{Label: "light", PercentOfWorkMin: 0.40, PercentOfWorkMax: 0.60, RepMin: 3, RepMax: 5},
		{Label: "moderate", PercentOfWorkMin: 0.65, PercentOfWorkMax: 0.80, RepMin: 2, RepMax: 3},
		{
			Label: "heavy", PercentOfWorkMin: 0.80, PercentOfWorkMax: 0.90,
			RepMin: 1, RepMax: 2, HeavyCompoundOnly: true,
		},
	},
}

// GenerateWarmupRamp builds a warm-up ramp for a KNOWN working-set
// prescription. Returns (nil, false) when targetWeightKg is not a real,
// positive number — #753's own rule, "no automatic warm-up when the working
// target is unknown" — so a caller must check the returned bool rather than
// treating an empty slice as "zero rungs were needed"; those are different
// claims, and this function never has occasion to make the second one.
//
// round is applied to every computed weight, letting the caller reuse
// whatever rounding the athlete's own equipment/unit system already implies
// (roundForProtocolV2, in Handler.Suggestions) rather than this engine
// inventing a second rounding rule. A nil round is the identity function —
// convenient for tests that want the raw percentage arithmetic.
func GenerateWarmupRamp(
	targetWeightKg float64,
	profile workout.ExerciseProfile,
	policy WarmupPolicy,
	round func(kg float64) float64,
) ([]WarmupStep, bool) {
	if targetWeightKg <= 0 {
		return nil, false
	}
	if round == nil {
		round = func(kg float64) float64 { return kg }
	}

	steps := make([]WarmupStep, 0, len(policy.Bands)+1)
	steps = append(steps, WarmupStep{
		Label:         policy.TechniqueLabel,
		PercentOfWork: policy.TechniquePercentOfWork,
		WeightKg:      round(targetWeightKg * policy.TechniquePercentOfWork),
		RepMin:        policy.TechniqueRepMin,
		RepMax:        policy.TechniqueRepMax,
	})

	heavyCompound := profile == workout.ProfilePrimaryCompound
	for _, b := range policy.Bands {
		if b.HeavyCompoundOnly && !heavyCompound {
			continue
		}
		pct := (b.PercentOfWorkMin + b.PercentOfWorkMax) / 2
		steps = append(steps, WarmupStep{
			Label:         b.Label,
			PercentOfWork: pct,
			WeightKg:      round(targetWeightKg * pct),
			RepMin:        b.RepMin,
			RepMax:        b.RepMax,
		})
	}
	return steps, true
}

// WarmupFatigueReason names one of #753's three documented advisory
// triggers for a completed warm-up set that may actually have been training
// work. See DetectWarmupFatigue.
type WarmupFatigueReason string

const (
	// FatigueHighEffort: the warm-up set's own reported RPE was 7 or higher,
	// or its RIR was 2 or lower — the SAME reserve a working set targets
	// (targetRIR, progression.go), which a warm-up should never need.
	FatigueHighEffort WarmupFatigueReason = "high_effort"
	// FatigueNearWorkingLoadHighReps: the warm-up was loaded at or above 80%
	// of the working weight — DefaultWarmupPolicy's own "heavy" band floor —
	// and performed for as many or more reps than the working target itself.
	FatigueNearWorkingLoadHighReps WarmupFatigueReason = "near_working_load_high_reps"
	// FatigueModerateLoadDoubleReps: a genuinely moderate load (40-80% of
	// working weight) taken to roughly DOUBLE the working target's reps —
	// #753's own wording, "a moderate-load warm-up with roughly twice the
	// working repetitions."
	FatigueModerateLoadDoubleReps WarmupFatigueReason = "moderate_load_double_reps"
)

// WarmupFatiguePrompt is the ONE question #753 specifies, verbatim, for
// every trigger alike — never composed per-reason, so a warm-up that trips
// two triggers at once still asks the athlete exactly one thing.
const WarmupFatiguePrompt = "This warm-up may be training work. Count it as work?"

// Thresholds behind DetectWarmupFatigue's three triggers.
const (
	// warmupHighRPEThreshold mirrors targetRIR's own reserve floor
	// (progression.go): RPE 7 converts to roughly 3 reps in reserve, already
	// closer to a working set's target effort than any warm-up should be.
	warmupHighRPEThreshold = 7.0
	// warmupLowRIRThreshold: 2 reps in reserve is targetRIR itself — a
	// warm-up finishing with a WORKING set's own target reserve is behaving
	// like a working set.
	warmupLowRIRThreshold = 2
	// warmupNearWorkingLoadFraction is DefaultWarmupPolicy's own "heavy" band
	// floor (0.80) — reused rather than a second, unexplained number: the
	// question ("is this load close enough to the working weight that its
	// rep count matters") is the same one that band already answers.
	warmupNearWorkingLoadFraction = 0.80
	// warmupModerateLoadMinFraction/MaxFraction bound the "moderate" zone —
	// DefaultWarmupPolicy's own "light" and "moderate" bands combined
	// (0.40-0.80), i.e. everything below the near-working-load floor above.
	warmupModerateLoadMinFraction = 0.40
	warmupModerateLoadMaxFraction = 0.80
	// warmupDoubleRepsFactor is #753's own wording, "roughly twice."
	warmupDoubleRepsFactor = 2.0
)

// DetectWarmupFatigue implements #753's three documented triggers for a
// single completed warm-up set, evaluated against the SAME working-set
// prescription GenerateWarmupRamp was built from (targetWeightKg,
// targetReps — typically Plan.TargetWeightKg/TargetReps).
//
// ADVISORY ONLY, and structurally so: this returns data, nothing more. It
// never reads or writes a session, a set, or Volume — the caller (a client,
// today; a handler, later, if this needs to be reachable when a session is
// out of local cache) decides whether and how to ask the athlete, and
// nothing here can change what a set counts as. See this file's own header
// comment for why there is no companion "reclassify" function.
//
// A nil result (len == 0) means none of the three triggers fired — this is
// the common case, for the common warm-up, and callers should treat it as
// "nothing to ask," not as "detection failed."
func DetectWarmupFatigue(
	warmupWeightKg float64,
	warmupReps int,
	warmupRIR *int,
	warmupRPE *float64,
	targetWeightKg float64,
	targetReps int,
) []WarmupFatigueReason {
	var reasons []WarmupFatigueReason

	if (warmupRPE != nil && *warmupRPE >= warmupHighRPEThreshold) ||
		(warmupRIR != nil && *warmupRIR <= warmupLowRIRThreshold) {
		reasons = append(reasons, FatigueHighEffort)
	}

	if targetWeightKg > 0 && targetReps > 0 && warmupWeightKg > 0 {
		pct := warmupWeightKg / targetWeightKg
		switch {
		case pct >= warmupNearWorkingLoadFraction && warmupReps >= targetReps:
			reasons = append(reasons, FatigueNearWorkingLoadHighReps)
		case pct >= warmupModerateLoadMinFraction && pct < warmupModerateLoadMaxFraction &&
			float64(warmupReps) >= warmupDoubleRepsFactor*float64(targetReps):
			reasons = append(reasons, FatigueModerateLoadDoubleReps)
		}
	}

	return reasons
}
