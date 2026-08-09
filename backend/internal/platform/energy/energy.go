// Package energy estimates what a session cost, in kilocalories.
//
// This number goes on a card people post, which makes being wrong expensive in
// a way an internal metric never is. Consumer apps routinely report 400–600
// kcal for an hour of weights; the published values do not support that, and
// three specific mistakes account for most of the gap. All three are avoided
// here on purpose, and each one makes the number SMALLER:
//
//  1. GROSS INSTEAD OF NET. `MET × kg × hours` includes the calories you would
//     have burned lying still for that hour. What a training card should show
//     is the extra, so every MET drops by one.
//
//  2. THE 1-MET BASELINE IS ITSELF INFLATED. The conventional 3.5 ml/kg/min was
//     derived from a single 70 kg, 40-year-old man and overestimates resting
//     rate by roughly 20–30% for many people — lower in women, in older
//     athletes, and at higher body mass. So the multiple is applied to the
//     athlete's OWN resting rate (Mifflin–St Jeor) rather than to a constant.
//
//  3. USING "VIGOROUS LIFTING" FOR A WHOLE SESSION. A weights session is mostly
//     rest. The Compendium's entry for ordinary multi-exercise work is 3.5 MET,
//     not the 6.0 that "vigorous" suggests, and 6.0 applied to wall-clock time
//     is where the inflated numbers come from.
//
// MET values are the 2011 Compendium of Physical Activities (Ainsworth et al.).
// Nothing here is tuned to make the number look good.
//
// HEART RATE REPLACES THIS, it does not supplement it. When a session carries
// HR the estimate should come from HR instead; this package is the floor for
// sessions that do not, and the shape (blocks of minutes at a MET) is the same
// either way.
package energy

import (
	"math"
	"strings"
	"time"
)

// MET values, 2011 Compendium. Named rather than inlined so the one place a
// value is chosen reads as a decision, and so a reviewer can check them
// against the source without reading the arithmetic.
const (
	// METStrengthGeneral — "resistance training, multiple exercises, 8–15 reps
	// at varied resistance". THE DEFAULT, deliberately: it is the entry that
	// describes what most people actually do, and the conservative choice when
	// a session's character is unclear.
	METStrengthGeneral = 3.5
	// METStrengthHeavy — "resistance training, squats, deadlift, slow or
	// explosive effort".
	METStrengthHeavy = 5.0
	// METStrengthDense — "resistance training, circuit, reciprocal supersets".
	METStrengthDense = 5.8
	// METBodyweight — "body weight resistance exercises, general".
	METBodyweight = 3.0

	// METMatLive — "martial arts, moderate pace (judo, jujitsu, karate…)".
	// Applied ONLY to recorded rolling time, never to the whole session.
	METMatLive = 10.3
	// METMatPractice — "martial arts, slower pace, novice performers,
	// practice". Everything on the mat that is not a live round.
	METMatPractice = 5.3
)

// Profile is what the estimate needs about the athlete. Every field is a
// pointer because every one of them is genuinely optional in this app, and the
// difference between "not recorded" and a default matters more here than
// almost anywhere else — see Estimate.
type Profile struct {
	// WeightKG is the most recent body check-in on or before the session.
	WeightKG *float64
	HeightCM *float64
	// DateOfBirth as "YYYY-MM-DD", matching the profile's own storage.
	DateOfBirth *string
	// Sex is "male", "female", or nil.
	Sex *string
}

// Block is a stretch of a session spent at one intensity.
type Block struct {
	MET     float64
	Minutes float64
}

// Estimate returns kilocalories, and whether it could produce one at all.
//
// ok is false when there is no bodyweight, and that is a refusal rather than a
// gap to paper over: weight is the dominant input, a 55 kg and a 105 kg athlete
// doing identical work differ by nearly half, and there is no honest default.
// The card shows its other numbers and asks for a check-in. It never assumes
// 70 kg.
//
// Height, age and sex are softer. Without them the resting rate falls back to
// the conventional baseline and the estimate gets coarser — worth doing, where
// guessing bodyweight is not.
func Estimate(p Profile, blocks []Block) (kcal float64, ok bool) {
	if p.WeightKG == nil || *p.WeightKG <= 0 {
		return 0, false
	}
	restPerMin := restingKcalPerMinute(p)
	total := 0.0
	for _, b := range blocks {
		if b.Minutes <= 0 || b.MET <= 1 {
			// A MET at or below resting contributes nothing NET, and a
			// negative contribution would be nonsense — sitting still does not
			// subtract from what a session cost.
			continue
		}
		total += (b.MET - 1) * restPerMin * b.Minutes
	}
	return total, true
}

