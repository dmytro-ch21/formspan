// Package contest is the competitive record: what you entered, in which
// division, and how it went.
//
// The schema landed first and alone (migration `000050`, 2026-08-10) with no
// module behind it; this is that module. Read the migration before this file —
// it carries the modelling argument, and the two decisions that shape every
// type here are made there rather than here:
//
//   - **One row is one ENTRY, not one event.** Gi and no-gi at the same
//     tournament are two contests. They share a name and a date and nothing
//     else.
//   - **Nothing here is self-rated.** A placement, a bracket size and a
//     referee's decision are externally verifiable, which makes a contest the
//     strongest MEASURED evidence this app holds — `session/basis.go`'s sense
//     of the word. Nothing self-rated may be added to these types; an opinion
//     about how it went belongs on the session that describes the training.
//
// # Vocabulary lives here, not in a CHECK constraint
//
// `sport`, `format`, `result` and `method` are all TEXT with no CHECK, which
// the migration says is deliberate: the vocabulary is validated in Go so that
// adding a value is an enum edit rather than a migration. That trade only pays
// if this file is genuinely the gate, so every one of them is checked on the
// way in — an unvalidated column with no constraint behind it is not a relaxed
// rule, it is no rule.
package contest

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"
)

var (
	ErrNotFound     = errors.New("contest: not found")
	ErrInvalidInput = errors.New("contest: invalid input")
)

// invalid wraps ErrInvalidInput with a message the handler passes straight to
// the caller. Matching `curriculum`, whose handler also surfaces `err.Error()`
// for this sentinel: a client that sent fifteen fields deserves to know which
// one was refused, and one flat message per endpoint cannot say.
func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidInput, fmt.Sprintf(format, args...))
}

// Result is how one match ended for the athlete.
//
// A draw is deliberately absent, as the migration notes — IBJJF brackets do
// not draw. Adding one is an edit to this block plus `validResults`.
type Result string

const (
	Won  Result = "won"
	Lost Result = "lost"
)

var validResults = map[Result]bool{Won: true, Lost: true}

// Method is how the match was decided.
//
// This is the half that makes `contest_matches` worth its cost over six
// counter columns on the entry: "lost on advantages" and "lost by armbar" are
// different findings, and a counter cannot tell them apart.
type Method string

const (
	MethodSubmission Method = "submission"
	MethodPoints     Method = "points"
	MethodAdvantage  Method = "advantage"
	MethodPenalty    Method = "penalty"
	MethodDecision   Method = "decision"
	MethodDQ         Method = "dq"
	MethodWalkover   Method = "walkover"
)

var validMethods = map[Method]bool{
	MethodSubmission: true, MethodPoints: true, MethodAdvantage: true,
	MethodPenalty: true, MethodDecision: true, MethodDQ: true, MethodWalkover: true,
}

// Format is how the matches were scored.
//
// Not called `ruleset`: that word is spoken for by the technique library's
// `techniques.ibjjf_ruleset_id`, which means IBJJF rule LEGALITY. The migration
// opens with that naming argument and it applies to the column and the Go
// vocabulary alike.
type Format string

const (
	FormatPoints         Format = "points"
	FormatSubmissionOnly Format = "submission_only"
)

var validFormats = map[Format]bool{FormatPoints: true, FormatSubmissionOnly: true}

// The free-text caps.
//
// **These are the only bound on these columns.** Every one is TEXT with no
// length constraint in the database — unlike `training_themes`, where the CHECK
// is the guarantee and the Go constant is only the error message. Here the Go
// constant IS the guarantee, so removing one does not merely worsen an error,
// it lets an athlete store a megabyte in `opponent`. The request body limit in
// the handler is the second line, not the first: it bounds the whole payload,
// not any single field.
const (
	MaxName         = 120
	MaxOrganisation = 80
	MaxDivision     = 40
	MaxNote         = 500
	MaxOpponent     = 80
	MaxMatchNote    = 280
)

