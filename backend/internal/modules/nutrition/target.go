// Calorie and macro targets, derived from what the athlete is already doing.
//
// # Why this computes on the server when the body module deliberately does not
//
// `body`'s rule is that the numbers a LOGGING screen renders must be computed
// on the client, because a bathroom scale is where the signal is worst. A
// target is a different animal: it is set once a month, online, and its
// dominant input is training expenditure aggregated across every session in the
// last four weeks — which the phone does not hold and would have to fetch.
//
// Mirroring Mifflin–St Jeor into TypeScript to avoid that would create a second
// copy of arithmetic that decides how much somebody eats. `check:grip-parity`
// exists in this repo because a vocabulary reached three copies and drifted;
// this would be the same shape with worse consequences. One implementation,
// server-side, and the endpoint returns the inputs alongside the answer so the
// client can render the explanation without owning the maths.
//
// # Everything here is pure
//
// No context, no SQL, no time.Now(). The caller passes the day. That is what
// lets every branch below be table-tested with no database, so it runs on every
// CI pass rather than only where TEST_DATABASE_URL is set.
package nutrition

import (
	"fmt"
	"math"
	"time"
)

// Activity is the NEAT multiplier — everything the athlete does that is NOT
// their logged training.
//
// **The vocabulary is truncated on purpose and this is the single easiest thing
// to get wrong here.** Textbook Harris/Mifflin multipliers run 1.2–1.9 and
// already INCLUDE exercise. Using 1.55 for "moderately active" and then adding
// the trailing training average double-counts every mat class — roughly 300–500
// kcal/day for a BJJ athlete, in the direction that makes a cut silently not
// happen. So the ladder stops at 1.45, which is an on-your-feet job and no
// more, and the training term is added separately where it can be audited.
type Activity string

const (
	ActivitySedentary Activity = "sedentary"
	ActivityLight     Activity = "light"
	ActivityActive    Activity = "active"
)

var Activities = []Activity{ActivitySedentary, ActivityLight, ActivityActive}

// ActivityFactors are NEAT-only. See the type doc before raising any of them.
var ActivityFactors = map[Activity]float64{
	ActivitySedentary: 1.20,
	ActivityLight:     1.30,
	ActivityActive:    1.45,
}

func (a Activity) valid() bool {
	_, ok := ActivityFactors[a]
	return ok
}

// ResolveActivity picks the level a derivation runs at, and says whether the
// athlete actually chose it.
//
// Three inputs collapse to one answer, in this order:
//
//  1. `asked` — an explicit `?activity=` on the request. A client previewing
//     "what if I had a desk job" must get that derivation without first writing
//     the choice to the account, so the parameter wins.
//  2. `stored` — the athlete's saved `profiles.activity_level`.
//  3. ActivityLight — the documented default.
//
// The second return is the whole reason this is a function rather than three
// lines inline. Without it the response cannot distinguish a derivation the
// athlete's own choice produced from one an assumption produced, and every
// client then has to render a filled pill for a decision nobody made. That is
// the half of N93 a plain persistence fix would have missed.
//
// **Every input is validated HERE as well as at the caller, and that
// redundancy is deliberate.** The handler already rejects an unknown `asked`
// with a 400, which is the right answer for a request nobody should be making;
// but this function is exported, and a second caller that forgot the guard
// would otherwise echo an out-of-vocabulary level back with
// `activity_chosen: true`.
//
// That failure is quiet in the worst way. `Suggest` coerces an invalid activity
// to ActivityLight on its own, so nothing looks broken: the athlete gets a
// perfectly plausible number derived at `light`, while the response tells their
// client they chose a level it cannot even render. A guard one call site away
// from the thing it protects is a guard waiting to be bypassed — raised in
// review, and worth the four lines.
func ResolveActivity(asked string, stored *Activity) (Activity, bool) {
	if a := Activity(asked); a.valid() {
		return a, true
	}
	if stored != nil && stored.valid() {
		return *stored, true
	}
	return ActivityLight, false
}

