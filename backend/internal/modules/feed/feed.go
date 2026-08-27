// Package feed answers one question: what have my training partners been doing.
//
// **IT IS THE FIRST ATHLETE-TO-ATHLETE READ OF TRAINING DATA IN THIS SYSTEM,
// and that is the fact to hold on to when changing anything here.** Every other
// read of `sessions` is `WHERE user_id = $1` with no exceptions; the share
// module moves COPIES on an explicit send-and-accept precisely so that it never
// has to decide who may see what. This package decides, so it does so in one
// query, in one place, and refuses to grow a second path.
//
// # Three conditions, all required
//
// A session appears in your feed only if all of these hold:
//
//  1. Its owner is an ACCEPTED friend of yours. Not pending, not requested —
//     accepted, which means both people agreed.
//  2. Its owner has turned `share_training_with_friends` ON. Off by default,
//     read LIVE rather than stamped onto the session, so switching it off
//     retracts everything immediately. That is the property a privacy control
//     has to have, and it is worth the retroactive-on side (turning it on shows
//     old sessions too — the settings copy says so).
//  3. The session is FINISHED. An in-progress session is a live location, and
//     "training right now" is a different disclosure from "trained on Tuesday".
//
// # What a row deliberately does not carry
//
// No sets, no notes, no RPE, no exercise ids. A feed says *that* somebody
// trained and roughly how much; it is not a window into their programme. The
// row is the smallest thing that makes a card, and enlarging it is a privacy
// decision rather than a feature.
//
// Notes especially: they are free prose an athlete wrote for themselves, and
// nothing in the app has ever suggested otherwise.
//
// # The one enlargement, and its own switch
//
// A row MAY carry `Detail` — up to five exercise or technique names with the
// top set or the outcome beside each. That is the paragraph above being
// overruled, so it was made a decision rather than a feature, exactly as that
// paragraph demanded: it needs a SECOND opt-in, `share_training_details`, off
// by default and separate from the one that puts you in the feed at all.
//
// Why two switches. The numbers say you trained hard; the detail says what you
// are working on. Those are different disclosures — somebody who competes
// against their training partners can reasonably want the first without the
// second — and one switch could not express that.
//
// It stays inside the original limits. Still no sets, no notes, no RPE, no
// ids: `Detail` carries a NAME and a figure, both of which the owner already
// chose to publish by turning the switch on. And it is read live, so switching
// it off strips the detail from every past row at once — the same property the
// master switch has, and for the same reason.
//
// # No unread state, and therefore no badge
//
// The notification module counts what is WAITING on you, and its rule is that
// answering the pending row is what clears the count — which is why it needs no
// read/unread state anywhere. A feed item is not answerable, so it has nothing
// to clear and cannot register there. Badging a feed would require inventing
// exactly the second source of truth that module was built to avoid.
package feed

import (
	"context"
	"time"
)

// No domain errors. A feed is a list and an empty one is an answer, so there
// is no ErrNotFound; and the only bad input is a malformed limit or offset,
// which the handler rejects before reaching the repository. An `ErrInvalidInput`
// was declared here first and never referenced — a sentinel nothing returns is
// a promise the package does not keep.

const (
	// DefaultLimit and MaxLimit mirror `session.List`, which is the only other
	// paged endpoint in the app. A feed is browsed rather than drained, so it
	// takes the offset+total shape docs/architecture/api-conventions.md
	// prescribes for that, not a cursor.
	DefaultLimit = 30
	MaxLimit     = 100
	// maxFriends bounds the id set the query fans out over. The friends list
	// itself is capped at 500; this is the same ceiling stated where it
	// matters, so an athlete with an implausible number of friends cannot make
	// this the most expensive query in the app.
	maxFriends = 500
)

