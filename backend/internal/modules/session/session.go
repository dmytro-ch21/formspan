// Package session holds performed training sessions and the sets that
// actually happened in them.
//
// Deliberately distinct from the workout module, which holds the *plan*.
// Keeping them apart is what preserves the gap between prescribed and
// actual — the adherence signal that makes the history worth analysing. A
// session may follow a template or be entirely freeform.
//
// Sets are stored as rows rather than an aggregate because that's the shape
// of the truth: the third set is heavier, the last one is a drop, the first
// two were warm-ups. "3×5 @ 100" can't express any of that, and it's exactly
// the detail that makes a training log worth keeping.
package session

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type SetType string

const (
	SetTypeWarmup  SetType = "warmup"
	SetTypeWorking SetType = "working"
	SetTypeBackoff SetType = "backoff"
	SetTypeDrop    SetType = "drop"
	SetTypeAMRAP   SetType = "amrap"
	SetTypeFailure SetType = "failure"
)

// Grip is how the implement was held for one set.
//
// A property of the SET, not of the exercise. A catalog row per grip would
// multiply the 762-row catalog into something near 3,000 and still not express the
// thing athletes actually do — switch on the last set because the first three
// hurt — while splitting one exercise's history in two, so the progression
// rule and the personal records each see half the sets.
//
// Six values, and which of them are OFFERED depends on the movement — see
// `GripsFor`. `mixed` and `hook` were absent until #266, which is why that
// function exists: they are how a heavy deadlift is held and they are not
// variations of the other four, so a hinge that could only answer `regular`
// collected a false entry rather than a missing one. The old fix was to
// withhold the picker from hinges, carries and olympic lifts — 93 of 762
// exercises, and the ones where grip matters most.
type Grip string

const (
	// GripRegular — overhand, pronated. The default way almost everything is
	// held, which is exactly why it must be CHOSEN rather than assumed: see
	// the nil case on Set.Grip.
	GripRegular Grip = "regular"
	// GripNeutral — palms facing each other. Dumbbells, a football bar, a
	// multi-grip handle.
	GripNeutral Grip = "neutral"
	// GripReverse — underhand, supinated. A reverse-grip press, a supinated row.
	GripReverse Grip = "reverse"
	// GripAngled — the canted position an EZ-bar or an angled handle forces,
	// which is neither fully pronated nor neutral.
	GripAngled Grip = "angled"
	// GripMixed — one hand pronated, one supinated. How a heavy deadlift is
	// pulled once it outgrows a double-overhand hold.
	//
	// **No side.** Lifters do alternate which hand is under, and it is the
	// reason they care — but nothing consumes that yet, and asking "which
	// hand?" between sets is a question answered carelessly or skipped, which
	// is the confident-wrong-answer this whole enum refuses. #256 made adding
	// a value later cheap, so `mixed_left`/`mixed_right` stay reachable.
	GripMixed Grip = "mixed"
	// GripHook — thumb trapped under the fingers. The olympic grip, and what a
	// deadlifter uses instead of mixed to keep the pull symmetrical.
	GripHook Grip = "hook"
)

// ValidGrip is the VOCABULARY check: is this a grip at all.
//
// Deliberately not pattern-aware, even though `GripsFor` is. The subset governs
// what a client OFFERS; refusing an unusual pairing server-side would turn a UI
// affordance into a data-integrity rule and invent a new false negative — a
// hook-gripped shrug is `isolation`, real, and nobody's business to refuse.
// This is the same split 000054 shipped with: `GripApplies` gated the picker,
// the server only ever checked the vocabulary.
func ValidGrip(g Grip) bool {
	switch g {
	case GripRegular, GripNeutral, GripReverse, GripAngled, GripMixed, GripHook:
		return true
	}
	return false
}

