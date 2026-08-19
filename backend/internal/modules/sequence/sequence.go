// Package sequence is the chain domain: what a class actually taught, in the
// order it flows.
//
// It exists because six technique tags cannot say that they connect, and the
// connection is the lesson. A beginners' class ran closed guard top → standing
// break → knee cut → side control → knee on belly → armbar; the library could
// record every one of those and nothing that said the knee cut came off a
// broken closed guard.
//
// DELIBERATELY NOT A CURRICULUM, though both are ordered technique lists. A
// curriculum's order is pedagogical — learn this before that, over months — and
// reordering it changes advice. A sequence's order is CAUSAL: this move puts
// you where the next one starts, and reordering it produces something that does
// not work on the mat. Migration 000035 argues the case at length, and it is
// why this package has no notion of mastery, criteria or progress: the mastery
// of a sequence's parts is already tracked per technique, and a chain is not a
// thing you complete.
//
// SEQUENCES ARE LINEAR, and that is a product decision rather than a
// simplification. A class that ends "…and if he defends the knee, armbar OR
// kimura" is two sequences sharing a prefix, not one sequence with a branch.
// Branch points are harder to author, much harder to read on a phone, and the
// fork stays visible either way.
//
// SHARING LIVES ELSEWHERE. Nothing here knows about audiences, visibility or
// recipients. Sharing is being built once, generically, over every ownable
// thing in the app — this package will implement that system's copy interface
// when it lands, and adding a `shared_with` concept here would be the fourth
// private implementation of one idea.
package sequence

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound     = errors.New("sequence: not found")
	ErrInvalidInput = errors.New("sequence: invalid input")
	// ErrAlreadyExists means a client-supplied id is taken BY SOMEBODY ELSE.
	// The same owner re-sending the same id is an idempotent retry and
	// succeeds — that is the whole point of accepting a client id.
	ErrAlreadyExists = errors.New("sequence: already exists")
	// ErrForbidden is reachable only from a WRITE, and the handler answers it
	// 403. It means exactly one thing: a VOLA-authored reference chain, which
	// EVERY caller can already read, so 403 discloses nothing they did not have.
	//
	// It must NEVER be returned for another athlete's row. Doing so makes the
	// write path an existence oracle — 404 for an unreal id, 403 for a real one
	// belonging to somebody else — which is this codebase's signature bug and
	// was live in this module until review caught it. Writes return ErrNotFound
	// for a foreign row, exactly as reads do.
	//
	// The collapse on the read side is the load-bearing half: distinguishing
	// "does not exist" from "is not yours" tells a caller that an id they
	// guessed is real, which is the ID-enumeration shape review has caught
	// twice in this codebase already.
	ErrForbidden = errors.New("sequence: forbidden")
)

const (
	// MaxSteps caps one chain. Real sequences are 3-6 steps: a class teaches a
	// chain you can hold in your head walking off the mat, and something 40
	// steps long is a curriculum wearing the wrong shape. The cap is generous
	// against that observation rather than tight against it.
	MaxSteps = 20
	// maxList bounds the response. Every list endpoint needs one — this is a
	// per-user list so nobody can grow anybody else's response, but an athlete
	// with 500 sequences would still be paying for all of them on every open.
	maxList = 200
	// maxName and maxDescription mirror what the clients can usefully render.
	// The database does not constrain TEXT, so without these a sequence name
	// can be a megabyte and every list that includes it becomes one.
	maxName        = 120
	maxDescription = 2000
	maxNotes       = 1000
)

