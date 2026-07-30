package session

import "math"

// maxEstimableReps bounds where a one-rep-max estimate is worth printing.
//
// Every rep-max formula is a curve fitted to sets near a true maximum, and
// they all diverge badly past about a dozen reps — a set of 20 will happily
// "estimate" a single nobody could lift. Twelve is the conventional ceiling
// and the point beyond which this returns nothing rather than a fiction.
const maxEstimableReps = 12

// EstimateOneRM estimates a one-rep max from a single set, returning false
// when the set can't support one.
//
// **Brzycki, not Epley**, and the reason is the boundary: Epley evaluates a
// true single as 1.033× the weight, so logging a genuine 1RM of 100kg would
// report 103kg — visibly wrong at exactly the moment the number is most
// checkable. Brzycki is w × 36/(37−r), which is w at one rep, and it's more
// conservative through the low-rep range where most heavy sets live.
//
// **Effort is folded in, and this is the part most apps get wrong.** A set of
// 5 with 3 reps left in the tank is not evidence of a 5-rep max; it's a set
// of 5 that could have been 8. VOLA records RIR and RPE per set, so the
// estimate uses reps + reserve rather than reps alone. Without that, stopping
// short would read as a strength loss — and the whole point of logging effort
// is that it changes what the numbers mean.
//
// RIR wins over RPE when both are present: it's the directly observed
// quantity, where RPE is a scale that has to be converted. With neither, the
// set is taken at face value, which under-estimates a submaximal set — the
// honest direction to be wrong in.
func EstimateOneRM(reps int, weightKg float64, rir *int, rpe *float64) (float64, bool) {
	if reps <= 0 || weightKg <= 0 {
		return 0, false
	}

	effective := reps
	switch {
	case rir != nil:
		effective += *rir
	case rpe != nil:
		// RPE 10 is nothing left; each point below is roughly one more rep.
		// Values above 10 are impossible and clamped rather than trusted.
		reserve := int(math.Round(10 - math.Min(*rpe, 10)))
		if reserve > 0 {
			effective += reserve
		}
	}

	if effective > maxEstimableReps {
		return 0, false
	}
	if effective <= 1 {
		// A true single is its own maximum. No formula needed, and applying
		// one here is how estimators end up claiming you lifted more than you
		// did.
		return weightKg, true
	}
	return weightKg * 36 / (37 - float64(effective)), true
}

// BestOneRM returns the highest estimate over a set of performed sets, and
// which set produced it.
//
// The best estimate is *not* simply the heaviest set: 5×100 (112.5kg) beats a
// single at 110. So every qualifying set is evaluated rather than pre-filtered
// by weight, which is also why this lives in Go instead of SQL.
//
// Warm-ups and sets that were never marked done are excluded — the same rule
// Summarise applies, for the same reason: a working maximum estimated off a
// warm-up, or off a set that was planned and skipped, is not a maximum.
func BestOneRM(sets []Set) (float64, *Set, bool) {
	var best float64
	var at *Set
	for i := range sets {
		s := &sets[i]
		if !s.Completed || s.SetType == SetTypeWarmup {
			continue
		}
		if s.Reps == nil || s.WeightKg == nil {
			continue
		}
		est, ok := EstimateOneRM(*s.Reps, *s.WeightKg, s.RIR, s.RPE)
		if !ok || est <= best {
			continue
		}
		best, at = est, s
	}
	return best, at, at != nil
}
