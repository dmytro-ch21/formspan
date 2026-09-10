// Package biometric holds heart-rate samples read from the platform health
// stores (HealthKit / Health Connect) and the per-session numbers derived
// from them — average and peak HR, a five-zone breakdown, and one
// cross-sport load figure (Edwards' TRIMP).
//
// Deliberately named `biometric`, not `health` — that name is already taken
// by internal/modules/health, which is operational telemetry (server errors,
// sync-blocked events), a wholly different domain that happens to share the
// word. See docs/decisions/health-integration-design.md §6.3.
//
// Sport-agnostic by construction: everything here is keyed on a generic
// `sessions` row's started_at/ended_at window (design doc §2's "window
// read"), never on a platform-specific workout object, so one module serves
// running, strength and BJJ sessions alike without special-casing any of
// them — the same posture running.go takes deriving from `sessions` rather
// than from a sport-specific parent.
//
// No client (mobile/web) surface exists yet. This ticket (N476/#821) is
// storage and computation only; the samples arrive from whatever ticket
// teaches a client to read HealthKit/Health Connect, and the join logic that
// decides window-read vs. workout-anchor (design doc §2, §6.2's `enrich.ts`)
// is inherently client-side — it needs to see the platform's own workout
// object, which never reaches this backend. What this package owns is
// storing whatever samples a caller reports, and deriving session metrics
// from whichever samples fall in a session's time window.
package biometric

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"
)

var (
	// ErrNotFound covers "no such session", "not yours", and "no metrics
	// computed for this session yet" alike — the same non-disclosure stance
	// running.ErrNotFound documents: telling these apart would let a caller
	// probe for which session ids are real.
	ErrNotFound = errors.New("biometric: not found")
	// ErrInvalidInput covers both a value this package's own Validate
	// rejects and a constraint Postgres rejects on our behalf
	// (translatePgError).
	ErrInvalidInput = errors.New("biometric: invalid input")
	// ErrAlreadyExists means a submitted sample id already belongs to a
	// DIFFERENT user — see PostgresRepository.PutSamples's doc comment,
	// which mirrors activity.Create's ID-collision handling exactly.
	ErrAlreadyExists = errors.New("biometric: already exists")
)

// MetricType is the vocabulary of readings this package stores.
//
// A deliberately small starting set — exactly what Phase 1 (HR session
// enrichment) and its two immediate follow-on tickets need: heart_rate
// drives TRIMP and zones, active_energy feeds active_kcal, and the
// remaining four are Tier 2/3 readings (design doc §3) whose storage this
// module can already take even though nothing computes from them yet.
// Growing this list is a one-line Go change, matching running.Source's
// stance on its own closed-but-extensible vocabulary — deliberately no
// database CHECK constraint (see the migration), for the same reason.
//
// MetricVO2Max is exactly that one-line growth, added by N477/#822 rather
// than N476/#821: the design doc's §3 is explicit that VO₂max is "read,
// never computed" and shown as a profile-level trend rather than joined to
// a session, so it needed no session-window plumbing of its own — only a
// vocabulary slot for whatever client reads it first to write into. No
// migration alongside it, for the same "no CHECK constraint" reason as
// every other value here.
type MetricType string

const (
	MetricHeartRate        MetricType = "heart_rate"
	MetricActiveEnergy     MetricType = "active_energy"
	MetricRestingHeartRate MetricType = "resting_heart_rate"
	MetricHRVSDNN          MetricType = "hrv_sdnn"
	MetricHRVRMSSD         MetricType = "hrv_rmssd"
	MetricSleepDuration    MetricType = "sleep_duration"
	MetricBodyMass         MetricType = "body_mass"
	MetricVO2Max           MetricType = "vo2_max"
)

var metricTypes = []MetricType{
	MetricHeartRate, MetricActiveEnergy, MetricRestingHeartRate,
	MetricHRVSDNN, MetricHRVRMSSD, MetricSleepDuration, MetricBodyMass,
	MetricVO2Max,
}

// MetricTypes lists the vocabulary, for a client rendering something without
// hardcoding the list a second time. Matches running.Sources' shape.
func MetricTypes() []MetricType {
	out := make([]MetricType, len(metricTypes))
	copy(out, metricTypes)
	return out
}

func (m MetricType) Valid() bool { return slices.Contains(metricTypes, m) }