// Sequence is the chain itself.
type Sequence struct {
	ID string `json:"id"`
	// OwnerUserID is nil for VOLA-authored reference content. Nothing seeds
	// those yet; the case is carried so that when it lands it changes no code.
	//
	// Deliberately NOT serialised: a client needs to know whether it may edit
	// this, which Editable answers, and never who else's account owns it.
	OwnerUserID *string `json:"-"`
	// Editable is computed per caller. It exists so a client never compares
	// user ids to decide whether to show an edit affordance — that shape is
	// how client-side authorization gets written by accident.
	//
	// It answers "may you edit this" and NOTHING about who wrote it. Today the
	// two happen to coincide here, because `visibleTo` has no public arm: you
	// see your own and VOLA's, nothing else. That coincidence is what made
	// three clients label a chain "reference" off `!editable` — see T9, and
	// F7 for the same inference on curricula, where a public arm DID exist and
	// the label became a lie about strangers.
	Editable bool `json:"editable"`
	// Official reports that VOLA authored this — the positive fact, so a client
	// never infers authorship from the ABSENCE of permission.
	//
	// `owner_user_id IS NULL` is the definition, and
	// `bjj_sequences_source_matches_owner` makes it trustworthy for the same
	// reason curricula's twin does: `(owner_user_id IS NULL) = (source <>
	// 'user')` is BIDIRECTIONAL, so an owned row cannot claim `seed`/`admin`
	// and an ownerless one cannot claim `user`. Ownership and provenance cannot
	// drift apart, which is what lets one boolean stand for both.
	//
	// **Nothing seeds an ownerless sequence yet**, so today this is false for
	// every row that exists. That is the point of landing it now: the day a
	// browse surface or a `visibility` column arrives, the clients are already
	// asking the right question and nothing has to be remembered.
	Official    bool   `json:"official"`
	Name        string `json:"name"`
	Description string `json:"description"`

	// StartPositionID is where the chain BEGINS, as a curated position id.
	//
	// The first step's technique carries its own `position`, so this looks
	// redundant and is not: `techniques.position` is 16 free-text values at a
	// different grain ("Guard - Top") than the 11 curated positions the
	// glossary renders. Storing the curated id makes the opening node the same
	// kind of thing as every node after it, so one renderer draws the line.
	//
	// Nil means not recorded, and stays legal — a chain whose start nobody
	// named is still a chain.
	StartPositionID *string `json:"start_position_id"`
	// StartPositionName is resolved from the library so a client renders
	// without a second fetch. Same reason curriculum.Item carries Name.
	StartPositionName string `json:"start_position_name,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// Steps is nil on list responses and populated on a single read. Sequences
	// are short, but a list of fifty of them is still the N+1 in its lazy form
	// — and the list only ever renders a name and a length.
	Steps []Step `json:"steps,omitempty"`
	// StepCount is present on BOTH, because a card has to say "4 steps"
	// without fetching them.
	StepCount int `json:"step_count"`
}

// Step is one move in the chain, and where it leaves you.
type Step struct {
	TechniqueID string `json:"technique_id"`
	// Name, Position, Category and Function come from the shared library so a
	// client can render the chain without a second fetch. They are read-only
	// projections — see NewStep, which refuses to accept them on write.
	Name     string `json:"name"`
	Position string `json:"position"`
	Category string `json:"category"`
	// Function is what the technique DOES (advance | reverse | escape |
	// control | finish). Carried because it is what tells a renderer that a
	// step ENDS the exchange rather than merely having no recorded
	// destination — see EndsAtPositionID.
	Function string `json:"function,omitempty"`

	Order int `json:"order"`

	// EndsAtPositionID is where this step leaves you, and therefore where the
	// next one starts. Authored, NOT derived from techniques.to_position:
	// migration 000029 populated that for 170 of the 542 techniques and documents
	// why the rest cannot be derived without inventing data, so deriving would
	// render most chains with holes.
	//
	// Nil means NOT RECORDED **or** ENDS THE EXCHANGE. That ambiguity is
	// deliberate: a submission finishes the chain and leaves you in no position
	// at all, and `Function == "finish"` already distinguishes the two cases.
	// A second column would encode the same fact twice and could disagree.
	EndsAtPositionID   *string `json:"ends_at_position_id"`
	EndsAtPositionName string  `json:"ends_at_position_name,omitempty"`

	// Notes is the athlete's own class. The step is a pointer into a shared
	// library; this is the only part of it that is theirs.
	Notes string `json:"notes"`
}

// NewSequence is the input for creating one. Ownership is not a field: it is
// always the caller, and a request that could name an owner is a request that
// could name somebody else.
type NewSequence struct {
	// ID is CLIENT-SUPPLIED and optional, empty meaning "server, pick one".
	//
	// This module shipped a day ago asserting the opposite — "a sequence is
	// authored at a desk against a catalog the client had to fetch anyway, so
	// there is no offline creation to make idempotent". That was true of the
	// web builder and wrong within a day: the phone captures a chain in the
	// changing room after class, which is exactly a gym dead-spot, and an
	// offline create needs a stable id to make its sync retry idempotent.
	// Same reasoning and same mechanism as workouts and activities.
	//
	// The cost is the one workouts documents: a client-chosen id lets a caller
	// PROBE for existing ones by watching which inserts conflict. Create's
	// conflict path is therefore scoped to the caller — see postgres.go.
	ID              string
	Name            string
	Description     string
	StartPositionID *string
	Steps           []NewStep
}

// Update is a partial update — nil fields are left unchanged.
type Update struct {
	Name        *string
	Description *string
	// SetStartPosition distinguishes "leave it alone" from "clear it".
	// StartPositionID is only consulted when this is true, so a nil id with
	// the flag set means null — which a lone *string cannot express.
	SetStartPosition bool
	StartPositionID  *string
	// Steps is nil to leave the chain alone and non-nil (possibly empty) to
	// replace it wholesale, matching every other client-owned list here.
	//
	// Replace-all rather than per-step patching because the ORDER is the
	// content: a reorder is not a sequence of moves that can be applied
	// independently, and two clients patching indices would interleave into a
	// chain neither of them authored.
	Steps []NewStep
}

// NewStep is one step as a client sends it. The library fields (name,
// position, category, function) are deliberately absent — they are the
// library's, and accepting them would let a client store a name that disagrees
// with the catalog.
type NewStep struct {
	TechniqueID      string
	EndsAtPositionID *string
	Notes            string
}

// Validate checks what the database cannot, and returns the first problem.
//
// The constraints catch some of this, but a constraint violation reaches the
// client as a generic "invalid input" naming no field — and the whole point of
// validating here is that the client can be told which step is wrong.
func (n NewSequence) Validate() error {
	if err := validateText(n.Name, n.Description); err != nil {
		return err
	}
	// A client id is optional, but a supplied one has to be sane: it is a
	// primary key, it lands in URLs, and an unbounded string here is an
	// unbounded key. Empty means "server picks", which is the web path.
	if n.ID != "" && !validClientID(n.ID) {
		return ErrInvalidInput
	}
	// A name is the only thing a list row can render, so an unnamed sequence is
	// an unopenable one. Description is genuinely optional.
	if n.Name == "" {
		return ErrInvalidInput
	}
	return ValidateSteps(n.Steps)
}

// Validate checks the partial update's populated fields only.
func (u Update) Validate() error {
	if u.Name != nil {
		if *u.Name == "" || len(*u.Name) > maxName {
			return ErrInvalidInput
		}
	}
	if u.Description != nil && len(*u.Description) > maxDescription {
		return ErrInvalidInput
	}
	// nil Steps means "leave the chain alone" and must not be validated as an
	// empty one — that distinction is the whole point of the nil/empty split.
	if u.Steps != nil {
		return ValidateSteps(u.Steps)
	}
	return nil
}

// validClientID guards what a caller may make a primary key.
//
// Length in RUNES, not bytes: the contract says minLength/maxLength, which
// OpenAPI counts in code points, and `len()` on a Go string counts bytes — so
// a byte check makes the server and the contract disagree about the same value
// (workout/handler_test.go documents the identical trap for names).
//
// The charset restriction is the more useful half. This value becomes a
// primary key, a URL path segment and eventually a share link, so whitespace,
// control characters, `/` and `#` have no business in it. The phone sends
// `randomUUID()` — 36 characters of [0-9a-f-] — so no real client loses
// anything. The rest of this family checks non-empty only; this is not
// inheriting that gap rather than fixing a live defect.
func validClientID(id string) bool {
	n := 0
	for _, r := range id {
		n++
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_'
		if !ok {
			return false
		}
	}
	return n >= 8 && n <= 64
}

func validateText(name, description string) error {
	if len(name) > maxName || len(description) > maxDescription {
		return ErrInvalidInput
	}
	return nil
}

// ValidateSteps guards the chain's shape.
//
// NOTE WHAT IS NOT CHECKED HERE, deliberately: that step N's end position is
// where step N+1 actually starts. That would make the app the arbiter of
// whether a chain is mechanically real, and it would be wrong constantly — the
// library's own position vocabulary is 16 free-text values at a different grain
// than the 11 curated positions, techniques are routinely taught from places
// the catalog does not list, and a coach's variation is not a validation error.
// The athlete is the authority on what their class did; this only refuses what
// is structurally impossible to store or render.
func ValidateSteps(steps []NewStep) error {
	if len(steps) > MaxSteps {
		return ErrInvalidInput
	}
	for _, s := range steps {
		if s.TechniqueID == "" {
			return ErrInvalidInput
		}
		if len(s.Notes) > maxNotes {
			return ErrInvalidInput
		}
	}
	// DUPLICATE TECHNIQUES ARE ALLOWED, unlike curriculum_items, which has a
	// uniqueness constraint. Returning to a position you have already been in
	// is ordinary grappling — sweep, get passed, sweep again — and a chain that
	// records it is more accurate, not less. The unique constraint that does
	// exist is on (sequence_id, sort_order), which the repository assigns.
	return nil
}

// Repository is the persistence boundary.
//
// Every method takes the caller's user id and applies ownership itself. There
// is deliberately no "get by id" that omits it: the handler cannot forget to
// check what it never had the option of skipping, which is the shape that
// stops an IDOR being one missing line away.
type Repository interface {
	// List returns the caller's sequences plus any VOLA-authored ones, newest
	// first. Steps are omitted; StepCount is populated.
	List(ctx context.Context, userID string) ([]Sequence, error)
	// Get returns one with its steps, or ErrNotFound when it does not exist or
	// is not visible to this caller.
	Get(ctx context.Context, id, userID string) (Sequence, error)
	Create(ctx context.Context, userID string, in NewSequence) (Sequence, error)
	// Update applies a partial change. Returns ErrForbidden for a sequence the
	// caller can see but does not own — the handler decides what the client
	// hears.
	Update(ctx context.Context, id, userID string, in Update) (Sequence, error)
	Delete(ctx context.Context, id, userID string) error
	// Copy duplicates a sequence the caller can SEE into a sequence they OWN,
	// and returns the new one with its steps.
	//
	// This is what makes a reference chain usable rather than only readable:
	// VOLA's chains are visible to everybody and editable by nobody, so
	// without it the only thing an athlete can do with one is look at it. The
	// refusal on the edit route used to say "Copy it to make it yours" with
	// nothing behind the sentence — see F9.
	//
	// Visibility, not ownership, is the gate: you may copy anything you may
	// read. Ownership of the RESULT is unconditional — the copy is a new row
	// owned outright, so editing it cannot touch the original and a deploy
	// refreshing a seeded chain cannot reach into the copy.
	Copy(ctx context.Context, id, userID string) (Sequence, error)
}
