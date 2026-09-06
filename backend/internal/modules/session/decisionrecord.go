package session

import "math"

// N513/#901 — an immutable decision-record audit trail for the progression
// engine (Progress in progression.go, ProgressV2 in progression_v2.go). Split
// out of #867/#753 phase 5 alongside N514 (property tests, #902) and N515
// (a shadow-replay tool, #903); neither of those is touched here.
//
// # The problem this closes
//
// Nothing the engine produced was ever recorded anywhere but the response
// itself. There was no way to ask, after the fact: which engine/ruleset
// version produced a given suggestion, why a protocol was selected, which
// sets counted as evidence and which didn't, what the normalized effort
// reading was, whether the athlete took the suggestion, or how they actually
// trained afterward.
//
// # Where this lives, and why
//
// Inside the `session` package rather than a new top-level module. The two
// callers that need to write here (Handler.Suggestions, Handler.ReplaceSets,
// Handler.Finish) already live here, the domain types being audited
// (ProgressionInput, Plan, SessionEffort, Set) already live here, and the
// pure helpers this file reuses to explain a decision (straightWorkingSetsWithWeight,
// workingSetsWithWeight, sameWeightCohort, effortCoverage) are unexported —
// a separate module would need either a second copy of them or an exported
// surface this package doesn't otherwise want. There is no new HTTP surface
// (see the history entry for why no read endpoint is built), so the
// `handler.go` half of the usual module pattern doesn't apply here; this
// file plus decisionrecord_postgres.go stand in for `<name>.go` and
// `postgres.go`.
//
// # What is, and isn't, captured
//
// Written on EVERY call to Progress/ProgressV2 that Handler.Suggestions
// makes for an exercise — including an abstained, conflicted, or
// no-history result. That is deliberate, not an oversight: the ticket names
// "output and any warnings" as a field to capture, and a no-op result is
// itself the answer to "why didn't this athlete get a suggestion", which is
// exactly the kind of question this table exists to answer later.
//
// Sets included/excluded is a SUMMARY over the one evidence session the
// engine actually reasoned from (Plan.EvidenceSessionID), not a full
// multi-session ledger — see explainExclusions' own doc comment for the
// reasoning (warm-ups are already filtered out before this package ever
// sees a session's sets, so there is nothing to report on there; a whole
// PRIOR session skipped for being non-normal is folded into `warnings`
// instead of counted here).
//
// decisionRulesetVersion is a hand-bumped marker of the DECISION LOGIC in
// progression.go/progression_v2.go — distinct from `engine`, which only
// names which file ran (that never changes meaning), and from the
// `new_recommendation_engine` feature flag, which only gates WHICH of the
// two runs. Bump this string whenever a change to either engine's branches
// could make the same history produce a different Code or Target* — a
// rename, a comment, or a new inert field must not bump it. There is
// currently one shared version for both engines rather than one per engine:
// v1 has been frozen since N473/#812 ("v1 must stay byte-for-byte
// unchanged") and is not expected to change again, so a single counter is
// simpler and a future v1 change (which would be surprising on its own) is
// the moment to reconsider that.
const decisionRulesetVersion = "1"

// EngineProgressV1 and EngineProgressV2 name which file produced a decision.
// Stored as plain strings (not a Go type wrapping a DB enum) because nothing
// in this package branches on them after they're written — the CHECK
// constraint in migration 000093 is the only thing that validates them.
const (
	EngineProgressV1 = "progress_v1"
	EngineProgressV2 = "progress_v2"
)

// Outcome status values — see NewDecisionRecord.OutcomeStatus and
// migration 000093's CHECK constraint.
const (
	OutcomeStatusPending       = "pending"
	OutcomeStatusApplied       = "applied"
	OutcomeStatusEdited        = "edited"
	OutcomeStatusDismissed     = "dismissed"
	OutcomeStatusNotApplicable = "not_applicable"
)

