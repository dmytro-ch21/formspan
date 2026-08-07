// Package share is how one athlete gives another a copy of something.
//
// It is deliberately GENERIC. Sequences are the first thing that can be
// shared and will not be the last — plans, workouts and curricula are the same
// verb — so this package knows only that a thing has a TYPE and an ID, and
// nothing whatsoever about what any of them contain. A module becomes
// shareable by implementing Copier and registering itself in cmd/api/main.go.
//
// THE DEPENDENCY DIRECTION IS THE POINT. This package must never import
// sequence, workout, plan or curriculum. If it did, every future shareable
// domain would have to join one knot at the centre of the app, and the fourth
// one to arrive would be the one that finally could not. Instead each module
// knows how to duplicate its own thing, which is knowledge it already has.
//
// SHARING IS BY COPY, WITH SNAPSHOT SEMANTICS. Accepting produces an
// independent thing the recipient owns outright; the sender's later edits
// never propagate, and neither do the recipient's back. That single decision
// is what lets this table have no `visibility` column, no ACL, no shared
// ownership and no "who may edit this" question — all of which the alternative
// (a pointer to somebody else's row) would have required.
//
// SHARES GO TO FRIENDS ONLY, and the friendship check collapses into the same
// 404 as an unknown handle. Nothing here can be used to discover whether an
// account exists, whether it is friends with you, or whether a resource id is
// real.
package share

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

var (
	ErrNotFound = errors.New("share: not found")
	// ErrInvalidInput covers a missing field and an unknown resource_type
	// alike — a type nothing has registered is a client sending a kind of
	// thing this build cannot copy.
	ErrInvalidInput = errors.New("share: invalid input")
	// ErrAlreadyExists means an unanswered share of this exact thing to this
	// exact person is already sitting in their inbox.
	ErrAlreadyExists = errors.New("share: already exists")
	// ErrGone means the share is real and the thing it points at is not: the
	// sender deleted it between sending and accepting. Distinct from
	// ErrNotFound because it is not a miss to hide — the recipient was
	// genuinely sent something, and telling them it evaporated is honest,
	// where a silent 404 would read as a bug in the app.
	ErrGone = errors.New("share: resource no longer exists")
)

const (
	// maxList bounds the inbox. It is the sharp case for a ceiling: unlike a
	// list of your own things, this one grows from OTHER people's actions.
	maxList = 200
	// maxLabel is what a card can usefully render, and bounds what a sender
	// can store in a recipient's inbox.
	maxLabel = 160
)

