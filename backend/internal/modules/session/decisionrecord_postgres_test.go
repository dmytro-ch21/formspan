package session

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// seedFixtureWorkout inserts a minimal workout row this file owns (own id,
// removed in cleanupDecisionFixtures) — session_progression_decisions.workout_id
// is a real FK into `workouts`, so ResolveDecisionOutcomes/
// DismissPendingDecisions' correlation tests need one that actually exists.
func seedFixtureWorkout(ctx context.Context, pool *pgxpool.Pool, id, ownerUserID string) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO workouts (id, owner_user_id, name, sport)
		VALUES ($1, $2, 'decision record fixture', 'strength')
		ON CONFLICT (id) DO NOTHING`, id, ownerUserID)
	return err
}

func cleanupDecisionFixtures(t *testing.T, pool *pgxpool.Pool, workoutID string) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		if _, err := pool.Exec(ctx,
			`DELETE FROM session_progression_decisions WHERE workout_id = $1`, workoutID); err != nil {
			t.Logf("cleanup decision records for workout %s: %v", workoutID, err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM workouts WHERE id = $1`, workoutID); err != nil {
			t.Logf("cleanup workout %s: %v", workoutID, err)
		}
	})
}

// seedEvidenceSessionFixture creates a real, finished session so a decision
// record's evidence_session_id FK has something to point at — a made-up id
// trips the FK violation exactly like a made-up exercise or workout id would
// (see translatePgError, which reports both under the same generic "unknown
// exercise" message, since none of these ids are ever caller-facing except
// through that path).
func seedEvidenceSessionFixture(t *testing.T, repo *PostgresRepository, pool *pgxpool.Pool, id, user string) {
	t.Helper()
	ended := time.Now().UTC().Add(-47 * time.Hour)
	if _, err := repo.Create(context.Background(), NewSession{
		ID: id, UserID: user, Sport: "strength", StartedAt: ended.Add(-time.Hour), EndedAt: &ended,
	}); err != nil {
		t.Fatalf("seed evidence session fixture %s: %v", id, err)
	}
	cleanup(t, pool, id)
}

// baseDecisionRecord is a full, real-looking NewDecisionRecord for the tests
// below to start from and override just what they're testing.
// evidenceSessionID must already exist (see seedEvidenceSessionFixture) —
// the column is a real FK, not a free-text label.
func baseDecisionRecord(userID, exerciseID string, workoutID *string, evidenceSessionID string) NewDecisionRecord {
	source := string(ProtocolSourceAthleteConfig)
	coverage := EffortCoverageAll
	return NewDecisionRecord{
		UserID: userID, ExerciseID: exerciseID, WorkoutID: workoutID,
		Engine: EngineProgressV2, RulesetVersion: decisionRulesetVersion,
		ProtocolSource: &source, ProtocolRepRangeLow: ptrInt(5), ProtocolRepRangeHigh: ptrInt(8),
		ProtocolTargetSets: ptrInt(3), ProtocolTargetRIR: ptrF(2),
		EvidenceSessionID: &evidenceSessionID, IncludedSetCount: 3,
		ExcludedSetSummary: map[string]int{"set_type:backoff": 1},
		EffortCoverage:     &coverage, EffortReadingRIR: ptrInt(2),
		OutputCode: string(ProgressAddLoad), OutputReason: "test reason",
		OutputTargetWeightKg: ptrF(102.5), OutputTargetReps: ptrInt(5),
		Warnings:      []string{"in_session_above"},
		OutcomeStatus: OutcomeStatusPending,
	}
}

