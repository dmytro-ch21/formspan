// Package health records the operational events an operator needs to look up,
// and serves them to the admin console.
//
// It exists because the structured logs cannot answer the questions that
// actually get asked. They go to stdout and are read through Railway's viewer:
// not queryable from the admin app, expiring, and — until this change —
// carrying no user id at all, which made "is this athlete having problems?"
// unanswerable rather than merely awkward.
//
// Two things feed it, and they are deliberately not the same thing:
//
//   - The **API observing itself** — server errors and requests slow enough to
//     be a symptom. Measured, trustworthy, and recorded from the middleware so
//     no handler has to remember to.
//   - The **client reporting what the server cannot see** — a push a device
//     gave up on, a local write that failed. This is the class of failure that
//     loses training data silently: the athlete's session sits on their phone,
//     every server-side metric looks perfect, and nobody finds out. Claimed
//     rather than measured, so it is bounded and attributed, never trusted.
package health

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// ErrInvalidInput means a client-reported event was malformed or oversized.
var ErrInvalidInput = errors.New("health: invalid input")

// Source is who noticed the problem.
type Source string

const (
	// SourceAPI is the server observing itself — measured.
	SourceAPI Source = "api"
	// SourceClient is an app reporting something the server cannot observe —
	// claimed. Bounded and attributed on the way in; never trusted.
	SourceClient Source = "client"
)

type Kind string

const (
	// KindServerError is a 5xx. Always worth a row: it is the server's own
	// fault by definition.
	KindServerError Kind = "server_error"
	// KindSlowRequest crossed the latency threshold. Recorded as a symptom,
	// not a failure — the request succeeded.
	KindSlowRequest Kind = "slow_request"
	// KindClientError is anything an app failed at locally.
	KindClientError Kind = "client_error"
	// KindSyncBlocked is the one that matters most: a client has given up
	// pushing something. The training exists only on that device, and no
	// server-side signal exists for it — which is precisely why the client has
	// to say so.
	KindSyncBlocked Kind = "sync_blocked"
)

// Event is one notable thing that happened.
//
// Request fields are pointers because a client-reported event has no request:
// zero would be a claim (`status: 0`, `duration_ms: 0`) where absence is the
// truth. The same reasoning as `user_id` being nullable — an unauthenticated
// failure genuinely has no user, and recording one would be worse than
// recording none.
type Event struct {
	ID         int64          `json:"id"`
	OccurredAt time.Time      `json:"occurred_at"`
	Source     Source         `json:"source"`
	Kind       Kind           `json:"kind"`
	UserID     *string        `json:"user_id"`
	Method     *string        `json:"method"`
	Path       *string        `json:"path"`
	Status     *int           `json:"status"`
	DurationMS *int           `json:"duration_ms"`
	ErrorCode  string         `json:"error_code"`
	Message    string         `json:"message"`
	RequestID  string         `json:"request_id"`
	TraceID    string         `json:"trace_id"`
	Details    map[string]any `json:"details"`
}

// NewEvent is a client-reported problem, before it has been stored.
//
// Deliberately narrow: a client may describe what *it* failed at, and may not
// assert anything about a request the server would have measured itself. It
// cannot set `source`, `status`, `duration_ms` or a user id — those are the
// server's to decide, and a client that could set them could forge a clean
// bill of health for someone else.
type NewEvent struct {
	Kind      Kind           `json:"kind"`
	Message   string         `json:"message"`
	ErrorCode string         `json:"error_code"`
	Details   map[string]any `json:"details"`
}

// Bounds on client-submitted text. Generous enough for a real error, small
// enough that a misbehaving or malicious client cannot use the endpoint as
// free storage.
const (
	MaxMessageLen   = 500
	MaxErrorCodeLen = 64
	// MaxDetailsBytes bounds one event's free-form context.
	//
	// `details` was previously bounded only by the 8KB body cap, which was a
	// fine implicit limit while a request carried one event. The batch form
	// raised the envelope to 64KB, so without this a single event could carry
	// eight times what the whole request used to — and the free-storage
	// concern that justified bounding `message` at all applies unchanged.
	// Found in review.
	MaxDetailsBytes = 4 << 10
)

// Validate bounds and normalises a client report.
//
// Only the two client-reportable kinds are accepted. A client claiming
// `server_error` would put a row in the operator's face that the server never
// observed and cannot corroborate — and the whole value of this table is that
// an operator can tell measured from claimed at a glance.
func (n *NewEvent) Validate() error {
	switch n.Kind {
	case KindClientError, KindSyncBlocked:
	default:
		return ErrInvalidInput
	}
	if len(n.Message) > MaxMessageLen || len(n.ErrorCode) > MaxErrorCodeLen {
		return ErrInvalidInput
	}
	// Measured by marshalling rather than by counting keys: the cost this
	// bounds is the bytes that reach the column, and a small map of very long
	// strings passes any key count.
	if len(n.Details) > 0 {
		b, err := json.Marshal(n.Details)
		if err != nil || len(b) > MaxDetailsBytes {
			return ErrInvalidInput
		}
	}
	return nil
}

// Summary is the shape the health screen opens on — enough to answer "is
// anything wrong right now?" without reading a single row.
type Summary struct {
	Since          time.Time      `json:"since"`
	Total          int            `json:"total"`
	ByKind         map[string]int `json:"by_kind"`
	AffectedUsers  int            `json:"affected_users"`
	SlowestPathsMS map[string]int `json:"slowest_paths_ms"`
}

// Filter narrows the event list. Every field is optional.
type Filter struct {
	Kind   Kind
	UserID string
	Since  time.Time
	Limit  int
}

// DefaultLimit bounds a listing that didn't ask for one — an unbounded read of
// a table that grows with every incident is a page that gets slower exactly
// when it is being used in anger.
const DefaultLimit = 100

// MaxLimit caps what a caller may ask for.
const MaxLimit = 500

type Repository interface {
	// Record stores one event. Best-effort by contract: callers on a request
	// path must not fail a user's request because observability failed.
	Record(ctx context.Context, e Event) error
	// RecordBatch stores several events ATOMICALLY, in one round trip.
	//
	// Beside Record rather than replacing it: the request-logging middleware
	// records exactly one event and would gain nothing from a slice, and
	// reshaping the interface for the batch endpoint's sake would put the
	// endpoint's shape into every caller.
	//
	// Atomic is the point, not just the round trip. A loop of single inserts
	// that fails partway leaves some rows committed and returns 500 — and
	// since the client never retries, the events it then reports as
	// `lost_events` include ones that were in fact stored. Telemetry that
	// misreports its own loss is the failure this whole feature exists to end.
	RecordBatch(ctx context.Context, events []Event) error
	List(ctx context.Context, f Filter) ([]Event, error)
	Summarise(ctx context.Context, since time.Time) (Summary, error)
}
