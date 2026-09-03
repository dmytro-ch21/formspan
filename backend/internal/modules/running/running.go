// Package running holds the running half of a session.
//
// A running session is a row in `sessions` like any other — `sport =
// "running"` — so it stays visible to training history, the consistency
// grid and the cross-sport load currency exactly like a strength or BJJ
// session does. This package owns only what a run has and a lift does not:
// the GPS track, distance splits, elevation and pace.
//
// The split mirrors `bjj`'s SessionDetail deliberately: the client creates
// the session through the session module (a plain `sessions` row, and
// usually a `session_sets` row against a "run" exercise so the generic
// personal-record pipeline sees it — see the package doc on
// `RecordKindsFor`), then PUTs this module's own detail alongside it.
// Nothing here writes the `sessions` table, and nothing here computes a
// personal record: `longest_time` and `furthest_distance` already work for
// any distance_time exercise through `session.Records`, and pace-normalized
// PRs (fastest 5k, fastest 10k) are explicitly out of scope — see the
// history entry this package landed with.
package running

import (
	"context"
	"errors"
	"slices"
	"time"
)

var (
	// ErrNotFound covers "no such session", "not yours" and "not a running
	// session" alike — deliberately the same error everywhere, so a caller
	// cannot use the response to probe for session ids. Same reasoning as
	// bjj.ErrNotFound.
	ErrNotFound = errors.New("running: not found")
	// ErrInvalidInput covers both a value the domain rejects (Validate) and a
	// constraint Postgres rejects on our behalf (translatePgError).
	ErrInvalidInput = errors.New("running: invalid input")
	// ErrAlreadyExists means this HealthKit UUID is already attached to a
	// DIFFERENT session's DETAIL row for this user — the per-user unique
	// index on healthkit_uuid firing. PutDetail is an upsert on session_id,
	// so this can never mean "the same session was saved twice"; it means
	// two different sessions are claiming the same HealthKit workout.
	//
	// This index refuses the DUPLICATE DETAIL ROW, no more — by the time it
	// fires, the caller's generic `sessions` row (created through the
	// session module, before this endpoint is ever reached) already exists
	// server-side. Refusing the detail alone would leave that a real,
	// permanent, detail-less duplicate in the athlete's training history.
	// What makes the end-to-end guarantee "no duplicate RUN" hold is the
	// mobile client's own handling of this exact error: on a 409 here for a
	// HealthKit-sourced session, it deletes the session it just created
	// (locally and via a DELETE call) rather than leaving it orphaned — see
	// `abandonDuplicateHealthKitImport` in apps/mobile/lib/sessionStore.ts.
	// This index is the backstop for the case the import flow's own local
	// ledger cannot catch on its own (a reinstalled app or a second device,
	// neither of which has a ledger to consult) — see HealthKitUUID's doc
	// comment.
	ErrAlreadyExists = errors.New("running: already exists")
)

// sportKey is the `sessions.sport` value this module owns.
//
// Matches the registry key in `internal/platform/discipline`. Duplicated as
// a constant rather than imported, for the same reason bjj does it: the
// registry describes what a client may enable, and this is a storage-level
// invariant about which rows this module may write to — the dependency
// would otherwise run backwards.
const sportKey = "running"

// Source is where a run's track and numbers came from.
type Source string

const (
	// SourcePhoneGPS is a track recorded live by the phone during the run.
	SourcePhoneGPS Source = "phone_gps"
	// SourceHealthKit is a run imported from Apple Health / HealthKit —
	// recorded by a watch or another app, not this one.
	SourceHealthKit Source = "healthkit"
	// SourceManual is hand-entered: distance and duration typed in after the
	// fact, with no track at all. Still a complete session — not every run
	// happens with a phone along.
	SourceManual Source = "manual"
)

var sources = []Source{SourcePhoneGPS, SourceHealthKit, SourceManual}

// Sources lists the source vocabulary, for a client rendering a picker
// without hardcoding the list a second time.
func Sources() []Source {
	out := make([]Source, len(sources))
	copy(out, sources)
	return out
}

func (s Source) Valid() bool {
	return slices.Contains(sources, s)
}

// RoutePoint is one recorded point along the run.
//
// Timestamped rather than merely ordered: RecordedAt is what lets a client
// re-derive pace-over-time or draw the track against a clock, and an array
// index alone cannot survive a partial re-send the way a timestamp can.
type RoutePoint struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
	// ElevationM is nil when the device did not report one — common indoors,
	// on an older phone, or on an imported track with a thinned-out feed.
	// Not defaulting to 0 avoids asserting sea level for a run that simply
	// didn't say.
	ElevationM *float64  `json:"elevation_m"`
	RecordedAt time.Time `json:"recorded_at"`
}

// maxLatDegrees and maxLngDegrees bound a coordinate to the range a real GPS
// fix can report. Not a precision check, and not a reliable catch for a
// swapped lat/lng either — most real coordinates fit in both ranges, so a
// swap only trips this for the minority that don't (e.g. anything with a
// longitude past ±90). What it does reliably catch is a value outside what
// a coordinate can physically be — a stray sentinel, a unit mixup — before
// it becomes a track nobody can render sensibly on a map.
const (
	maxLatDegrees = 90.0
	maxLngDegrees = 180.0
)

func (p RoutePoint) valid() bool {
	if p.Lat < -maxLatDegrees || p.Lat > maxLatDegrees {
		return false
	}
	if p.Lng < -maxLngDegrees || p.Lng > maxLngDegrees {
		return false
	}
	return true
}