// PhaseKind mirrors body_phases.kind.
//
// Declared here rather than imported: a module never imports a sibling in this
// codebase, and nutrition reads body_phases by SQL the way sessioncard reads
// profiles. The database's CHECK constraint is what keeps the two spellings
// honest; an unknown value here falls through to maintenance rather than
// guessing, so a phase kind added later under-feeds nothing.
type PhaseKind string

const (
	PhaseCut           PhaseKind = "cut"
	PhaseLeanBulk      PhaseKind = "lean_bulk"
	PhaseRecomposition PhaseKind = "recomposition"
	PhaseMaintenance   PhaseKind = "maintenance"
	PhaseMakingWeight  PhaseKind = "making_weight"
)

// RateBand is a target rate as a FRACTION OF BODY MASS PER WEEK, stored as a
// positive magnitude with the sign applied per phase below.
//
// **The magnitudes are a mirror of `RATE_TARGETS` in
// apps/mobile/lib/anthropometry.ts and `scripts/check-rate-parity.py` fails the
// build if the two drift.** Storing magnitudes and signing them once is the TS
// file's decision, kept deliberately: a cut's rate is negative, so writing the
// comparison inline gets it inverted, and an inverted comparison here proposes
// MORE food to somebody already losing too fast while every number on screen
// still looks plausible.
type RateBand struct{ Min, Max float64 }

// RateTargets is the evidence-based band per phase. Cut: Garthe et al. (2011)
// — elite athletes at ~0.7%/week held lean mass where ~1.4%/week did not. Lean
// bulk is tighter because past ~0.5%/week the surplus outruns what muscle can
// be built from. making_weight has no band: the rate comes from the deadline.
var RateTargets = map[PhaseKind]*RateBand{
	PhaseCut:           {Min: 0.005, Max: 0.01},
	PhaseLeanBulk:      {Min: 0.0025, Max: 0.005},
	PhaseRecomposition: {Min: -0.0025, Max: 0.0025},
	PhaseMaintenance:   {Min: -0.0025, Max: 0.0025},
	PhaseMakingWeight:  nil,
}

// Mirrored from anthropometry.ts and checked by check-rate-parity.py. Unused by
// the derivation itself — they belong to the adjustment rule (N24) and to the
// trend the client draws — but they live here so the parity check has one Go
// home to compare against rather than hunting them across files later.
const (
	TrendDays        = 7
	MinTrendReadings = 3
	MinRateDays      = 7
)

// kcalPerKG is Wishnofsky's 3500 kcal/lb, and it is an approximation that
// OVERESTIMATES long-run loss: it ignores adaptive thermogenesis and treats
// every kilogram lost as pure fat. A target built on it drifts optimistic over
// a phase — which is precisely why the weekly adjustment rule exists rather
// than being a nice-to-have. Do not "correct" this constant; correct the target
// from observed weight change, which is what actually happened.
const kcalPerKG = 7700.0

// Clamps, in the order they are applied. Each exists to stop the arithmetic
// producing a number that is internally consistent and physiologically wrong.
const (
	// Never below the athlete's own resting rate. Exactly 1.0, and the margin
	// that used to sit on top of it was removed for the same reason the
	// deficit cap moved: at 1.1 it bound on the reference athlete, whose
	// 1954 kcal target on a standard 0.75%/week cut is one any coach would
	// sign off. A rail that fires on the ordinary case is not protecting
	// anybody, it is just noise in the explanation.
	//
	// Resting itself is the line worth defending and the one an athlete
	// recognises — "we will not propose less than your body burns lying
	// still" is a sentence that means something. A multiplier above it is a
	// safety factor invented on top of a rule that is already conservative,
	// and inventing one here would be exactly the unevidenced second opinion
	// the deficit-cap comment warns about.
	minKcalOverResting = 1.0
	// 30%, and the number was moved UP from 25% because a hand-worked test
	// showed 25% firing on the ordinary case: an 80 kg lightly-active athlete
	// on the evidence-based cut midpoint needs a 25.2% deficit, because the
	// rate scales with bodyweight while TDEE scales sub-linearly with it (RMR
	// carries height and age terms that do not). A rail that routinely
	// overrides Garthe et al. is not a rail, it is a second opinion with no
	// evidence behind it — and one that fires constantly teaches everyone to
	// ignore it. This catches proportional absurdity; minKcalOverResting above
	// catches absolute absurdity, and that is the harder of the two.
	maxDeficitFraction = 0.30
	maxSurplusFraction = 0.20
)

