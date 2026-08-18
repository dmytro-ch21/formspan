// Package accomplishment answers "what have I actually achieved in jiu-jitsu",
// derived from evidence that already exists rather than from anything new.
//
// # Why this exists
//
// `SessionCelebration` gives a finished strength session a personal-record row
// and gives a BJJ session nothing, with a comment saying so: there is no BJJ
// equivalent of a PR, and inventing a "you showed up" badge to fill the gap is
// the wallpaper the badge rule exists to prevent. This is the other half.
//
// # The rule for what may be in here
//
// An accomplishment is a **FIRST**: a thing that happened once, that a row
// somewhere proves, and that most athletes reach at most once ever. That single
// rule does the work three separate prohibitions would:
//
//   - It excludes anything that fires constantly for whoever trains that way —
//     long sessions, high volume, many techniques. history.md rejects those by
//     name as "a description of a training style rather than an achievement".
//   - It excludes running counters, which is the whole ethical argument
//     `lib/milestones.ts` makes on the mobile side: a number that can visibly
//     break is a thing to protect, and protecting it is what makes somebody
//     train on a week their body wanted off. A first cannot break.
//   - It excludes anything self-declared, because every kind here is a query
//     over rows the athlete logged as events, never a claim they made about
//     themselves.
//
// **Nothing is stored.** Every kind is derived on read, the same call `records`
// and `bjj.Standing` make and for the same reason: an accomplishment table
// would be a second source for a fact the evidence already answers, and
// correcting a contest result or deleting a session has to be able to RETRACT
// an award. A badge for a match you did not have, surviving because it was
// cached, is worse than no badge.
//
// # Belt promotions are deliberately NOT here
//
// They are the obvious candidate and they are the one thing excluded on
// principle. `bjj_promotions` already records them, `/v1/bjj/standing` already
// derives current rank from them, and re-deriving them here would put one fact
// behind two vocabularies — the drift this repo has argued against every time
// it has come up (see the theme/focus split, and the `contest`/`competition`
// naming note). A client that wants to show a promotion beside these has an
// endpoint for it.
package accomplishment

import (
	"context"
	"sort"
	"time"
)

// Kind is what was achieved. The vocabulary is closed and part of the wire
// contract — a client renders copy per kind, so adding one is a deliberate
// contract change and removing one breaks a rendered screen.
type Kind string

const (
	// FirstCompetition — entered one at all. The hardest step, and the one
	// nobody else marks.
	FirstCompetition Kind = "first_competition"
	// FirstMatchWon — won a match, whatever the bracket did afterwards.
	FirstMatchWon Kind = "first_match_won"
	// FirstSubmissionWin — the migration's own named example of an
	// accomplishment worth awarding, and the reason `contest_matches` records
	// a method rather than a win/loss counter: "lost on advantages" and "lost
	// by armbar" are different findings, and so are their mirrors.
	FirstSubmissionWin Kind = "first_submission_win"
	// FirstPodium — placed third or better.
	FirstPodium Kind = "first_podium"
	// FirstGold — won the division.
	FirstGold Kind = "first_gold"
	// FirstScored — landed anything live, from the tag stream.
	FirstScored Kind = "first_scored"
	// FirstDrilledScored — landed live a technique drilled in an EARLIER
	// session. This is the funnel's whole claim made concrete: drilled →
	// attempted → scored is the sport's most actionable sequence, and this is
	// the moment it completes for the first time.
	FirstDrilledScored Kind = "first_drilled_scored"
)

// kinds in the order a client would render them: the mat before the podium,
// because that is the order they happen in for almost everybody.
var kinds = []Kind{
	FirstScored,
	FirstDrilledScored,
	FirstCompetition,
	FirstMatchWon,
	FirstSubmissionWin,
	FirstPodium,
	FirstGold,
}

// Kinds lists every kind, so a client can render an "not yet" list without
// hardcoding the vocabulary a second time.
func Kinds() []Kind {
	out := make([]Kind, len(kinds))
	copy(out, kinds)
	return out
}

// Basis says what KIND of evidence stands behind an award.
//
// Mirrored from `session/basis.go`, which is the authority — this is a second
// declaration of a shared wire vocabulary, exactly as `apps/web`'s `Basis` type
// is, and for the reason recorded there: each side needs its own type for one
// wire format.
//
// It matters here more than anywhere else in the app, because this is the one
// list that puts the two side by side. A contest result is MEASURED: a bracket,
// a referee, a placement nobody can talk themselves into. A tag is REPORTED:
// the athlete typed that they hit an armbar, and no one checked. Both are worth
// marking and they are not the same claim, so the difference travels with each
// award rather than being flattened into one gold-star list.
//
// Note what basis.go's first reading rule then forbids: a measured award may
// never be judged, ranked or gated by a reported one. Nothing here ranks
// anything — the list is chronological — and that is deliberate rather than
// incidental. A "score" over these would be exactly the violation.
type Basis string

const (
	// Measured — externally verifiable. Competition results only.
	Measured Basis = "measured"
	// Reported — the athlete's own logged evidence. Session tags.
	Reported Basis = "reported"
)