// Effort coverage values — see effortCoverage in progression_v2.go, reused
// directly by explainExclusions below rather than re-derived.
const (
	EffortCoverageAll     = "all"
	EffortCoverageNone    = "none"
	EffortCoveragePartial = "partial"
)

// NewDecisionRecord is what RecordDecisions inserts — one per exercise, per
// Suggestions request. Every field below OutcomeStatus is write-once once
// inserted (enforced by migration 000093's trigger, not just by convention);
// OutcomeStatus itself is the row's initial value only ('pending' or
// 'not_applicable'), never touched again by this struct — later changes go
// through ResolveDecisionOutcomes/DismissPendingDecisions instead, which
// update a disjoint, explicitly narrower set of columns.
type NewDecisionRecord struct {
	UserID     string
	ExerciseID string
	// WorkoutID is nil for a suggestion requested without one (a freeform
	// session, or the exercise-detail screen) — see handler.go's Suggestions,
	// where workout_id is already optional and unvalidated for the same
	// reason.
	WorkoutID *string

	Engine         string
	RulesetVersion string

	// Protocol* mirrors ResolveProtocol's ResolvedProtocol (protocol.go) —
	// nil throughout for v1, which never resolves one. ProtocolSource is one
	// of ProtocolSource's own string values (program/athlete_config/
	// profile_default/abstain).
	ProtocolSource               *string
	ProtocolRepRangeLow          *int
	ProtocolRepRangeHigh         *int
	ProtocolTargetSets           *int
	ProtocolTargetRIR            *float64
	ProtocolEquipmentIncrementKg *float64
	ProtocolStrategy             *string

	// EvidenceSessionID is Plan.EvidenceSessionID — nil when no evidence
	// session exists (SuggestNoHistory, SuggestNotApplicable).
	EvidenceSessionID *string
	// IncludedSetCount is Plan.WorkingSets, reused verbatim rather than
	// recomputed — the engine already knows exactly how many sets it used.
	IncludedSetCount int
	// ExcludedSetSummary maps a short reason string (e.g. "set_type:backoff",
	// "missing_weight_or_reps", "different_weight_than_anchor") to a count,
	// over the evidence session's own sets only — see explainExclusions.
	// Empty (not nil) when there is no evidence session, so it always
	// round-trips through jsonb as `{}` rather than `null`.
	ExcludedSetSummary map[string]int

	// EffortCoverage is "all"/"none"/"partial" over the same evidence-session
	// sets ExcludedSetSummary describes — nil when there's no evidence
	// session to have a coverage reading over.
	EffortCoverage   *string
	EffortReadingRIR *int
	EffortReadingRPE *float64

	OutputCode           string
	OutputReason         string
	OutputTargetWeightKg *float64
	OutputTargetReps     *int
	// Warnings is a JSON array of short machine strings — the SuggestionCode
	// itself when it names a warning (effort_conflict, abstain,
	// no_recent_normal_session), the InSessionSignal's own code when
	// present, and "light_or_deload_session_skipped" when
	// Plan.SkippedNonNormalSession is true. Never Reason, which is prose a
	// client (and now this table) must not pattern-match — see
	// SuggestionCode's own doc comment.
	Warnings []string

	// OutcomeStatus is this row's INITIAL value only, decided once at build
	// time by whether OutputTargetWeightKg is non-nil — see
	// BuildDecisionRecord. 'not_applicable' rows are never touched again by
	// ResolveDecisionOutcomes/DismissPendingDecisions, because there is
	// nothing for the athlete to have applied, edited, or dismissed.
	OutcomeStatus string
}

// warningAbstainCodes are the SuggestionCode values BuildDecisionRecord folds
// into Warnings — the ticket's own "effort_conflict, abstain, etc." Not
// SuggestNoHistory/SuggestNotApplicable/SuggestRepeatStale/
// SuggestRepeatUnknownEffort/SuggestRepeatHard: those are ordinary,
// non-surprising outcomes with their own OutputCode already, not warnings
// about the DECISION process itself the way an abstention or a conflict is.
var warningAbstainCodes = map[SuggestionCode]bool{
	SuggestAbstain:               true,
	SuggestEffortConflict:        true,
	SuggestNoRecentNormalSession: true,
}

