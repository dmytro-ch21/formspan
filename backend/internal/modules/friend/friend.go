// Package friend is the social graph: requests, acceptance, and the friends
// list the app-wide share-by-copy design will deliver into.
//
// The model is deliberately small. One row per PAIR (canonically ordered, see
// migration 000041), two states (pending, accepted), and DECLINE IS DELETE —
// a stored "declined" would either block re-requests forever or make the API
// lie to the sender, and the honest cost (a declined sender may ask again) is
// recorded as a moderation residual rather than papered over.
//
// EVERYTHING IS ADDRESSED BY USERNAME. User ids never cross the wire in
// either direction: requests are sent to a handle, the inbox shows handles,
// accept and remove take handles. That keeps Clerk ids out of client
// circulation entirely and means a renamed handle propagates instantly,
// because every read joins profiles live rather than denormalising.
package friend

import (
	"context"
	"errors"
	"time"
)

// maxBadgeCount bounds every counting query. A badge cannot usefully render
// more than a couple of digits, and counting a capped subquery is what stops
// one athlete making another athlete's most-polled endpoint expensive.
const maxBadgeCount = 99

var (
	ErrNotFound     = errors.New("friend: not found")
	ErrInvalidInput = errors.New("friend: invalid input")
	// ErrAlreadyExists covers BOTH "already friends" and "a request is already
	// pending, in either direction". One error on purpose: splitting them
	// would let a sender distinguish "they haven't answered" from "they
	// declined and someone re-requested" and other states that are none of
	// the sender's business. The 409 message stays deliberately ambiguous.
	ErrAlreadyExists = errors.New("friend: already connected or pending")
	// ErrNoUsername: the CALLER has not claimed a handle. A request arrives in
	// somebody's inbox as a handle; an unnamed requester would render as
	// nothing. Claiming first is the price of participating.
	ErrNoUsername = errors.New("friend: claim a username first")
)

// Card is one person as the social surfaces show them — the same two public
// fields as profile.PublicProfile, plus the relationship timestamps this
// module owns. Never an id.
type Card struct {
	Username    string  `json:"username"`
	DisplayName *string `json:"display_name"`
	// Since is when the friendship was accepted (friends list) or when the
	// request was sent (request lists).
	Since time.Time `json:"since"`
}

// Requests is the two directions of pending, split because they mean
// different actions: incoming rows carry accept/decline, outgoing rows carry
// only cancel.
type Requests struct {
	Incoming []Card `json:"incoming"`
	Outgoing []Card `json:"outgoing"`
}

// Repository is the persistence boundary. Every method takes the caller's
// user id and scopes itself; there is no unscoped read or write, so a handler
// cannot forget what it never had.
type Repository interface {
	// Send creates a pending request from the caller to the named handle.
	// ErrNoUsername when the caller has no handle; ErrNotFound when the
	// target handle does not exist; ErrInvalidInput for self-requests;
	// ErrAlreadyExists when any row for the pair already exists.
	Send(ctx context.Context, callerID, targetUsername string) error
	// Accept flips a pending request ADDRESSED TO the caller. ErrNotFound
	// when there is no such pending request — including when the caller is
	// the one who sent it, indistinguishably, because "you cannot accept
	// your own request" confirms the request exists.
	Accept(ctx context.Context, callerID, fromUsername string) error
	// Remove deletes whatever row links the caller and the handle: a decline
	// (incoming pending), a cancel (outgoing pending), or an unfriend
	// (accepted). One verb because all three are "this relationship, gone",
	// and the caller's UI knows which one it offered.
	Remove(ctx context.Context, callerID, username string) error
	// Friends lists accepted connections, newest first.
	Friends(ctx context.Context, callerID string) ([]Card, error)
	// Pending lists both directions of open requests, newest first.
	Pending(ctx context.Context, callerID string) (Requests, error)
	// FriendID resolves a handle to an ACCEPTED friend's user id. ok is false
	// for every kind of miss alike. This is the friendship test the share
	// module consumes; it is declared there as its own one-method interface,
	// so that package does not import this one.
	FriendID(ctx context.Context, callerID, username string) (id string, ok bool, err error)
	// PendingCount is how many requests are waiting on the caller to answer —
	// INCOMING only. Satisfies notification.Counter, which is declared over
	// there so that package does not import this one.
	PendingCount(ctx context.Context, callerID string) (int, error)
}

// pairOf returns the canonical ordering the schema requires.
func pairOf(x, y string) (string, string) {
	if x < y {
		return x, y
	}
	return y, x
}