// Copier is what a module implements to become shareable.
//
// Two methods, because sharing asks two different questions at two different
// times: "may this person share this, and what is it called" when the share is
// sent, and "duplicate it" when it is accepted.
type Copier interface {
	// Describe returns the label to show in the recipient's inbox.
	//
	// ok is false when the resource does not exist OR the sharer cannot see
	// it — ONE answer for both, deliberately. Splitting them would make
	// POST /v1/shares an existence oracle over every other athlete's library:
	// share a guessed id at a friend, and the error tells you whether it is
	// real. Visibility rather than ownership is the right test, because a
	// caller can already read VOLA-authored content and passing it on is
	// nothing they could not do by hand.
	Describe(ctx context.Context, resourceID, sharerID string) (label string, ok bool, err error)

	// CopyTo duplicates the resource into newOwnerID's ownership, INSIDE the
	// transaction it is handed, returning the new resource's id.
	//
	// The transaction is the whole design. The copy and the share's status
	// flip commit together or not at all, so there is no accepted share
	// without a copy and no way to accept twice and get two. ok is false when
	// the source has been deleted since it was shared.
	//
	// sharerID is passed so the READ can carry the same visibility predicate
	// Describe used. Authorization happened when the share was SENT, and this
	// runs whenever the recipient gets round to accepting — an implementation
	// that read by bare id would copy whatever holds that id by then. Modules
	// here accept client-supplied ids, so an id freed by a delete and taken by
	// somebody else is not a hypothetical shape.
	CopyTo(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (newID string, ok bool, err error)
}

// Registry maps a resource_type to the module that owns it, built in
// cmd/api/main.go. A type absent from it cannot be shared or accepted — which
// is also the failure mode for a share stored by an older build whose module
// has since been removed, and why Accept treats an unknown type as ErrGone
// rather than pretending it is a miss.
type Registry map[string]Copier

// Friends is the friendship test, satisfied by the friend module. Declared
// here as a consumer-side interface so this package does not import that one.
type Friends interface {
	// FriendID resolves a handle to the user id of an ACCEPTED friend of the
	// caller.
	//
	// ok is false for every kind of miss alike — no such handle, not your
	// friend, a request still pending — so that sharing cannot answer
	// questions the friends API itself refuses to. It is a separate return
	// rather than a sentinel error for the reason Copier uses the same shape:
	// a cross-package error value cannot be matched with errors.Is without
	// one package importing the other, and collapsing "any error" into "miss"
	// would quietly turn a database outage into a 404.
	FriendID(ctx context.Context, callerID, username string) (id string, ok bool, err error)
}

// Card is one share as the inbox renders it. No user ids and no raw resource
// internals: a handle, a label, and what kind of thing it is.
type Card struct {
	ID            string `json:"id"`
	ResourceType  string `json:"resource_type"`
	ResourceLabel string `json:"resource_label"`
	// From is the sender's handle, joined live so a rename propagates — the
	// same reasoning as friend cards.
	From      string    `json:"from"`
	CreatedAt time.Time `json:"created_at"`
}

// SentCard is one share the caller is WAITING ON. Same shape as Card with the
// counterpart named for what it actually is: `to`, not `from`. One struct with
// a neutrally-named field was the alternative and would have made every client
// render "shared with @alice" for an inbox row.
type SentCard struct {
	ID            string `json:"id"`
	ResourceType  string `json:"resource_type"`
	ResourceLabel string `json:"resource_label"`
	// To is the recipient's handle, joined live like Card.From.
	To        string    `json:"to"`
	CreatedAt time.Time `json:"created_at"`
}

// Accepted is what accepting hands back: enough for the client to navigate
// straight to the recipient's OWN new copy.
type Accepted struct {
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
}

// New is a share as a client sends it. The sender is always the caller, and
// the recipient is always a handle — a request that could name a user id is a
// request that could name somebody who never agreed to hear from you.
type New struct {
	ToUsername   string
	ResourceType string
	ResourceID   string
}

// Repository is the persistence boundary. Every method takes the caller and
// scopes itself; there is no "get by id" that omits it.
type Repository interface {
	// Create sends a pending share. ErrNotFound when the recipient is not a
	// friend, the handle does not exist, or the resource is not one the
	// sender can see — all indistinguishable. ErrAlreadyExists when an
	// unanswered one is already there.
	Create(ctx context.Context, callerID string, in New) error
	// Inbox lists what is waiting for the caller, newest first.
	Inbox(ctx context.Context, callerID string) ([]Card, error)
	// Sent lists what the caller is waiting on — their own PENDING shares,
	// newest first.
	//
	// PENDING ONLY, and that is a privacy decision rather than a scope cut.
	// Include accepted rows and a VANISHED row starts to mean "declined",
	// since declining deletes — which is precisely the inference
	// decline-is-delete exists to prevent. So this answers "what have they
	// not answered yet" and never "what did they say". Same rule as the
	// friend module's outgoing list, for the same reason.
	Sent(ctx context.Context, callerID string) ([]SentCard, error)
	// Accept copies the resource into the caller's ownership and marks the
	// share accepted, atomically. ErrNotFound when there is no such pending
	// share ADDRESSED TO the caller — including when the caller is the one
	// who sent it. ErrGone when the resource has since been deleted.
	Accept(ctx context.Context, callerID, shareID string) (Accepted, error)
	// Delete removes a share: a decline, or the sender taking it back. One
	// verb, as with friend requests, because both are "this, gone" and the
	// client knows which it offered.
	//
	// ASYMMETRIC, and deliberately. The recipient may remove a row in ANY
	// status; the sender may only remove a PENDING one. A sender allowed to
	// delete an accepted row learns it was accepted — 204 versus 404 — which
	// turns this into the accept-vs-decline oracle the sent list's
	// pending-only design exists to prevent.
	Delete(ctx context.Context, callerID, shareID string) error
}

// Validate checks what the database cannot.
func (n New) Validate(reg Registry) error {
	if n.ToUsername == "" || n.ResourceType == "" || n.ResourceID == "" {
		return ErrInvalidInput
	}
	// An unregistered type is rejected before anything is resolved, so a
	// client cannot use a bogus type to probe handles.
	if _, ok := reg[n.ResourceType]; !ok {
		return ErrInvalidInput
	}
	return nil
}
