package session

import (
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/modules/workout"
)

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// TestBuildDecisionRecord_NoHistoryIsStillRecorded pins the ticket's own
// explicit requirement (N513/#901): a no-op result is recorded exactly like
// a real prescription — "why didn't this athlete get a suggestion" is the
// question this table exists to answer.
func TestBuildDecisionRecord_NoHistoryIsStillRecorded(t *testing.T) {
	in := ProgressionInput{
		ExerciseID: "bench-press", LoadType: "weight_reps", MovementPattern: "horizontal_push",
	}
	plan := Progress(in, time.Now())
	if plan.Code != SuggestNoHistory {
		t.Fatalf("test setup: want SuggestNoHistory, got %s", plan.Code)
	}

	rec := BuildDecisionRecord("user1", "bench-press", nil, false, in, plan)
	if rec.Engine != EngineProgressV1 {
		t.Errorf("Engine = %q, want %q", rec.Engine, EngineProgressV1)
	}
	if rec.OutputCode != string(SuggestNoHistory) {
		t.Errorf("OutputCode = %q, want %q", rec.OutputCode, SuggestNoHistory)
	}
	if rec.OutcomeStatus != OutcomeStatusNotApplicable {
		t.Errorf("OutcomeStatus = %q, want %q — no target was given, so nothing to apply/edit/dismiss",
			rec.OutcomeStatus, OutcomeStatusNotApplicable)
	}
	if rec.EvidenceSessionID != nil {
		t.Errorf("EvidenceSessionID = %v, want nil — there is no history to point at", rec.EvidenceSessionID)
	}
	if len(rec.Warnings) != 0 {
		t.Errorf("Warnings = %v, want none — no_history is an ordinary outcome, not a decision warning", rec.Warnings)
	}
}

// TestBuildDecisionRecord_EffortConflictIsAWarning pins the ticket's other
// named example ("effort_conflict") into Warnings, and that a conflicted
// decision still carries no numeric target to act on.
func TestBuildDecisionRecord_EffortConflictIsAWarning(t *testing.T) {
	now := time.Now()
	rir0, rpe8 := 0, 8.0
	s := finishedSess(2*24*time.Hour, now, straightSet(5, 100, &rir0, &rpe8))
	in := squatIn("", s)

	plan := ProgressV2(in, now)
	if plan.Code != SuggestEffortConflict {
		t.Fatalf("test setup: want SuggestEffortConflict, got %s", plan.Code)
	}

	rec := BuildDecisionRecord("u1", "back-squat", nil, true, in, plan)
	if rec.Engine != EngineProgressV2 {
		t.Errorf("Engine = %q, want %q", rec.Engine, EngineProgressV2)
	}
	if !containsString(rec.Warnings, string(SuggestEffortConflict)) {
		t.Errorf("Warnings = %v, want it to contain %q", rec.Warnings, SuggestEffortConflict)
	}
	if rec.OutcomeStatus != OutcomeStatusNotApplicable {
		t.Errorf("OutcomeStatus = %q, want %q", rec.OutcomeStatus, OutcomeStatusNotApplicable)
	}
	if rec.EvidenceSessionID == nil || *rec.EvidenceSessionID != "s" {
		t.Errorf("EvidenceSessionID = %v, want \"s\"", rec.EvidenceSessionID)
	}
}

// TestBuildDecisionRecord_ExplainsIncludedAndExcludedSets is the ticket's
// third named example ("excluded: backoff set") — a session mixing a
// straight-set cohort with a backoff set and an incomplete set, and
// BuildDecisionRecord naming which of the engine's own filters excluded
// each one, using the SAME predicates the engine itself used (not a
// re-derived approximation).
func TestBuildDecisionRecord_ExplainsIncludedAndExcludedSets(t *testing.T) {
	now := time.Now()
	rir2 := 2
	straight1 := straightSet(8, 100, &rir2, nil)
	straight2 := straightSet(8, 100, &rir2, nil)
	straight3 := straightSet(8, 100, &rir2, nil)
	backoff := straightSet(8, 80, &rir2, nil)
	backoff.SetType = SetTypeBackoff
	incomplete := straightSet(8, 100, &rir2, nil)
	incomplete.Completed = false

	s := finishedSess(2*24*time.Hour, now, straight1, straight2, straight3, backoff, incomplete)
	in := squatIn("", s)

	plan := ProgressV2(in, now)
	if plan.Code != ProgressAddLoad {
		t.Fatalf("test setup: want ProgressAddLoad, got %s (every straight set hit the top of the range with reserve)", plan.Code)
	}

	rec := BuildDecisionRecord("u1", "back-squat", nil, true, in, plan)
	if rec.IncludedSetCount != 3 {
		t.Errorf("IncludedSetCount = %d, want 3", rec.IncludedSetCount)
	}
	if got := rec.ExcludedSetSummary["set_type:backoff"]; got != 1 {
		t.Errorf(`ExcludedSetSummary["set_type:backoff"] = %d, want 1 (map: %v)`, got, rec.ExcludedSetSummary)
	}
	if got := rec.ExcludedSetSummary["not_completed"]; got != 1 {
		t.Errorf(`ExcludedSetSummary["not_completed"] = %d, want 1 (map: %v)`, got, rec.ExcludedSetSummary)
	}
	if rec.EffortCoverage == nil || *rec.EffortCoverage != EffortCoverageAll {
		t.Errorf("EffortCoverage = %v, want %q — every included set carried an RIR", rec.EffortCoverage, EffortCoverageAll)
	}
	if rec.EffortReadingRIR == nil || *rec.EffortReadingRIR != 2 {
		t.Errorf("EffortReadingRIR = %v, want 2 (the top set's own RIR)", rec.EffortReadingRIR)
	}
	if rec.OutcomeStatus != OutcomeStatusPending {
		t.Errorf("OutcomeStatus = %q, want %q — a real target was given", rec.OutcomeStatus, OutcomeStatusPending)
	}
}