// Macro rules, with their sources.
const (
	// Morton et al. 2018 (BJSM meta-analysis, 49 studies) finds the benefit of
	// added protein plateaus at ~1.62 g/kg/day with a confidence interval
	// reaching 2.2. The upper end is the defensible choice in a deficit, where
	// protein is doing double duty preserving lean mass (Helms et al. 2014).
	//
	// Scaled to BODYWEIGHT, not fat-free mass, deliberately. FFM would be the
	// better denominator but needs a body-fat estimate, and `navyBodyFat` lives
	// client-side — porting it would be a second copy of a formula for a
	// second-order refinement. Revisit if body fat ever reaches the server.
	proteinDeficitGPerKG = 2.2
	proteinDefaultGPerKG = 1.8
	proteinFloorGPerKG   = 1.6

	// Fat has two floors and both bind: an absolute g/kg floor for essential
	// fatty acids, and a share of total energy for hormonal function. A very
	// large athlete on a small target can satisfy one and violate the other.
	fatGPerKG       = 0.8
	fatFloorGPerKG  = 0.5
	fatMinKcalShare = 0.20

	// US Dietary Guidelines: 14 g per 1000 kcal. Advisory — a target the
	// athlete is not failing against if they miss it.
	fibreGPer1000Kcal = 14.0
)

// Inputs is everything the derivation needs, gathered by one repository query.
//
// Every field is what it says at a moment in time: the weight is the latest
// check-in ON OR BEFORE the day being derived for, not the newest one, so
// re-deriving an old target is reproducible.
type Inputs struct {
	// On is the day the target takes effect, "YYYY-MM-DD".
	On string

	WeightKG         *float64
	WeightMeasuredOn string
	HeightCM         *float64
	DateOfBirth      *string
	Sex              *string

	// ActivityLevel is the athlete's stored daily-movement choice, or nil when
	// they have never made one.
	//
	// Nil is not "sedentary" and not "light" — it is the absence of an answer,
	// and the handler turns it into the documented default while telling the
	// client that is what happened. Collapsing the two here would take away the
	// clients' only way to render an assumption as an assumption.
	ActivityLevel *Activity

	// Phase is the live body_phases row, empty when none is running.
	PhaseKind           PhaseKind
	PhaseTargetOn       *string
	PhaseTargetWeightKG *float64

	// TrainingKcalPerDay is the trailing average of NET session cost.
	//
	// Amortised FLAT over the window rather than applied per-day: per-day
	// cycling needs tomorrow's schedule, which does not exist yet, and a target
	// that moved with yesterday's training would make the observed weekly rate
	// unreadable — you could no longer tell a bad week of eating from a moved
	// goalpost.
	TrainingKcalPerDay  float64
	TrainingDaysCovered int
	TrainingSessions    int
}

// TrainingWindowDays is the trailing window the training average is taken over.
//
// 28 rather than 14 because BJJ attendance is lumpy — one holiday week distorts
// a fortnight badly enough to move a target by a few hundred kcal. The window
// is reported in the Basis so a thin history is visible rather than silently
// flattering.
const TrainingWindowDays = 28

