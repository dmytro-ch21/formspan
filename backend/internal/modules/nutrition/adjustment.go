package nutrition

import (
	"math"
	"sort"
)

// The weekly target adjustment rule.
//
// # What it is for
//
// `target.go` derives a target from Mifflin–St Jeor and Wishnofsky's 7700
// kcal/kg. Both are approximations, and `kcalPerKG`'s own comment says so:
// it ignores adaptive thermogenesis, so a target built on it drifts optimistic
// over a phase. This file is the correction, and it corrects from what actually
// happened to the athlete's weight rather than from a better constant.
//
// # A proposal, never an application
//
// Nothing here writes. The endpoint returns a proposal with its arithmetic
// attached; accepting it is an ordinary `PUT /v1/nutrition/targets/{date}` with
// `source: "adjustment"`. That is the same posture as the AI meal draft and the
// project's auditable-recommendations principle — and it is also what makes
// declining free, since a decline is simply not sending the PUT. **No stored
// dismissal**: it would be stale the moment the next check-in landed, and the
// 14-day cooldown below is already derivable from target history.
//
// # No scheduler
//
// This repo has no cron and must not grow one for this. The rule is evaluated
// when somebody asks, from rows that already exist.
//
// # The guards ARE the feature
//
// A proposal from thin evidence is worse than no proposal: it moves how much
// somebody eats on the strength of a number nobody recorded. Each guard below
// answers "is this measuring intake, or is it measuring a gap in the data".

// AdjustmentWindowDays is the evidence window: two 7-day halves compared.
const AdjustmentWindowDays = 14

// The guards, as thresholds rather than as scattered literals.
const (
	// MinLoggedDays of AdjustmentWindowDays must have real intake on them.
	// Ten of fourteen tolerates a couple of missed days without accepting a
	// week of silence as evidence.
	MinLoggedDays = 10

	// LoggedDayKcalShare is what counts as a logged day: at least half the
	// target's calories. A day with one apple on it is not a record of eating,
	// and counting it would let a fortnight of near-silence clear the bar above.
	LoggedDayKcalShare = 0.5

	// MinWeighinsPerHalf must hold in EACH 7-day half, not across the window.
	// Four is deliberately stricter than the 3 `MinTrendReadings` the displayed
	// trend needs, because this number moves food rather than a chart, and
	// because seven readings bunched in one half would otherwise pass while
	// telling you nothing about the change between them.
	MinWeighinsPerHalf = 4

	// MinDaysOnTarget before a target may be judged. A week after a change is
	// measuring the water shift the change caused, not the change. This
	// doubles as the cooldown — no separate state to store or expire.
	MinDaysOnTarget = 14

	// DeadbandFractionPerWeek is roughly the noise floor of a 7-day trend.
	// Inside it, the honest answer is that nothing is distinguishable.
	DeadbandFractionPerWeek = 0.0025

	// The step size: whichever of these is smaller, so a wrong adjustment costs
	// a fortnight rather than a phase.
	MaxStepKcal     = 250
	MaxStepFraction = 0.10
)

// Why a proposal was withheld. Every one of these is a NORMAL state, not an
// error — the endpoint returns 200 with `adjustment: null` and these attached,
// because the client's job is to say what is missing, not to retry.
const (
	BlockedNoTarget    = "no_target"
	BlockedNoPhase     = "no_phase"
	BlockedTooSoon     = "too_soon"
	BlockedNotLogging  = "not_logging"
	BlockedNotWeighing = "not_weighing"
	BlockedOnTrack     = "on_track"
)

// Weighin is one reading, as the repository read it.
type Weighin struct {
	On string  `json:"on"`
	KG float64 `json:"kg"`
}

// AdjustmentInputs is everything the rule needs, gathered once by the caller.
//
// Same shape as `Inputs`: no context, no clock, no SQL — `On` is passed in, so
// this whole file is testable without a database and cannot disagree with
// itself about what day it is.
type AdjustmentInputs struct {
	// On is today, "YYYY-MM-DD".
	On string

	// The live target, and the day it took effect.
	TargetKcal        int
	TargetEffectiveOn string

	// The live phase. Empty kind means none is running.
	PhaseKind           PhaseKind
	PhaseTargetOn       *string
	PhaseTargetWeightKG *float64

	// Weighins within the window, any order.
	Weighins []Weighin

	// DaysLogged is how many days in the window cleared LoggedDayKcalShare.
	//
	// A COUNT computed by query, never a stored counter — the same reasoning
	// `adherence` records: a counter has to be maintained on every write and
	// silently disagrees with the rows the moment one path forgets.
	DaysLogged int

	// RMRKcal is the floor's input. The proposal may never go below
	// RMRKcal * 1.1, whatever the arithmetic says.
	RMRKcal float64
}

