package nutrition

import (
	"context"
	"errors"
	"fmt"

	"github.com/dmytro-ch21/vola/backend/internal/platform/energy"
	"github.com/jackc/pgx/v5"
)

// TargetInputs gathers everything the derivation needs, in three queries.
//
// # Why this reads other modules' tables directly
//
// nutrition needs the profile, the latest weight, the live phase and the last
// four weeks of training. Three of those belong to `profile` and `body`, and a
// module in this codebase never imports a sibling — sessioncard set the
// precedent by reading `profiles` and `body_checkins` by SQL for exactly the
// same reason. The coupling is to the SCHEMA, which migrations version, rather
// than to another package's Go API, which nothing does.
func (r *PostgresRepository) TargetInputs(ctx context.Context, userID, on string) (Inputs, error) {
	in := Inputs{On: on}

	// The weight is the latest check-in ON OR BEFORE the day being derived for,
	// not simply the newest. That is what makes re-deriving an old target
	// reproducible rather than quietly using today's body.
	err := r.pool.QueryRow(ctx, `
		SELECT p.height_cm,
		       to_char(p.date_of_birth, 'YYYY-MM-DD'),
		       p.sex,
		       c.weight_kg,
		       c.measured_on::text
		FROM profiles p
		LEFT JOIN LATERAL (
			SELECT weight_kg, measured_on FROM body_checkins
			WHERE user_id = p.user_id AND weight_kg IS NOT NULL AND measured_on <= $2::date
			ORDER BY measured_on DESC LIMIT 1
		) c ON true
		WHERE p.user_id = $1`, userID, on).
		Scan(&in.HeightCM, &in.DateOfBirth, &in.Sex, &in.WeightKG, &weightOn{&in})
	if errors.Is(err, pgx.ErrNoRows) {
		// No profile at all is a legitimate state, not an error: a brand-new
		// athlete asking what they should eat gets told which fields to fill
		// in, the same way an absent bodyweight is handled.
		return in, nil
	}
	if err != nil {
		return in, fmt.Errorf("nutrition: target inputs: %w", err)
	}

	// The live phase. At most one by construction — body_phases carries a
	// partial unique index on (user_id) WHERE ended_on IS NULL — so this cannot
	// silently pick between two.
	var kind *string
	err = r.pool.QueryRow(ctx, `
		SELECT kind, target_on::text, target_weight_kg
		FROM body_phases
		WHERE user_id = $1 AND ended_on IS NULL`, userID).
		Scan(&kind, &in.PhaseTargetOn, &in.PhaseTargetWeightKG)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return in, fmt.Errorf("nutrition: live phase: %w", err)
	}
	if kind != nil {
		in.PhaseKind = PhaseKind(*kind)
	}
	// No live phase leaves PhaseKind empty, which targetRate reads as
	// maintenance — see phaseOrMaintenance. Holding weight is the right default
	// for somebody who has not said what they are doing.

	if err := r.trainingLoad(ctx, userID, on, &in); err != nil {
		return in, err
	}
	return in, nil
}

// weightOn lets the weight and its date be scanned in the same row without a
// second nullable string variable escaping into Inputs when the LEFT JOIN
// misses. A missing check-in leaves WeightMeasuredOn empty rather than "".
type weightOn struct{ in *Inputs }

func (w *weightOn) Scan(src any) error {
	if src == nil {
		w.in.WeightMeasuredOn = ""
		return nil
	}
	if s, ok := src.(string); ok {
		w.in.WeightMeasuredOn = s
		return nil
	}
	return fmt.Errorf("nutrition: unexpected measured_on %T", src)
}

// trainingLoad averages the NET cost of the trailing window's sessions.
//
// Flat over TrainingWindowDays rather than per-day: per-day cycling needs
// tomorrow's schedule, which does not exist yet, and a target that moved with
// yesterday's training would make the observed weekly rate unreadable — you
// could no longer tell a bad week of eating from a moved goalpost.
//
// Every session is priced through the SAME energy.Estimate the session card
// uses, with the same block builders, so the number an athlete sees on a card
// and the number inside their target cannot disagree.
func (r *PostgresRepository) trainingLoad(ctx context.Context, userID, on string, in *Inputs) error {
	// `ss.completed AND ss.set_type <> 'warmup'` is `session.SQLWorkingSet`,
	// inlined rather than imported because a module never imports a sibling —
	// sessioncard's calorie query does the same and says so. The wider rule is
	// deliberate: this count is a DENSITY proxy for energy.StrengthBlocks, not
	// a number anybody reads, so back-offs and drops belong in it.
	//
	// The first draft of this query filtered on a `warmup` boolean column that
	// does not exist. It compiled, because Go does not type-check SQL — which
	// is why the integration test below is the thing that actually proves this
	// query runs at all.
	rows, err := r.pool.Query(ctx, `
		SELECT s.sport,
		       EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 60.0 AS minutes,
		       b.rounds, b.round_minutes,
		       (SELECT count(*) FROM session_sets ss
		         WHERE ss.session_id = s.id
		           AND ss.completed AND ss.set_type <> 'warmup')
		FROM sessions s
		LEFT JOIN bjj_session_details b ON b.session_id = s.id
		WHERE s.user_id = $1
		  AND s.ended_at IS NOT NULL
		  AND s.ended_at >= ($2::date - ($3::int - 1))
		  AND s.ended_at < ($2::date + 1)`,
		userID, on, TrainingWindowDays)
	if err != nil {
		return fmt.Errorf("nutrition: training load: %w", err)
	}
	defer rows.Close()

	// The profile is rebuilt here rather than reusing the one being assembled,
	// because Estimate needs it as energy.Profile and the conversion is the
	// only place the two shapes meet.
	p := energy.Profile{
		WeightKG:    in.WeightKG,
		HeightCM:    in.HeightCM,
		DateOfBirth: in.DateOfBirth,
		Sex:         in.Sex,
	}

	total := 0.0
	count := 0
	for rows.Next() {
		var sport string
		var minutes *float64
		var rounds, roundMinutes, workingSets *int
		if err := rows.Scan(&sport, &minutes, &rounds, &roundMinutes, &workingSets); err != nil {
			return fmt.Errorf("nutrition: training load: %w", err)
		}
		count++
		if minutes == nil || *minutes <= 0 {
			// A session with no duration contributes nothing rather than a
			// guess. It still counts toward TrainingSessions, so a history full
			// of them shows up as sessions-with-no-load rather than as no
			// history at all.
			continue
		}
		var blocks []energy.Block
		if sport == "bjj" {
			blocks = energy.MatBlocks(*minutes, deref(rounds), deref(roundMinutes))
		} else {
			// Conservative on purpose: without set-level detail this is
			// energy's default multi-exercise MET, which is the lowest of the
			// strength options. Under-counting training makes the target
			// SMALLER, which is the safe direction for the failure — the
			// opposite mistake feeds an athlete for work they did not do.
			blocks = energy.StrengthBlocks(*minutes, deref(workingSets), true, false)
		}
		if kcal, ok := energy.Estimate(p, blocks); ok {
			total += kcal
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("nutrition: training load: %w", err)
	}

	in.TrainingSessions = count
	in.TrainingDaysCovered = TrainingWindowDays
	in.TrainingKcalPerDay = total / float64(TrainingWindowDays)
	return nil
}

func deref(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}