// Basis is the arithmetic, every line of which the UI renders as one row of the
// explanation. Frozen onto the target row when the athlete accepts it.
type Basis struct {
	RMRKcal      int     `json:"rmr_kcal"`
	RMRPrecision string  `json:"rmr_precision"`
	WeightKG     float64 `json:"weight_kg"`
	WeightOn     string  `json:"weight_measured_on"`

	Activity       Activity `json:"activity"`
	ActivityFactor float64  `json:"activity_factor"`
	NEATKcal       int      `json:"neat_kcal"`

	TrainingKcalPerDay  int `json:"training_kcal_per_day"`
	TrainingDaysCovered int `json:"training_days_covered"`
	TrainingSessions    int `json:"training_sessions"`

	TDEEKcal int `json:"tdee_kcal"`

	PhaseKind         PhaseKind `json:"phase_kind"`
	TargetRatePerWeek float64   `json:"target_rate_pct_per_week"`
	TargetRateKGPerWk float64   `json:"target_rate_kg_per_week"`
	KcalPerKG         float64   `json:"kcal_per_kg"`
	EnergyDeltaKcal   int       `json:"energy_delta_kcal"`

	// Clamped is true when a rail bound, so the UI can say "we stopped here"
	// rather than showing arithmetic whose last line does not follow from the
	// one above it.
	Clamped     bool   `json:"clamped"`
	ClampReason string `json:"clamp_reason,omitempty"`

	// Relaxed names which macro rule had to give way, empty when none did.
	Relaxed string `json:"relaxed,omitempty"`

	ProteinGPerKG float64 `json:"protein_g_per_kg"`
	FatGPerKG     float64 `json:"fat_g_per_kg"`

	// Projection is "does this look right?" — when the phase's goal weight
	// arrives at this rate, and whether that is before its deadline.
	//
	// NULL is the ordinary case and means there is nothing to say: no goal
	// weight, or no phase. A client must render nothing rather than an
	// all-clear, because "we did not check" and "it checks out" are different
	// answers and only one of them is reassuring.
	Projection *Projection `json:"projection"`
}

// Suggestion is a proposal. Nothing here is stored until the athlete accepts
// it with a PUT — the same posture as the weekly adjustment rule, and the
// project's "auditable recommendations" principle: a number you can argue with
// beats a verdict you must trust.
type Suggestion struct {
	Kcal     int    `json:"kcal"`
	ProteinG int    `json:"protein_g"`
	CarbG    int    `json:"carb_g"`
	FatG     int    `json:"fat_g"`
	FibreG   int    `json:"fibre_g"`
	Basis    *Basis `json:"basis"`
}

// Missing names the profile fields a derivation needs and did not have.
const (
	MissingWeight = "weight_kg"
	MissingHeight = "height_cm"
	MissingDOB    = "date_of_birth"
	MissingSex    = "sex"
)

