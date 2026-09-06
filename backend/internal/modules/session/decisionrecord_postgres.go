package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// RecordDecisions appends one row per record — see decisionrecord.go for the
// full design and Repository's own doc comment for why this is batched
// rather than one call per exercise. A failure here is reported to the
// caller (Handler.Suggestions decides, and deliberately chooses, to log and
// continue rather than fail the request — see its own comment for why: this
// table is secondary bookkeeping on a path mobile calls after every
// completed set, and must never become a reason the athlete's actual
// suggestion fails to load).
func (r *PostgresRepository) RecordDecisions(ctx context.Context, records []NewDecisionRecord) error {
	if len(records) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for i, rec := range records {
		excludedJSON, err := json.Marshal(rec.ExcludedSetSummary)
		if err != nil {
			return fmt.Errorf("session: marshal excluded_set_summary for record %d: %w", i, err)
		}
		warningsJSON, err := json.Marshal(rec.Warnings)
		if err != nil {
			return fmt.Errorf("session: marshal warnings for record %d: %w", i, err)
		}
		batch.Queue(`
			INSERT INTO session_progression_decisions (
				user_id, exercise_id, workout_id, engine, ruleset_version,
				protocol_source, protocol_rep_range_low, protocol_rep_range_high,
				protocol_target_sets, protocol_target_rir, protocol_equipment_increment_kg,
				protocol_strategy, evidence_session_id, included_set_count,
				excluded_set_summary, effort_coverage, effort_reading_rir, effort_reading_rpe,
				output_code, output_reason, output_target_weight_kg, output_target_reps,
				warnings, outcome_status
			) VALUES (
				$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
			)`,
			rec.UserID, rec.ExerciseID, rec.WorkoutID, rec.Engine, rec.RulesetVersion,
			rec.ProtocolSource, rec.ProtocolRepRangeLow, rec.ProtocolRepRangeHigh,
			rec.ProtocolTargetSets, rec.ProtocolTargetRIR, rec.ProtocolEquipmentIncrementKg,
			rec.ProtocolStrategy, rec.EvidenceSessionID, rec.IncludedSetCount,
			excludedJSON, rec.EffortCoverage, rec.EffortReadingRIR, rec.EffortReadingRPE,
			rec.OutputCode, rec.OutputReason, rec.OutputTargetWeightKg, rec.OutputTargetReps,
			warningsJSON, rec.OutcomeStatus)
	}
	results := r.pool.SendBatch(ctx, batch)
	for i := range records {
		if _, err := results.Exec(); err != nil {
			results.Close() //nolint:errcheck // returning the more useful error
			if t := translatePgError(err); !errors.Is(t, err) {
				return t
			}
			return fmt.Errorf("session: insert decision record %d: %w", i, err)
		}
	}
	return results.Close()
}

// decisionOutcomeCandidate is one exercise's representative logged
// performance, for correlating back to whatever decision record preceded
// it — see ResolveDecisionOutcomes' own doc comment for why the HEAVIEST
// completed set for the exercise is the representative one, not the first or
// the last.
type decisionOutcomeCandidate struct {
	weightKg float64
	reps     *int
}

