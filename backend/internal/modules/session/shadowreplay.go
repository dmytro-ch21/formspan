package session

import (
	"fmt"
	"math"
	"time"
)

// N515/#903 — the pure half of VOLA's shadow-replay validation tool
// (cmd/shadowreplay), split out of #867/#753 phase 5 alongside N513
// (decisionrecord.go, the audit trail) and N514 (progression_property_test.go,
// the property tests). Neither of those is touched here.
//
// # What this closes
//
// #753's own validation plan names "historical shadow replay comparing v1
// and v2" as a required step BEFORE the opt-in pilot: running Progress and
// ProgressV2 over the same real, finished session history and reporting
// where they diverge, without ever turning `new_recommendation_engine` on
// for a real athlete. This file is the comparison itself — CompareEngines
// and the Disagreement it returns; cmd/shadowreplay/main.go is the thin CLI
// orchestrator (DB connection, candidate enumeration via
// Repository.ShadowReplayCandidates, per-user batching, report formatting)
// that has no reason to duplicate this package's own definitions of "what
// counts as agreement" a second time outside it.
//
// # Why this lives here rather than in cmd/shadowreplay
//
// Same reasoning decisionrecord.go gives for its own placement: the domain
// types being compared (ProgressionInput, Plan, SuggestionCode) already live
// in this package, and "what counts as disagreement" is a fact about the
// two engines, testable with the same plain-Go, no-database tests
// progression_test.go and progression_v2_test.go already use — not a fact
// about a CLI tool's plumbing. A caller outside this package reconstructing
// the comparison from Plan's already-exported fields would be a second,
// driftable copy of this decision.
//
// # Never touches an athlete-facing surface
//
// CompareEngines takes two ProgressionInput values and returns a value type.
// It calls Progress and ProgressV2 — exactly the same two functions
// Handler.Suggestions already calls — and nothing else; it opens no
// connection, writes no row, and is not wired into cmd/api's HTTP surface at
// all. See cmd/shadowreplay/main.go's own doc comment for the read-only
// guarantee at the tool level, and docs/decisions/history.md's N515 entry
// for the explicit confirmation that this diff adds no route and changes no
// existing handler's behavior.

// DisagreementCategory classifies WHY two plans disagree — the ticket's own
// three cases (#903: "different code, different target_weight_kg/
// target_reps, or one abstaining where the other progresses"), kept as
// distinct, mutually exclusive buckets (via CompareEngines' priority order)
// rather than one aggregate count, per that same ticket's own "broken down
// usefully" requirement for the summary a strength coach would read.
type DisagreementCategory string

const (
	// DisagreementAbstentionDivergence: exactly one engine has no numeric
	// target at all (TargetWeightKg nil) while the other does — the
	// highest-priority category, checked first, because "one engine says
	// nothing and the other tells you what to lift" is the most
	// product-relevant kind of divergence a coach can review, and the one
	// most likely to also show a different Code (an abstain-like code is
	// never the SAME code as add_load/add_reps/hold/deload/repeat_*, so this
	// case would otherwise always be swallowed by DisagreementCodeDiffers
	// below).
	DisagreementAbstentionDivergence DisagreementCategory = "abstention_divergence"
	// DisagreementCodeDiffers: both engines produced a Code, and the codes
	// differ, but neither side is a bare abstention (that case is caught
	// above first) — e.g. one says add_reps, the other add_load.
	DisagreementCodeDiffers DisagreementCategory = "code_differs"
	// DisagreementTargetDiffers: same Code, but the numeric prescription
	// itself differs — a different TargetWeightKg (outside
	// disagreementWeightEpsilonKg) or a different TargetReps.
	DisagreementTargetDiffers DisagreementCategory = "target_differs"
)

// disagreementWeightEpsilonKg reuses weightCohortEpsilonKg (progression_v2.go)
// rather than inventing a second float tolerance in this package — see that
// constant's own doc comment for why 1e-6 is safely far below anything
// loadable (smallestPlateKg, the finest real plate increment this package
// knows about, is four orders of magnitude larger) and therefore tolerates
// only float noise, never a genuine difference in what either engine is
// telling an athlete to load.
const disagreementWeightEpsilonKg = weightCohortEpsilonKg

// EngineOutcome is one engine's Plan, trimmed to what a reviewing strength
// coach needs to judge a disagreement — not the whole Plan (InSessionSignal
// and Warmup are populated by the live handler, never by Progress/
// ProgressV2 themselves, so they would always be zero here and are omitted
// rather than printed as misleading empty fields).
type EngineOutcome struct {
	Code           SuggestionCode `json:"code"`
	Reason         string         `json:"reason"`
	TargetWeightKg *float64       `json:"target_weight_kg,omitempty"`
	TargetReps     *int           `json:"target_reps,omitempty"`
	LastWeightKg   *float64       `json:"last_weight_kg,omitempty"`
	LastReps       *int           `json:"last_reps,omitempty"`
	WorkingSets    int            `json:"working_sets"`
	SessionsAtLoad int            `json:"sessions_at_load"`
}