// Suggest derives a target, or reports what is missing.
//
// A nil Suggestion with a non-empty `missing` is NOT an error and the handler
// returns 200 for it: the request was fine, the profile is incomplete, and the
// client's fix is a form rather than a retry.
//
// # The refusal that matters most in this file
//
// `energy`'s own package doc says its fallback resting baseline runs 20–30%
// high for many people. On a session card that inflates a badge nobody acts on.
// Used for a FOOD TARGET it inflates the whole chain by roughly 400 kcal/day,
// and the cut then simply does not happen — invisibly, indefinitely, with every
// number on screen looking reasonable. So a coarse profile is refused outright
// rather than derived-with-a-caveat: there is no caveat an athlete can act on.
func Suggest(in Inputs, activity Activity, restingPerDay func() (float64, bool), precision string) (*Suggestion, []string) {
	if !activity.valid() {
		activity = ActivityLight
	}

	var missing []string
	if in.WeightKG == nil || !(*in.WeightKG > 0) {
		missing = append(missing, MissingWeight)
	}
	if in.HeightCM == nil {
		missing = append(missing, MissingHeight)
	}
	if in.DateOfBirth == nil {
		missing = append(missing, MissingDOB)
	}
	if in.Sex == nil {
		missing = append(missing, MissingSex)
	}
	if len(missing) > 0 {
		return nil, missing
	}

	rmr, ok := restingPerDay()
	// PrecisionEstimated is the only acceptable quality — see the doc above.
	// The string rather than the energy.Precision type keeps this file free of
	// the import and therefore testable with a stub.
	if !ok || precision != "estimated" {
		// Nothing is nil-checked away here: the caller had every field, so a
		// coarse verdict means one of them was unusable (an unparseable date of
		// birth, most likely). Report the fields rather than a bare failure.
		return nil, []string{MissingHeight, MissingDOB, MissingSex}
	}

	weight := *in.WeightKG
	factor := ActivityFactors[activity]
	neat := rmr * (factor - 1)
	tdee := rmr + neat + in.TrainingKcalPerDay

	ratePerWeek, rateKGPerWeek := targetRate(in, weight)
	deltaPerDay := rateKGPerWeek * kcalPerKG / 7

	kcal, clamped, reason := clampKcal(tdee+deltaPerDay, tdee, rmr)

	basis := &Basis{
		RMRKcal:             int(math.Round(rmr)),
		RMRPrecision:        precision,
		WeightKG:            round2(weight),
		WeightOn:            in.WeightMeasuredOn,
		Activity:            activity,
		ActivityFactor:      factor,
		NEATKcal:            int(math.Round(neat)),
		TrainingKcalPerDay:  int(math.Round(in.TrainingKcalPerDay)),
		TrainingDaysCovered: in.TrainingDaysCovered,
		TrainingSessions:    in.TrainingSessions,
		TDEEKcal:            int(math.Round(tdee)),
		PhaseKind:           phaseOrMaintenance(in.PhaseKind),
		TargetRatePerWeek:   round4(ratePerWeek),
		TargetRateKGPerWk:   round2(rateKGPerWeek),
		KcalPerKG:           kcalPerKG,
		EnergyDeltaKcal:     int(math.Round(deltaPerDay)),
		Clamped:             clamped,
		ClampReason:         reason,
	}
	// Computed here, on the server, rather than in each client. The rule then
	// lives in ONE place and both apps agree by construction — the lesson N16
	// records for `offered_grips`, where the same arithmetic was reimplemented
	// in two apps and a parity script stood in for a shared package. Serving it
	// is cheaper than policing it, and this one has to reach the phone as well
	// as web under the mobile-first rule.
	basis.Projection = project(in, weight, rateKGPerWeek)

	s := macros(kcal, weight, isDeficit(ratePerWeek), basis)
	return &s, nil
}

// targetRate returns the signed weekly rate — negative for loss — as a fraction
// of body mass and as kilograms.
//
// The band midpoint rather than an edge: the min and max are where a rate stops
// being worth pursuing and starts costing lean mass respectively, so aiming at
// either leaves no room for the week to go slightly wrong.
func targetRate(in Inputs, weight float64) (fraction, kg float64) {
	switch in.PhaseKind {
	case PhaseCut:
		b := RateTargets[PhaseCut]
		fraction = -midpoint(b)
	case PhaseLeanBulk:
		b := RateTargets[PhaseLeanBulk]
		fraction = midpoint(b)
	case PhaseMakingWeight:
		fraction = -makingWeightRate(in, weight)
	default:
		// recomposition, maintenance, and any phase kind this build does not
		// know: hold weight. Under-feeding on a vocabulary mismatch would be
		// the worse failure.
		fraction = 0
	}
	return fraction, fraction * weight
}

// makingWeightRate is the rate a deadline demands, CLAMPED AT THE CUT CEILING.
//
// A competition date does not change physiology: if the division is four weeks
// away and the athlete is six kilos over, the honest answer is the fastest safe
// rate plus a plan that says the gap will not close, not a target that starves
// them. This is the same clamp `makingWeightPlan` applies on the client, whose
// `safe` flag surfaces the shortfall.
func makingWeightRate(in Inputs, weight float64) float64 {
	ceiling := RateTargets[PhaseCut].Max
	if in.PhaseTargetOn == nil || in.PhaseTargetWeightKG == nil || weight <= 0 {
		return midpoint(RateTargets[PhaseCut])
	}
	days := daysBetween(in.On, *in.PhaseTargetOn)
	toGo := weight - *in.PhaseTargetWeightKG
	if toGo <= 0 {
		// Already made it: hold, do not keep cutting into the weigh-in.
		return 0
	}
	if days <= 0 {
		// A deadline today or in the past cannot yield a rate — dividing by it
		// gives +Inf, which would render as a number and clamp to the ceiling
		// silently. Return the ceiling explicitly instead.
		return ceiling
	}
	required := (toGo / weight) * (7 / float64(days))
	return math.Min(required, ceiling)
}