// ResolveDecisionOutcomes correlates a just-saved set list back to whichever
// pending decision record it answers. A no-op — not an error — when
// workoutID is nil: there is no reliable correlation key for a freeform
// session's suggestions (they may have come from the exercise-detail screen,
// hours or days before, with nothing tying that request to this save), so
// this package does not guess. See docs/decisions/history.md's N513 entry
// for the full reasoning and what is deliberately left uncorrelated as a
// result.
//
// For each exercise with at least one COMPLETED, weighted set in `sets`, the
// representative candidate is the HEAVIEST such set (ties broken by the
// higher rep count) — the same "top set" reasoning Progress/ProgressV2
// themselves use (topSet in progression.go) to decide what a session
// demonstrated, applied here to decide what the athlete actually did versus
// what was suggested.
//
// Resolves the single most recent PENDING decision record for
// (user_id, exercise_id, workout_id) — not every pending one for that
// exercise in the workout's history, so an athlete who fetched suggestions
// several times before logging (session focus, each prior completed set)
// leaves the earlier, superseded fetches at 'pending' rather than marking
// them all resolved. That is a documented, deliberate simplification: only
// the LAST suggestion the athlete actually saw before logging is the one
// whose accuracy this measures.
func (r *PostgresRepository) ResolveDecisionOutcomes(ctx context.Context, userID string, workoutID *string, sessionID string, sets []Set) error {
	if workoutID == nil {
		return nil
	}
	byExercise := map[string]decisionOutcomeCandidate{}
	for _, s := range sets {
		if !s.Completed || s.WeightKg == nil || *s.WeightKg <= 0 {
			continue
		}
		cur, ok := byExercise[s.ExerciseID]
		if !ok || *s.WeightKg > cur.weightKg ||
			(*s.WeightKg == cur.weightKg && s.Reps != nil && (cur.reps == nil || *s.Reps > *cur.reps)) {
			byExercise[s.ExerciseID] = decisionOutcomeCandidate{weightKg: *s.WeightKg, reps: s.Reps}
		}
	}
	if len(byExercise) == 0 {
		return nil
	}

	batch := &pgx.Batch{}
	exerciseIDs := make([]string, 0, len(byExercise))
	for exerciseID, cand := range byExercise {
		exerciseIDs = append(exerciseIDs, exerciseID)
		batch.Queue(`
			UPDATE session_progression_decisions SET
				-- Epsilon rather than exact equality: output_target_weight_kg
				-- is NUMERIC(6,2), and the float64 the athlete's logged
				-- weight round-trips through can land a hair off an exact
				-- match even when the plate loaded is identical — the same
				-- reasoning progression_v2.go's weightCohortEpsilonKg exists
				-- for. Reps are compared exactly: they're small integers,
				-- with no unit-conversion rounding to tolerate.
				outcome_status = CASE
					WHEN abs(output_target_weight_kg - $1::numeric) < 0.01
						AND (output_target_reps IS NULL OR output_target_reps = $2)
					THEN 'applied' ELSE 'edited' END,
				outcome_weight_kg = $1,
				outcome_reps = $2,
				outcome_session_id = $3,
				outcome_recorded_at = now()
			WHERE id = (
				SELECT id FROM session_progression_decisions
				WHERE user_id = $4 AND exercise_id = $5 AND workout_id = $6
					AND outcome_status = 'pending'
				ORDER BY created_at DESC
				LIMIT 1
			)`,
			cand.weightKg, cand.reps, sessionID, userID, exerciseID, workoutID)
	}
	results := r.pool.SendBatch(ctx, batch)
	for i := range exerciseIDs {
		if _, err := results.Exec(); err != nil {
			results.Close() //nolint:errcheck // returning the more useful error
			if t := translatePgError(err); !errors.Is(t, err) {
				return t
			}
			return fmt.Errorf("session: resolve decision outcome for exercise %d: %w", i, err)
		}
	}
	return results.Close()
}

// DismissPendingDecisions closes out every still-'pending' decision record
// for this (user, workout) when the session finishes — the suggestion was
// seen and the athlete never acted on it in a way ResolveDecisionOutcomes
// could already tell. A no-op when workoutID is nil, for the same reason
// ResolveDecisionOutcomes is: no reliable scope to sweep.
func (r *PostgresRepository) DismissPendingDecisions(ctx context.Context, userID string, workoutID *string, sessionID string) error {
	if workoutID == nil {
		return nil
	}
	_, err := r.pool.Exec(ctx, `
		UPDATE session_progression_decisions SET
			outcome_status = 'dismissed',
			outcome_session_id = $1,
			outcome_recorded_at = now()
		WHERE user_id = $2 AND workout_id = $3 AND outcome_status = 'pending'`,
		sessionID, userID, workoutID)
	if err != nil {
		if t := translatePgError(err); !errors.Is(t, err) {
			return t
		}
		return fmt.Errorf("session: dismiss pending decisions: %w", err)
	}
	return nil
}