// The per-pattern grip table used to live here as `GripsFor`/`GripApplies`.
//
// It moved to `exercise.OfferedGrips` and is now SERVED on `GET /v1/exercises`
// (N16). It belongs with `movement_pattern`, which is catalog data, and it had
// no production caller on this side — it was a specification the server
// published, never used, and both apps re-implemented. Read `exercise/grips.go`
// for the subsets and why they are what they are.
//
// `ValidGrip` above stays, and the split it documents is unchanged: the
// vocabulary is enforced, the per-movement subset is advisory. That is exactly
// what makes serving the subset safe — a client on a stale copy over- or
// under-offers, and never produces a 400.

func ValidSetType(s SetType) bool {
	switch s {
	case SetTypeWarmup, SetTypeWorking, SetTypeBackoff, SetTypeDrop, SetTypeAMRAP, SetTypeFailure:
		return true
	}
	return false
}

var (
	// ErrNotFound covers "no such session" and "not yours" alike —
	// deliberately the same error, so a caller can't probe for IDs. Same
	// reasoning as the workout module.
	ErrNotFound      = errors.New("session: not found")
	ErrAlreadyExists = errors.New("session: id already in use")
	ErrInvalidInput  = errors.New("session: invalid input")
	// ErrInvalidGrip is an invalid input the CLIENT can fix without a human:
	// it drops the grip and retries. Wraps ErrInvalidInput, so every existing
	// `errors.Is(err, ErrInvalidInput)` still classifies it — but writeErr must
	// test for it FIRST, or the broader case swallows it and the phone loses
	// the one thing that made it actionable.
	ErrInvalidGrip = fmt.Errorf("%w: unknown grip", ErrInvalidInput)
	// ErrSportMismatch means a logged set's exercise belongs to a different
	// discipline than the session.
	ErrSportMismatch = errors.New("session: exercise sport does not match session sport")
)

// Set is one set actually performed.
//
// Every measure is optional because which ones apply is decided by the
// exercise's own load_type — a plank has no reps, a run has no weight. Same
// principle as the workout template: the catalog decides the shape.
//
// RIR and RPE are two views of the same quantity (RPE 8 ≈ 2 RIR). Both are
// stored because lifters are fluent in one or the other and rarely both;
// forcing a conversion at the moment someone has just finished a hard set is
// the wrong time to ask for arithmetic.
type Set struct {
	ExerciseID string  `json:"exercise_id"`
	Position   int     `json:"position"`
	SetType    SetType `json:"set_type"`

	Reps      *int     `json:"reps"`
	WeightKg  *float64 `json:"weight_kg"`
	Seconds   *int     `json:"seconds"`
	DistanceM *int     `json:"distance_m"`

	RIR *int     `json:"rir"`
	RPE *float64 `json:"rpe"`

	// Completed is the trigger for progressive volume: the summary counts
	// what's been done, not what's been planned. A template opens with every
	// set false, and each one ticks over as it's performed.
	Completed bool `json:"completed"`

	Notes string `json:"notes"`

	// AssistedReps is how many of `Reps` somebody else helped with — a spotter,
	// a band, an assisted-pull-up machine.
	//
	// NULL is UNRECORDED and 0 is "none of them", and the difference is the
	// whole reason this is a pointer: nobody should have to type 0 on every
	// set, and a zero default would claim every historical set was performed
	// unaided when nothing asked.
	//
	// `Reps` always holds the FULL count, assisted included. That keeps every
	// existing figure — tonnage, rep totals, the volume rule — reading the same
	// number it always did, and makes `SoloReps` the only thing that has to
	// know about the split.
	AssistedReps *int `json:"assisted_reps"`

	// Grip is how the implement was held for this set.
	//
	// A POINTER because nil is UNRECORDED and that is not `regular`. Every set
	// logged before this column existed chose no grip, and defaulting them to
	// overhand would have the app assert training that never happened — which
	// is worse than silence, because a later "you press better neutral" would
	// then be computed over invented data.
	//
	// Nothing is derived from it. It is recorded and shown, never summed, which
	// is why it appears in exactly two queries — the insert and the read that
	// returns a session's sets — rather than in the ten that `AssistedReps`
	// touches.
	Grip *Grip `json:"grip"`

	// LoadFactor is how many implements of `WeightKg` the athlete moved: 1 for
	// a barbell, a machine, or a single kettlebell held in two hands; 2 for a
	// pair of dumbbells.
	//
	// **SERVER-POPULATED ON READ, AND IGNORED ON WRITE.** It is the exercise's
	// `implements` — a property of the movement. It was derived from
	// `load_mode` and `is_unilateral` together until migration 000057, a rule
	// that read "one LIMB" as "one IMPLEMENT" and so could not express a
	// dumbbell walking lunge. These are properties of the movement — so a client sending one would be asserting something it
	// cannot know, and about a row it does not own. The repository fills it
	// from the catalog join; `ReplaceSets` never reads it.
	//
	// `json:"load_factor"` is emitted so a client can render "30 kg × 2 = 60"
	// without a second lookup. Zero means one — see TotalWeightKg.
	LoadFactor int `json:"load_factor"`
}

