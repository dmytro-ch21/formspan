// Package score answers one question: where does this session sit among your
// own?
//
// NOT A RATING OF THE ATHLETE, and not a comparison with anybody else. This app
// has no leaderboards and the social scope is closed; a score that ranked people
// against each other would be a different product.
//
// # Why a percentile and not a sum of components
//
// The obvious build is four components worth 25 points each, added up. It was
// rejected. Averaging partial scores pulls everything to the middle, so such a
// score lands between 70 and 90 for almost every session, and a number that is
// never bad is decoration. This project already made that call once, about
// curriculum mastery: the number has to be able to disappoint.
//
// A percentile cannot flatter. Half your sessions score below 50 by
// construction, an easy session says so, and there are no weights for anyone to
// argue about.
//
// # The load it ranks
//
// Foster's session RPE — effort × duration — which is the standard training-load
// measure precisely because neither term alone is enough.
//
// Note what multiplying does and does not claim. It does NOT make a long easy
// session score below a short hard one: three hours at RPE 3 equals one hour at
// RPE 9 exactly, and that equivalence is the model, not a loophole. What it
// prevents is duration DOMINATING — under an additive load a three-hour stroll
// (3 + 180) would outrank a brutal hour (9 + 60) nearly threefold, which is the
// shape that actually lets junk volume farm a score.
//
// Effort tracking is a setting and plenty of people have it off — and so is
// every session logged before somebody switched it on. Then the basis falls
// back to DURATION and the score still works; it just measures how long the
// session was rather than what it cost. Which one happened is carried on the
// result, because a number whose meaning changed silently is worse than no
// number.
//
// Duration, not tonnage, and the doc said tonnage until a reviewer checked the
// caller. Tonnage would be the better measure and cannot be the one used: it is
// meaningless for BJJ, so a single basis has to be something both sports have.
// The consequence is real and worth stating rather than hiding — under the
// volume basis a sixty-minute session of thirty sets ties a sixty-minute
// session of ten. That is the price of a number that works for an athlete who
// does not record effort, and it is why the basis travels with the score.
//
// # Derived, never stored
//
// Recomputed on read, like BJJ rank and curriculum mastery, so it cannot drift
// from the sessions it describes. There is no score column and there should not
// be one.
package score

import "sort"

const (
	// MinHistory is the fewest prior sessions that can produce a score.
	//
	// A percentile against three sessions is noise wearing a number: one
	// unusually light week would put an ordinary session at 100. Below this
	// the card shows its stats and omits the score entirely rather than
	// printing a confident figure that means nothing.
	MinHistory = 8

	// Window is how many recent sessions the percentile ranks against.
	//
	// Twenty is roughly the last six weeks for somebody training three or four
	// times a week — long enough to be a distribution, short enough that a
	// season of progress moves the baseline with the athlete instead of
	// scoring this year against last year's fitness.
	Window = 20
)

// Basis says what the load was built from, so the explanation can be honest
// about which question the number answers.
type Basis string

const (
	// BasisEffort — RPE × minutes. What the session cost.
	BasisEffort Basis = "effort"
	// BasisVolume — duration, when effort was not recorded. How long the
	// session was, which is the only size measure BJJ and strength share.
	BasisVolume Basis = "volume"
)

// Load is Foster's session RPE: effort multiplied by duration.
//
// Multiplied, not added, and that is the property that matters — though not
// the one it is tempting to claim. Multiplying does not make a long easy
// session lose to a short hard one; it makes them commensurate, which is the
// point. What it rules out is the additive shape, where duration swamps effort
// and the longest session wins regardless of what it cost.
func Load(rpe, minutes float64) float64 {
	if rpe <= 0 || minutes <= 0 {
		return 0
	}
	return rpe * minutes
}

// Score is the answer, with enough context to explain itself.
type Score struct {
	// Value is 0–100: the share of recent sessions this one beat.
	Value int
	Basis Basis
	// Compared is how many prior sessions it was ranked against, so a client
	// can say "of your last 14" rather than implying a fixed window.
	Compared int
}

// Of ranks load against history, newest-first, and reports whether a score
// could be produced at all.
//
// ok is false below MinHistory. That is a refusal rather than a fallback: the
// alternatives are inventing a population baseline this app does not have, or
// printing a number computed from four data points, and both are worse than an
// absent score.
//
// Ties count as half, which is the mid-rank convention and matters more here
// than it looks: repeating a workout exactly is completely ordinary, and under
// a strict "beat it" rule the second identical session would score lower than
// the first for no reason an athlete could accept.
func Of(load float64, history []float64, basis Basis) (Score, bool) {
	if len(history) < MinHistory {
		return Score{}, false
	}
	window := history
	if len(window) > Window {
		window = window[:Window]
	}

	below, equal := 0, 0
	for _, h := range window {
		switch {
		case h < load:
			below++
		case h == load:
			equal++
		}
	}

	n := float64(len(window))
	pct := (float64(below) + 0.5*float64(equal)) / n * 100

	return Score{
		Value:    int(pct + 0.5),
		Basis:    basis,
		Compared: len(window),
	}, true
}

// Median returns the middle load of the window, which is what a client needs to
// say "about the same as usual" rather than only printing a rank.
//
// Exposed because a bare percentile invites the wrong question — 62 sounds
// precise and means little without knowing what 50 looks like — and because a
// caller computing it separately would have to re-sort the same slice.
//
// NO PRODUCTION CALLER YET, which review flagged as dead surface. Kept
// deliberately: the card's "about the same as usual" line is the intended
// consumer, and in the meantime `TestAnEasySessionScoresLow` uses it to pin the
// property this whole package exists for — that the median session scores near
// 50. Reimplementing that inside the test would leave the two able to disagree,
// which is the same argument the window cap here was added under.
func Median(history []float64) (float64, bool) {
	if len(history) == 0 {
		return 0, false
	}
	window := history
	if len(window) > Window {
		window = window[:Window]
	}
	sorted := append([]float64(nil), window...)
	sort.Float64s(sorted)

	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[mid], true
	}
	return (sorted[mid-1] + sorted[mid]) / 2, true
}