func TestRecordDecisions_InsertsAndReadsBackEveryField(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	var workoutID, user = "wk-decrec-insert", "user_decrec_insert"
	const evidenceID = "ses-decrec-insert-evidence"
	if err := seedFixtureWorkout(ctx, pool, workoutID, user); err != nil {
		t.Fatalf("seed fixture workout: %v", err)
	}
	cleanupDecisionFixtures(t, pool, workoutID)
	seedEvidenceSessionFixture(t, repo, pool, evidenceID, user)

	rec := baseDecisionRecord(user, exBench, &workoutID, evidenceID)
	if err := repo.RecordDecisions(ctx, []NewDecisionRecord{rec}); err != nil {
		t.Fatalf("RecordDecisions: %v", err)
	}

	var (
		gotEngine, gotRuleset, gotProtocolSource, gotOutputCode, gotOutputReason string
		gotEvidenceSessionID, gotOutcomeStatus, gotEffortCoverage                string
		gotIncludedSetCount, gotProtocolRepLow, gotProtocolRepHigh               int
		gotOutputTargetWeightKg                                                  float64
		gotOutputTargetReps                                                      int
		excludedJSON, warningsJSON                                               []byte
	)
	err := pool.QueryRow(ctx, `
		SELECT engine, ruleset_version, protocol_source, output_code, output_reason,
			evidence_session_id, outcome_status, effort_coverage, included_set_count,
			protocol_rep_range_low, protocol_rep_range_high, output_target_weight_kg,
			output_target_reps, excluded_set_summary, warnings
		FROM session_progression_decisions WHERE user_id = $1 AND exercise_id = $2 AND workout_id = $3`,
		user, exBench, workoutID).Scan(
		&gotEngine, &gotRuleset, &gotProtocolSource, &gotOutputCode, &gotOutputReason,
		&gotEvidenceSessionID, &gotOutcomeStatus, &gotEffortCoverage, &gotIncludedSetCount,
		&gotProtocolRepLow, &gotProtocolRepHigh, &gotOutputTargetWeightKg,
		&gotOutputTargetReps, &excludedJSON, &warningsJSON)
	if err != nil {
		t.Fatalf("read back the inserted row: %v", err)
	}

	if gotEngine != EngineProgressV2 || gotRuleset != decisionRulesetVersion {
		t.Errorf("engine/ruleset_version = %q/%q, want %q/%q", gotEngine, gotRuleset, EngineProgressV2, decisionRulesetVersion)
	}
	if gotProtocolSource != string(ProtocolSourceAthleteConfig) {
		t.Errorf("protocol_source = %q, want %q", gotProtocolSource, ProtocolSourceAthleteConfig)
	}
	if gotOutputCode != string(ProgressAddLoad) || gotOutputReason != "test reason" {
		t.Errorf("output_code/output_reason = %q/%q, want %q/%q", gotOutputCode, gotOutputReason, ProgressAddLoad, "test reason")
	}
	if gotEvidenceSessionID != evidenceID {
		t.Errorf("evidence_session_id = %q, want %q", gotEvidenceSessionID, evidenceID)
	}
	if gotOutcomeStatus != OutcomeStatusPending {
		t.Errorf("outcome_status = %q, want %q", gotOutcomeStatus, OutcomeStatusPending)
	}
	if gotEffortCoverage != EffortCoverageAll {
		t.Errorf("effort_coverage = %q, want %q", gotEffortCoverage, EffortCoverageAll)
	}
	if gotIncludedSetCount != 3 {
		t.Errorf("included_set_count = %d, want 3", gotIncludedSetCount)
	}
	if gotProtocolRepLow != 5 || gotProtocolRepHigh != 8 {
		t.Errorf("protocol_rep_range = [%d,%d], want [5,8]", gotProtocolRepLow, gotProtocolRepHigh)
	}
	if gotOutputTargetWeightKg != 102.5 || gotOutputTargetReps != 5 {
		t.Errorf("output_target = %v/%d, want 102.5/5", gotOutputTargetWeightKg, gotOutputTargetReps)
	}

	var excluded map[string]int
	if err := json.Unmarshal(excludedJSON, &excluded); err != nil {
		t.Fatalf("unmarshal excluded_set_summary: %v", err)
	}
	if excluded["set_type:backoff"] != 1 {
		t.Errorf("excluded_set_summary round-tripped as %v, want set_type:backoff=1", excluded)
	}
	var warnings []string
	if err := json.Unmarshal(warningsJSON, &warnings); err != nil {
		t.Fatalf("unmarshal warnings: %v", err)
	}
	if len(warnings) != 1 || warnings[0] != "in_session_above" {
		t.Errorf("warnings round-tripped as %v, want [\"in_session_above\"]", warnings)
	}
}