// Source is the device or vendor a sample came from.
//
// hrv_sdnn and hrv_rmssd are separate MetricTypes rather than one `hrv` type
// with a Source-dependent unit, per design doc §5.4/§6.3: "system-design §8
// said don't compare them; making them the same enum value is how someone
// eventually does." Source and MetricType are independent axes on purpose —
// a reading's vendor does not imply which of the two HRV algorithms it used.
type Source string

const (
	SourceAppleWatch Source = "apple_watch"
	SourceOura       Source = "oura"
	SourceWhoop      Source = "whoop"
	SourceGarmin     Source = "garmin"
	SourceManual     Source = "manual"
	// SourceAndroidWearable covers a Health Connect sample whose writing app
	// (its `dataOrigin`, in Health Connect's own terms) isn't one of the
	// vendors above — Samsung Health chief among them: extremely common on
	// Android, and Health Connect's own docs list no stable per-vendor
	// identifier this package could match against the way SourceGarmin/
	// SourceOura/SourceWhoop do for named apps. Added for N478 rather than
	// silently mislabelling those readings as SourceGarmin (a real lie) or
	// SourceManual (also a lie — nobody typed these in), which is exactly
	// the kind of false precision the hr_source honesty discipline (design
	// doc §6.3) exists to rule out one level up. Matches this package's own
	// doc comment on MetricType: "growing this list is a one-line Go
	// change."
	SourceAndroidWearable Source = "android_wearable"
	// SourceHRMonitor (N528/#958): any Bluetooth Heart Rate Profile device —
	// an Amazfit, a Garmin, a Polar strap — read live by this app. One value
	// on purpose: the profile is vendor-neutral and the app never learns the
	// vendor from it; the monitor's advertised name stays on the phone that
	// paired it, which is where the report names it from.
	SourceHRMonitor Source = "hr_monitor"
)

var sources = []Source{
	SourceAppleWatch, SourceOura, SourceWhoop, SourceGarmin, SourceManual, SourceAndroidWearable,
	SourceHRMonitor,
}

func Sources() []Source {
	out := make([]Source, len(sources))
	copy(out, sources)
	return out
}

func (s Source) Valid() bool { return slices.Contains(sources, s) }

// SourcePlatform is which platform health store surfaced the sample.
//
// `manual` covers a sample the athlete typed in directly rather than one a
// device wrote to a health store — not in the design doc's original two-value
// sketch (healthkit/health_connect), added because Source already allows
// SourceManual and a manual reading has to name a source_platform too; NOT
// NULL is what protects trend-by-(metric_type, source) grouping (§6.3) from
// ever colliding null with an intentional value.
type SourcePlatform string

const (
	PlatformHealthKit     SourcePlatform = "healthkit"
	PlatformHealthConnect SourcePlatform = "health_connect"
	PlatformManual        SourcePlatform = "manual"
	// PlatformBluetooth (N528/#958): recorded by this app itself, live, from a
	// Bluetooth Heart Rate Profile monitor (GATT 0x180D) — no health store in
	// between. The one platform whose samples ComputeSessionMetrics prefers
	// over the rest for the same window; see MergeHRSources. `source` is
	// SourceHRMonitor for these.
	PlatformBluetooth SourcePlatform = "bluetooth"
)

var sourcePlatforms = []SourcePlatform{PlatformHealthKit, PlatformHealthConnect, PlatformManual, PlatformBluetooth}

func SourcePlatforms() []SourcePlatform {
	out := make([]SourcePlatform, len(sourcePlatforms))
	copy(out, sourcePlatforms)
	return out
}

func (p SourcePlatform) Valid() bool { return slices.Contains(sourcePlatforms, p) }

// maxSampleIDLength, maxUnitLength bound their TEXT columns generously —
// range checks, not format checks, matching running's stance on
// HealthKitUUID: stop an absurd payload without becoming a second place a
// format has to be kept in sync with reality.
const (
	maxSampleIDLength = 128
	maxUnitLength     = 32
)

// MaxSamplesPerRequest bounds one PutSamples call.
//
// Apple Watch samples continuously (not just every ~5 minutes) during an
// active workout (design doc §2); a two-hour session at roughly one sample
// every few seconds is on the order of a couple thousand points. 10,000 is
// generous headroom over any real sync batch — the same "stop an unbounded
// client payload from becoming an unbounded transaction" reasoning as
// running.MaxRoutePoints.
const MaxSamplesPerRequest = 10000