func outcomeOf(p Plan) EngineOutcome {
	return EngineOutcome{
		Code: p.Code, Reason: p.Reason,
		TargetWeightKg: p.TargetWeightKg, TargetReps: p.TargetReps,
		LastWeightKg: p.LastWeightKg, LastReps: p.LastReps,
		WorkingSets: p.WorkingSets, SessionsAtLoad: p.SessionsAtLoad,
	}
}

// Disagreement is one (athlete, exercise) pair where Progress and ProgressV2
// produced materially different advice — carrying enough context that a
// strength coach can judge it without re-running anything, per #903's own
// "in a form a strength coach could review" requirement: which athlete,
// which exercise, WHY this counts as a disagreement in one prose sentence,
// and both engines' full outcomes side by side.
type Disagreement struct {
	UserID     string               `json:"user_id"`
	ExerciseID string               `json:"exercise_id"`
	Category   DisagreementCategory `json:"category"`
	// Detail is a short, human-readable explanation — prose for a coach to
	// read, never pattern-matched by anything, same standing this package
	// already gives Plan.Reason.
	Detail string        `json:"detail"`
	V1     EngineOutcome `json:"v1"`
	V2     EngineOutcome `json:"v2"`
}

// CompareEngines runs Progress (v1) and ProgressV2 (v2) and reports whether
// — and how — they disagree. Read-only and side-effect-free: it calls
// exactly the same two pure functions Handler.Suggestions already calls, and
// nothing else.
//
// v1In and v2In are taken SEPARATELY, deliberately, rather than one shared
// ProgressionInput plus a bool: that is exactly how the two engines are
// called everywhere else in this package (Handler.Suggestions calls
// RecentEfforts for v1 and RecentEffortsV2 for v2, never the same map for
// both), and RecentEfforts/RecentEffortsV2 are NOT interchangeable — see
// RecentEffortsV2's own doc comment on why v1's ranking can seat an
// unfinished session ahead of real history, starving its window. Collapsing
// the two callers' inputs into one here would silently paper over exactly
// the kind of difference #753 exists to surface, not merely fail to exercise
// it.
//
// now is passed in, not read from time.Now(), for the same determinism
// standing every other pure function in this package holds — a caller (a
// test, or cmd/shadowreplay wanting one consistent instant across a whole
// run) controls it explicitly.
func CompareEngines(userID, exerciseID string, v1In, v2In ProgressionInput, now time.Time) (Disagreement, bool) {
	p1 := Progress(v1In, now)
	p2 := ProgressV2(v2In, now)

	v1Abstains := p1.TargetWeightKg == nil
	v2Abstains := p2.TargetWeightKg == nil

	var category DisagreementCategory
	var detail string
	switch {
	case v1Abstains != v2Abstains:
		category = DisagreementAbstentionDivergence
		if v1Abstains {
			detail = fmt.Sprintf("v1 abstains (%s); v2 progresses to %s", p1.Code, describeTarget(p2))
		} else {
			detail = fmt.Sprintf("v2 abstains (%s); v1 progresses to %s", p2.Code, describeTarget(p1))
		}
	case p1.Code != p2.Code:
		category = DisagreementCodeDiffers
		detail = fmt.Sprintf("v1 says %s (%s); v2 says %s (%s)",
			p1.Code, describeTarget(p1), p2.Code, describeTarget(p2))
	case !sameTarget(p1, p2):
		category = DisagreementTargetDiffers
		detail = fmt.Sprintf("both say %s but disagree on the target: v1 %s, v2 %s",
			p1.Code, describeTarget(p1), describeTarget(p2))
	default:
		return Disagreement{}, false
	}

	return Disagreement{
		UserID: userID, ExerciseID: exerciseID,
		Category: category, Detail: detail,
		V1: outcomeOf(p1), V2: outcomeOf(p2),
	}, true
}

// describeTarget renders a Plan's prescription as one short, human-readable
// string for Disagreement.Detail — never used for comparison, only display.
func describeTarget(p Plan) string {
	switch {
	case p.TargetWeightKg != nil && p.TargetReps != nil:
		return fmt.Sprintf("%.2fkg x %d", *p.TargetWeightKg, *p.TargetReps)
	case p.TargetWeightKg != nil:
		return fmt.Sprintf("%.2fkg", *p.TargetWeightKg)
	case p.TargetReps != nil:
		return fmt.Sprintf("%d reps", *p.TargetReps)
	default:
		return "no target"
	}
}

// sameTarget is true when two plans' numeric prescriptions agree — both
// nil, or both present and equal within disagreementWeightEpsilonKg (weight)
// and exactly (reps, an integer with no float noise to tolerate).
func sameTarget(p1, p2 Plan) bool {
	if !sameWeightPtr(p1.TargetWeightKg, p2.TargetWeightKg) {
		return false
	}
	return sameIntPtr(p1.TargetReps, p2.TargetReps)
}

func sameWeightPtr(a, b *float64) bool {
	if (a == nil) != (b == nil) {
		return false
	}
	if a == nil {
		return true
	}
	return math.Abs(*a-*b) < disagreementWeightEpsilonKg
}

func sameIntPtr(a, b *int) bool {
	if (a == nil) != (b == nil) {
		return false
	}
	if a == nil {
		return true
	}
	return *a == *b
}