// restingKcalPerMinute is Mifflin–St Jeor when it can be, and the conventional
// MET baseline when it cannot.
//
// Mifflin–St Jeor is the equation clinical practice settled on for resting
// energy; it needs weight, height, age and sex. The fallback — the
// conventional 1-MET baseline — is the thing the package doc calls inflated,
// so it is used only when the better inputs are missing, and the caller can
// tell which happened via Precision.
func restingKcalPerMinute(p Profile) float64 {
	if age, okAge := ageYears(p.DateOfBirth); okAge && p.HeightCM != nil && p.Sex != nil {
		w, h := *p.WeightKG, *p.HeightCM
		perDay := 10*w + 6.25*h - 5*float64(age)
		switch strings.ToLower(*p.Sex) {
		case "male":
			perDay += 5
		case "female":
			perDay -= 161
		default:
			// A recorded sex this package does not model. Take the midpoint
			// rather than silently assuming male, which is what "+5" would be.
			perDay -= 78
		}
		if perDay > 0 {
			return perDay / 1440
		}
	}
	// The conventional baseline: 1 MET = 3.5 ml O2/kg/min, and a litre of O2
	// releases ~5 kcal on a mixed substrate.
	//
	// The 5 is the constant to get right, and 4.184 is the trap — that is
	// joules per calorie, not kcal per litre of O2, and using it here made
	// this baseline LOWER than Mifflin–St Jeor, quietly inverting the very
	// relationship this fallback exists to describe. The check: 3.5 ml/kg/min
	// at 5 kcal/L works out to ~1 kcal/kg/hour, which is the familiar MET
	// shorthand. A test pins that this baseline sits ABOVE an average
	// athlete's own resting rate, because that gap is the whole reason
	// Mifflin–St Jeor is preferred when the inputs exist.
	const kcalPerLitreO2 = 5.0
	return 3.5 * *p.WeightKG * kcalPerLitreO2 / 1000
}

// Precision says how good the estimate is, so a caller can label it honestly
// rather than presenting two different qualities of number identically.
type Precision string

const (
	// PrecisionNone — no bodyweight, no estimate.
	PrecisionNone Precision = "none"
	// PrecisionCoarse — bodyweight only; resting rate from the generic
	// baseline, which runs 20–30% high for many people.
	PrecisionCoarse Precision = "coarse"
	// PrecisionEstimated — weight, height, age and sex all present.
	PrecisionEstimated Precision = "estimated"
)

// PrecisionOf reports which path Estimate would take.
func PrecisionOf(p Profile) Precision {
	if p.WeightKG == nil || *p.WeightKG <= 0 {
		return PrecisionNone
	}
	if age, ok := ageYears(p.DateOfBirth); ok && p.HeightCM != nil && p.Sex != nil && age > 0 {
		return PrecisionEstimated
	}
	return PrecisionCoarse
}

func ageYears(dob *string) (int, bool) {
	if dob == nil {
		return 0, false
	}
	born, err := time.Parse("2006-01-02", *dob)
	if err != nil {
		return 0, false
	}
	now := time.Now().UTC()
	years := now.Year() - born.Year()
	if now.YearDay() < born.YearDay() {
		years--
	}
	if years < 10 || years > 100 {
		// Outside this range the equation is not validated and the value is
		// far more likely to be a typo than a centenarian.
		return 0, false
	}
	return years, true
}

// StrengthBlocks describes a lifting session as one block of wall-clock time.
//
// ONE BLOCK, NOT WORK-AND-REST, and that is not laziness. The Compendium's
// resistance-training values were measured over sessions as people actually
// perform them, rest included — so the 3.5 already has the rest in it. Splitting
// wall-clock into "working sets at 6.0" and "rest at 1.5" would double-count the
// discount and produce a number that looks rigorous and is wrong.
//
// Which MET applies is chosen from what the session was, in the order a coach
// would read it: loaded compounds beat density beats the general case.
func StrengthBlocks(minutes float64, workingSets int, anyLoaded bool, heavyCompounds bool) []Block {
	met := METStrengthGeneral
	switch {
	case !anyLoaded:
		met = METBodyweight
	case heavyCompounds:
		met = METStrengthHeavy
	case minutes > 0 && float64(workingSets)/minutes >= 0.5:
		// A working set every two minutes or faster is circuit-like density.
		met = METStrengthDense
	}
	return []Block{{MET: met, Minutes: minutes}}
}

// MatBlocks splits a BJJ session into live rounds and everything else.
//
// The split is real data rather than an assumption: the app records rounds and
// round length separately from session duration, so rolling time is known. A
// flat MET over the whole session would either overestimate the drilling or
// underestimate the rolling, and on a two-hour class those are large errors in
// opposite directions.
func MatBlocks(sessionMinutes float64, rounds int, roundMinutes int) []Block {
	live := float64(rounds) * float64(roundMinutes)
	if live > sessionMinutes {
		// More rolling than session is a data error somewhere; trust the
		// smaller number rather than inventing time.
		live = sessionMinutes
	}
	rest := sessionMinutes - live
	blocks := make([]Block, 0, 2)
	if live > 0 {
		blocks = append(blocks, Block{MET: METMatLive, Minutes: live})
	}
	if rest > 0 {
		blocks = append(blocks, Block{MET: METMatPractice, Minutes: rest})
	}
	return blocks
}

// Round returns the value a client should show: whole kilocalories, and never
// a false precision. Always rendered with a "≈" by the caller.
func Round(kcal float64) int { return int(math.Round(kcal)) }