// Split is one distance-based split — "this kilometre took 5:12".
//
// Distance-based rather than time-based because that is how every running
// app and every runner already thinks about a split; a time-based split
// ("every 5 minutes") is a different, rarer view this ticket does not build.
type Split struct {
	DistanceM       float64 `json:"distance_m"`
	DurationSeconds int     `json:"duration_seconds"`
}

func (s Split) valid() bool {
	return s.DistanceM > 0 && s.DurationSeconds > 0
}

// MaxRoutePoints bounds the track on one session.
//
// A GPS track sampled every few seconds on a two-hour long run is on the
// order of a thousand points; 20,000 is far past anything a real run
// produces and exists only to stop an unbounded client payload from becoming
// an unbounded transaction — the same reasoning as bjj.MaxTags.
const MaxRoutePoints = 20000

// MaxSplits bounds the split list. A marathon at 1km splits is 42; 500 is far
// past any real run, including one split per tenth of a kilometre on an
// ultra.
const MaxSplits = 500

// maxHealthKitUUIDLength bounds a HealthKit workout UUID. Not a format check
// (Validate does not parse this as a real UUID, the same "range, not shape"
// stance the rest of this file takes on a vocabulary it does not otherwise
// need to police) — HKWorkout.uuid is Apple's standard 36-character UUID
// string, and this is generous headroom over that rather than an exact fit,
// so it stops an absurd payload without becoming a second place the UUID
// format has to be kept in sync with reality.
const maxHealthKitUUIDLength = 128

// SessionDetail is everything a run has beyond the generic session row.
type SessionDetail struct {
	SessionID string `json:"session_id"`

	// RoutePoints is the GPS track, in recording order. Empty for a manual
	// entry or an imported summary with no track — a real run, not an error.
	RoutePoints []RoutePoint `json:"route_points"`
	// Splits are the distance-based splits, in order.
	Splits []Split `json:"splits"`

	// ElevationGainM is total climb, derived client-side from the track (or
	// reported by HealthKit) rather than recomputed here — this module
	// stores what it is told, the same stance session.Set.LoadFactor's
	// sibling fields take on derived numbers elsewhere in this codebase.
	ElevationGainM *float64 `json:"elevation_gain_m"`
	// AvgPaceSecPerKm is seconds per kilometre, averaged over the whole run.
	// Nil rather than computed from DistanceM/DurationSeconds here: a client
	// with a real track may have a better number (excluding paused time),
	// and this module must not silently override it with a coarser one.
	AvgPaceSecPerKm *float64 `json:"avg_pace_sec_per_km"`
	// DistanceM and DurationSeconds are the run's own numbers.
	//
	// Deliberately duplicated from wherever a `session_sets` row for this
	// session's exercise also carries them (see the package doc): that row
	// is what the generic Records pipeline reads for longest_time and
	// furthest_distance, while these are what THIS module's own detail
	// screen renders without a second fetch. The two are populated from the
	// same client-side numbers and are not reconciled against each other —
	// same relationship bjj's SessionRPE has to session_sets.rpe on a
	// strength session: same fact, two homes, because they serve different
	// screens.
	DistanceM       *float64 `json:"distance_m"`
	DurationSeconds *int     `json:"duration_seconds"`

	Source Source `json:"source"`

	// HealthKitUUID is the `HKWorkout.uuid` a HealthKit-imported run came
	// from — nil for every other source. This is the dedup key: N465's
	// import flow checks its own local ledger before ever reaching here, but
	// a reinstalled or second device has no local ledger to check, so this
	// column carries a per-user unique index (see the migration) as the
	// backstop that makes a repeat import of the same watch-recorded run
	// impossible rather than merely unlikely. Stored as given, not required
	// to be non-nil for SourceHealthKit — this module stores what it is told
	// (see ElevationGainM's note above), and enforcing that pairing is the
	// client's job, not a storage-level invariant.
	HealthKitUUID *string `json:"healthkit_uuid"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Validate reports whether this is a detail record the system can store.
func (d SessionDetail) Validate() error {
	if !d.Source.Valid() {
		return ErrInvalidInput
	}
	if d.DistanceM != nil && *d.DistanceM < 0 {
		return ErrInvalidInput
	}
	if d.DurationSeconds != nil && *d.DurationSeconds < 0 {
		return ErrInvalidInput
	}
	if d.ElevationGainM != nil && *d.ElevationGainM < 0 {
		return ErrInvalidInput
	}
	if d.AvgPaceSecPerKm != nil && *d.AvgPaceSecPerKm < 0 {
		return ErrInvalidInput
	}
	if d.HealthKitUUID != nil && (*d.HealthKitUUID == "" || len(*d.HealthKitUUID) > maxHealthKitUUIDLength) {
		return ErrInvalidInput
	}
	if len(d.RoutePoints) > MaxRoutePoints {
		return ErrInvalidInput
	}
	for _, p := range d.RoutePoints {
		if !p.valid() {
			return ErrInvalidInput
		}
	}
	if len(d.Splits) > MaxSplits {
		return ErrInvalidInput
	}
	for _, s := range d.Splits {
		if !s.valid() {
			return ErrInvalidInput
		}
	}
	return nil
}

// Repository is the persistence port for the running half of a session.
//
// PutDetail/GetDetail, matching bjj.SessionRepository's shape exactly:
// PutDetail upserts and replaces the route/splits wholesale, so a retry
// after a partial failure (the mobile outbox's ordinary case) converges
// instead of duplicating rather than needing a merge.
type Repository interface {
	PutDetail(ctx context.Context, userID string, d SessionDetail) (SessionDetail, error)
	GetDetail(ctx context.Context, userID, sessionID string) (SessionDetail, error)
}
