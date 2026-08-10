// Package curriculum is the ordered-set-of-techniques domain: VOLA-authored
// belt syllabuses, the athlete's own lists, and — when the items carry
// completion criteria — the roadmaps built on them.
//
// It is deliberately NOT a suggestion engine. Following a curriculum says what
// you intend to learn; the suggestion tiers in the mobile app say what your
// logs report about how it is going. Keeping those apart is what stops a
// curriculum silently becoming a prescription, and it is why nothing in this
// package reads or writes bjj_focus.
package curriculum

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound      = errors.New("curriculum: not found")
	ErrAlreadyExists = errors.New("curriculum: already exists")
	ErrInvalidInput  = errors.New("curriculum: invalid input")
	// ErrForbidden is separate from ErrNotFound on purpose, but note the
	// handler maps BOTH to 404 for reads — see writeError. Having the distinct
	// error internally means the repository can say what it means; collapsing
	// it at the boundary is what stops the API confirming that somebody else's
	// private curriculum exists.
	ErrForbidden = errors.New("curriculum: forbidden")
	// ErrInUse is a curriculum other athletes are working. Deleting it would
	// take their record of having worked it with it, so the FK refuses -- see
	// curriculum_enrollments' ON DELETE RESTRICT.
	ErrInUse = errors.New("curriculum: other athletes are working this")
)

// Curriculum is the list itself.
type Curriculum struct {
	ID string `json:"id"`
	// OwnerUserID is nil for a VOLA-authored syllabus. Same convention as
	// workouts, and it is what the sharing model is built on.
	//
	// Deliberately NOT serialised: a client needs to know whether it may edit
	// this, which `Editable` answers, and not who else's account owns it.
	OwnerUserID *string `json:"-"`
	// Editable is computed per caller — see Repository. It exists so a client
	// never has to compare user ids to decide whether to show an edit affordance,
	// which is the shape that produces client-side authorization.
	Editable bool   `json:"editable"`
	Name     string `json:"name"`
	// Belt this is the fundamentals for, or nil for an athlete's own list.
	//
	// A HINT FOR ORDERING, NOT A GATE. The app knows the athlete's rank from
	// bjj_promotions, so "Blue belt basics" can surface first — but working
	// white-belt fundamentals at purple is not a mistake and nothing here
	// refuses it.
	Belt *string `json:"belt"`
	// Track is which browse section this belongs to — "belt", "foundations",
	// and whatever comes next. Same contract as Belt: a hint for grouping,
	// never a gate, and nil for an athlete's own list, which lives under
	// "mine" rather than in any section.
	Track       *string `json:"track"`
	Description string  `json:"description"`
	Visibility  string  `json:"visibility"`
	// Enrolled reports whether the CALLER is working this one, and StartedOn
	// when they took it on. Both are per-caller, like Editable.
	Enrolled  bool      `json:"enrolled"`
	StartedOn *string   `json:"started_on"` // "YYYY-MM-DD", nil unless enrolled
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// Phases is the curriculum's internal structure — "Survive the bad places
	// first", with the objective and performance expectations in the
	// description. Same lazy contract as Items: nil on list responses,
	// populated on a single read. Items point INTO this array via their Phase
	// index; an item with a nil Phase is unphased, and a flat curriculum has
	// no phases at all.
	Phases []Phase `json:"phases,omitempty"`
	// Items is nil on list responses and populated on a single read. A
	// syllabus is a dozen techniques and a list is a dozen syllabuses; sending
	// every item on every list read is the N+1 in its lazy form.
	Items []Item `json:"items,omitempty"`
	// ItemCount is how many items are in it — techniques AND concepts —
	// present on BOTH the list and the single read: a card has to be able to
	// say "12 items" without fetching all of them.
	ItemCount int `json:"item_count"`
	// CountableItems and MasteredItems ship THE PROGRESS RULE rather than
	// leaving each client to invent it.
	//
	// Progress counts only items that carry criteria, so a ten-item curriculum
	// with three roadmap steps is three items' worth of progress and not three
	// tenths. A client handed only `items` and a per-item `mastered` would
	// divide by len(items) -- which is the silent wrong answer the migration's
	// comment warns about. Both are zero on list responses, where Items is
	// absent.
	CountableItems int `json:"countable_items"`
	MasteredItems  int `json:"mastered_items"`
}