// Item is one finished session, as somebody else's feed sees it.
//
// Named for the feed rather than for the session, because it is deliberately
// NOT a `session.Session` with fields removed — that shape would invite the
// missing ones back. This is its own type and its own contract.
type Item struct {
	// ID is the session's id, and no endpoint anywhere accepts it from
	// somebody who does not own it — `session.Get` is owner-scoped, so this is
	// a key for a list, not a handle to fetch with. It is here because a client
	// needs a stable key and the alternative (from+timestamp) can collide.
	ID string `json:"id"`
	// From is the owner's HANDLE, never their user id — the same rule the
	// whole social API follows in both directions. Joined live, so a rename
	// propagates rather than freezing whatever the name was that day.
	From        string  `json:"from"`
	DisplayName *string `json:"display_name"`

	Sport string `json:"sport"`
	Name  string `json:"name"`

	StartedAt time.Time `json:"started_at"`
	// EndedAt is never null: unfinished sessions are excluded entirely.
	EndedAt time.Time `json:"ended_at"`

	// WorkingSets and TonnageKg follow `session.Summarise` exactly — warm-ups
	// and uncompleted sets contribute nothing. Computed in SQL here rather than
	// by loading sets, because a feed page would otherwise be an N+1 over other
	// people's training; the rule is duplicated and a test pins the two
	// against each other.
	WorkingSets int     `json:"working_sets"`
	TonnageKg   float64 `json:"tonnage_kg"`

	// Detail is empty unless the OWNER has `share_training_details` on. Empty
	// rather than null so a client can iterate it without a nil check, and so
	// "opted out" and "an empty session" render identically — which they
	// should, because the alternative advertises who has the switch off.
	Detail []Detail `json:"detail"`
	// More is how many names Detail left out, so a card can say "+4 more".
	// Zero whenever Detail is, for the same reason.
	More int `json:"more"`
}

// Detail is one line of what was done: an exercise, or a technique.
//
// **THE SAME WIRE SHAPE AS `sessioncard.Detail`, and deliberately a separate
// Go type.** Modules in this codebase do not import each other — the feed
// already inverts its one dependency into the `Friends` interface for that
// reason — and importing another module for a struct would be the first
// exception. The client renders both through one component, so the JSON must
// match exactly; a test marshals both and compares the field sets rather than
// trusting this comment, the same way `workingVolume` is pinned against
// `session.Summarise`.
type Detail struct {
	Name string `json:"name"`
	// Strength: the top working set, e.g. "140 kg × 5". Empty for BJJ.
	Figure string `json:"figure,omitempty"`
	// BJJ: "scored", "attempted", "drilled". Empty for strength.
	Outcome string `json:"outcome,omitempty"`
	// BJJ: how many times, when more than one.
	Count int `json:"count,omitempty"`
}

// MaxDetail matches sessioncard.MaxDetail: five names plus a count is the
// session, and a twelve-exercise list turns a card into a spreadsheet. Capped
// server-side, so an opted-in athlete's whole programme never crosses the wire
// to be trimmed on somebody else's phone.
const MaxDetail = 5

// Page is the offset+total shape the conventions prescribe for a browsed list.
type Page struct {
	Items  []Item `json:"items"`
	Total  int    `json:"total"`
	Limit  int    `json:"limit"`
	Offset int    `json:"offset"`
	// WindowDays is FeedWindow (postgres.go), reported rather than left
	// implicit — N13 (#379). Before this, the value existed only as a Go
	// constant plus three independently hand-written copies of "3 days" (two
	// mobile strings, one line of OpenAPI prose), none of which could ever
	// notice the other two going stale. Same shape as `bjj.DraftQuota.Limit`:
	// the number is computed server-side, once, and a client renders it
	// rather than re-stating it — so "configurable in one place" is actually
	// true of the COPY too, not just the SQL clause it always drove.
	WindowDays int `json:"window_days"`
}

// Friends is the social-graph test, satisfied by the friend module. Declared
// here as a CONSUMER-side interface so this package does not import that one —
// the same inversion `share.Friends` uses, for the same reason.
type Friends interface {
	// FriendIDs returns the user ids of everyone who has ACCEPTED a friendship
	// with the caller. Ids rather than handles because this is the inside of
	// the system talking to itself; the wire still only ever sees handles.
	FriendIDs(ctx context.Context, userID string) ([]string, error)
}

// Repository is the persistence boundary.
type Repository interface {
	// List returns finished sessions belonging to the caller's opted-in
	// friends, newest first. The caller's OWN sessions are excluded — a feed
	// of your own training is the Today tab, and mixing them in makes the one
	// question this screen answers ("what has everyone else been doing")
	// impossible to read at a glance.
	List(ctx context.Context, userID string, limit, offset int) (Page, error)
}

// ClampLimit turns a client's requested page size into one this endpoint will
// serve, reporting whether the request was acceptable at all.
//
// A pure function because it is the whole of the paging contract and the
// handler cannot be tested around it — `auth`'s context key is unexported, so
// a handler test cannot get past the first line. The same reason
// `share.ScopeFilter` and `theme.CleanTitle` were extracted.
//
// Zero means "unspecified" and gets the default. NEGATIVE is rejected rather
// than clamped: it is a client bug, and quietly serving page one hides it.
func ClampLimit(requested int) (int, bool) {
	if requested < 0 {
		return 0, false
	}
	if requested == 0 {
		return DefaultLimit, true
	}
	if requested > MaxLimit {
		return MaxLimit, true
	}
	return requested, true
}