// AdjustmentBasis is the arithmetic, rendered as the explanation.
type AdjustmentBasis struct {
	ObservedKGPerWeek  float64 `json:"observed_kg_per_week"`
	ObservedPctPerWeek float64 `json:"observed_pct_per_week"`
	TargetKGPerWeek    float64 `json:"target_kg_per_week"`
	TargetPctPerWeek   float64 `json:"target_pct_per_week"`

	// TrendWeightKG is the recent half's mean — the same statistic the check-in
	// card draws, so the two cannot tell different stories about one athlete.
	TrendWeightKG       float64 `json:"trend_weight_kg"`
	EarlierTrendKG      float64 `json:"earlier_trend_weight_kg"`
	WeighinsRecent      int     `json:"weighins_recent_half"`
	WeighinsEarlier     int     `json:"weighins_earlier_half"`
	DaysLogged          int     `json:"days_logged"`
	DaysConsidered      int     `json:"days_considered"`
	DaysOnCurrentTarget int     `json:"days_on_current_target"`

	KcalPerKG float64 `json:"kcal_per_kg"`
	// RawDeltaKcal is what the arithmetic asked for, before the step cap and
	// the floor. Shown so a capped proposal reads as "we stopped here" rather
	// than as arithmetic whose last line does not follow.
	RawDeltaKcal int    `json:"raw_delta_kcal"`
	Capped       bool   `json:"capped"`
	CapReason    string `json:"cap_reason,omitempty"`
	Relaxed      string `json:"relaxed,omitempty"`

	ProteinGPerKG float64 `json:"protein_g_per_kg"`
	FatGPerKG     float64 `json:"fat_g_per_kg"`
}

// Adjustment is the proposal.
type Adjustment struct {
	FromKcal  int `json:"from_kcal"`
	ToKcal    int `json:"to_kcal"`
	DeltaKcal int `json:"delta_kcal"`

	ProteinG int `json:"protein_g"`
	CarbG    int `json:"carb_g"`
	FatG     int `json:"fat_g"`
	FibreG   int `json:"fibre_g"`

	// EffectiveOn is the day the proposal would take effect if accepted:
	// TOMORROW, never today. A target applied retroactively would judge a day
	// the athlete has already eaten most of, and the day's remaining figure
	// would jump under them.
	EffectiveOn string `json:"effective_on"`

	Basis *AdjustmentBasis `json:"basis"`
}