// TestBuildDecisionRecord_V1ExplainsExclusionsTheSameWay is the v1 sibling —
// a warm-up set (defensive: SessionEffort.Sets should never carry one, but a
// hand-built fixture can, and classifySetExclusion must still name it rather
// than mis-attributing it) and a set missing its weight.
func TestBuildDecisionRecord_V1ExplainsExclusionsTheSameWay(t *testing.T) {
	now := time.Now()
	rir2 := 2
	warm := set(5, 40, &rir2, nil)
	warm.SetType = SetTypeWarmup
	working1 := set(8, 100, &rir2, nil)
	working2 := set(8, 100, &rir2, nil)
	working3 := set(8, 100, &rir2, nil)
	missingWeight := set(8, 100, &rir2, nil)
	missingWeight.WeightKg = nil

	s := sess(2*24*time.Hour, now, warm, working1, working2, working3, missingWeight)
	in := ProgressionInput{
		ExerciseID: "bench-press", LoadType: "weight_reps", MovementPattern: "horizontal_push",
		Recent: []SessionEffort{s},
	}
	plan := Progress(in, now)

	rec := BuildDecisionRecord("u1", "bench-press", nil, false, in, plan)
	if rec.IncludedSetCount != 3 {
		t.Errorf("IncludedSetCount = %d, want 3", rec.IncludedSetCount)
	}
	if got := rec.ExcludedSetSummary["warmup"]; got != 1 {
		t.Errorf(`ExcludedSetSummary["warmup"] = %d, want 1 (map: %v)`, got, rec.ExcludedSetSummary)
	}
	if got := rec.ExcludedSetSummary["missing_weight_or_reps"]; got != 1 {
		t.Errorf(`ExcludedSetSummary["missing_weight_or_reps"] = %d, want 1 (map: %v)`, got, rec.ExcludedSetSummary)
	}
}