// BuildDecisionRecord assembles the audit row for one exercise's suggestion.
// Pure — reads only its arguments, touches no database — and called once per
// exercise from Handler.Suggestions, for BOTH engines and every SuggestionCode
// alike (see this file's own doc comment on why an abstained/no-history
// result is written too).
//
// isV2 selects both which Engine constant is stamped and which pure helper
// (straightWorkingSetsWithWeight vs workingSetsWithWeight) explainExclusions
// reapplies to the evidence session — the same v1/v2 split
// progression.go/progression_v2.go maintain everywhere else in this package.
func BuildDecisionRecord(userID, exerciseID string, workoutID *string, isV2 bool, in ProgressionInput, plan Plan) NewDecisionRecord {
	rec := NewDecisionRecord{
		UserID:         userID,
		ExerciseID:     exerciseID,
		WorkoutID:      workoutID,
		RulesetVersion: decisionRulesetVersion,

		IncludedSetCount:   plan.WorkingSets,
		ExcludedSetSummary: map[string]int{},

		OutputCode:           string(plan.Code),
		OutputReason:         plan.Reason,
		OutputTargetWeightKg: plan.TargetWeightKg,
		OutputTargetReps:     plan.TargetReps,
		Warnings:             []string{},
	}
	if isV2 {
		rec.Engine = EngineProgressV2
	} else {
		rec.Engine = EngineProgressV1
	}

	if plan.TargetWeightKg != nil {
		rec.OutcomeStatus = OutcomeStatusPending
	} else {
		rec.OutcomeStatus = OutcomeStatusNotApplicable
	}

	if warningAbstainCodes[plan.Code] {
		rec.Warnings = append(rec.Warnings, string(plan.Code))
	}
	if plan.SkippedNonNormalSession {
		rec.Warnings = append(rec.Warnings, "light_or_deload_session_skipped")
	}
	if plan.InSessionSignal != nil {
		rec.Warnings = append(rec.Warnings, string(plan.InSessionSignal.Code))
	}

	if isV2 && in.Protocol != nil {
		source := string(in.Protocol.Source)
		rec.ProtocolSource = &source
		if in.Protocol.RepRange != nil {
			low, high := in.Protocol.RepRange.Low, in.Protocol.RepRange.High
			rec.ProtocolRepRangeLow, rec.ProtocolRepRangeHigh = &low, &high
		}
		rec.ProtocolTargetSets = in.Protocol.TargetSets
		rec.ProtocolTargetRIR = in.Protocol.TargetRIR
		rec.ProtocolEquipmentIncrementKg = in.Protocol.EquipmentIncrementKg
		if in.Protocol.Strategy != "" {
			strategy := string(in.Protocol.Strategy)
			rec.ProtocolStrategy = &strategy
		}
	}

	if plan.EvidenceSessionID == "" {
		return rec
	}
	evidenceID := plan.EvidenceSessionID
	rec.EvidenceSessionID = &evidenceID

	sess, ok := findSessionEffort(in.Recent, plan.EvidenceSessionID)
	if !ok {
		// Defensive only: Plan.EvidenceSessionID is always one of in.Recent's
		// own SessionIDs in practice (both engines set it from the same slice
		// they searched), but a future caller building a Plan by hand (a
		// test, say) must not panic here.
		return rec
	}

	included := evidenceCohort(sess, isV2, plan.LastWeightKg)
	rec.ExcludedSetSummary = explainExclusions(sess, isV2, plan.LastWeightKg)

	rec.EffortReadingRIR = plan.LastRIR
	rec.EffortReadingRPE = plan.LastRPE
	if len(included) > 0 {
		all, none := effortCoverage(included)
		coverage := EffortCoveragePartial
		switch {
		case all:
			coverage = EffortCoverageAll
		case none:
			coverage = EffortCoverageNone
		}
		rec.EffortCoverage = &coverage
	}

	return rec
}