// TestRecordDecisions_AbstainedRecordHasNoTargetAndIsNotApplicable pins the
// ticket's own requirement that a no-op result is written too, and that its
// row correctly carries no outcome-tracking obligation.
func TestRecordDecisions_AbstainedRecordHasNoTargetAndIsNotApplicable(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	var workoutID, user = "wk-decrec-abstain", "user_decrec_abstain"
	if err := seedFixtureWorkout(ctx, pool, workoutID, user); err != nil {
		t.Fatalf("seed fixture workout: %v", err)
	}
	cleanupDecisionFixtures(t, pool, workoutID)

	rec := NewDecisionRecord{
		UserID: user, ExerciseID: exSquat, WorkoutID: &workoutID,
		Engine: EngineProgressV2, RulesetVersion: decisionRulesetVersion,
		ExcludedSetSummary: map[string]int{}, Warnings: []string{string(SuggestAbstain)},
		OutputCode: string(SuggestAbstain), OutputReason: "ambiguous evidence",
		OutcomeStatus: OutcomeStatusNotApplicable,
	}
	if err := repo.RecordDecisions(ctx, []NewDecisionRecord{rec}); err != nil {
		t.Fatalf("RecordDecisions: %v", err)
	}

	var status string
	var targetWeight *float64
	err := pool.QueryRow(ctx, `
		SELECT outcome_status, output_target_weight_kg FROM session_progression_decisions
		WHERE user_id = $1 AND exercise_id = $2 AND workout_id = $3`,
		user, exSquat, workoutID).Scan(&status, &targetWeight)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if status != OutcomeStatusNotApplicable {
		t.Errorf("outcome_status = %q, want %q", status, OutcomeStatusNotApplicable)
	}
	if targetWeight != nil {
		t.Errorf("output_target_weight_kg = %v, want nil", *targetWeight)
	}
}

// TestSessionProgressionDecisions_CoreFieldsAreImmutable is the DB-level
// guarantee migration 000093's trigger exists for — see decisionrecord.go's
// own doc comment on what "immutable" protects. Mutation-shaped: this must
// fail, and a version of the trigger that silently allowed the UPDATE would
// make this test fail differently (no error) rather than pass.
func TestSessionProgressionDecisions_CoreFieldsAreImmutable(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	var workoutID, user = "wk-decrec-immutable", "user_decrec_immutable"
	const evidenceID = "ses-decrec-immutable-evidence"
	if err := seedFixtureWorkout(ctx, pool, workoutID, user); err != nil {
		t.Fatalf("seed fixture workout: %v", err)
	}
	cleanupDecisionFixtures(t, pool, workoutID)
	seedEvidenceSessionFixture(t, repo, pool, evidenceID, user)

	rec := baseDecisionRecord(user, exOHP, &workoutID, evidenceID)
	if err := repo.RecordDecisions(ctx, []NewDecisionRecord{rec}); err != nil {
		t.Fatalf("RecordDecisions: %v", err)
	}
	var id int64
	if err := pool.QueryRow(ctx,
		`SELECT id FROM session_progression_decisions WHERE user_id = $1 AND exercise_id = $2 AND workout_id = $3`,
		user, exOHP, workoutID).Scan(&id); err != nil {
		t.Fatalf("find inserted row: %v", err)
	}

	_, err := pool.Exec(ctx,
		`UPDATE session_progression_decisions SET output_code = 'tampered' WHERE id = $1`, id)
	if err == nil {
		t.Fatalf("directly updating output_code succeeded — the immutability trigger did not fire")
	}

	// The one thing that IS allowed to change — proves the trigger is
	// scoped to the core columns, not a blanket "no UPDATE at all" refusal
	// that would also (wrongly) block ResolveDecisionOutcomes/
	// DismissPendingDecisions below.
	if _, err := pool.Exec(ctx,
		`UPDATE session_progression_decisions SET outcome_status = 'dismissed' WHERE id = $1`, id); err != nil {
		t.Errorf("updating outcome_status (the one mutable column) failed: %v", err)
	}
}