func midpoint(b *RateBand) float64 { return (b.Min + b.Max) / 2 }

func isDeficit(fraction float64) bool { return fraction < 0 }

func phaseOrMaintenance(k PhaseKind) PhaseKind {
	if k == "" {
		return PhaseMaintenance
	}
	return k
}

// clampKcal applies every rail in order and reports which one bound last.
//
// **The rails fall through rather than returning early, and that is the whole
// point.** They used to `return` on the first hit, which made the resting-rate
// floor — the one the comments call the harder of the two — unreachable
// whenever a percentage cap fired first. That is not a corner case: the
// reference athlete (RMR 1780) sedentary with no logged training has a TDEE of
// 2136, so an ordinary cut wants 1476, the 30% cap catches it at 1495 and
// returns **1500 kcal — 280 below the athlete's own resting rate** — while the
// Basis cheerfully reported that only the deficit cap had bound. Found in
// review.
//
// The floor is applied LAST so its message wins, which is what the original
// comment intended and the control flow prevented.
func clampKcal(want, tdee, rmr float64) (kcal int, clamped bool, reason string) {
	if lo := tdee * (1 - maxDeficitFraction); want < lo {
		want, clamped = lo, true
		reason = fmt.Sprintf("the deficit was capped at %.0f%% of maintenance", maxDeficitFraction*100)
	}
	if hi := tdee * (1 + maxSurplusFraction); want > hi {
		want, clamped = hi, true
		reason = fmt.Sprintf("the surplus was capped at %.0f%% of maintenance", maxSurplusFraction*100)
	}
	// A target under resting is the one an athlete most needs told, and a
	// percentage cap can land below it — which is exactly what happened.
	floorBound := false
	if floor := rmr * minKcalOverResting; want < floor {
		want, clamped, floorBound = floor, true, true
		reason = "the target was raised to stay above your resting rate"
	}
	if floorBound {
		// Rounded UP when the floor bound, because the final rounding can put
		// the number back BELOW the rail that just raised it: a floor of 1874
		// became 1870 here while the reason line said it had been raised to
		// stay above resting. A floor that rounds to nearest is not a floor.
		//
		// The adjustment rule reads this same constant and rounds up too, so
		// the two agreeing is what keeps a derived target from being one the
		// adjustment immediately proposes raising. Found by review on N27.
		return ceilTo10(want), clamped, reason
	}
	return roundTo10(want), clamped, reason
}

// macros splits a calorie target into grams.
//
// Protein and fat are set from bodyweight and carbs take the remainder, which
// is the order that matters: carbs are the only one of the three with no floor
// worth defending, so they are what gives way when the target is small.
//
// When the remainder still goes negative — a heavy athlete on an aggressive
// cut — the rules relax in a FIXED, RECORDED order: fat toward its absolute
// floor, then protein toward the Morton plateau. Writing the order down once,
// here, is the whole point; relaxing ad hoc at a call site is how one athlete
// ends up on a different rule from another.
func macros(kcal int, weight float64, deficit bool, basis *Basis) Suggestion {
	proteinPerKG := proteinDefaultGPerKG
	if deficit {
		proteinPerKG = proteinDeficitGPerKG
	}
	fatPerKG := fatGPerKG

	total := float64(kcal)
	protein := proteinPerKG * weight
	fat := math.Max(fatPerKG*weight, total*fatMinKcalShare/9)

	if remainder(total, protein, fat) < 0 {
		// Step one: fat down to its absolute floor. The energy-share floor is
		// abandoned before the essential-fatty-acid one, because the former is
		// a ratio and the latter is an intake.
		fatPerKG = fatFloorGPerKG
		fat = fatPerKG * weight
		basis.Relaxed = "fat reduced to its floor to leave room for carbohydrate"
	}
	if remainder(total, protein, fat) < 0 {
		// Step two: protein down to the plateau Morton et al. identify. Below
		// this there is measurable lean-mass cost, so it is where relaxing
		// stops.
		proteinPerKG = proteinFloorGPerKG
		protein = proteinPerKG * weight
		basis.Relaxed = "protein and fat both reduced toward their floors"
	}

	carb := remainder(total, protein, fat) / 4
	if carb < 0 {
		// Step three: there is no honest split left. Report zero carbohydrate
		// rather than a negative one — the clamp above should make this
		// unreachable, and a negative gram figure rendered in a UI is worse
		// than a zero that visibly does not add up.
		carb = 0
		basis.Relaxed = "the target is too small to hold protein and fat at their floors"
	}

	basis.ProteinGPerKG = round2(proteinPerKG)
	basis.FatGPerKG = round2(fatPerKG)

	return Suggestion{
		Kcal:     kcal,
		ProteinG: roundTo5(protein),
		CarbG:    roundTo5(carb),
		FatG:     roundTo5(fat),
		FibreG:   roundTo5(total / 1000 * fibreGPer1000Kcal),
		Basis:    basis,
	}
}