// basisOf maps every kind to its evidence class.
//
// A map rather than a method with a default, so that adding a Kind without
// classifying it is caught by TestEveryKindHasABasis rather than silently
// defaulting to the more flattering answer.
var basisOf = map[Kind]Basis{
	FirstCompetition:   Measured,
	FirstMatchWon:      Measured,
	FirstSubmissionWin: Measured,
	FirstPodium:        Measured,
	FirstGold:          Measured,
	FirstScored:        Reported,
	FirstDrilledScored: Reported,
}

// BasisOf returns the evidence class for a kind, and false for one it does not
// know.
func BasisOf(k Kind) (Basis, bool) {
	b, ok := basisOf[k]
	return b, ok
}

// Accomplishment is one award, with the evidence that earned it.
//
// Flat with per-kind nullable fields, matching `session.Record` rather than
// nesting an `evidence` object: a client rendering a row reads two or three
// fields and a nested object buys nothing but a level of indirection.
//
// Which fields are populated follows from Kind, and a client should switch on
// that rather than sniffing for non-null fields.
type Accomplishment struct {
	Kind  Kind  `json:"kind"`
	Basis Basis `json:"basis"`

	// AchievedOn is "YYYY-MM-DD", or nil.
	//
	// Nil is a real and ordinary state, not a defect: a contest may be recorded
	// with no date at all, because refusing an undated entry would lose the
	// fact in order to protect the metadata. An accomplishment whose evidence
	// carries no date still happened — it simply cannot sit on a timeline, and
	// a client must render it rather than dropping it.
	AchievedOn *string `json:"achieved_on"`

	// Competition evidence.
	ContestID   *string `json:"contest_id"`
	ContestName *string `json:"contest_name"`
	Placement   *int    `json:"placement"`
	// Entrants travels with Placement wherever it is known, because third of
	// four and third of sixty-four are not the same result and a badge showing
	// only the placement loses that permanently.
	Entrants *int `json:"entrants"`

	// Mat evidence.
	SessionID   *string `json:"session_id"`
	TechniqueID *string `json:"technique_id"`
	// TechniqueName is resolved server-side from the library. Nil when the tag
	// named no technique — "got the sweep" without saying which is real
	// evidence the schema deliberately accepts — and also when the technique
	// has since been retired from the library, since that FK is ON DELETE SET
	// NULL.
	//
	// **That survival is not uniform across kinds, which review pointed out
	// and this comment used to overstate.** FirstScored survives a retired
	// technique with only the name going nil. FirstDrilledScored does NOT: it
	// requires a non-null technique_id on both sides to correlate the drill
	// with the score, so retiring the catalog row retracts that award outright.
	// There is no fix short of storing it, and storing it is what this module
	// exists not to do — but "retracts when the session is deleted" and
	// "retracts when the catalog row is retired" are both true, and only the
	// first is obvious.
	TechniqueName *string `json:"technique_name"`
}

// Repository is the persistence port.
//
// One method, and no writes at all — there is nothing to write. If a second
// ever appears here, check first that it is not an accomplishments TABLE
// arriving by the back door.
type Repository interface {
	// List returns the caller's accomplishments, earliest first, undated last.
	// `tz` is the IANA zone the session-derived dates are rendered in.
	List(ctx context.Context, userID, tz string) ([]Accomplishment, error)
}

// ParseZone reads an IANA timezone name.
//
// Local to this package rather than shared, matching `session`'s own
// unexported copy. "Local" is rejected for the reason recorded there: it is
// meaningless over HTTP, since it would mean the SERVER's zone, and the
// caller's zone is the one thing the server cannot infer — which is why the
// parameter exists at all.
func ParseZone(tz string) (*time.Location, bool) {
	if tz == "" || tz == "Local" || tz == "local" {
		return nil, false
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, false
	}
	return loc, true
}

// rank is the display order of a kind, for use as a tiebreak.
var rank = func() map[Kind]int {
	m := make(map[Kind]int, len(kinds))
	for i, k := range kinds {
		m[k] = i
	}
	return m
}()

// sortChronologically orders a derived list: earliest first, undated last.
//
// Done here rather than as an outer ORDER BY on the union for two reasons. It
// is a pure function over at most seven rows, so it is testable without a
// database — and the tiebreak is the `kinds` DISPLAY order, which SQL could
// only express as a CASE listing the vocabulary a second time, in a second
// place, where it could drift from this one.
//
// **Undated last, never first.** A contest recorded with no date still earned
// its award, but it cannot be shown to have come BEFORE something dated —
// sorting a NULL as the beginning of time would put "first competition,
// undated" ahead of the mat awards that genuinely preceded it, and produce a
// career timeline that reads wrong.
func sortChronologically(list []Accomplishment) {
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		switch {
		case a.AchievedOn == nil && b.AchievedOn == nil:
			return rank[a.Kind] < rank[b.Kind]
		case a.AchievedOn == nil:
			return false
		case b.AchievedOn == nil:
			return true
		}
		// Lexical comparison IS chronological for YYYY-MM-DD, which is the
		// whole reason this app stores calendar dates in that layout. No
		// parsing, so a malformed date cannot turn an ordering into an error.
		if *a.AchievedOn != *b.AchievedOn {
			return *a.AchievedOn < *b.AchievedOn
		}
		// Same day: two awards genuinely can land together — a first
		// competition that was also a first gold — so the display order
		// decides, and it is stable rather than whatever the union returned.
		return rank[a.Kind] < rank[b.Kind]
	})
}