type Session struct {
	ID     string `json:"id"`
	UserID string `json:"user_id"`
	// The template followed, if any. Nil for a freeform session, and also
	// nil once a followed template has been deleted — history outlives the
	// plan it came from.
	WorkoutID *string `json:"workout_id"`
	Sport     string  `json:"sport"`
	Name      string  `json:"name"`

	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at"`
	Notes     string     `json:"notes"`

	Sets      []Set     `json:"sets"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Volume is the derived summary a client would otherwise recompute.
//
// Warm-ups are excluded from working volume deliberately: counting them
// inflates every number and makes a light day look like a hard one, which
// would poison any load calculation built on top.
//
// ExerciseIDs is the one field that counts *everything* — warm-ups and sets
// that were planned but never performed. It answers "what is this session
// about", not "what did I complete", which is why an opened template
// reports its exercises alongside zero working volume.
type Volume struct {
	WorkingSets int      `json:"working_sets"`
	TotalReps   int      `json:"total_reps"`
	TonnageKg   float64  `json:"tonnage_kg"`
	HardestRPE  float64  `json:"hardest_rpe"` // over working sets only
	ExerciseIDs []string `json:"exercise_ids"`
}

// TotalWeightKg is what the athlete actually moved, which is not always the
// number they typed.
//
// `WeightKg` holds what is written on the implement. For a barbell or a machine
// that is the whole load. For a PAIR of dumbbells it is one of them, and the
// total is double — which is what `LoadFactor` carries.
//
// A zero factor means one, deliberately. Every set written before this existed
// has no factor, and treating zero as zero would erase the tonnage of every
// historical session rather than merely under-reporting the dumbbell ones. It
// also keeps every caller that builds a `Set` by hand — the tests, the sync
// path — reporting the number they did before.
func (s Set) TotalWeightKg() float64 {
	if s.WeightKg == nil {
		return 0
	}
	if s.LoadFactor < 1 {
		return *s.WeightKg
	}
	return *s.WeightKg * float64(s.LoadFactor)
}

// SoloReps is what the athlete did unaided, and the number worth training
// against.
//
// "225 for 5, then 3 more with a spotter" is 8 reps of work and 5 reps of
// capability. Progression cares about the second: the athlete's own target is
// to need the spotter for one or two rather than three, and that is only
// expressible if the split is recorded rather than folded into a note.
//
// Unrecorded assistance means all of them were solo. That is the reading every
// set logged before this column existed needs, and it is the safe direction —
// it credits the athlete with what `Reps` already claimed rather than silently
// revising their history downward.
//
// **THAT FALLBACK HAS A TRAP, AND IT IS AIMED AT THE NEXT PERSON TO USE THIS.**
// `RecentEfforts`, `BestOneRMs`, `bestOneRMSets` and `Records` build `Set`
// values from queries that DO NOT SELECT `assisted_reps`, so every set they
// hydrate has it permanently nil. Wiring progression to `SoloReps` therefore
// compiles, passes unit fixtures built by hand, and silently reads full reps
// from the database path — because "column not selected" and "athlete never
// recorded it" are the same value here. Add `ss.assisted_reps` to those
// SELECTs first, in the same change.
func (s Set) SoloReps() int {
	if s.Reps == nil {
		return 0
	}
	if s.AssistedReps == nil {
		return *s.Reps
	}
	solo := *s.Reps - *s.AssistedReps
	if solo < 0 {
		// The database CHECK forbids this, so it means a set that never went
		// through Postgres — a client's in-memory row mid-edit. Clamp rather
		// than return a negative rep count into somebody's chart.
		return 0
	}
	return solo
}

// DropsOf returns the drop sets hanging off the set at `i`, which are the rows
// immediately following it.
//
// **THE RELATIONSHIP IS ADJACENCY, NOT A FOREIGN KEY**, and that is forced
// rather than chosen. `ReplaceSets` deletes every row of a session and
// reinserts them on each save, so `session_sets.id` is regenerated constantly
// and a `parent_set_id` would dangle on the first edit. Position is already a
// total order — `UNIQUE (session_id, position)` — so a run of `drop` rows after
// a non-drop row is unambiguous without a second ordering concept for clients
// to keep consistent.
//
// A drop belongs to the preceding set of the SAME exercise. A `drop` row that
// follows a different exercise is orphaned, which is a client bug rather than a
// state worth modelling: it is skipped, so it can never attach itself to
// somebody else's lift.
func DropsOf(sets []Set, i int) []Set {
	if i < 0 || i >= len(sets) || sets[i].SetType == SetTypeDrop {
		return nil
	}
	var out []Set
	for j := i + 1; j < len(sets); j++ {
		if sets[j].SetType != SetTypeDrop {
			break
		}
		if sets[j].ExerciseID != sets[i].ExerciseID {
			break
		}
		out = append(out, sets[j])
	}
	return out
}

// Summarise computes working volume for a session. Kept in the domain rather
// than in SQL or a client so both platforms report identical numbers.
func Summarise(sets []Set) Volume {
	v := Volume{ExerciseIDs: []string{}}
	seen := map[string]bool{}
	for _, s := range sets {
		if !seen[s.ExerciseID] {
			seen[s.ExerciseID] = true
			v.ExerciseIDs = append(v.ExerciseIDs, s.ExerciseID)
		}
		// Planned but not yet performed contributes nothing. This is what
		// makes the header climb as you work rather than start at the total.
		if !s.Completed {
			continue
		}
		// Warm-ups count toward no working-volume measure — not sets, not
		// tonnage, and not the hardest RPE. They stay in ExerciseIDs above,
		// because "what did I train" does include an exercise you only
		// warmed up on.
		if s.SetType == SetTypeWarmup {
			continue
		}
		if s.RPE != nil && *s.RPE > v.HardestRPE {
			v.HardestRPE = *s.RPE
		}
		// A DROP IS NOT A SET, but its work still counts.
		//
		// 225x3 stripped to 185x8 is one approach to the bar and one rest
		// period — the athlete did three sets, not four, and that count is the
		// one they carry around and compare to last week. The rows on the
		// session screen already number it that way; this is the tile above
		// them agreeing.
		//
		// Only the COUNT changes. The reps and the tonnage below are unguarded
		// on purpose: the weight was moved, so it belongs in the volume. That
		// split is the whole change, and collapsing it back into one predicate
		// is how a drop's work silently disappears.
		if s.SetType != SetTypeDrop {
			v.WorkingSets++
		}
		if s.Reps != nil {
			v.TotalReps += *s.Reps
			if s.WeightKg != nil {
				v.TonnageKg += float64(*s.Reps) * s.TotalWeightKg()
			}
		}
	}
	return v
}

// NewSession is the input to Create.
type NewSession struct {
	ID        string
	UserID    string
	WorkoutID *string
	Sport     string
	Name      string
	StartedAt time.Time
	EndedAt   *time.Time
	Notes     string
	Sets      []Set
}

// Filter narrows a listing. A zero Filter returns the caller's recent
// sessions.
type Filter struct {
	Sport      string // empty means any
	ExerciseID string // sessions containing this exercise; empty means any
	// From and To bound started_at as a half-open range: From <= t < To.
	// The *handler* is what widens a caller's inclusive `to=2026-03-03` to the
	// exclusive instant here, so a direct repository caller must pass the
	// exclusive bound itself. Zero means unbounded.
	From time.Time
	To   time.Time
	// Query matches the session's name, case-insensitively, anywhere in it.
	// Names are the only free text a session has, and "leg day" is how people
	// actually remember one.
	Query  string
	Limit  int // 0 means the repository default
	Offset int // rows to skip, for paging
}

// SessionPage is one page of a listing plus how many rows the filter matched
// in total.
//
// Total comes back with the page rather than from a second endpoint because
// the two must describe the same filter — a count that disagrees with the
// rows is worse than no count, and it's exactly what happens when they're
// fetched separately and one of them changes.
type SessionPage struct {
	Sessions []Session `json:"sessions"`
	Total    int       `json:"total"`
	Limit    int       `json:"limit"`
	Offset   int       `json:"offset"`
}

// HistoryFilter bounds a history rollup. Unlike Filter the range is required —
// an unbounded aggregate over a training career is not a page, it's a report.
type HistoryFilter struct {
	Sport string    // empty means any
	From  time.Time // inclusive
	To    time.Time // exclusive
	// TZ is an IANA name used to bucket sessions into calendar days. It has
	// to be the caller's, not the server's: training at 19:00 in New York is
	// 23:00 UTC, and bucketing that in UTC puts a Tuesday session on the
	// calendar's Wednesday — visibly wrong on the one view whose whole job is
	// showing which days you trained. Validated by the handler.
	TZ string
}

// HistoryDay is one calendar day's training, in the caller's own timezone.
//
// Days with no training are absent rather than zero-filled: the range already
// says which days exist, and sending ~365 empty objects to draw gaps the
// client can infer is wasted on every request.
type HistoryDay struct {
	Date            string   `json:"date"` // YYYY-MM-DD, caller's timezone
	Sessions        int      `json:"sessions"`
	WorkingSets     int      `json:"working_sets"`
	TotalReps       int      `json:"total_reps"`
	TonnageKg       float64  `json:"tonnage_kg"`
	DurationSeconds int      `json:"duration_seconds"`
	Sports          []string `json:"sports"`
}

// HistoryTotals is a period's training in one line.
//
// Exercises counts *distinct* exercises across the period, which is why it
// can't be derived by summing the days — training bench on Monday and again
// on Thursday is one exercise, not two.
type HistoryTotals struct {
	Sessions        int     `json:"sessions"`
	WorkingSets     int     `json:"working_sets"`
	TotalReps       int     `json:"total_reps"`
	TonnageKg       float64 `json:"tonnage_kg"`
	DurationSeconds int     `json:"duration_seconds"`
	Exercises       int     `json:"exercises"`
	// Days on which anything was logged. The denominator for "how often am I
	// actually training", which sessions alone doesn't answer — two sessions
	// in one day is not two days of training.
	ActiveDays int `json:"active_days"`
}

// SportCount powers the filter chips: how much of this period was each sport.
type SportCount struct {
	Sport    string `json:"sport"`
	Sessions int    `json:"sessions"`
}

// History is the analytical surface behind the web history page.
//
// Previous holds the immediately preceding window of the same length, which
// is what makes the totals mean anything — "182 tonnes" is a number, "182
// tonnes, up 12%" is a fact about your training. It's computed over the same
// sport filter, so switching to BJJ compares BJJ against BJJ.
type History struct {
	From     string        `json:"from"` // YYYY-MM-DD, echoed back
	To       string        `json:"to"`
	Totals   HistoryTotals `json:"totals"`
	Previous HistoryTotals `json:"previous"`
	Days     []HistoryDay  `json:"days"`
	Sports   []SportCount  `json:"sports"`
}

type Repository interface {
	List(ctx context.Context, userID string, f Filter) (*SessionPage, error)
	// History rolls a date range up per day plus period totals. Aggregated in
	// SQL rather than by listing sessions and calling Summarise, because a
	// year of training is thousands of set rows and the page needs six
	// numbers. TestHistoryAgreesWithSummarise pins the two together.
	History(ctx context.Context, userID string, f HistoryFilter) (*History, error)
	// RecentEfforts returns, per requested exercise, the working sets of its
	// last few sessions — everything the progression rule reads. Missing keys
	// mean "never logged". Used by v1's Progress; UNCHANGED by N473/#812 —
	// see RecentEffortsV2 for why v2 needs a separate query rather than this
	// one plus a filter.
	RecentEfforts(ctx context.Context, userID string, exerciseIDs []string) (map[string]ProgressionInput, error)
	// RecentEffortsV2 is ProgressV2's own history read (N473/#812, item 3),
	// ranking sessions FINISHED-ONLY so a currently-open session can never
	// occupy one of the window's slots and starve it of real history —
	// exactly the failure a post-hoc Go-side filter over RecentEfforts'
	// existing ranking would have, since that ranking is computed before any
	// finished/unfinished distinction is applied. Missing keys mean "never
	// logged", same as RecentEfforts.
	RecentEffortsV2(ctx context.Context, userID string, exerciseIDs []string) (map[string]ProgressionInput, error)
	// BestOneRMs returns the highest estimated one-rep max in the caller's
	// history per requested exercise. Missing keys mean "no estimate".
	BestOneRMs(ctx context.Context, userID string, exerciseIDs []string) (map[string]float64, error)
	// Records derives every personal record the caller holds for the named
	// exercises. Derived rather than stored — see the implementation.
	Records(ctx context.Context, userID string, exerciseIDs []string) ([]ExerciseRecords, error)

	// LoadHistory is one exercise's arc over time, one point per session.
	// Serves the web analytical surface — see the type's doc comment for why
	// it is not the phone.
	LoadHistory(ctx context.Context, userID, exerciseID string, f LoadHistoryFilter) (*LoadHistory, error)
	// PinnedExercises is the athlete's chosen shortlist for their profile.
	PinnedExercises(ctx context.Context, userID string) ([]string, error)
	SetPinnedExercises(ctx context.Context, userID string, exerciseIDs []string) error
	// MostTrainedExercises backs the default shortlist, so the records view
	// says something useful before anyone configures it.
	MostTrainedExercises(ctx context.Context, userID string, limit int) ([]string, error)
	Get(ctx context.Context, userID, id string) (*Session, error)
	// Create is idempotent on the client-supplied ID for the same user; a
	// different user's ID collides with ErrAlreadyExists.
	Create(ctx context.Context, in NewSession) (*Session, error)
	// ReplaceSets swaps the whole ordered list — the natural shape for
	// "log another set" and "fix a typo" alike.
	ReplaceSets(ctx context.Context, userID, sessionID string, sets []Set) (*Session, error)
	Finish(ctx context.Context, userID, sessionID string, endedAt time.Time) (*Session, error)
	// Rename changes only the name — see the implementation for why it is not
	// a general Update.
	Rename(ctx context.Context, userID, sessionID, name string) (*Session, error)
	// Reschedule changes only started_at — see the implementation for why
	// this is a second single-field method rather than folded into Rename.
	Reschedule(ctx context.Context, userID, sessionID string, startedAt time.Time) (*Session, error)
	Delete(ctx context.Context, userID, id string) error
}