// ProposeAdjustment returns a proposal, or nil plus the reasons it was withheld.
//
// Never an error and never a write. A nil proposal with reasons is the ordinary
// outcome for most athletes on most days, which is why it is a 200.
func ProposeAdjustment(in AdjustmentInputs) (*Adjustment, []string) {
	var blocked []string

	if in.TargetKcal <= 0 || in.TargetEffectiveOn == "" {
		// Nothing to adjust FROM. Reported alone: every other guard is a
		// statement about a target that does not exist.
		return nil, []string{BlockedNoTarget}
	}

	daysOn := daysBetween(in.TargetEffectiveOn, in.On)
	if daysOn < MinDaysOnTarget {
		blocked = append(blocked, BlockedTooSoon)
	}
	if in.DaysLogged < MinLoggedDays {
		blocked = append(blocked, BlockedNotLogging)
	}

	recent, earlier := splitHalves(in.Weighins, in.On)
	if len(recent) < MinWeighinsPerHalf || len(earlier) < MinWeighinsPerHalf {
		blocked = append(blocked, BlockedNotWeighing)
	}

	kind := phaseOrMaintenance(in.PhaseKind)
	if in.PhaseKind == "" {
		blocked = append(blocked, BlockedNoPhase)
	}

	// Everything above is about EVIDENCE. Below needs the numbers, so bail
	// first — computing a rate from two empty halves divides by nothing.
	if len(blocked) > 0 {
		return nil, blocked
	}

	trend := mean(recent)
	earlierTrend := mean(earlier)

	// The halves' means sit one week apart, so their difference IS the weekly
	// rate. No division by a day count that would have to guess at gaps.
	observedKG := trend - earlierTrend
	observedFraction := 0.0
	if earlierTrend > 0 {
		observedFraction = observedKG / earlierTrend
	}

	targetFraction, targetKG := targetRate(Inputs{
		On:                  in.On,
		PhaseKind:           kind,
		PhaseTargetOn:       in.PhaseTargetOn,
		PhaseTargetWeightKG: in.PhaseTargetWeightKG,
	}, trend)
	// No "rate could not be derived" branch, deliberately, and the first draft
	// of this file had one. `makingWeightRate` falls back to the cut midpoint
	// when the date or target weight is missing, so a rate is ALWAYS derivable;
	// the only way to reach zero on a making_weight phase is having already
	// made the weight, which is a legitimate instruction to hold. A guard there
	// would have blocked exactly the athlete it claimed to protect, for a
	// reason its own comment misdescribed.

	if math.Abs(observedFraction-targetFraction) <= DeadbandFractionPerWeek {
		return nil, []string{BlockedOnTrack}
	}

	// The correction. Losing SLOWER than target (gap positive) means eating
	// less, so the delta carries the opposite sign to the gap.
	gapKG := observedKG - targetKG
	rawDelta := -gapKG * kcalPerKG / 7

	basis := &AdjustmentBasis{
		ObservedKGPerWeek:   round2(observedKG),
		ObservedPctPerWeek:  round4(observedFraction),
		TargetKGPerWeek:     round2(targetKG),
		TargetPctPerWeek:    round4(targetFraction),
		TrendWeightKG:       round2(trend),
		EarlierTrendKG:      round2(earlierTrend),
		WeighinsRecent:      len(recent),
		WeighinsEarlier:     len(earlier),
		DaysLogged:          in.DaysLogged,
		DaysConsidered:      AdjustmentWindowDays,
		DaysOnCurrentTarget: daysOn,
		KcalPerKG:           kcalPerKG,
		RawDeltaKcal:        roundTo10(rawDelta),
	}

	delta, capped, reason := capStep(rawDelta, in.TargetKcal)
	to := in.TargetKcal + delta

	if floor := in.RMRKcal * 1.1; in.RMRKcal > 0 && float64(to) < floor {
		// Rounded UP, not to nearest. `roundTo10` would put a floor of 1874 at
		// 1870 — four calories under the number this branch exists to hold, on
		// the one rail whose whole purpose is being a lower bound. A floor that
		// rounds downward is not a floor.
		to = ceilTo10(floor)
		delta = to - in.TargetKcal
		capped, reason = true, "held at 10% above resting metabolic rate"
	}
	basis.Capped, basis.CapReason = capped, reason

	// Macros come from the SAME function the derivation uses, so a target
	// reached by adjustment and one reached by derivation cannot split protein
	// and fat differently for the same athlete at the same calories.
	m := macros(to, trend, isDeficit(targetFraction), &Basis{})
	basis.ProteinGPerKG = m.Basis.ProteinGPerKG
	basis.FatGPerKG = m.Basis.FatGPerKG
	basis.Relaxed = m.Basis.Relaxed

	return &Adjustment{
		FromKcal:    in.TargetKcal,
		ToKcal:      to,
		DeltaKcal:   delta,
		ProteinG:    m.ProteinG,
		CarbG:       m.CarbG,
		FatG:        m.FatG,
		FibreG:      m.FibreG,
		EffectiveOn: dayAfter(in.On),
		Basis:       basis,
	}, nil
}

// capStep bounds one move to whichever of the two limits is tighter.
func capStep(raw float64, current int) (delta int, capped bool, reason string) {
	limit := math.Min(MaxStepKcal, float64(current)*MaxStepFraction)
	switch {
	case raw > limit:
		return roundTo10(limit), true, "increase capped to one step"
	case raw < -limit:
		return -roundTo10(limit), true, "decrease capped to one step"
	}
	return roundTo10(raw), false, ""
}

// splitHalves puts each reading in the recent or earlier 7 days of the window,
// and discards anything older. Readings on the same day are all kept: two
// weigh-ins on one morning are two readings of that morning, and dropping one
// would be choosing which.
func splitHalves(all []Weighin, on string) (recent, earlier []Weighin) {
	sorted := append([]Weighin(nil), all...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].On < sorted[j].On })
	for _, w := range sorted {
		age := daysBetween(w.On, on)
		switch {
		case age < 0:
			// A future-dated reading. Not this rule's to reject, but not
			// evidence about the past fortnight either.
		case age < TrendDays:
			recent = append(recent, w)
		case age < AdjustmentWindowDays:
			earlier = append(earlier, w)
		}
	}
	return recent, earlier
}

// ceilTo10 rounds up to the next multiple of ten, so a bound stays a bound
// while still obeying the module's coarse-rounding rule.
func ceilTo10(v float64) int { return int(math.Ceil(v/10) * 10) }

// dayAfter is the next calendar day.
//
// Uses time arithmetic on a parsed date rather than string surgery, so month
// and year ends are the calendar's problem. A malformed date returns itself,
// which the handler turns into no proposal rather than a target dated to the
// zero year.
func dayAfter(on string) string {
	t, err := parseDay(on)
	if err != nil {
		return on
	}
	return t.AddDate(0, 0, 1).Format("2006-01-02")
}

func mean(ws []Weighin) float64 {
	if len(ws) == 0 {
		return 0
	}
	var sum float64
	for _, w := range ws {
		sum += w.KG
	}
	return sum / float64(len(ws))
}
