package bjj

import (
	"context"
	"time"
)

// The BJJ half of a session.
//
// A BJJ session is a row in `sessions` like any other — that is what keeps it
// visible to training history, the consistency grid and the cross-sport load
// currency. This file owns only what a mat session has and a barbell session
// does not, hanging off that row.
//
// The split mirrors how sets attach to a session, deliberately: the client
// creates the session through the session module, then PUTs the discipline's
// own detail alongside it. Nothing here writes the `sessions` table.

// Kind is what the session actually was.
//
// Four rather than one because they are different training, not different
// intensities of the same training: an hour of drilling and an hour of hard
// rounds cost the body different amounts and produce different evidence.
// Deliberately not a CHECK in the database — see the migration.
type Kind string

const (
	// KindClass is a taught class: instruction, usually some drilling,
	// usually some rounds at the end.
	KindClass Kind = "class"
	// KindDrilling is repetition work with a cooperative partner.
	KindDrilling Kind = "drilling"
	// KindPositional is starting from a set position and going live from
	// there — between drilling and rolling in both intent and cost.
	KindPositional Kind = "positional"
	// KindRolling is free sparring.
	KindRolling Kind = "rolling"
)

var kinds = []Kind{KindClass, KindDrilling, KindPositional, KindRolling}

// Kinds lists the session kinds, for a client rendering a picker without
// hardcoding the list a second time.
func Kinds() []Kind {
	out := make([]Kind, len(kinds))
	copy(out, kinds)
	return out
}

func (k Kind) Valid() bool {
	for _, v := range kinds {
		if v == k {
			return true
		}
	}
	return false
}

// Category is what kind of action a tag records.
//
// Drawn from the technique library's own category vocabulary so that tagging
// a technique can prefill it, and kept to the six that have a genuine
// symmetric opposite — you can hit a sweep or be swept, but "transition" has
// no meaningful other side, so it is not offered.
type Category string

const (
	CategorySubmission Category = "submission"
	CategorySweep      Category = "sweep"
	CategoryPass       Category = "pass"
	CategoryEscape     Category = "escape"
	CategoryTakedown   Category = "takedown"
	CategoryControl    Category = "control"
)

var categories = []Category{
	CategorySubmission, CategorySweep, CategoryPass,
	CategoryEscape, CategoryTakedown, CategoryControl,
}

func Categories() []Category {
	out := make([]Category, len(categories))
	copy(out, categories)
	return out
}

func (c Category) Valid() bool {
	for _, v := range categories {
		if v == c {
			return true
		}
	}
	return false
}

// Event is the outcome direction, and the reason the tag table is worth its
// cost.
//
// drilled → attempted → scored is the technique funnel; its drop-offs are the
// most actionable numbers in the sport. Conceded is the symmetric half and the
// more valuable one — "where do I keep getting stuck" is the question a schema
// that recorded only successes could never answer.
//
// # The live four are a 2x2, and `defended` is the cell that was missing
//
// Every live event answers two questions: who started it, and did it land.
//
//	                it landed     it did not
//	I initiated      scored        attempted
//	they initiated   conceded      defended
//
// Three of those shipped. `defended` — they went for it and you stopped them —
// did not, which meant the schema could record every way an exchange goes
// EXCEPT succeeding defensively. That is not a small gap: it made defensive
// skill the one thing the app could only infer from absence, and an absence
// gets more convincing the LESS you roll, which is backwards.
//
// Adding it needed no migration. `bjj_session_tags.event` is TEXT with no
// CHECK precisely so this vocabulary could grow in Go — see 000025, which took
// the same stance for `kind` and said so.
type Event string

const (
	// EventDrilled is practised, not live.
	EventDrilled Event = "drilled"
	// EventAttempted is tried live and did not land.
	EventAttempted Event = "attempted"
	// EventScored is landed live.
	EventScored Event = "scored"
	// EventConceded is having it done to you.
	EventConceded Event = "conceded"
	// EventDefended is them going for it and you stopping them — the mirror
	// of EventAttempted, and the completion of the 2x2 above.
	EventDefended Event = "defended"
)

var events = []Event{EventDrilled, EventAttempted, EventScored, EventConceded, EventDefended}

func Events() []Event {
	out := make([]Event, len(events))
	copy(out, events)
	return out
}

func (e Event) Valid() bool {
	for _, v := range events {
		if v == e {
			return true
		}
	}
	return false
}

// sportKey is the `sessions.sport` value this module owns.
//
// Matches the registry key in `internal/platform/discipline`. Duplicated as a
// constant rather than imported because the dependency would run the wrong
// way — the registry describes what a client may enable, and this is a
// storage-level invariant about which rows this module may write to.
const sportKey = "bjj"

// MaxTags bounds the tag stream on one session. Mirrors maxSets in the
// session module — same reasoning, same order of magnitude.
const MaxTags = 500

// MaxRPE is the top of the session-RPE scale. 1–10 matches `session_sets.rpe`
// and the Foster sRPE method the load currency is built on.
const MaxRPE = 10