// MaxSamplesPerListQuery bounds one ListSamples call — the read side's own
// ceiling, separate from MaxSamplesPerRequest above. The 400-day window cap
// on `from`/`to` (see the handler) bounds TIME, not ROW COUNT: continuous
// per-second heart_rate sampling during active workouts, summed across
// months, can run into the hundreds of thousands of rows long before the
// window limit ever bites — a query with no ceiling of its own would
// buffer all of it in memory (and, through apihttp's conditional-GET
// hashing, a second time over) for the ETag alone. 20,000 matches
// running.MaxRoutePoints' order of magnitude — generous for the kind of
// read this exists to serve (a trend surface, not a full-fidelity export)
// — and results are returned oldest-first (`ORDER BY measured_at, id`), so
// a caller that hits the cap narrows `from`/`to` rather than losing recent
// data silently.
const MaxSamplesPerListQuery = 20000

// Sample is one raw reading.
type Sample struct {
	// ID is client-generated, matching activities' idempotency pattern
	// (design doc §6.3) — a sync retry re-sends the same id and converges
	// rather than duplicating.
	ID string `json:"id"`

	MetricType     MetricType     `json:"metric_type"`
	Source         Source         `json:"source"`
	SourcePlatform SourcePlatform `json:"source_platform"`

	Value float64 `json:"value"`
	Unit  string  `json:"unit"`

	MeasuredAt time.Time `json:"measured_at"`
	// PeriodEnd is nil for an instantaneous reading (a single HR sample) and
	// set for one covering an interval (e.g. a night's sleep_duration) — see
	// the migration's column comment.
	PeriodEnd *time.Time `json:"period_end"`

	CreatedAt time.Time `json:"created_at"`
}

// Validate reports whether this is a sample the system can store.
func (s Sample) Validate() error {
	if s.ID == "" || len(s.ID) > maxSampleIDLength {
		return ErrInvalidInput
	}
	if !s.MetricType.Valid() {
		return ErrInvalidInput
	}
	if !s.Source.Valid() {
		return ErrInvalidInput
	}
	if !s.SourcePlatform.Valid() {
		return ErrInvalidInput
	}
	// N528/#958: `bluetooth` and `hr_monitor` go together, both ways. The
	// platform alone now decides real behaviour (MergeHRSources' priority,
	// hr_direct_count), so a sample claiming one half without the other
	// would take part in — or be excluded from — that priority on a field
	// that contradicts its own `source`. Neither value existed before N528,
	// so no client can have been sending either legitimately.
	if (s.SourcePlatform == PlatformBluetooth) != (s.Source == SourceHRMonitor) {
		return ErrInvalidInput
	}
	if s.Unit == "" || len(s.Unit) > maxUnitLength {
		return ErrInvalidInput
	}
	if s.MeasuredAt.IsZero() {
		return ErrInvalidInput
	}
	if s.PeriodEnd != nil && s.PeriodEnd.Before(s.MeasuredAt) {
		return ErrInvalidInput
	}
	return nil
}

// HRSource is how confidently a session's heart-rate metrics are grounded in
// real evidence — design doc §2, §6.3. Required, never defaulted: a
// session_metrics row that claims `workout` or `window` confidence when
// SampleCount is 0 would be exactly the false precision system-design §7
// rules out, so Compute (see trimp.go) always forces `none` when there are
// no samples, regardless of what a caller claims.
type HRSource string

const (
	// HRSourceWorkout means the samples backing this session's metrics are
	// known to come from a platform workout object the caller matched to
	// this session (design doc §2's anchor refinement) — evidence at least
	// as dense as an actively-recorded workout. No caller of this backend
	// can produce this today (the anchor match is client-side, and nothing
	// client-side has been built yet — see the package doc), but the value
	// exists now so the shape does not have to change when one does.
	HRSourceWorkout HRSource = "workout"
	// HRSourceWindow means the samples came from a plain time-window read
	// (design doc §2's default, primary path) — real evidence, but without
	// the guarantee that every sample in the window was actually recorded
	// during the session rather than, say, the walk to the gym.
	HRSourceWindow HRSource = "window"
	// HRSourceNone means no heart-rate samples were found for this session
	// at all. Not an error — most athletes have no wearable, and system
	// design must not read that as misconfiguration (design doc §5.1).
	HRSourceNone HRSource = "none"
)

var hrSources = []HRSource{HRSourceWorkout, HRSourceWindow, HRSourceNone}

func HRSources() []HRSource {
	out := make([]HRSource, len(hrSources))
	copy(out, hrSources)
	return out
}