// findSessionEffort locates the evidence session by id — in.Recent is at
// most `progressionWindow`+ a few entries, so a linear scan costs nothing.
func findSessionEffort(recent []SessionEffort, sessionID string) (SessionEffort, bool) {
	for _, s := range recent {
		if s.SessionID == sessionID {
			return s, true
		}
	}
	return SessionEffort{}, false
}

// evidenceCohort reapplies the SAME filters the engine itself used to decide
// which of the evidence session's sets counted — straightWorkingSetsWithWeight
// + sameWeightCohort for v2, workingSetsWithWeight for v1 — so
// BuildDecisionRecord's effort-coverage reading is computed over exactly the
// set list the engine reasoned over, never a re-derived approximation of it.
func evidenceCohort(sess SessionEffort, isV2 bool, anchorWeightKg *float64) []Set {
	if !isV2 {
		return workingSetsWithWeight(sess.Sets)
	}
	straight := straightWorkingSetsWithWeight(sess.Sets)
	if anchorWeightKg == nil {
		return straight
	}
	return sameWeightCohort(straight, *anchorWeightKg)
}

// explainExclusions is a best-effort, SUMMARY-level "sets included/excluded
// and why" over the one evidence session Plan.EvidenceSessionID names — not
// a full multi-session ledger. Two things it deliberately does NOT attempt,
// both documented in docs/decisions/history.md's N513 entry:
//
//  1. Warm-up sets never appear here, because SessionEffort.Sets already has
//     them filtered out before this package ever sees a session (see that
//     field's own doc comment) — there is nothing left to report on by the
//     time a SessionEffort reaches this file.
//  2. A PRIOR session skipped entirely for being non-normal (light/deload)
//     is not counted set-by-set here — BuildDecisionRecord instead folds
//     Plan.SkippedNonNormalSession into Warnings as a single flag, which is
//     the coarser but honest answer to "was anything skipped upstream of the
//     session actually used".
//
// What it DOES capture: for every set in the evidence session that did NOT
// make it into the engine's own cohort (evidenceCohort above), which of the
// engine's own filters excluded it — set type, incompleteness, a missing
// measure, or (v2 only) sitting at a different weight than the session's own
// anchor.
func explainExclusions(sess SessionEffort, isV2 bool, anchorWeightKg *float64) map[string]int {
	out := map[string]int{}
	for _, s := range sess.Sets {
		if reason, excluded := classifySetExclusion(s, isV2); excluded {
			out[reason]++
			continue
		}
		if isV2 && anchorWeightKg != nil && s.WeightKg != nil &&
			math.Abs(*s.WeightKg-*anchorWeightKg) >= weightCohortEpsilonKg {
			out["different_weight_than_anchor"]++
		}
	}
	return out
}

// classifySetExclusion mirrors workingSetsWithWeight's (v1) and
// straightWorkingSetsWithWeight's (v2) own filters exactly — see those
// functions' doc comments in progression.go/progression_v2.go for why each
// check exists; this just names the one that fired instead of silently
// dropping the set.
func classifySetExclusion(s Set, isV2 bool) (reason string, excluded bool) {
	if isV2 {
		if s.SetType != SetTypeWorking {
			return "set_type:" + string(s.SetType), true
		}
	} else if s.SetType == SetTypeWarmup {
		// Defensive: SessionEffort.Sets should never carry a warm-up (see
		// this file's own doc comment), but v1's own filter checks this
		// explicitly, so this does too rather than silently disagreeing with
		// it if that upstream guarantee is ever loosened.
		return "warmup", true
	}
	if !s.Completed {
		return "not_completed", true
	}
	if s.WeightKg == nil || s.Reps == nil || *s.WeightKg <= 0 {
		return "missing_weight_or_reps", true
	}
	return "", false
}