// MaxMatches caps one entry's bracket.
//
// A cap has to exist, and the hard reason is the column rather than good
// taste: `contest_matches.position` is SMALLINT, so position 32,768 fails with
// SQLSTATE 22003 — a numeric overflow, NOT a constraint violation, which a
// repository translating by constraint name would pass through as an unmapped
// internal error. The migration flags exactly this trap on `contests.placement`
// and it applies here too. 64 is then the practical number: the largest IBJJF
// bracket is 128 entrants, which is seven matches to a final.
const MaxMatches = 64

// maxPlacement bounds `placement` and `entrants` for the same reason
// MaxMatches exists, and the migration spells the trap out on these two
// columns specifically. They are INTEGER — deliberately, so a 60,000-runner
// road race can record finishing 41,203rd — and INTEGER still overflows at
// 2,147,483,647 with a 22003 rather than a check violation. Refusing above the
// column's own ceiling keeps every rejection a 400 that names the field.
const maxPlacement = 2147483647

// Match is one bout inside an entry.
//
// # Why there is no `id` here
//
// `contest_matches.id` is a BIGINT identity, and matches are replaced wholesale
// on every write (see Repository.Update) — so the id of the third match changes
// every time the entry is edited. Exposing it would invite a client to treat it
// as a handle and hold a reference that silently starts pointing at a different
// match. POSITION is the stable identifier within an entry, and it is the one
// the unique constraint is on.
//
// `created_at` is omitted for the same reason: on a replaced row it records
// when the edit happened, not when the match did, and a client rendering it as
// the latter would be wrong in a way nothing corrects.
type Match struct {
	// Position is the order within the bracket, 1-based. ASSIGNED BY THE
	// SERVER from the order the matches arrive in — a client does not send it
	// and cannot choose it. That is what makes the unique constraint
	// unviolatable from outside, and it means "lost in the final" is expressed
	// by putting that match last rather than by trusting a client's numbering.
	Position int `json:"position"`

	Result Result `json:"result"`
	// Method is empty when not recorded, which is normal for an entry logged
	// from memory years later.
	Method Method `json:"method"`
	// TechniqueID names the submission when there was one and the athlete
	// knows it. A pointer because the column is a nullable FK into the shared
	// library: "" would be a missing FK target rather than an absent one.
	TechniqueID *string `json:"technique_id"`
	Opponent    string  `json:"opponent"`
	Note        string  `json:"note"`
}