func (s HRSource) Valid() bool { return slices.Contains(hrSources, s) }

// MaxHRWindowOverrideDrift bounds how far an explicit HR-window override
// (ComputeSessionMetrics's windowStart/windowEnd parameters) may sit from the
// owning session's own started_at — N522/#934. A sanity check, not a security
// boundary: the samples read are always the caller's own, override or not.
// It exists to reject an override that is obviously not "the same session,
// mistimed" before it is stored as a real hr_window_start/hr_window_end.
//
// CORRECTION (backend-reviewer, N522 PR review): this comment previously
// claimed the mobile client's own fit padding puts its worst case at "roughly
// 14h from started_at at the far edge". That was wrong, measured directly
// against apps/mobile/lib/hrWindowFit.ts's real shape: wideHRQueryWindow
// bounds to the session's dated CALENDAR DAY (not a fixed offset from
// started_at) plus WIDE_WINDOW_PADDING_HOURS on each side, so a session
// started near local midnight puts the wide window's far edge up to
// `24h + WIDE_WINDOW_PADDING_HOURS` (~25.9h) from started_at — ABOVE this
// 24h bound. The client cannot close that gap by retuning its own padding
// (the gap IS the padding, for any positive value), so
// apps/mobile/lib/hrWindowFit.ts's fitHRWindow instead carries its own
// HR_FIT_MAX_BACKEND_DRIFT_MS mirroring this exact constant, and declines a
// fit that would land outside it rather than ever sending an override this
// validation is guaranteed to reject. This bound itself is unchanged by that
// correction — it exists to catch a client sending something unrelated to
// the session at all, and 24h was and remains the deliberately-chosen value;
// only the "why the client already respects it" justification was wrong.
const MaxHRWindowOverrideDrift = 24 * time.Hour

// ValidateHRWindowOverride checks a caller-supplied HR-window override
// against the session it is for — N522/#934, the fix for a post-hoc-logged
// session whose recorded started_at/ended_at do not reflect when the
// athlete actually trained. Pure, so "is this a sane override" is
// unit-testable without a database.
//
// windowStart and windowEnd must both be present or both be absent — one
// without the other is a malformed request, not "no override" (see
// Repository.ComputeSessionMetrics's own doc comment on why nil,nil is the
// only legitimate "no override" shape). This NEVER touches sessions.started_at
// or sessions.ended_at — it only changes which biometric_samples
// ComputeSessionMetrics reads for THIS computation. That is deliberate:
// "heart rate corroborates a session, it never replaces what the athlete
// logged" (docs/testing — vola-athlete-ux's BJJ conventions), so the
// athlete's own authored start/end time is never silently rewritten by an
// inferred fit, no matter how confident.
func ValidateHRWindowOverride(sessionStartedAt time.Time, windowStart, windowEnd *time.Time) error {
	if windowStart == nil && windowEnd == nil {
		return nil
	}
	if windowStart == nil || windowEnd == nil {
		return fmt.Errorf("%w: hr_window_start and hr_window_end must both be set or both omitted", ErrInvalidInput)
	}
	if !windowStart.Before(*windowEnd) {
		return fmt.Errorf("%w: hr_window_start must be before hr_window_end", ErrInvalidInput)
	}
	if absDuration(windowStart.Sub(sessionStartedAt)) > MaxHRWindowOverrideDrift ||
		absDuration(windowEnd.Sub(sessionStartedAt)) > MaxHRWindowOverrideDrift {
		return fmt.Errorf("%w: hr_window is too far from the session's own started_at", ErrInvalidInput)
	}
	return nil
}

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

// HRMaxSource records whether the HRmax value that produced a session's
// zones/TRIMP (SessionMetrics.HRMaxBPM) was an ESTIMATE or an OBSERVED
// maximum — N483/#833, following design doc §3's HRmax sequencing directly:
//
//	"Seed from 220 − age, and mark the session's zones as estimated...
//	Replace it with the observed maximum across the athlete's own history
//	as soon as there is one... Never silently switch between them. Which
//	HRmax produced a given session's zones belongs in session_metrics
//	alongside hr_source, for the same reason."
//
// Required whenever HRMaxBPM is non-nil — the honest-confidence pairing
// this package already uses for HRSource/SampleCount, applied to the OTHER
// input a session's zones depend on. Not a growing vocabulary (unlike
// MetricType/Source): exactly two provenances exist for HRmax per the design
// doc's sequencing, so — like HRSource — this gets a real database CHECK
// constraint too (see the migration), not just Go-side validation.
type HRMaxSource string

