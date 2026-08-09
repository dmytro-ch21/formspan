// Package sessioncard serves the numbers a finished session's share card shows
// and the client cannot compute for itself.
//
// The card already renders everything the phone knows — duration, sets, reps,
// tonnage, PRs. This module exists for the three things it does not: the
// calorie estimate (which needs the athlete's bodyweight, height, age and sex),
// the VOLA Score (which needs the last twenty sessions of the same sport), and
// the exercise or technique list (which needs names the offline store does not
// carry).
//
// ONE ENDPOINT FOR ALL OF IT, rather than three. The card renders once and
// either has its numbers or does not; three round trips would give it three
// chances to half-arrive, and a card that pops a score in a second after the
// calories is worse than one that waits.
//
// DERIVED, NEVER STORED. There is no card table and no score column. Both
// numbers are recomputed on read, like BJJ rank and curriculum mastery, so
// neither can drift from the session it describes — and editing a set changes
// the card the next time it is opened rather than leaving a stale figure
// somebody has already posted.
package sessioncard

import "context"

// Calories is the estimate, with how good it is.
//
// Precision travels with the number because "estimated" and "coarse" are
// different claims and a card that renders them identically is overstating one
// of them. Absent entirely when there is no bodyweight — see the energy
// package for why that is a refusal rather than a default.
type Calories struct {
	Kcal int `json:"kcal"`
	// "estimated" (weight, height, age and sex) or "coarse" (weight only).
	Precision string `json:"precision"`
}

// Score is the VOLA Score. Absent below the history threshold.
type Score struct {
	Value int `json:"value"`
	// "effort" (RPE × minutes) or "volume", when effort tracking is off.
	Basis string `json:"basis"`
	// How many prior sessions it was ranked against, so a client can say
	// "of your last 14" rather than implying a window it did not have.
	Compared int `json:"compared"`
}

// Detail is one line of the "what I did" band: an exercise, or a technique.
type Detail struct {
	Name string `json:"name"`
	// Strength: the top working set, e.g. "140 kg × 5". Empty for BJJ.
	Figure string `json:"figure,omitempty"`
	// BJJ: "scored", "attempted", "drilled". Empty for strength.
	Outcome string `json:"outcome,omitempty"`
	// BJJ: how many times, when more than one.
	Count int `json:"count,omitempty"`
}

// Card is the whole response. Every field is optional because every one of
// them has a legitimate absent state, and absent is not zero: no score means
// "not enough history", not "you scored nothing".
type Card struct {
	Calories *Calories `json:"calories"`
	Score    *Score    `json:"score"`
	// Capped server-side. Trimming on the phone would ship a whole session's
	// exercise list to render five rows of it.
	Detail []Detail `json:"detail"`
	// True when there is more than `Detail` shows, so a client can say "+4
	// more" without being told the number and inferring the rest.
	More int `json:"more"`
}

// MaxDetail is what a card can usefully render. A twelve-exercise session
// turns the card into a spreadsheet; five plus a count is the session.
const MaxDetail = 5

// Repository is the persistence boundary. Every method takes the caller and
// scopes itself — there is no read here that omits ownership.
type Repository interface {
	// Card assembles one session's card numbers.
	//
	// ErrNotFound when the session does not exist, is not the caller's, or has
	// not finished — indistinguishably. An unfinished session has no duration,
	// so every number on the card would be a lie about a session still in
	// progress.
	Card(ctx context.Context, callerID, sessionID string) (Card, error)
}