// Contest is one entry: one athlete, one bracket, one result.
type Contest struct {
	ID string `json:"id"`
	// UserID never crosses the wire — it is the caller, and a response that
	// echoed it would invite a client to compare ids and call that
	// authorization.
	UserID string `json:"-"`

	Sport        string `json:"sport"`
	Name         string `json:"name"`
	Organisation string `json:"organisation"`
	// HeldOn is "YYYY-MM-DD", or nil when the athlete does not remember.
	// Nullable on the migration's stated reasoning: refusing an undated entry
	// would lose the fact in order to protect the metadata. It simply cannot
	// sit on a timeline.
	HeldOn *string `json:"held_on"`
	Format Format  `json:"format"`
	// Gi is three-state — nil is "didn't say", which is a different fact from
	// gi or no-gi and has to stay tellable. Same convention as
	// `bjj_session_details.gi`.
	Gi *bool `json:"gi"`

	// The division as three independent parts, flat rather than nested,
	// because api-conventions.md maps JSON to columns 1:1 and these are three
	// columns. Nesting them would be the only object in the payload that does
	// not correspond to something in the table.
	DivisionBelt   string `json:"division_belt"`
	DivisionAge    string `json:"division_age"`
	DivisionWeight string `json:"division_weight"`

	// Placement is 1 for a win. Nil is "not recorded" and NOT "did not place" —
	// the migration refuses a sentinel because 0 or 99 would make every future
	// ORDER BY and AVG wrong in a different way.
	Placement *int `json:"placement"`
	// Entrants is what gives a placement its meaning: third of four and third
	// of sixty-four are not the same result.
	Entrants *int `json:"entrants"`

	Note string `json:"note"`

	// Matches always marshals as an array, never null, so a client can iterate
	// it without a null check.
	Matches []Match `json:"matches"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Input is everything a caller may set. Create and Update take the same type
// because PUT replaces the whole entry — see the route comment in main.go for
// why this resource is a PUT and not a PATCH.
type Input struct {
	Sport          string
	Name           string
	Organisation   string
	HeldOn         *string
	Format         Format
	Gi             *bool
	DivisionBelt   string
	DivisionAge    string
	DivisionWeight string
	Placement      *int
	Entrants       *int
	Note           string
	Matches        []Match
}

const dateLayout = "2006-01-02"

// Validate checks everything the database will not.
//
// Split from the handler so the accepting cases are testable: a VALID input
// passes validation and goes on to the repository, which needs claims that
// `auth`'s unexported context key makes impossible to forge — so a
// handler-level test can only ever cover the rejections. `theme.CleanTitle`
// was extracted for this exact reason, and records that testing only the
// refusal is what let a bytes-for-runes bug survive elsewhere.
//
// It normalises as well as checks: trimming is done here so that a name of
// three spaces is refused rather than stored, and so the repository is handed
// a value it can write unchanged.
func (in *Input) Validate() error {
	if !discipline.ValidSport(in.Sport) {
		return invalid("sport must be one of %s", discipline.SportList())
	}

	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return invalid("name is required")
	}
	// Runes, not bytes, everywhere below. `len` would refuse 80 Japanese
	// characters at 240 bytes; the point of a cap is a bound on what a human
	// typed. CLAUDE.md records a rename endpoint that got this wrong and a test
	// that passed against the bug because it only ever asserted the refusal.
	if err := capRunes("name", in.Name, MaxName); err != nil {
		return err
	}

	in.Organisation = strings.TrimSpace(in.Organisation)
	if err := capRunes("organisation", in.Organisation, MaxOrganisation); err != nil {
		return err
	}

	if in.HeldOn != nil {
		// An empty string is the shape a form sends for "cleared", and it means
		// the same thing as omitting the field. Normalised to nil rather than
		// refused, so a client need not special-case its own empty input.
		if strings.TrimSpace(*in.HeldOn) == "" {
			in.HeldOn = nil
		} else if _, err := time.Parse(dateLayout, *in.HeldOn); err != nil {
			return invalid("held_on must be YYYY-MM-DD or null")
		}
	}

	// Empty is a real value: a powerlifting meet and a 10k have no format.
	if in.Format != "" && !validFormats[in.Format] {
		return invalid("format must be one of points, submission_only, or empty")
	}

	in.DivisionBelt = strings.TrimSpace(in.DivisionBelt)
	in.DivisionAge = strings.TrimSpace(in.DivisionAge)
	in.DivisionWeight = strings.TrimSpace(in.DivisionWeight)
	for field, v := range map[string]string{
		"division_belt":   in.DivisionBelt,
		"division_age":    in.DivisionAge,
		"division_weight": in.DivisionWeight,
	} {
		if err := capRunes(field, v, MaxDivision); err != nil {
			return err
		}
	}

	// Checked here as well as by the database, and the reason is the error
	// rather than the safety. `contests_placement_positive` and
	// `contests_placement_within_field` would both refuse these — but the
	// OVERFLOW above INTEGER would not: it raises 22003, which is not a
	// constraint violation and carries no constraint name to translate by.
	// Bounding the value here is what keeps that a 400 naming the field.
	if err := positive("placement", in.Placement); err != nil {
		return err
	}
	if err := positive("entrants", in.Entrants); err != nil {
		return err
	}
	if in.Placement != nil && in.Entrants != nil && *in.Placement > *in.Entrants {
		return invalid("placement cannot exceed entrants")
	}

	in.Note = strings.TrimSpace(in.Note)
	if err := capRunes("note", in.Note, MaxNote); err != nil {
		return err
	}

	return in.validateMatches()
}

func (in *Input) validateMatches() error {
	// Normalised so the repository and the response both see [] rather than
	// nil. An entry with no matches recorded is entirely ordinary — a placement
	// alone is a complete thing to remember.
	if in.Matches == nil {
		in.Matches = []Match{}
	}
	if len(in.Matches) > MaxMatches {
		return invalid("a contest can hold at most %d matches", MaxMatches)
	}
	for i := range in.Matches {
		m := &in.Matches[i]
		// Assigned, not accepted. A client's own numbering is never trusted:
		// server-side positions are what make `contest_matches_unique_position`
		// unviolatable from outside, and they mean array order is the bracket
		// order — which is the only thing that makes "lost in the final"
		// distinguishable from "lost the first match".
		m.Position = i + 1

		if !validResults[m.Result] {
			return invalid("match %d: result must be won or lost", m.Position)
		}
		if m.Method != "" && !validMethods[m.Method] {
			return invalid(
				"match %d: method must be one of submission, points, advantage, penalty, decision, dq, walkover, or empty",
				m.Position)
		}
		if m.TechniqueID != nil {
			// Same normalisation as held_on: "" from a cleared select means
			// absent, and storing it would be a foreign key that cannot match.
			if strings.TrimSpace(*m.TechniqueID) == "" {
				m.TechniqueID = nil
			}
		}
		// A technique is what the submission WAS, so naming one on a match that
		// did not end by submission is a contradiction rather than extra
		// detail. Refused rather than silently dropped: quietly discarding a
		// field is how a UI ends up displaying a value the server never stored
		// — the same call `bjj.Rank.Validate` makes for a degree on a coloured
		// belt.
		if m.TechniqueID != nil && m.Method != MethodSubmission {
			return invalid("match %d: technique_id is only meaningful when method is submission", m.Position)
		}
		m.Opponent = strings.TrimSpace(m.Opponent)
		if err := capRunes(fmt.Sprintf("match %d: opponent", m.Position), m.Opponent, MaxOpponent); err != nil {
			return err
		}
		m.Note = strings.TrimSpace(m.Note)
		if err := capRunes(fmt.Sprintf("match %d: note", m.Position), m.Note, MaxMatchNote); err != nil {
			return err
		}
	}
	return nil
}

func capRunes(field, v string, max int) error {
	if utf8.RuneCountInString(v) > max {
		return invalid("%s must be at most %d characters", field, max)
	}
	return nil
}

func positive(field string, v *int) error {
	if v == nil {
		return nil
	}
	if *v < 1 {
		return invalid("%s must be at least 1 when given", field)
	}
	if *v > maxPlacement {
		return invalid("%s is out of range", field)
	}
	return nil
}

// Repository is the persistence port.
//
// Every method takes userID as its own argument rather than reading it off a
// domain struct, so a repository implementation cannot accidentally scope a
// query by an id that arrived in a request body. `bjj`'s promotion update
// documents the IDOR this shape prevents; the reviewers have caught it twice
// in this codebase.
type Repository interface {
	// List returns the caller's entries, newest first, capped.
	List(ctx context.Context, userID string) ([]Contest, error)
	// Get returns one entry with its matches, or ErrNotFound.
	Get(ctx context.Context, userID, id string) (*Contest, error)
	// Create writes a new entry and its matches in one transaction.
	Create(ctx context.Context, userID string, in Input) (*Contest, error)
	// Update replaces an entry and ALL of its matches, or ErrNotFound.
	Update(ctx context.Context, userID, id string, in Input) (*Contest, error)
	// Delete removes an entry; its matches go with it by ON DELETE CASCADE.
	Delete(ctx context.Context, userID, id string) error
}