func TestResolveDecisionOutcomes_AppliedExactMatchVsEditedDifferentWeight(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	var workoutID, user, sessionID = "wk-decrec-resolve", "user_decrec_resolve", "ses-decrec-resolve"
	const evidenceID = "ses-decrec-resolve-evidence"
	if err := seedFixtureWorkout(ctx, pool, workoutID, user); err != nil {
		t.Fatalf("seed fixture workout: %v", err)
	}
	cleanupDecisionFixtures(t, pool, workoutID)
	cleanup(t, pool, sessionID)
	seedEvidenceSessionFixture(t, repo, pool, evidenceID, user)

	benchRec := baseDecisionRecord(user, exBench, &workoutID, evidenceID)
	benchRec.OutputTargetWeightKg, benchRec.OutputTargetReps = ptrF(100), ptrInt(5)
	squatRec := baseDecisionRecord(user, exSquat, &workoutID, evidenceID)
	squatRec.OutputTargetWeightKg, squatRec.OutputTargetReps = ptrF(150), ptrInt(5)
	if err := repo.RecordDecisions(ctx, []NewDecisionRecord{benchRec, squatRec}); err != nil {
		t.Fatalf("RecordDecisions: %v", err)
	}

	if _, err := repo.Create(ctx, NewSession{
		ID: sessionID, UserID: user, WorkoutID: &workoutID, Sport: "strength",
		StartedAt: time.Now().UTC().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("create session fixture: %v", err)
	}

	sets := []Set{
		// Exact match on both weight and reps: applied.
		{ExerciseID: exBench, SetType: SetTypeWorking, Completed: true, WeightKg: ptrF(100), Reps: ptrInt(5)},
		// Same exercise, a lighter warm-up-shaped set that should NOT win
		// over the heavier one above as the "representative" set.
		{ExerciseID: exBench, SetType: SetTypeWorking, Completed: true, WeightKg: ptrF(60), Reps: ptrInt(10)},
		// Heavier than suggested: edited.
		{ExerciseID: exSquat, SetType: SetTypeWorking, Completed: true, WeightKg: ptrF(155), Reps: ptrInt(5)},
	}
	if err := repo.ResolveDecisionOutcomes(ctx, user, &workoutID, sessionID, sets); err != nil {
		t.Fatalf("ResolveDecisionOutcomes: %v", err)
	}

	var benchStatus, squatStatus string
	var benchWeight, squatWeight float64
	if err := pool.QueryRow(ctx, `
		SELECT outcome_status, outcome_weight_kg FROM session_progression_decisions
		WHERE user_id = $1 AND exercise_id = $2 AND workout_id = $3`,
		user, exBench, workoutID).Scan(&benchStatus, &benchWeight); err != nil {
		t.Fatalf("read back bench: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT outcome_status, outcome_weight_kg FROM session_progression_decisions
		WHERE user_id = $1 AND exercise_id = $2 AND workout_id = $3`,
		user, exSquat, workoutID).Scan(&squatStatus, &squatWeight); err != nil {
		t.Fatalf("read back squat: %v", err)
	}

	if benchStatus != OutcomeStatusApplied {
		t.Errorf("bench outcome_status = %q, want %q", benchStatus, OutcomeStatusApplied)
	}
	if benchWeight != 100 {
		t.Errorf("bench outcome_weight_kg = %v, want 100 (the heaviest completed set, not the 60kg one)", benchWeight)
	}
	if squatStatus != OutcomeStatusEdited {
		t.Errorf("squat outcome_status = %q, want %q", squatStatus, OutcomeStatusEdited)
	}
	if squatWeight != 155 {
		t.Errorf("squat outcome_weight_kg = %v, want 155", squatWeight)
	}
}

// TestResolveDecisionOutcomes_NoopWithoutWorkoutID pins the documented
// scope limit: a freeform session (nil workout_id) has no reliable
// correlation key, so this must change nothing rather than guess.
func TestResolveDecisionOutcomes_NoopWithoutWorkoutID(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	var workoutID, user, sessionID = "wk-decrec-noop", "user_decrec_noop", "ses-decrec-noop"
	const evidenceID = "ses-decrec-noop-evidence"
	if err := seedFixtureWorkout(ctx, pool, workoutID, user); err != nil {
		t.Fatalf("seed fixture workout: %v", err)
	}
	cleanupDecisionFixtures(t, pool, workoutID)
	cleanup(t, pool, sessionID)
	seedEvidenceSessionFixture(t, repo, pool, evidenceID, user)

	rec := baseDecisionRecord(user, exBench, &workoutID, evidenceID)
	rec.OutputTargetWeightKg, rec.OutputTargetReps = ptrF(100), ptrInt(5)
	if err := repo.RecordDecisions(ctx, []NewDecisionRecord{rec}); err != nil {
		t.Fatalf("RecordDecisions: %v", err)
	}
	if _, err := repo.Create(ctx, NewSession{
		ID: sessionID, UserID: user, Sport: "strength", StartedAt: time.Now().UTC().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("create session fixture: %v", err)
	}

	sets := []Set{{ExerciseID: exBench, SetType: SetTypeWorking, Completed: true, WeightKg: ptrF(100), Reps: ptrInt(5)}}
	if err := repo.ResolveDecisionOutcomes(ctx, user, nil, sessionID, sets); err != nil {
		t.Fatalf("ResolveDecisionOutcomes with nil workoutID returned an error, want a silent no-op: %v", err)
	}

	var status string
	if err := pool.QueryRow(ctx, `
		SELECT outcome_status FROM session_progression_decisions
		WHERE user_id = $1 AND exercise_id = $2 AND workout_id = $3`,
		user, exBench, workoutID).Scan(&status); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if status != OutcomeStatusPending {
		t.Errorf("outcome_status = %q, want %q — a nil workoutID call must change nothing", status, OutcomeStatusPending)
	}
}

func TestDismissPendingDecisions_ClosesOutWhatWasNeverResolved(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	var workoutID, user, sessionID = "wk-decrec-dismiss", "user_decrec_dismiss", "ses-decrec-dismiss"
	const evidenceID = "ses-decrec-dismiss-evidence"
	if err := seedFixtureWorkout(ctx, pool, workoutID, user); err != nil {
		t.Fatalf("seed fixture workout: %v", err)
	}
	cleanupDecisionFixtures(t, pool, workoutID)
	cleanup(t, pool, sessionID)
	seedEvidenceSessionFixture(t, repo, pool, evidenceID, user)

	rec := baseDecisionRecord(user, exPullUp, &workoutID, evidenceID)
	rec.OutputTargetWeightKg, rec.OutputTargetReps = ptrF(0), ptrInt(8)
	if err := repo.RecordDecisions(ctx, []NewDecisionRecord{rec}); err != nil {
		t.Fatalf("RecordDecisions: %v", err)
	}
	if _, err := repo.Create(ctx, NewSession{
		ID: sessionID, UserID: user, WorkoutID: &workoutID, Sport: "strength",
		StartedAt: time.Now().UTC().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("create session fixture: %v", err)
	}

	if err := repo.DismissPendingDecisions(ctx, user, &workoutID, sessionID); err != nil {
		t.Fatalf("DismissPendingDecisions: %v", err)
	}

	var status, outcomeSessionID string
	var recordedAt *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT outcome_status, outcome_session_id, outcome_recorded_at FROM session_progression_decisions
		WHERE user_id = $1 AND exercise_id = $2 AND workout_id = $3`,
		user, exPullUp, workoutID).Scan(&status, &outcomeSessionID, &recordedAt); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if status != OutcomeStatusDismissed {
		t.Errorf("outcome_status = %q, want %q", status, OutcomeStatusDismissed)
	}
	if outcomeSessionID != sessionID {
		t.Errorf("outcome_session_id = %q, want %q", outcomeSessionID, sessionID)
	}
	if recordedAt == nil {
		t.Errorf("outcome_recorded_at is nil, want it stamped")
	}
}

// TestDismissPendingDecisions_NeverTouchesANotApplicableRow pins that a
// decision with nothing to apply (an abstain/no_history result) is never
// swept into 'dismissed' — there was nothing for the athlete to act on, so
// 'dismissed' would misreport an ignored suggestion that never existed.
func TestDismissPendingDecisions_NeverTouchesANotApplicableRow(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	var workoutID, user, sessionID = "wk-decrec-dismiss-na", "user_decrec_dismiss_na", "ses-decrec-dismiss-na"
	if err := seedFixtureWorkout(ctx, pool, workoutID, user); err != nil {
		t.Fatalf("seed fixture workout: %v", err)
	}
	cleanupDecisionFixtures(t, pool, workoutID)
	cleanup(t, pool, sessionID)

	rec := NewDecisionRecord{
		UserID: user, ExerciseID: exRun, WorkoutID: &workoutID,
		Engine: EngineProgressV1, RulesetVersion: decisionRulesetVersion,
		ExcludedSetSummary: map[string]int{}, Warnings: []string{},
		OutputCode: string(SuggestNotApplicable), OutcomeStatus: OutcomeStatusNotApplicable,
	}
	if err := repo.RecordDecisions(ctx, []NewDecisionRecord{rec}); err != nil {
		t.Fatalf("RecordDecisions: %v", err)
	}
	if _, err := repo.Create(ctx, NewSession{
		ID: sessionID, UserID: user, WorkoutID: &workoutID, Sport: "strength",
		StartedAt: time.Now().UTC().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("create session fixture: %v", err)
	}

	if err := repo.DismissPendingDecisions(ctx, user, &workoutID, sessionID); err != nil {
		t.Fatalf("DismissPendingDecisions: %v", err)
	}

	var status string
	if err := pool.QueryRow(ctx, `
		SELECT outcome_status FROM session_progression_decisions
		WHERE user_id = $1 AND exercise_id = $2 AND workout_id = $3`,
		user, exRun, workoutID).Scan(&status); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if status != OutcomeStatusNotApplicable {
		t.Errorf("outcome_status = %q, want %q — a not_applicable row must never become dismissed",
			status, OutcomeStatusNotApplicable)
	}
}
