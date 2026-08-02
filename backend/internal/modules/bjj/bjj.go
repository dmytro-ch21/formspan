// Package bjj is the jiu-jitsu-specific athlete record: rank, and the
// promotion history that rank is derived from.
//
// It lives here rather than on `profile` because profile is the account-level
// record four disciplines share, and a belt is meaningless to three of them —
// see the note at the top of profile.go, which called this split before there
// was anything to put in it.
package bjj

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound     = errors.New("bjj: not found")
	ErrInvalidInput = errors.New("bjj: invalid input")
)

// Belt is an adult IBJJF belt.
//
// Kids belts (grey/yellow/orange/green, each in three variants) and the
// coral/red belts are deliberately absent. Adding either is an edit to this
// slice plus a rendering branch in the clients — there is no CHECK constraint
// in the database precisely so neither needs a migration.
type Belt string

const (
	White  Belt = "white"
	Blue   Belt = "blue"
	Purple Belt = "purple"
	Brown  Belt = "brown"
	Black  Belt = "black"
)

// belts, in order. The ORDER is the load-bearing part: it decides which
// promotion is current, so the slice is the single source for both validity
// and comparison.
var belts = []Belt{White, Blue, Purple, Brown, Black}

// MaxStripes is 4 on every belt. A fifth stripe is what promotion to the next
// belt means, so 5 is not a rank this can represent.
const MaxStripes = 4

// MaxDegree is 6. Degrees above that (7th–9th are the coral and red belts)
// are a different belt colour, not a further degree of black.
const MaxDegree = 6

// Rank is a point in the belt system.
type Rank struct {
	Belt    Belt `json:"belt"`
	Stripes int  `json:"stripes"`
	// Degree is black-belt degrees. 0 on every other belt, and 0 on a black
	// belt that has none — both render the same, so there is nothing to
	// distinguish and no reason for a pointer.
	Degree int `json:"degree"`
}

// Order returns a value that sorts ranks correctly, or false for an unknown
// belt.
//
// **This is what "current rank" means, and it is not the most recent date.**
// Dates are optional (plenty of people do not remember when they got their
// blue belt) and are entered by hand, so ordering by them makes the current
// belt a function of data-entry care. Rank in BJJ is monotonic — nobody is
// demoted — so the highest rank recorded IS the current one, and that holds
// whether the promotions were entered in order, backwards, or with no dates
// at all.
func (r Rank) Order() (int, bool) {
	for i, b := range belts {
		if b == r.Belt {
			// Stripes and degrees are within-belt, so they cannot outrank a
			// belt change: white/4 must still sort below blue/0. Multiplying
			// by the maxima+1 keeps each level strictly dominant over the one
			// below it.
			return i*(MaxStripes+1)*(MaxDegree+1) +
				r.Stripes*(MaxDegree+1) +
				r.Degree, true
		}
	}
	return 0, false
}

// Validate reports whether this is a rank the system can represent.
func (r Rank) Validate() error {
	if _, ok := r.Order(); !ok {
		return ErrInvalidInput
	}
	if r.Stripes < 0 || r.Stripes > MaxStripes {
		return ErrInvalidInput
	}
	if r.Degree < 0 || r.Degree > MaxDegree {
		return ErrInvalidInput
	}
	// A degree on a coloured belt is not a thing. Rejecting it rather than
	// silently zeroing it: the client sent something it believed, and quietly
	// dropping a field is how a UI ends up displaying a value the server
	// never stored.
	if r.Degree > 0 && r.Belt != Black {
		return ErrInvalidInput
	}
	return nil
}

// Belts lists the belts in order, for a client that wants to render a picker
// without hardcoding the list a fourth time.
func Belts() []Belt {
	out := make([]Belt, len(belts))
	copy(out, belts)
	return out
}

// Promotion is one rank event: what was awarded, when, where and by whom.
type Promotion struct {
	ID     string `json:"id"`
	UserID string `json:"-"`
	Rank   `json:""`
	// PromotedOn is "YYYY-MM-DD", or nil when the athlete does not remember.
	// An undated promotion still establishes rank — refusing it to protect
	// the metadata would lose the fact itself.
	PromotedOn *string   `json:"promoted_on"`
	Academy    string    `json:"academy"`
	Instructor string    `json:"instructor"`
	Note       string    `json:"note"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Standing is the whole BJJ rank picture for one athlete.
type Standing struct {
	// Current is the highest recorded rank, or nil if nothing is recorded.
	// Nil is a real state and clients must render it — a new account has no
	// belt, and guessing white for them would put a rank on someone who has
	// never trained.
	Current *Rank `json:"current"`
	// TimeAtCurrentDays is days since the promotion that set the current
	// rank, or nil when that promotion has no date. Nil rather than 0: "I
	// don't know" and "today" are different answers.
	TimeAtCurrentDays *int        `json:"time_at_current_days"`
	Promotions        []Promotion `json:"promotions"`
}

// Repository is the persistence port.
type Repository interface {
	ListPromotions(ctx context.Context, userID string) ([]Promotion, error)
	CreatePromotion(ctx context.Context, p Promotion) (Promotion, error)
	UpdatePromotion(ctx context.Context, p Promotion) (Promotion, error)
	DeletePromotion(ctx context.Context, userID, id string) error
}

// StandingFrom derives the whole picture from a promotion list.
//
// A pure function over the rows, so the derivation is testable without a
// database and cannot differ between the read path and any future writer.
func StandingFrom(promotions []Promotion, now time.Time) Standing {
	// Normalised here, not left to the caller. The repository already returns
	// a non-nil empty slice, but this function is what builds the response —
	// so a nil from anywhere else would marshal as `null` and force a null
	// check on every client that iterates it.
	if promotions == nil {
		promotions = []Promotion{}
	}
	s := Standing{Promotions: promotions}
	if len(promotions) == 0 {
		return s
	}

	best := -1
	var current *Promotion
	for i := range promotions {
		o, ok := promotions[i].Order()
		// An unknown belt is skipped rather than sorted as zero. A row
		// written by a newer build (coral, say) must not be read as
		// something below white and silently ignored in favour of a real
		// white belt — better to act as though the row is not there.
		if !ok {
			continue
		}
		if o > best {
			best, current = o, &promotions[i]
		}
	}
	if current == nil {
		return s
	}

	rank := current.Rank
	s.Current = &rank
	if current.PromotedOn != nil {
		if d, err := time.Parse("2006-01-02", *current.PromotedOn); err == nil {
			days := int(now.Sub(d).Hours() / 24)
			// A promotion dated in the future is someone's typo. Reporting a
			// negative time-at-belt would be worse than reporting none.
			if days >= 0 {
				s.TimeAtCurrentDays = &days
			}
		}
	}
	return s
}
