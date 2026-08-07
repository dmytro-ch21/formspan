// Package notification answers one question: what is waiting for you.
//
// THERE IS NO NOTIFICATIONS TABLE, and that is the design rather than a corner
// cut. Everything that arrives from another person already exists as a PENDING
// ROW somewhere — a friend request, a share — and that row IS the
// notification. Storing a second copy would mean two truths that can disagree:
// a notification row surviving the request it describes, a read flag that says
// answered when the thing is still sitting there, a backfill needed the first
// time a source is added. Deriving costs two counting queries and cannot drift.
//
// It is also why there is no read/unread state. "Unread" would be a third
// truth on top of the second one; ANSWERING the request is what clears it,
// which is the only definition that cannot be wrong. The consequence is worth
// stating plainly: you cannot dismiss a friend request by reading it. That is
// correct — it is still waiting for you.
//
// COUNTS, NOT A FEED. The items behind these numbers already have two screens
// that render them properly, with the right verbs attached (accept, decline,
// cancel). A feed would be a third rendering of the same rows whose only
// affordance is "go to one of the other two", and it would need its own
// pagination, its own empty state and its own ordering across sources. The
// number is what was actually missing: a share sitting in an inbox was
// discoverable only by visiting the page it sits on.
//
// Sources REGISTER, exactly as share.Copier does — this package imports
// neither friend nor share, and cmd/api/main.go is the one place that knows
// which modules have something that waits.
package notification

import "context"

// Counter is what a module implements to contribute a waiting-count.
//
// One method, and it must count only what the caller can ACT ON. An outgoing
// friend request is pending too, and it is not waiting for you — badging it
// would send someone to a screen to do nothing.
type Counter interface {
	PendingCount(ctx context.Context, userID string) (int, error)
}

// Registry maps a wire key to the module that can count it, built in
// cmd/api/main.go.
//
// THE KEY IS WIRE FORMAT: it is a field name in the response and clients
// switch on it, so renaming one silently drops a badge rather than failing
// anything.
type Registry map[string]Counter

// Repository is the persistence boundary — such as it is. Counting is the
// whole of it, and the counting lives in the registered modules.
type Repository interface {
	// Pending returns every registered count for the caller, keyed by wire
	// name.
	//
	// It FAILS if any single counter fails, rather than omitting that key or
	// reporting it as zero. A badge that wrongly reads zero is worse than no
	// badge at all: it does not say "I could not check", it says "nothing is
	// waiting for you", which is the one thing this endpoint exists to never
	// get wrong.
	Pending(ctx context.Context, userID string) (map[string]int, error)
}