// Phase is one named section of a curriculum. Order is its identity — items
// reference a phase by this number — and Description is where the phase's
// objective and performance expectations live.
type Phase struct {
	Order       int    `json:"order"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

// Item is one entry in the list. A `technique` item points into the shared
// library and may carry mastery criteria; a `concept` item is authored text —
// "position before submission", a graduation standard — and never carries
// criteria, because no evidence stream could measure one and nothing here may
// be completable by hand.
type Item struct {
	Kind string `json:"kind"`
	// TechniqueID is empty on concept items, which point at nothing.
	TechniqueID string `json:"technique_id,omitempty"`
	// Title is the concept's own heading, and empty on technique items — their
	// name is the library's, and storing one here could disagree with it.
	Title string `json:"title,omitempty"`
	// Name, Position and Category come from the shared library so a client can
	// render the list without a second fetch — same reason Focus carries them.
	// All empty on concept items.
	Name     string `json:"name"`
	Position string `json:"position"`
	Category string `json:"category"`
	Order    int    `json:"order"`
	// Phase is the index of the phase this item belongs to, nil when unphased.
	Phase *int   `json:"phase"`
	Notes string `json:"notes"`
	// Criteria is nil when this item has no completion criterion, which is what
	// makes the same table serve a plain reading list and a roadmap.
	Criteria *Criteria `json:"criteria"`
	// Progress is nil when Criteria is, and when the caller is not enrolled.
	// There is no progress toward a target that does not exist.
	Progress *Progress `json:"progress"`
}

// Criteria is what mastering this technique takes.
//
// Every threshold is a bar the RECORD has to clear. There is deliberately no
// way to mark a technique mastered by hand — not in this struct, not in the
// schema, not on any endpoint. A roadmap whose completions can be self-declared
// cannot tell an athlete anything they did not already believe.
type Criteria struct {
	// TargetScored is times landed live, since enrolling.
	//
	// Nil is allowed, and the case it serves is the one that justified adding
	// the `defended` event at all: "not get caught in guard pull N times" has
	// no offensive half. The schema requires at least one of this and
	// TargetDefended (curriculum_items_criteria_anchored).
	TargetScored *int `json:"target_scored"`
	// TargetDefended is times you stopped theirs. Nil where a technique has no
	// meaningful defensive counterpart — a criterion nobody can satisfy is a
	// roadmap that never finishes.
	//
	// Should be about a THIRD of TargetScored. Not because defence matters
	// less: you choose when to attempt a technique and not when one is
	// attempted on you, so the evidence arrives roughly 3.2x more slowly, and a
	// symmetric criterion leaves a roadmap stuck at three-quarters complete.
	TargetDefended *int `json:"target_defended"`
	// TargetSessions is how many distinct sessions the evidence must span —
	// the guard against one big open mat against a tired training partner.
	TargetSessions *int `json:"target_sessions"`
	// MinHitRate is scored / (attempted + scored), and it is the reason this
	// package is allowed to use the word "mastered" at all.
	//
	// A volume threshold says nothing about the denominator: 25-from-30 and
	// 25-from-400 satisfy it equally and only the first is skill. The rate is
	// computable because migration 000025 keeps `attempted` and `scored`
	// DISJOINT — `attempted` means "tried it live, it didn't land", not total
	// tries — so this is a real hit rate rather than an estimate.
	MinHitRate *float64 `json:"min_hit_rate"`
	// TargetDrilledSessions is distinct sessions carrying a `drilled` tag for
	// this technique, since enrolling — the criterion for the movement
	// fundamentals a beginner will never score with (a breakfall, a shrimp).
	//
	// SESSIONS, not volume, on purpose: drilling a movement forty times in one
	// class is one class, and spread across weeks is the only claim a drilled
	// criterion can honestly make. This is the ONE place drilled evidence
	// counts — every other criterion excludes it, because practice must not
	// satisfy a bar about live use.
	TargetDrilledSessions *int `json:"target_drilled_sessions"`
}

// Progress is the caller's evidence against one item's criteria.
//
// Recomputed on every read and stored nowhere. A stored derivation goes stale
// against the evidence it came from, and deleting a session has to withdraw the
// claim it supported — the same argument lib/adherence.ts makes on the client.
type Progress struct {
	Scored   int `json:"scored"`
	Defended int `json:"defended"`
	Sessions int `json:"sessions"`
	// Attempts is scored + attempted — how often they went for it. Sent so a
	// client can show the rate honestly rather than recomputing a denominator
	// it would have to guess at.
	Attempts int `json:"attempts"`
	// HitRate is nil when Attempts is zero. Zero-from-zero is not a rate, and
	// rendering it as 0% would report a failure the athlete has not had.
	HitRate *float64 `json:"hit_rate"`
	// DrilledSessions is distinct sessions in which this was drilled — the
	// evidence TargetDrilledSessions measures, and reported even where no
	// criterion reads it, so a client can show practice alongside live use.
	DrilledSessions int  `json:"drilled_sessions"`
	Mastered        bool `json:"mastered"`
}

// Met reports whether this progress clears every criterion.
//
// Lives here rather than in SQL so it is testable without a database and so
// there is exactly one definition of mastered. The repository computes the
// COUNTS; this decides what they mean.
func (p Progress) Met(c Criteria) bool {
	if c.TargetScored != nil && p.Scored < *c.TargetScored {
		return false
	}
	if c.TargetDefended != nil && p.Defended < *c.TargetDefended {
		return false
	}
	if c.TargetSessions != nil && p.Sessions < *c.TargetSessions {
		return false
	}
	if c.TargetDrilledSessions != nil && p.DrilledSessions < *c.TargetDrilledSessions {
		return false
	}
	if c.MinHitRate != nil {
		// No attempts means no rate, and no rate cannot clear a rate bar. The
		// schema guarantees a rate is accompanied by TargetScored
		// (curriculum_items_hit_rate_needs_volume), so reaching that target
		// already implies attempts — this branch is here so the method is total
		// rather than relying on a constraint in another file.
		if p.HitRate == nil || *p.HitRate < *c.MinHitRate {
			return false
		}
	}
	return true
}

// Countable reports whether this item participates in progress at all.
//
// THE PROGRESS RULE, and it lives here so the first caller to render a
// percentage cannot pick one silently: progress counts only items that carry
// criteria. An item without them is reading, and reading is not something the
// record can mark done — so a ten-item curriculum where three carry criteria is
// three items' worth of progress, not three tenths.
//
// A curriculum where nothing carries criteria has no progress at all. Not 0%,
// which reads as failure, and not 100%, which claims something.
func (i Item) Countable() bool { return i.Criteria != nil }

// Mastered reports whether this item is done. False for a reading item, which
// can never be.
func (i Item) Mastered() bool { return i.Progress != nil && i.Progress.Mastered }

// Defaults for a new roadmap item, and the reasoning for each.
//
// NOT SQL DEFAULTs: the columns are plain nullable, because "no criterion"
// has to stay expressible — a curriculum is also allowed to be a reading list,
// and a column default would silently make every item a roadmap step. These
// apply where a client asks for a criterion without saying what it is.
const (
	// DefaultTargetScored: 25 lands in roughly 30 focus-sessions at the
	// modelled rate — about ten weeks. The earlier draft's 10 cleared in a
	// month, which is not what anyone means by mastering a technique.
	DefaultTargetScored = 25
	// DefaultTargetDefended: a third of the above, so the two halves complete
	// at about the same moment rather than defence gating everything.
	DefaultTargetDefended = 8
	// DefaultTargetSessions: well below the volume target on purpose. This is
	// the shape constraint, not the binding one.
	DefaultTargetSessions = 12
	// DefaultMinHitRate: landing a specific named technique on a resisting
	// opponent better than a third of the times you commit to it is a good
	// number. Note what it implies — 25 scores at 0.35 is roughly 70 live
	// attempts at one technique.
	DefaultMinHitRate = 0.35
)

// Bounds. Every list write is client-owned and replaced wholesale, so these
// are the only thing standing between a typo and an unbounded row count.
const (
	// MaxItems was 60 when every item was a measurable technique. A
	// phase-structured belt curriculum is mostly CONCEPT items — cheap text
	// that never enters the progress query — so the ceiling rises with the
	// redesign. Still far under anything that would make the progress query
	// expensive, because that query only ever sees the technique items.
	MaxItems = 150
	// MaxPhases is generous next to the real material — the largest belt
	// curriculum drafted has eleven.
	MaxPhases = 20
	// MaxBody rose with MaxItems: 150 items plus authored phase prose can
	// brush 64 KB, and the failure there is a truncated decode reported as
	// "invalid JSON body" — deterministic but misleading. Still trivially
	// bounded.
	MaxBody = 128 << 10
	// maxList caps the list response.
	//
	// api-conventions.md is explicit that a list endpoint without a LIMIT
	// silently unbounds the peak-memory property the conditional-GET buffering
	// depends on -- and this list is worse than most, because it spans every
	// user's PUBLIC curricula. Without a cap any user can grow every other
	// user's response.
	maxList = 200
)

// NewCurriculum is the input for creating one. Ownership is not a field: it is
// always the caller, and a request that could name an owner is a request that
// could name somebody else.
type NewCurriculum struct {
	Name        string
	Description string
	Belt        *string
	Track       *string
	Visibility  string
	Phases      []NewPhase
	Items       []NewItem
}

// Update is a partial update — nil fields are left unchanged. Items is nil to
// leave the list alone and non-nil (possibly empty) to replace it wholesale,
// matching every other client-owned list here.
type Update struct {
	Name        *string
	Description *string
	// SetBelt distinguishes "leave it alone" from "clear it". Belt is only
	// consulted when SetBelt is true, so a nil Belt with SetBelt set means
	// null -- which a lone *string could not express.
	SetBelt bool
	Belt    *string
	// Track gets the same treatment as Belt, for the same reason.
	SetTrack   bool
	Track      *string
	Visibility *string
	// Items nil leaves the CONTENT — items and phases together — alone;
	// non-nil replaces both wholesale. They travel as one because an item
	// names its phase by index into the accompanying array: replacing items
	// against somebody's idea of the previous phases is exactly the
	// half-updated state wholesale replacement exists to rule out. Phases is
	// only consulted when Items is non-nil.
	Phases []NewPhase
	Items  []NewItem
}

// NewPhase is one phase as a client sends it. Order is implied by array
// position, exactly as item order is.
type NewPhase struct {
	Title       string
	Description string
}

// NewItem is one item as a client sends it. The library fields (name, position,
// category) are deliberately absent — they are the library's, and accepting
// them would let a client store a name that disagrees with the catalog.
type NewItem struct {
	// Kind is "technique" or "concept"; empty means technique, which is what
	// every client predating the kinds sends.
	Kind        string
	TechniqueID string
	Title       string
	Phase       *int
	Notes       string
	Criteria    *Criteria
}

// ValidVisibility guards the two the schema allows.
func ValidVisibility(v string) bool { return v == "private" || v == "public" }

// ValidateContent checks what the database cannot, and returns the first
// problem. Phases and items are validated together because an item names its
// phase by index into the array it arrived with.
//
// The CHECK constraints catch most of this, but a constraint violation reaches
// the client as a generic "invalid input" with no indication of which item —
// and a curriculum is dozens of items deep, so "one of them is wrong" is not a
// usable error.
func ValidateContent(phases []NewPhase, items []NewItem) error {
	if len(phases) > MaxPhases {
		return ErrInvalidInput
	}
	for _, p := range phases {
		// Mirrors curriculum_phases_title_nonempty.
		if p.Title == "" {
			return ErrInvalidInput
		}
	}
	if len(items) > MaxItems {
		return ErrInvalidInput
	}
	seen := make(map[string]struct{}, len(items))
	for _, it := range items {
		// Mirrors the phase FK: an index outside the array names a phase that
		// does not exist.
		if it.Phase != nil && (*it.Phase < 0 || *it.Phase >= len(phases)) {
			return ErrInvalidInput
		}
		// Mirrors curriculum_items_kind_shape. A concept is authored text and
		// nothing else; a technique is a library pointer and never carries its
		// own title.
		switch it.Kind {
		case "concept":
			if it.TechniqueID != "" || it.Title == "" || it.Criteria != nil {
				return ErrInvalidInput
			}
			continue
		case "", "technique":
			if it.TechniqueID == "" || it.Title != "" {
				return ErrInvalidInput
			}
		default:
			return ErrInvalidInput
		}
		// Mirrors curriculum_items_technique_unique. Caught here so the client
		// hears "you listed this twice" rather than a constraint name.
		if _, dup := seen[it.TechniqueID]; dup {
			return ErrInvalidInput
		}
		seen[it.TechniqueID] = struct{}{}
		if it.Criteria == nil {
			continue
		}
		c := it.Criteria
		// Mirrors curriculum_items_criteria_anchored: a criterion is anchored
		// on volume — offensive, defensive, or drilled spread — or it is not a
		// criterion.
		if c.TargetScored == nil && c.TargetDefended == nil && c.TargetDrilledSessions == nil {
			return ErrInvalidInput
		}
		// Mirrors curriculum_items_hit_rate_needs_volume. A rate divides the
		// offensive attempt count, so on a defence-only item it would gate on
		// an unrelated number.
		if c.MinHitRate != nil && c.TargetScored == nil {
			return ErrInvalidInput
		}
		if c.TargetScored != nil && *c.TargetScored <= 0 {
			return ErrInvalidInput
		}
		if c.TargetDefended != nil && *c.TargetDefended <= 0 {
			return ErrInvalidInput
		}
		if c.TargetSessions != nil && *c.TargetSessions <= 0 {
			return ErrInvalidInput
		}
		if c.TargetDrilledSessions != nil && *c.TargetDrilledSessions <= 0 {
			return ErrInvalidInput
		}
		if c.MinHitRate != nil && (*c.MinHitRate <= 0 || *c.MinHitRate > 1) {
			return ErrInvalidInput
		}
	}
	return nil
}

// Repository is the storage boundary.
//
// EVERY METHOD TAKES userID, including the reads. That is not ceremony: a
// curriculum is readable when it is public OR the caller owns it, and a read
// that does not know who is asking cannot enforce the second half. The same
// omission has produced a cross-user enumeration bug in two other modules here.
type Repository interface {
	// EVERY DATE HERE IS THE ATHLETE'S, NOT THE SERVER'S. `tz` is an IANA name
	// and the empty string means UTC, which is the old behaviour.
	//
	// This is not a nicety. `started_on` used to default to Postgres's
	// CURRENT_DATE, and Postgres runs UTC in every deployed environment — so an
	// athlete enrolling at 22:00 in New York was stamped with TOMORROW, and the
	// screen told them their progress was "counted from" a date that had not
	// happened. Everything logged that evening then fell outside the window.
	//
	// List returns the curricula this caller can see — their own, plus every
	// public one — with Enrolled and Editable resolved for them.
	List(ctx context.Context, userID string) ([]Curriculum, error)
	// Working returns the roadmaps this athlete is ACTIVELY on, each with its
	// items and progress — the one question Today and You both ask.
	//
	// A separate read rather than a flag on List because the two are bounded by
	// different things. List spans every public curriculum and is capped at 200;
	// computing mastery there means the per-curriculum evidence aggregate once
	// per row, to draw numbers nobody reads off a browse screen. This is bounded
	// by how many syllabuses one athlete has taken on, which is one or two.
	//
	// Archived enrollments are excluded: "what am I working" is present tense.
	Working(ctx context.Context, userID, tz string) ([]Curriculum, error)
	// Get returns one with its items, and with the caller's progress against
	// any criteria. Returns ErrNotFound for a private curriculum the caller
	// does not own — never ErrForbidden, which would confirm it exists.
	Get(ctx context.Context, userID, id, tz string) (*Curriculum, error)
	// Create stores a new curriculum owned by the caller.
	Create(ctx context.Context, userID, tz string, in NewCurriculum) (*Curriculum, error)
	// Update edits one the caller owns. ErrForbidden for a VOLA-authored row,
	// which no user may edit however public it is.
	Update(ctx context.Context, userID, id, tz string, in Update) (*Curriculum, error)
	// Delete removes one the caller owns.
	Delete(ctx context.Context, userID, id string) error
	// Enroll starts the caller working this curriculum, or un-archives it.
	// Idempotent: enrolling twice is not an error, because a retry after a
	// dropped response must converge rather than fail.
	Enroll(ctx context.Context, userID, id, tz string) error
	// Archive records that the caller put it down. Deliberately not a delete —
	// having worked a syllabus and stopped is a fact about them, and a roadmap
	// that vanishes cannot later say "you did three quarters of this".
	Archive(ctx context.Context, userID, id string) error
}