const (
	// HRMaxSourceEstimated means the value is the 220 − age formula seeded
	// from profile.date_of_birth — design doc §3 step 1. A poor estimator
	// (±10-12 bpm standard deviation) that a client must label as such
	// wherever a session's zones are shown, per that section.
	HRMaxSourceEstimated HRMaxSource = "estimated"
	// HRMaxSourceObserved means the value is the highest heart rate actually
	// recorded across the athlete's own history — design doc §3 step 2,
	// preferred over the estimate the moment one exists.
	HRMaxSourceObserved HRMaxSource = "observed"
)

var hrMaxSources = []HRMaxSource{HRMaxSourceEstimated, HRMaxSourceObserved}

// HRMaxSources lists the vocabulary, matching HRSources' shape.
func HRMaxSources() []HRMaxSource {
	out := make([]HRMaxSource, len(hrMaxSources))
	copy(out, hrMaxSources)
	return out
}

func (s HRMaxSource) Valid() bool { return slices.Contains(hrMaxSources, s) }

// SessionMetrics is the derived per-session enrichment — one row per session.
type SessionMetrics struct {
	SessionID string `json:"session_id"`

	// AvgHRBPM, MaxHRBPM and TRIMP are nil together whenever SampleCount is
	// 0 (HRSourceNone) — there is nothing to average, and TRIMP additionally
	// stays nil whenever no HRmax was available to classify zones by, even
	// with real samples present (see Compute in trimp.go). Nil, not zero:
	// zero would assert "measured and it was zero", which is not what an
	// absent computation means.
	AvgHRBPM *int     `json:"avg_hr_bpm"`
	MaxHRBPM *int     `json:"max_hr_bpm"`
	TRIMP    *float64 `json:"trimp"`

	// ActiveKcal sums whatever active_energy samples fall in the session's
	// window. Nil when none were found — same "absent, not zero" stance.
	ActiveKcal *int `json:"active_kcal"`

	// HRMaxBPM and HRMaxSource record which HRmax value produced THIS row's
	// zones/TRIMP, and whether it was estimated or observed — design doc §3:
	// "which HRmax produced a given session's zones belongs in
	// session_metrics alongside hr_source." N483/#833, a follow-up to
	// N476/#821 which stored zones/TRIMP without this provenance.
	//
	// Nil together whenever TRIMP is nil (same gating as TimeInZones) — there
	// is no HRmax to attribute when nothing was classified against one — AND
	// on any row computed before N483 shipped, since the migration adds both
	// columns nullable with no backfill (see the migration's comment: no
	// client surface existed yet to have written a real row). A nil here on
	// a row that DOES carry a TRIMP means exactly one thing: "computed before
	// this ticket," never "computed with no HRmax," which TRIMP-is-nil
	// already covers.
	//
	// No separate history of past values: ComputeSessionMetrics UPSERTs one
	// row per session (ON CONFLICT DO UPDATE, see postgres.go), so a
	// recompute with a different HRmax simply overwrites these two fields
	// along with the rest of the row — the row itself is the up-to-date
	// record of what produced its current numbers, the same "derive on
	// demand, don't keep a stale copy" stance this table already takes on
	// zones/TRIMP overall (see the migration's own comment).
	HRMaxBPM    *float64     `json:"hr_max_bpm"`
	HRMaxSource *HRMaxSource `json:"hr_max_source"`

	// TimeInZones maps zone number ("1".."5") to minutes spent in that
	// zone. Always present as a (possibly empty) object once JSON-encoded —
	// see Compute — never null, so a client can iterate without a nil
	// check, matching running's stance on RoutePoints/Splits.
	TimeInZones map[string]float64 `json:"time_in_zones"`

	// HRSource and SampleCount are the honest-confidence fields (design doc
	// §6.3) and are not optional — HRSource always carries a real value
	// (never the empty string) once this leaves Compute.
	HRSource    HRSource `json:"hr_source"`
	SampleCount int      `json:"sample_count"`

	// N528/#958 — provenance of the samples above. HRDirectCount is how many
	// of SampleCount were recorded straight from a Bluetooth monitor by this
	// app (source_platform bluetooth); SampleCount - HRDirectCount is what
	// Apple Health / Health Connect contributed (gap fill only, once a direct
	// stream exists — MergeHRSources). The monitor's NAME is not here: the
	// phone that paired it remembers it, and the report names it from there.
	HRDirectCount int `json:"hr_direct_count"`

	// HRWindowStart and HRWindowEnd are the ACTUAL [start, end] this row's
	// samples were queried from — always populated once a row exists, never
	// nil. Ordinarily this equals the owning session's own
	// started_at/ended_at (design doc §2's plain window read); it differs
	// only when ComputeSessionMetrics's caller supplied an explicit
	// windowStart/windowEnd override — N522/#934's fix for a post-hoc-logged
	// session whose recorded times don't reflect when the athlete actually
	// trained. Surfacing this on every row (not only overridden ones) is
	// deliberate: it is exactly what would have made that incident
	// immediately diagnosable rather than invisible — the athlete's watch
	// had real data the whole time; nothing had ever queried for it in the
	// right place, and there was nowhere to see what place HAD been queried.
	// Never affects sessions.started_at/ended_at — see
	// ValidateHRWindowOverride's doc comment.
	HRWindowStart time.Time `json:"hr_window_start"`
	HRWindowEnd   time.Time `json:"hr_window_end"`

	ComputedAt time.Time `json:"computed_at"`
	// RuleVersion matches what the design doc already requires of the
	// recommendation engine (§8): store the inputs and the rule version
	// alongside every derived output, so a later change to the TRIMP
	// formula or the zone boundaries is a version bump a client can detect
	// rather than a silently reinterpreted old number.
	RuleVersion int `json:"rule_version"`
}

