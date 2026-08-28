// Package classplan is the coach's lesson plan: an ordered list of blocks —
// warmup, drilling, live rounds, notes — that together make up one class.
//
// It exists because a coach who teaches four classes a week re-derives the
// same shape from memory every time: how long is warmup, which technique gets
// drilled, how much time is left for rounds. A class plan lets that shape be
// written down once and reused, and lets a coach see at a glance how a
// planned hour actually divides up (`TotalDurationMinutes`).
//
// DELIBERATELY NOT SHARED WITH `sequence` OR `curriculum`, though all three
// are ordered lists that point into the technique catalog. A sequence's order
// is causal (this move puts you where the next one starts) and a
// curriculum's is pedagogical (learn this before that, over months). A class
// plan's order is neither — it is a SCHEDULE: ten minutes of this, then
// fifteen of that, then rounds. Only `technique_drill` blocks even reference
// the catalog; `warmup`, `live_rounds` and `notes` blocks are plain
// schedule entries with a duration and, optionally, a note.
//
// NO SHARING, NO VOLA-AUTHORED ROWS, deliberately, and unlike every one of
// those three siblings. A class plan is one coach's answer to "what am I
// teaching tonight" — there is no reference content to publish and (unlike
// `sequence`) nothing here anticipates a `Copy` capability landing later. If
// that changes, the ownership model below (a bare, always-non-null owner) is
// what has to change first, not this file's Repository shape.
package classplan

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound = errors.New("classplan: not found")
	// ErrAlreadyExists means a client-supplied id is taken BY SOMEBODY ELSE.
	// The same owner re-sending the same id is an idempotent retry and
	// succeeds — that is the whole point of accepting a client id. See
	// NewClassPlan.ID.
	ErrAlreadyExists = errors.New("classplan: already exists")
	ErrInvalidInput  = errors.New("classplan: invalid input")

	// NOTE WHAT IS DELIBERATELY ABSENT: an ErrForbidden.
	//
	// sequence.go declares one and it is load-bearing THERE, because a
	// sequence can be VOLA-authored (ownerless) — a row every caller may
	// READ but only its owner may WRITE, which is exactly the 404-on-read /
	// 403-on-write split that module documents at length.
	//
	// A class plan has NO ownerless row at all: `class_plans.owner_user_id`
	// is `NOT NULL` (see the migration), so there is no row a caller can
	// legitimately see without owning it. "Not owned" and "does not exist"
	// are therefore the SAME case on every path this package has — reads
	// AND writes — so a caller attempting to PATCH or DELETE somebody
	// else's plan gets exactly the answer they get for an id that was
	// never real: ErrNotFound. Introducing ErrForbidden here would be
	// reaching for sequence's shape without sequence's reason for it.
	//
	// If this module ever grows a public/VOLA-authored row (a starter
	// template plan, say), THAT is the day this decision has to be
	// revisited — and sequence.go's comment on the same question is the
	// place to start.
)

const (
	// maxBlocks caps one plan. A real class is 45-90 minutes taught as a
	// handful of blocks — warmup, one or two technique drills, live rounds,
	// maybe a notes block — not dozens of them. 40 is generous against that
	// observation rather than tight against it: even a coach who logs every
	// five-minute segment of a two-hour open mat stays comfortably under it,
	// while a plan that size would already be unreadable as a single class.
	maxBlocks = 40
	// maxList bounds the response the same way sequence's does: a per-user
	// list still needs a ceiling, or an unusually prolific coach's own
	// response has no bound.
	maxList = 200
	// maxName, maxDescription, maxFreeText and maxNotes mirror what a client
	// can usefully render. Postgres does not constrain TEXT, so without these
	// a plan's name (or a block's free-text drill) can be arbitrarily large
	// and every list response that includes it grows with it.
	maxName        = 120
	maxDescription = 2000
	maxFreeText    = 500
	maxNotes       = 1000

	// minDurationMinutes and maxDurationMinutes bound one block. Zero and
	// negative durations are meaningless; 180 (three hours) is well past any
	// single block of a class and exists only to keep a typo (1800 for 18:00,
	// say) from producing a plan that renders as nonsense.
	minDurationMinutes = 1
	maxDurationMinutes = 180
)

// Valid block types. An ENUMERATED VOCABULARY IN GO, not a Postgres CHECK
// constraint — matching profile.go's ValidActivityLevel/ValidUnitSystem
// convention (see migration 000021's argument, which that file references):
// changing the set of legal block types is then a code change, not a
// migration, and every existing row stays valid the moment the new type ships
// rather than needing a backfill.
const (
	BlockTypeWarmup         = "warmup"
	BlockTypeTechniqueDrill = "technique_drill"
	BlockTypeLiveRounds     = "live_rounds"
	BlockTypeNotes          = "notes"
)

