package nutrition

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/dmytro-ch21/vola/backend/internal/platform/energy"
)

// AdjustmentInputs gathers the fortnight of evidence the rule judges, in five
// queries.
//
// Reads `body_checkins` and `body_phases` directly, for the reason
// `TargetInputs` states above: a module here never imports a sibling, and the
// coupling is to the schema — which migrations version — rather than to another
// package's Go API, which nothing does.
func (r *PostgresRepository) AdjustmentInputs(ctx context.Context, userID, on string) (AdjustmentInputs, error) {
	in := AdjustmentInputs{On: on}

	// The target LIVE on the day being judged: the newest row effective on or
	// before it. Same lookup the day screen uses, so the rule cannot judge a
	// target the athlete was never eating to.
	err := r.pool.QueryRow(ctx, `
		SELECT kcal, effective_on::text
		FROM nutrition_targets
		WHERE user_id = $1 AND effective_on <= $2::date
		ORDER BY effective_on DESC
		LIMIT 1`, userID, on).Scan(&in.TargetKcal, &in.TargetEffectiveOn)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return in, fmt.Errorf("nutrition: live target: %w", err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// No target is the ordinary state for a new athlete. Returned as inputs
		// the rule will block on rather than as an error — there is nothing
		// wrong with the request.
		return in, nil
	}

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

	// Every weigh-in in the window, left unaggregated on purpose: the halves
	// are split in Go, where `splitHalves` is tested against the boundary
	// without a database. Aggregating here would move that boundary into SQL
	// and out of reach of those tests.
	rows, err := r.pool.Query(ctx, `
		SELECT measured_on::text, weight_kg
		FROM body_checkins
		WHERE user_id = $1
		  AND weight_kg IS NOT NULL
		  AND measured_on <= $2::date
		  AND measured_on > $2::date - $3::int
		ORDER BY measured_on`, userID, on, AdjustmentWindowDays)
	if err != nil {
		return in, fmt.Errorf("nutrition: weigh-ins: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var w Weighin
		if err := rows.Scan(&w.On, &w.KG); err != nil {
			return in, fmt.Errorf("nutrition: weigh-in row: %w", err)
		}
		in.Weighins = append(in.Weighins, w)
	}
	if err := rows.Err(); err != nil {
		return in, fmt.Errorf("nutrition: weigh-ins: %w", err)
	}

	// Adherence as a QUERY, never a stored counter — the same reasoning
	// `adherence` records: a counter is maintained on every write and silently
	// disagrees with the rows the first time a path forgets to bump it.
	//
	// A day counts when its total clears half the live target. Counting any day
	// with a single row would let a fortnight of near-silence pass the guard
	// that exists to catch exactly that.
	//
	// The bar is the CURRENT target's, applied across the whole window, which
	// would misjudge days eaten under a previous target. It cannot affect a
	// shipped proposal, and the reason is an invariant rather than luck:
	// `MinDaysOnTarget` (14) is not less than `AdjustmentWindowDays` (14), so
	// whenever a proposal is actually produced every day in the window falls
	// after the target took effect. While `too_soon` is blocking, a stale bar
	// can only make `not_logging` appear or vanish in `blocked_by` — cosmetic.
	// **If either constant moves, that stops holding**, and this query needs
	// the target that was live on each day instead.
	err = r.pool.QueryRow(ctx, `
		SELECT count(*)
		FROM (
			SELECT eaten_on
			FROM nutrition_entries
			WHERE user_id = $1
			  AND eaten_on <= $2::date
			  AND eaten_on > $2::date - $3::int
			GROUP BY eaten_on
			HAVING sum(kcal) >= $4::numeric
		) AS logged`, userID, on, AdjustmentWindowDays,
		float64(in.TargetKcal)*LoggedDayKcalShare).Scan(&in.DaysLogged)
	if err != nil {
		return in, fmt.Errorf("nutrition: logged days: %w", err)
	}

	// The resting floor's input.
	//
	// Computed HERE rather than handed to `ProposeAdjustment` as a profile,
	// so that file stays free of `energy` and remains testable with nothing but
	// numbers. A profile too coarse to price is left at zero, which the rule
	// reads as "no floor" — the right failure, because `energy`'s fallback
	// baseline runs 20-30% high and a floor built on it would sit ABOVE many
	// athletes' real targets and block every legitimate reduction.
	var prof energy.Profile
	err = r.pool.QueryRow(ctx, `
		SELECT p.height_cm,
		       to_char(p.date_of_birth, 'YYYY-MM-DD'),
		       p.sex,
		       c.weight_kg
		FROM profiles p
		LEFT JOIN LATERAL (
			SELECT weight_kg FROM body_checkins
			WHERE user_id = p.user_id AND weight_kg IS NOT NULL AND measured_on <= $2::date
			ORDER BY measured_on DESC LIMIT 1
		) c ON true
		WHERE p.user_id = $1`, userID, on).
		Scan(&prof.HeightCM, &prof.DateOfBirth, &prof.Sex, &prof.WeightKG)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return in, fmt.Errorf("nutrition: profile for the resting floor: %w", err)
	}
	if energy.PrecisionOf(prof) == energy.PrecisionEstimated {
		if rmr, ok := energy.RestingPerDay(prof); ok {
			in.RMRKcal = rmr
		}
	}

	return in, nil
}