// MaxSessionLoadRows bounds one ListSessionLoad call — the row-count ceiling
// `docs/architecture/api-conventions.md`'s conditional-GET section requires
// of every list endpoint, independent of maxSessionLoadRangeDays' TIME cap
// (handler.go): every response passes through apihttp's ETag hashing, which
// buffers the whole body to hash it, so peak memory is only bounded when
// every list has a row ceiling of its own — the exact property that section
// names two endpoints (`activity.ListByUser`, `workout.List`) for lacking
// before it was added there. `ListSamples`' MaxSamplesPerListQuery is the
// direct precedent in this same package. 5000 is generous headroom over any
// realistic training history — training five times a week for a decade is
// under 2,700 sessions with a computed load — and results are returned
// oldest-first with a deterministic `(started_at, id)` tiebreak, so a caller
// that hits the cap narrows `from`/`to` rather than losing recent data
// silently.
const MaxSessionLoadRows = 5000

// SessionLoad is one session's contribution to a cross-session training-load
// trend — N489/#850. Deliberately a NARROW projection of SessionMetrics
// joined with the owning session's sport/started_at, not the full
// SessionMetrics row: the trend this feeds (Progress tab, all three sports)
// needs exactly "when, how much, which sport", and returning the whole row
// (time_in_zones, hr_max_bpm, …) per session would be work the caller never
// uses, multiplied by however many sessions fall in the window.
type SessionLoad struct {
	SessionID string `json:"session_id"`
	// Sport is the owning session's sport ('strength' | 'running' | 'bjj') —
	// what makes this trend legitimately CROSS-SPORT rather than three
	// separate ones: TRIMP is computed identically regardless of sport (see
	// trimp.go), so one query already spans all three.
	Sport     string    `json:"sport"`
	StartedAt time.Time `json:"started_at"`
	// TRIMP is never nil here — see ListSessionLoad's doc comment: a session
	// whose metrics have TRIMP nil (no samples, or no HRmax to classify
	// against) is excluded from the result entirely rather than surfaced as
	// a zero, which is the same "absent, not zero" stance SessionMetrics.TRIMP
	// itself takes.
	TRIMP float64 `json:"trimp"`
}

// ExerciseHR is one exercise's heart-rate readout within a single session —
// N490/#851, extending SessionMetrics' whole-session numbers to the
// granularity a strength athlete actually asked for ("what was my heart
// rate on squats, versus lateral raises"). See ListExerciseHR and
// exerciseHRWindow (trimp.go) for the join-granularity decision this type's
// existence rests on.
//
// Deliberately narrow, matching SessionLoad's own stance: no time_in_zones,
// no TRIMP, no hr_max provenance — a per-exercise breakdown is read
// alongside the session's own SessionMetrics card, not instead of it, so it
// only needs to carry what that card cannot already show.
type ExerciseHR struct {
	ExerciseID string `json:"exercise_id"`
	// AvgHRBPM and MaxHRBPM are never both zero-with-real-meaning here: a
	// row with SampleCount 0 is excluded from ListExerciseHR's result
	// entirely rather than reported with these at zero — the same
	// "absent, not zero" stance SessionMetrics.TRIMP already takes.
	AvgHRBPM int `json:"avg_hr_bpm"`
	MaxHRBPM int `json:"max_hr_bpm"`
	// SampleCount is the honesty figure a client needs to decide how much to
	// trust a single-digit sample average — mirrors SessionMetrics.SampleCount
	// for the same reason.
	SampleCount int `json:"sample_count"`
}