func validBlockType(t string) bool {
	switch t {
	case BlockTypeWarmup, BlockTypeTechniqueDrill, BlockTypeLiveRounds, BlockTypeNotes:
		return true
	default:
		return false
	}
}

// ClassPlan is one coach's plan for one class.
type ClassPlan struct {
	ID string `json:"id"`
	// OwnerUserID is never serialised — same reasoning as profile and
	// sequence: a client needs to know it may edit its own resources, never
	// who else's account might own something with the same shape. Unlike
	// Sequence.OwnerUserID this is never nil: every class plan has an owner.
	OwnerUserID string `json:"-"`

	Name        string `json:"name"`
	Description string `json:"description"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// Blocks is nil on list responses and populated on a single Get — the
	// same lazy pattern as Sequence.Steps. A list of fifty plans only ever
	// renders a name, a block count and a total duration; fetching every
	// block for all fifty would be the N+1 in its lazy form.
	Blocks []Block `json:"blocks,omitempty"`
	// BlockCount is present on BOTH list and get, mirroring
	// Sequence.StepCount, so a list card can say "6 blocks" without
	// fetching them.
	BlockCount int `json:"block_count"`
	// TotalDurationMinutes is the sum of every block's duration, likewise
	// present on both — a list card renders "45 min" the same way it
	// renders "6 blocks", without a second fetch.
	TotalDurationMinutes int `json:"total_duration_minutes"`
}

// Block is one scheduled segment of a class.
type Block struct {
	// Order is zero-based and assigned by the repository from the array
	// index the client sent, exactly like Sequence.Step.Order — the client's
	// array order is already the authoritative statement of the schedule,
	// and accepting a client-supplied ordinal would let it collide with
	// itself.
	Order int `json:"order"`
	// Type is one of the BlockType constants above.
	Type            string `json:"type"`
	DurationMinutes int    `json:"duration_minutes"`

	// TechniqueID and FreeText apply ONLY when Type == BlockTypeTechniqueDrill,
	// and exactly one of them is set then — never both, never neither. See
	// ValidateBlocks. For every other block type both are nil: a warmup or
	// live-rounds block has nothing to point at, and Notes below is the
	// general-purpose free text for those.
	TechniqueID *string `json:"technique_id,omitempty"`
	FreeText    *string `json:"free_text,omitempty"`

	// TechniqueName and TechniquePosition are RESOLVED from the shared
	// library on every read, never stored on the block — so a renamed
	// technique reads correctly everywhere. Read-only projections, exactly
	// like Sequence.Step's Name/Position: they let a client render a block
	// without a second fetch, and NewBlock refuses to accept them on write
	// (there is nowhere on NewBlock to send them at all).
	//
	// Both are empty unless TechniqueID is set.
	TechniqueName     string `json:"technique_name,omitempty"`
	TechniquePosition string `json:"technique_position,omitempty"`

	// Notes is the coach's own note on this block. For a BlockTypeNotes
	// block this IS the block's content; for every other type it is
	// supplementary detail ("emphasize grip fighting") — mirroring
	// Sequence.Step.Notes's role as the one part of a library-pointing row
	// that is the author's own.
	Notes string `json:"notes"`
}

// NewClassPlan is the input for creating one. Ownership is not a field: it is
// always the caller, and a request that could name an owner is a request
// that could name somebody else.
type NewClassPlan struct {
	// ID is CLIENT-SUPPLIED and optional, empty meaning "server, pick one".
	//
	// A coach builds a class plan on the mat as often as at a desk — jotting
	// down "warmup, armbar drilling, rounds" between classes, in exactly the
	// gym dead-spot that makes an offline create need a stable id for its
	// sync retry to be idempotent. Same reasoning and mechanism as
	// sequence.NewSequence.ID, workouts and activities.
	ID          string
	Name        string
	Description string
	Blocks      []NewBlock
}

// ClassPlanUpdate is a partial update — nil Name/Description means
// unchanged. Blocks nil means "leave the plan's blocks alone"; Blocks non-nil
// (including an empty slice) REPLACES them wholesale.
//
// Replace-all rather than per-block patching, exactly for the reason
// sequence.Update.Steps gives: the ORDER is the content. A reorder is not a
// sequence of independent edits, and two clients patching indices at once
// would interleave into a schedule neither of them authored.
type ClassPlanUpdate struct {
	Name        *string
	Description *string
	Blocks      []NewBlock
}

// NewBlock is one block as a client sends it.
type NewBlock struct {
	Type            string
	DurationMinutes int
	TechniqueID     *string
	FreeText        *string
	Notes           string
}

// Validate checks what the database cannot, and returns the first problem —
// the constraints catch some of this too, but a raw constraint violation
// reaches the client as a generic "invalid input" naming no field, and the
// whole point of validating here is to say which one is wrong before the
// query even runs.
func (n NewClassPlan) Validate() error {
	if n.ID != "" && !validClientID(n.ID) {
		return ErrInvalidInput
	}
	// A name is the only thing a list card can render, so an unnamed plan
	// is an unopenable one. Description is genuinely optional.
	if n.Name == "" || len(n.Name) > maxName {
		return ErrInvalidInput
	}
	if len(n.Description) > maxDescription {
		return ErrInvalidInput
	}
	return ValidateBlocks(n.Blocks)
}

// Validate checks the partial update's populated fields only.
func (u ClassPlanUpdate) Validate() error {
	if u.Name != nil {
		if *u.Name == "" || len(*u.Name) > maxName {
			return ErrInvalidInput
		}
	}
	if u.Description != nil && len(*u.Description) > maxDescription {
		return ErrInvalidInput
	}
	// nil Blocks means "leave the plan alone" and must not be validated as
	// an empty one — that distinction is the entire point of the nil/empty
	// split, exactly as on sequence.Update.Steps.
	if u.Blocks != nil {
		return ValidateBlocks(u.Blocks)
	}
	return nil
}

// ValidateBlocks guards one plan's shape. NOTE WHAT IS NOT CHECKED HERE:
// whether a referenced technique id actually EXISTS in the catalog. That
// needs a database lookup and belongs in the repository's Create/Update,
// which translates a missing FK into ErrInvalidInput the same way every
// other module here translates a constraint violation — see postgres.go.
func ValidateBlocks(blocks []NewBlock) error {
	if len(blocks) > maxBlocks {
		return ErrInvalidInput
	}
	for _, b := range blocks {
		if !validBlockType(b.Type) {
			return ErrInvalidInput
		}
		if b.DurationMinutes < minDurationMinutes || b.DurationMinutes > maxDurationMinutes {
			return ErrInvalidInput
		}
		if len(b.Notes) > maxNotes {
			return ErrInvalidInput
		}
		techSet := b.TechniqueID != nil && *b.TechniqueID != ""
		freeSet := b.FreeText != nil && *b.FreeText != ""
		if freeSet && len(*b.FreeText) > maxFreeText {
			return ErrInvalidInput
		}
		if b.Type == BlockTypeTechniqueDrill {
			// EXACTLY ONE, never both and never neither. A technique_drill
			// block has to say what is being drilled, and it has to say it
			// exactly one way — a block naming both a catalog id and free
			// text is a block that disagrees with itself about what it is.
			if techSet == freeSet {
				return ErrInvalidInput
			}
		} else {
			// Every other block type: neither applies. A warmup or
			// live-rounds block has nothing to point at, and Notes is
			// already the general-purpose free text for those — accepting
			// TechniqueID/FreeText here would give the same information two
			// homes that could disagree.
			if techSet || freeSet {
				return ErrInvalidInput
			}
		}
	}
	return nil
}

// validClientID guards what a caller may make a primary key. Identical shape
// to sequence.validClientID (unexported there too, so duplicated rather than
// shared) — see that function's comment for the full reasoning: length in
// RUNES to match the OpenAPI contract's minLength/maxLength, and a charset
// restricted to what is safe as a primary key, a URL path segment and
// eventually a share link.
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

// Repository is the persistence boundary.
//
// Every method takes the caller's user id and applies ownership itself.
// There is deliberately no "get by id" that omits it: the handler cannot
// forget to check what it never had the option of skipping — the same shape
// sequence.Repository documents as what stops an IDOR being one missing line
// away.
type Repository interface {
	// List returns the caller's own plans, newest first, capped at maxList.
	// Blocks are omitted; BlockCount and TotalDurationMinutes are populated.
	// Unlike sequence.Repository.List there is no second source to merge —
	// this domain has no VOLA-authored rows at all.
	List(ctx context.Context, callerUserID string) ([]ClassPlan, error)
	// Get returns one plan with its blocks, or ErrNotFound when it does not
	// exist or is not owned by the caller — collapsed identically, per the
	// ID-enumeration rule: distinguishing "does not exist" from "is not
	// yours" tells a caller that a guessed id is real.
	Get(ctx context.Context, id, callerUserID string) (ClassPlan, error)
	Create(ctx context.Context, callerUserID string, in NewClassPlan) (ClassPlan, error)
	// Update applies a partial change and returns ErrNotFound for a foreign
	// row — see the package doc comment on the absent ErrForbidden for why
	// this differs from sequence.Repository.Update.
	Update(ctx context.Context, id, callerUserID string, in ClassPlanUpdate) (ClassPlan, error)
	// Delete returns ErrNotFound for a foreign row, for the same reason.
	Delete(ctx context.Context, id, callerUserID string) error
}