// Tag is one piece of evidence from a session.
//
// Never a self-assessment. "Attempted twice from closed guard, hit once" is a
// fact that stays true; "my triangle is a 3/5" is a number with no provenance
// that goes stale the week after it is entered.
type Tag struct {
	ID       int64    `json:"id"`
	Category Category `json:"category"`
	Event    Event    `json:"event"`
	// Position is the position family ("Half Guard", "Mount"), matching the
	// library's own filter granularity. Empty is a normal fast-path outcome,
	// not an error — requiring it would slow the path that has to stay fast.
	Position string `json:"position"`
	// TechniqueID is the specific technique when the athlete named one.
	// Nil is ordinary: "got swept from half guard" is real evidence and must
	// not require naming the sweep.
	TechniqueID *string `json:"technique_id"`
	// Count, because reflection is recalled in counts. Three armbars is one
	// tag with count 3, not three tags.
	Count int `json:"count"`
}

// Validate reports whether this is a tag the system can store and later read
// as evidence.
// maxTagCount bounds one tag's repetitions. Generous — nobody hits 1000
// armbars in a session — so it constrains only nonsense.
const maxTagCount = 1000

func (t Tag) Validate() error {
	if !t.Category.Valid() || !t.Event.Valid() {
		return ErrInvalidInput
	}
	// Upper bound as well as lower. SUM(count) is a bigint that the proficiency
	// query narrows with ::int, so two rows near math.MaxInt32 on one technique
	// make that read fail with "integer out of range" — a 500 that STAYS
	// broken for that athlete until the sessions are deleted, because the bad
	// data is durable. Self-inflicted only (the endpoint is self-scoped), but a
	// ceiling is cheaper than the support conversation.
	if t.Count < 1 || t.Count > maxTagCount {
		return ErrInvalidInput
	}
	// A technique id that is present but empty is a client bug rather than an
	// untagged event, and storing it would produce a row that joins to
	// nothing. Untagged is expressed by omitting the field.
	if t.TechniqueID != nil && *t.TechniqueID == "" {
		return ErrInvalidInput
	}
	return nil
}

// SessionDetail is everything the reflection captured, minus the session row
// itself.
type SessionDetail struct {
	SessionID string `json:"session_id"`
	Kind      Kind   `json:"kind"`
	// Gi is nil for "didn't say", which is a different fact from gi or no-gi
	// and has to stay tellable — the three-tap floor does not ask.
	Gi *bool `json:"gi"`
	// Rounds and RoundMinutes are the sparring volume. Both nil-able: a class
	// you turned up to and did not spar is a real session.
	Rounds       *int `json:"rounds"`
	RoundMinutes *int `json:"round_minutes"`
	// SessionRPE is the single highest-information input in the app, and the
	// internal-load half of sRPE × duration.
	SessionRPE *int      `json:"session_rpe"`
	Academy    string    `json:"academy"`
	Note       string    `json:"note"`
	BodyNote   string    `json:"body_note"`
	Tags       []Tag     `json:"tags"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Validate checks the detail the client is asking to store.
func (d SessionDetail) Validate() error {
	if !d.Kind.Valid() {
		return ErrInvalidInput
	}
	if d.SessionRPE != nil && (*d.SessionRPE < 1 || *d.SessionRPE > MaxRPE) {
		return ErrInvalidInput
	}
	if d.Rounds != nil && *d.Rounds < 1 {
		return ErrInvalidInput
	}
	if d.RoundMinutes != nil && *d.RoundMinutes < 1 {
		return ErrInvalidInput
	}
	// Bounded for the same reason as maxSets on a strength session: the
	// tag list is client-supplied and each entry becomes a row, so an
	// unbounded body is an unbounded transaction. A hard session produces
	// tens of tags; 500 is far past anything real.
	if len(d.Tags) > MaxTags {
		return ErrInvalidInput
	}
	for _, t := range d.Tags {
		if err := t.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// RollingMinutes is the sparring volume in minutes, or 0 when the athlete did
// not record rounds.
//
// Deliberately NOT the session's duration: `sessions.ended_at - started_at` is
// the mat time and stays the authority for the load calculation. This is the
// harder subset of it, which is the number "hard rounds this week" is really
// asking about.
func (d SessionDetail) RollingMinutes() int {
	if d.Rounds == nil || d.RoundMinutes == nil {
		return 0
	}
	return *d.Rounds * *d.RoundMinutes
}

// SessionRepository is the persistence port for the BJJ half of a session.
type SessionRepository interface {
	// PutDetail upserts the detail and replaces the tag set wholesale.
	//
	// Replace rather than merge for the same reason sets are replaced: the
	// client holds the desired state and re-sends it, so a retry after a
	// partial failure converges instead of duplicating.
	PutDetail(ctx context.Context, userID string, d SessionDetail) (SessionDetail, error)
	GetDetail(ctx context.Context, userID, sessionID string) (SessionDetail, error)
}