func remainder(total, protein, fat float64) float64 {
	return total - protein*4 - fat*9
}

// Rounding is coarse on purpose: macros to 5 g, kcal to 10. Nobody weighs
// chicken to the gram against a target, and a target printed to three
// significant figures implies a precision the whole chain does not have.
//
// The consequence, and it must be stated in the contract: 4P + 4C + 9F will not
// equal kcal exactly. **Kcal is authoritative.** A client that "reconciles"
// them by recomputing kcal from the macros discards the clamp above.
func roundTo5(v float64) int  { return int(math.Round(v/5) * 5) }
func roundTo10(v float64) int { return int(math.Round(v/10) * 10) }
func round2(v float64) float64 {
	return math.Round(v*100) / 100
}
func round4(v float64) float64 { return math.Round(v*10000) / 10000 }

// daysBetween counts whole days from a to b, positive when b is later. Both
// must already be valid "YYYY-MM-DD"; callers validate first.
func daysBetween(a, b string) int {
	ta, errA := parseDay(a)
	tb, errB := parseDay(b)
	if errA != nil || errB != nil {
		return 0
	}
	return int(tb.Sub(ta).Hours() / 24)
}

func parseDay(s string) (time.Time, error) {
	return time.Parse("2006-01-02", s)
}

// addDays returns a calendar day n days after s, "YYYY-MM-DD".
//
// AddDate rather than adding hours, so the answer stays a calendar day across a
// DST boundary — adding 24h*n to a wall clock silently lands on the previous day
// twice a year, which on a projection months out is exactly the kind of quiet
// off-by-one nobody would trace back to here.
func addDays(s string, n int) string {
	t, err := parseDay(s)
	if err != nil {
		return ""
	}
	return t.AddDate(0, 0, n).Format("2006-01-02")
}