// TestBuildDecisionRecord_CapturesTheResolvedProtocol pins that v2's
// four-level protocol resolution (protocol.go's ResolvedProtocol) round-trips
// into the record field-for-field, and that v1 — which never resolves one —
// leaves every protocol field nil.
func TestBuildDecisionRecord_CapturesTheResolvedProtocol(t *testing.T) {
	now := time.Now()
	rir2 := 2
	s := finishedSess(2*24*time.Hour, now, straightSet(8, 100, &rir2, nil))
	in := squatIn("", s)

	targetSets := 4
	targetRIR := 1.5
	increment := 2.5
	rng := RepRange{Low: 6, High: 10}
	resolved := ResolvedProtocol{
		Source: ProtocolSourceAthleteConfig, RepRange: &rng, TargetSets: &targetSets,
		TargetRIR: &targetRIR, EquipmentIncrementKg: &increment, Strategy: workout.StrategyDoubleProgression,
	}
	in.Protocol = &resolved
	plan := ProgressV2(in, now)

	rec := BuildDecisionRecord("u1", "back-squat", nil, true, in, plan)
	if rec.ProtocolSource == nil || *rec.ProtocolSource != string(ProtocolSourceAthleteConfig) {
		t.Errorf("ProtocolSource = %v, want %q", rec.ProtocolSource, ProtocolSourceAthleteConfig)
	}
	if rec.ProtocolRepRangeLow == nil || *rec.ProtocolRepRangeLow != 6 ||
		rec.ProtocolRepRangeHigh == nil || *rec.ProtocolRepRangeHigh != 10 {
		t.Errorf("ProtocolRepRange = [%v,%v], want [6,10]", rec.ProtocolRepRangeLow, rec.ProtocolRepRangeHigh)
	}
	if rec.ProtocolTargetSets == nil || *rec.ProtocolTargetSets != 4 {
		t.Errorf("ProtocolTargetSets = %v, want 4", rec.ProtocolTargetSets)
	}
	if rec.ProtocolTargetRIR == nil || *rec.ProtocolTargetRIR != 1.5 {
		t.Errorf("ProtocolTargetRIR = %v, want 1.5", rec.ProtocolTargetRIR)
	}
	if rec.ProtocolEquipmentIncrementKg == nil || *rec.ProtocolEquipmentIncrementKg != 2.5 {
		t.Errorf("ProtocolEquipmentIncrementKg = %v, want 2.5", rec.ProtocolEquipmentIncrementKg)
	}
	if rec.ProtocolStrategy == nil || *rec.ProtocolStrategy != string(workout.StrategyDoubleProgression) {
		t.Errorf("ProtocolStrategy = %v, want %q", rec.ProtocolStrategy, workout.StrategyDoubleProgression)
	}

	// v1 must never carry any of this — see progression.go's own standing
	// rule that Progress must not read ProgressionInput.Protocol.
	v1Plan := Progress(in, now)
	v1Rec := BuildDecisionRecord("u1", "back-squat", nil, false, in, v1Plan)
	if v1Rec.ProtocolSource != nil {
		t.Errorf("v1 ProtocolSource = %v, want nil", v1Rec.ProtocolSource)
	}
}

// TestBuildDecisionRecord_SkippedNonNormalSessionIsAWarning pins N474's
// light/deload-skip signal into Warnings, using the exact same fixture
// shape TestProgress_SkipsAnUnusableSessionForARealOneBehindIt's siblings
// use elsewhere in this package.
func TestBuildDecisionRecord_SkippedNonNormalSessionIsAWarning(t *testing.T) {
	now := time.Now()
	rir2 := 2
	light := sessWithIntent(IntentLight, 1*24*time.Hour, now, set(5, 40, &rir2, nil))
	normal := sess(8*24*time.Hour, now, set(8, 100, &rir2, nil), set(8, 100, &rir2, nil))

	in := ProgressionInput{
		ExerciseID: "bench-press", LoadType: "weight_reps", MovementPattern: "horizontal_push",
		Recent: []SessionEffort{light, normal},
	}
	plan := Progress(in, now)
	if !plan.SkippedNonNormalSession {
		t.Fatalf("test setup: want SkippedNonNormalSession=true")
	}

	rec := BuildDecisionRecord("u1", "bench-press", nil, false, in, plan)
	if !containsString(rec.Warnings, "light_or_deload_session_skipped") {
		t.Errorf("Warnings = %v, want it to contain \"light_or_deload_session_skipped\"", rec.Warnings)
	}
	// The evidence session is still the NORMAL one, not the skipped light
	// one — the light session was never the evidence, only a detour on the
	// way to it.
	if rec.EvidenceSessionID == nil || *rec.EvidenceSessionID != normal.SessionID {
		t.Errorf("EvidenceSessionID = %v, want %q", rec.EvidenceSessionID, normal.SessionID)
	}
}

// TestBuildDecisionRecord_InSessionSignalIsAWarning pins N191's in-session
// divergence signal into Warnings too — a live, orthogonal flag from the
// abstain/conflict codes, and BuildDecisionRecord must not conflate the two.
func TestBuildDecisionRecord_InSessionSignalIsAWarning(t *testing.T) {
	now := time.Now()
	rir2 := 2
	s := sess(8*24*time.Hour, now, set(8, 100, &rir2, nil), set(8, 100, &rir2, nil))
	in := ProgressionInput{
		ExerciseID: "bench-press", LoadType: "weight_reps", MovementPattern: "horizontal_push",
		Recent: []SessionEffort{s},
		// Meaningfully heavier than the 100kg standing prescription — see
		// applyInSessionSignal's own threshold (10%).
		InSessionWorkingWeightsKg: []float64{130},
	}
	plan := Progress(in, now)
	if plan.InSessionSignal == nil {
		t.Fatalf("test setup: want a non-nil InSessionSignal")
	}

	rec := BuildDecisionRecord("u1", "bench-press", nil, false, in, plan)
	if !containsString(rec.Warnings, string(InSessionAbove)) {
		t.Errorf("Warnings = %v, want it to contain %q", rec.Warnings, InSessionAbove)
	}
}