// Repository is the persistence port for this module.
// ObservedHRMax is the highest heart rate this athlete has actually
// recorded, with enough context for a screen to show WHERE it came from
// rather than asserting a bare number.
//
// Design doc §3 step 2: "Replace it with the observed maximum across the
// athlete's own history as soon as there is one — with a strap sampling
// every second, a few hard sessions produce a better number than the
// formula ever will." `220 − age` carries a standard deviation of ±10–12
// bpm, which is routinely enough to move two zone boundaries; a number the
// athlete's own chest actually reached is not an estimate at all.
//
// SampleCount is carried because ONE reading is not a maximum, it is a
// spike. A strap slipping, a cold contact or a car ignition can all produce
// a single implausible beat, and a zone table built on it would be wrong in
// the direction that makes every session look easy. The count lets a caller
// — and the athlete reading the screen — judge how much history is behind
// the figure.
type ObservedHRMax struct {
	BPM float64 `json:"bpm"`

	// MeasuredAt is when the peak itself was recorded, not when it was
	// synced. A maximum from three years ago is a different claim from one
	// from Tuesday, and only the athlete can judge which still describes
	// them.
	MeasuredAt time.Time `json:"measured_at"`

	// SampleCount is how many heart-rate samples exist in total, not how
	// many equal the maximum — the question it answers is "is there enough
	// history here to trust a peak at all".
	SampleCount int `json:"sample_count"`
}