// Projection answers "does this look right?" — the third section
// `nutrition-design.md` §5 asked for and the one nothing had built.
//
// # What it is for
//
// A phase carries a goal weight, a deadline and a rate. Nothing compared them,
// so an athlete could set "lose eight kilos by Christmas", be handed a
// perfectly safe rate that reaches it in April, and find out in April. §5's
// words: it "catches an impossible goal before six weeks of failing at it".
//
// # It is the INVERSE of makingWeightRate, deliberately
//
// `makingWeightRate` asks "what rate does this deadline demand?" and clamps at
// the cut ceiling, because a competition date is fixed and physiology is not.
// This asks "when does the rate I was given actually arrive?" — which is the
// right question for every other phase, where the DEADLINE is the soft thing
// and the rate was chosen to be safe.
//
// Both exist because both questions are real. Answering only the first would
// tell an athlete on an ordinary cut to eat faster than is safe; answering only
// the second would tell someone with a weigh-in that their date is wrong.
//
// # Nil is the normal case
//
// No goal weight, no live phase, or a rate of zero all mean there is nothing to
// project, and a maintenance phase never "arrives" anywhere. Nil renders as
// nothing rather than as a reassuring absence of warning.
type Projection struct {
	// TargetWeightKG is the phase's goal, repeated so a client rendering this
	// block needs nothing else.
	TargetWeightKG float64 `json:"target_weight_kg"`
	// KGToGo is unsigned — how far there is left to travel, in whichever
	// direction the phase is going.
	KGToGo float64 `json:"kg_to_go"`
	// ReachedOn is the day the goal weight arrives at the phase's own rate,
	// "YYYY-MM-DD". Empty when Unreachable.
	ReachedOn string `json:"reached_on"`
	// WeeksToGo is the same figure before it was turned into a date, because a
	// span is what an athlete reasons with ("that is five months") and a date
	// is what they diary.
	WeeksToGo float64 `json:"weeks_to_go"`

	// Already reports that the goal weight is already met. The plan is not
	// wrong; it is finished, which is a different thing to say.
	Already bool `json:"already"`
	// Unreachable means the rate never closes the gap — it is zero, or it
	// points away from the goal. A bulk with a goal weight BELOW current is the
	// real case: two settings that each look fine and contradict each other.
	Unreachable       bool   `json:"unreachable"`
	UnreachableReason string `json:"unreachable_reason,omitempty"`

	// DeadlineOn is the phase's target date, when it set one.
	DeadlineOn string `json:"deadline_on,omitempty"`
	// MeetsDeadline is nil when there is no deadline to meet — absent, not
	// false, because "no deadline" and "misses it" must not render alike.
	MeetsDeadline *bool `json:"meets_deadline"`
	// ShortfallKG is how much would still be left on the deadline, when it is
	// missed. Zero otherwise.
	ShortfallKG float64 `json:"shortfall_kg,omitempty"`
	// DaysLate is how far past the deadline the goal actually arrives.
	DaysLate int `json:"days_late,omitempty"`
}

// project builds the feasibility answer, or nil when there is nothing to say.
//
// `rateKGPerWeek` is SIGNED — negative on a cut — and that sign is what makes a
// contradictory plan detectable rather than silently producing a date in the
// past.
func project(in Inputs, weight, rateKGPerWeek float64) *Projection {
	if in.PhaseTargetWeightKG == nil || weight <= 0 {
		return nil
	}
	goal := *in.PhaseTargetWeightKG
	p := &Projection{TargetWeightKG: round2(goal)}
	if in.PhaseTargetOn != nil {
		p.DeadlineOn = *in.PhaseTargetOn
	}

	delta := goal - weight // negative when the goal is below: a cut
	p.KGToGo = round2(math.Abs(delta))

	// Within a tenth of a kilo is arrived. Scales do not resolve better than
	// that day to day, so demanding exactness would leave someone "0.02 kg
	// away" forever.
	if math.Abs(delta) < 0.1 {
		p.Already = true
		return p
	}
	if rateKGPerWeek == 0 {
		p.Unreachable = true
		p.UnreachableReason = "this phase holds your weight where it is"
		return p
	}
	// Signs disagree: the rate moves away from the goal. Two settings that each
	// look reasonable on their own screen and cannot both be meant.
	if (delta > 0) != (rateKGPerWeek > 0) {
		p.Unreachable = true
		p.UnreachableReason = "this phase moves your weight away from that goal"
		return p
	}

	weeks := delta / rateKGPerWeek // same sign both sides, so positive
	p.WeeksToGo = round2(weeks)
	p.ReachedOn = addDays(in.On, int(math.Ceil(weeks*7)))

	if p.DeadlineOn != "" {
		daysLate := daysBetween(p.DeadlineOn, p.ReachedOn)
		meets := daysLate <= 0
		p.MeetsDeadline = &meets
		if !meets {
			p.DaysLate = daysLate
			// What is still left to travel on the deadline itself — the number
			// that says how far off the plan is, where the date says only that
			// it is off.
			daysLeft := daysBetween(in.On, p.DeadlineOn)
			if daysLeft < 0 {
				daysLeft = 0
			}
			moved := math.Abs(rateKGPerWeek) * (float64(daysLeft) / 7)
			short := math.Abs(delta) - moved
			if short < 0 {
				short = 0
			}
			p.ShortfallKG = round2(short)
		}
	}
	return p
}