type Repository interface {
	// PutSamples stores a batch of raw readings, idempotently — a retried
	// sync re-sending the same ids converges rather than duplicating or
	// erroring, matching activity.Create's stance on client-generated ids.
	PutSamples(ctx context.Context, userID string, samples []Sample) ([]Sample, error)

	// ListSamples returns the caller's own samples of one metric type whose
	// MeasuredAt falls in [from, to], ascending. The read path a later
	// ticket's trend/effectiveness surface (N477/N481) uses, and the same
	// query ComputeSessionMetrics runs internally scoped to a session's
	// window.
	ListSamples(ctx context.Context, userID string, metricType MetricType, from, to time.Time) ([]Sample, error)

	// ObservedHRMax returns the caller's own highest recorded heart rate,
	// or nil when they have no heart-rate samples at all — which is a
	// normal state for a new athlete, not an error (design doc §6.4's
	// posture, the same one GetSessionMetrics takes).
	//
	// Deliberately unfiltered by date: a maximum is a maximum. Ageing it
	// out on a fixed window would silently downgrade an athlete to the
	// 220−age estimate after a quiet few months, which is exactly the
	// silent switch §3 step 3 forbids. If a stale peak ever needs
	// retiring, that is a decision the athlete makes on a screen showing
	// them the date, not one this query makes for them.
	ObservedHRMax(ctx context.Context, userID string) (*ObservedHRMax, error)

	// ComputeSessionMetrics derives and stores session_metrics for a
	// session the caller owns, from whatever biometric_samples already fall
	// in that session's started_at/ended_at window (design doc §2's window
	// read) — UNLESS windowStart/windowEnd override it (both non-nil; see
	// ValidateHRWindowOverride). hrMaxBPM must be > 0 — see Compute in
	// trimp.go for why zones and TRIMP cannot be derived without it.
	// hrMaxSource must be Valid() and records whether hrMaxBPM is the
	// 220−age estimate or an observed maximum (design doc §3, HRMaxSource's
	// doc comment) — stored alongside hrMaxBPM whenever zones actually get
	// computed from it. hrSourceHint is downgraded to HRSourceNone whenever
	// no heart-rate samples are found, regardless of what the caller claims
	// — see HRSource's doc comment.
	//
	// windowStart and windowEnd (N522/#934) let a caller ask this to look
	// somewhere OTHER than the session's own recorded window — the fix for a
	// post-hoc-logged BJJ session whose started_at/ended_at were computed
	// from when the athlete tapped "Log it", not from when training actually
	// happened, so the exact window a plain read would use finds nothing
	// even though the watch has real data nearby. Both nil means "use the
	// session's own window" (the ordinary case, and the only shape every
	// caller before N522 ever passed); both non-nil is validated by
	// ValidateHRWindowOverride and used as the query window INSTEAD of
	// started_at/ended_at for both the heart-rate and active-energy queries.
	// Exactly one non-nil is ErrInvalidInput. This NEVER writes to
	// sessions.started_at/ended_at — seeing an override is not the same as
	// correcting the session, deliberately (see ValidateHRWindowOverride's
	// doc comment on "corroborates, never replaces"). The resolved window —
	// override or default — is always returned on SessionMetrics.HRWindowStart/
	// HRWindowEnd, so a client can show exactly what was queried regardless
	// of which path produced it.
	//
	// ErrNotFound covers "no such session" and "not yours" alike — telling
	// them apart would confirm which session ids are real. A session with
	// no ended_at yet is a DIFFERENT case and answers ErrInvalidInput
	// instead, deliberately: ownership has already been confirmed by the
	// time that check runs (see postgres.go), so there is nothing left to
	// avoid disclosing — it is an ordinary validation failure ("a load
	// number needs a finished window"), not an authorization one.
	ComputeSessionMetrics(
		ctx context.Context, userID, sessionID string,
		hrMaxBPM float64, hrMaxSource HRMaxSource, hrSourceHint HRSource,
		windowStart, windowEnd *time.Time,
	) (SessionMetrics, error)

	// GetSessionMetrics reads back a previously computed row.
	// ErrNotFound when none has been computed yet — a normal state (design
	// doc §6.4: "session_metrics being absent is a normal state, not an
	// error"), not a fault.
	GetSessionMetrics(ctx context.Context, userID, sessionID string) (SessionMetrics, error)

	// ListSessionLoad returns the caller's own sessions with a COMPUTED
	// TRIMP (i.e. session_metrics.trimp IS NOT NULL) whose started_at falls
	// in [from, to], ascending — N489/#850, the Progress-tab cross-session
	// load trend.
	//
	// A JOIN, not N calls to GetSessionMetrics: the trend this feeds asks
	// for up to a year (or more) of sessions in one screen load, and one
	// query bounded by an index beats a per-session round trip whose count
	// scales with how often the athlete trains — see this ticket's history
	// entry for the full reasoning on why N+1 was rejected here specifically
	// (unlike, say, a single session detail screen, which only ever needs
	// one row and is exactly what GetSessionMetrics already serves).
	//
	// A session with NO computed metrics (never enriched) or with
	// hr_source='none' (no HR evidence at all) is excluded from the result
	// rather than reported as zero load — trimp is nil in both cases (see
	// SessionMetrics.TRIMP's doc comment and Compute in trimp.go), so
	// filtering on "trimp IS NOT NULL" is the same honesty rule already
	// enforced at computation time, applied again at the read.
	ListSessionLoad(ctx context.Context, userID string, from, to time.Time) ([]SessionLoad, error)

	// ListExerciseHR computes, live, one avg/max HR readout per exercise
	// within a session the caller owns — N490/#851. Nothing here is
	// persisted the way SessionMetrics is: each call re-derives its answer
	// from whatever session_sets.performed_at values and heart_rate samples
	// currently exist, which is cheap enough at session-detail scale (a
	// session holds at most maxSets sets, so at most a few dozen distinct
	// exercises) and, unlike SessionMetrics, has no "recompute" verb to keep
	// in sync with a stored row.
	//
	// Requires the session to have ended, exactly like ComputeSessionMetrics
	// and for a related but distinct reason: an in-progress session's
	// LATEST exercise has an open-ended window (its last set's window only
	// extends to "so far"), and reporting that exercise's HR as final would
	// be the same false-confidence mistake SessionMetrics.TRIMP already
	// refuses for a session with no ended_at.
	//
	// An exercise with no completed set carrying a real PerformedAt (never
	// ticked live, or logged before N490 shipped) is excluded from the
	// result entirely — no window exists to derive one from, and the same
	// is true of an exercise whose window contains zero heart_rate samples.
	// Both are the "absent, not zero" stance ExerciseHR's own doc comment
	// describes, not partial results.
	//
	// See exerciseHRWindow (trimp.go) for the per-exercise join-granularity
	// decision and its reasoning, and this ticket's history entry for the
	// fuller account.
	ListExerciseHR(ctx context.Context, userID, sessionID string) ([]ExerciseHR, error)
}
