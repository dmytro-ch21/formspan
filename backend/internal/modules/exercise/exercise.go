// Package exercise holds the global exercise catalog — the reference content
// the logger, the planner, and eventually the recommendation rules all read
// from. Operator-authored and shared by every user; unlike profile and
// activity there is no owner, which is why nothing here takes a user ID.
//
// Two fields carry most of the design intent:
//
//   - LoadType tells a client *which fields to render* for this exercise.
//     A back squat wants weight × reps, a plank wants a duration, a run
//     wants distance and time. Carrying that as data rather than branching
//     in client code is what keeps logging one screen instead of a form per
//     exercise type — and it means adding an exercise never needs an app
//     release.
//
//   - MovementPattern is the level the cross-sport rules can actually reason
//     at. "Heavy hinge and squat work yesterday" is what makes hard sparring
//     today worth flagging; muscle lists alone are too granular to write a
//     readable rule against.
//
// Read-only over HTTP. The catalog is seeded from version-controlled JSON
// (see seed.go) rather than edited through an API: content stays diffable
// and code-reviewed, and no authoring UI has to exist for the catalog to
// grow. User-authored custom exercises are a later decision.
package exercise

import (
	"context"
	"errors"
	"time"
)

// LoadType determines which measurements a session of this exercise records,
// and therefore which inputs a client shows.
type LoadType string

const (
	LoadTypeWeightReps   LoadType = "weight_reps"   // barbell squat: 5 × 100kg
	LoadTypeReps         LoadType = "reps"          // pull-up: 8
	LoadTypeTime         LoadType = "time"          // plank, BJJ round: 90s
	LoadTypeDistance     LoadType = "distance"      // farmer's carry: 40m
	LoadTypeDistanceTime LoadType = "distance_time" // run: 5km in 24:30
)

// MediaKind is what an asset depicts, which is how a client picks the right
// one for a context — a list thumbnail versus a full demo.
type MediaKind string

const (
	MediaKindDemo      MediaKind = "demo"       // single representative still (the common case)
	MediaKindStart     MediaKind = "start"      // starting position
	MediaKindEnd       MediaKind = "end"        // end position
	MediaKindDemoVideo MediaKind = "demo_video" // short looping clip
	MediaKindThumbnail MediaKind = "thumbnail"  // list/browse thumbnail
)

// Media is one asset belonging to an exercise.
//
// StorageKey is the path within the bucket; URL is assembled from it at read
// time using MEDIA_BASE_URL. Deliberately not stored as an absolute URL —
// that would pin the bucket and CDN hostname into the database, so moving
// either would become a data migration instead of an env-var change.
type Media struct {
	Kind        MediaKind `json:"kind"`
	StorageKey  string    `json:"storage_key"`
	URL         string    `json:"url"`
	ContentType string    `json:"content_type"`
	Width       *int      `json:"width"`
	Height      *int      `json:"height"`
	Position    int       `json:"position"`
	// UpdatedAt versions the assembled URL and is deliberately not serialised.
	//
	// Replacing the bytes at a storage key leaves the URL identical, and every
	// cache downstream is then entitled to keep serving the old picture —
	// permanently, in the case of `expo-image`'s disk cache, which never
	// revalidates. Folding this into the URL as `?v=` makes new bytes a new
	// resource, which is the only thing all those caches agree to respect.
	//
	// Internal rather than a JSON field because no client needs to *read* it —
	// they need the URL to differ, and it does. Adding contract surface that
	// nothing consumes is how a contract becomes hard to change.
	UpdatedAt time.Time `json:"-"`
	// IsDefault marks a sport-level placeholder standing in for an exercise
	// that has no photo of its own. Exposed rather than hidden so a client
	// can present it differently, and so "how much of the catalog actually
	// has media" stays answerable — a placeholder that's indistinguishable
	// from real content makes the gap invisible and therefore permanent.
	IsDefault bool `json:"is_default"`
}

// defaultMedia are the per-sport placeholders in the bucket, used for any
// exercise with no media of its own.
//
// Resolved at read time rather than seeded as rows. Seeding would mean ~1000
// rows across 519 exercises all pointing at six files, and — worse — it would
// destroy the ability to ask which exercises actually have their own photo,
// which is exactly the coverage metric worth tracking while the library is
// being filled in.
var defaultMedia = map[string][]Media{
	"strength": {
		{Kind: MediaKindDemo, StorageKey: "exercises/_defaults/strength.webp",
			ContentType: "image/webp", Width: intp(683), Height: intp(1024), IsDefault: true},
		{Kind: MediaKindThumbnail, StorageKey: "exercises/_defaults/strength-thumbnail.webp",
			ContentType: "image/webp", Width: intp(213), Height: intp(320), IsDefault: true},
	},
	"bjj": {
		{Kind: MediaKindDemo, StorageKey: "exercises/_defaults/bjj-default.webp",
			ContentType: "image/webp", Width: intp(1024), Height: intp(1024), IsDefault: true},
		{Kind: MediaKindThumbnail, StorageKey: "exercises/_defaults/bjj-default-thumbnail.webp",
			ContentType: "image/webp", Width: intp(320), Height: intp(320), IsDefault: true},
	},
	"running": {
		{Kind: MediaKindDemo, StorageKey: "exercises/_defaults/running-default.webp",
			ContentType: "image/webp", Width: intp(683), Height: intp(1024), IsDefault: true},
		{Kind: MediaKindThumbnail, StorageKey: "exercises/_defaults/running-default-thumbnail.webp",
			ContentType: "image/webp", Width: intp(213), Height: intp(320), IsDefault: true},
	},
}

func intp(v int) *int { return &v }

// defaultMediaRevision versions the placeholder assets' URLs.
//
// The placeholders have no `exercise_media` row, so nothing bumps an
// `updated_at` for them — swap a `_defaults/` file in the bucket and every
// cache keeps the old one forever, which is precisely the trap the URL
// versioning exists to close. **Bump this by hand whenever you replace a
// `_defaults/` asset.** It is hand-maintained because there is no row to
// automate it from, and a stale constant is a visible mistake where a missing
// mechanism is not.
var defaultMediaRevision = time.Date(2026, 7, 29, 18, 14, 20, 0, time.UTC)

// DefaultMediaFor returns the placeholder set for a sport, or nil if that
// sport has none — in which case a client renders its own empty state rather
// than a broken image.
func DefaultMediaFor(sport string) []Media {
	src := defaultMedia[sport]
	if src == nil {
		return nil
	}
	// Copied so a caller mutating URLs (which the handler does) can't write
	// through into the shared package-level map.
	out := make([]Media, len(src))
	copy(out, src)
	for i := range out {
		out[i].UpdatedAt = defaultMediaRevision
	}
	return out
}

// ErrNotFound means no exercise exists with the requested ID.
var ErrNotFound = errors.New("exercise: not found")

type Exercise struct {
	ID              string `json:"id"` // stable slug, e.g. "barbell-back-squat"
	Name            string `json:"name"`
	Sport           string `json:"sport"`
	MovementPattern string `json:"movement_pattern"`
	// The source catalog's own, far more granular pattern (75 distinct
	// values). Kept for display and filtering; rules read MovementPattern.
	MovementPatternDetail string   `json:"movement_pattern_detail"`
	PrimaryMuscles        []string `json:"primary_muscles"`
	SecondaryMuscles      []string `json:"secondary_muscles"`
	Equipment             []string `json:"equipment"`
	LoadType              LoadType `json:"load_type"`
	IsUnilateral          bool     `json:"is_unilateral"`
	// LoadMode says how to read a logged weight for this movement: "total"
	// (a barbell, a machine, or one implement in two hands) or "per_side"
	// (one of a pair of dumbbells). It decides whether tonnage doubles, so it
	// lives in the seed catalog rather than only in a migration backfill —
	// otherwise a freshly seeded database takes the column default and every
	// dumbbell session under-reports again. Empty means "total".
	LoadMode string `json:"load_mode"`
	// Implements is how many of the logged weight move in one rep: 1 for a
	// barbell, a machine, or a single dumbbell; 2 for a PAIR.
	//
	// It multiplies logged weight to give tonnage, a job that used to be done
	// by deriving `load_mode = 'per_side' AND NOT is_unilateral`. That
	// derivation read `is_unilateral` — one LIMB at a time — as though it meant
	// one IMPLEMENT, and could not express a dumbbell walking lunge: two
	// implements, one leg. See migration 000057.
	//
	// Zero means "not recorded" and reads as 1, so a row written by code that
	// predates the column under-reports rather than inventing weight.
	Implements   int    `json:"implements"`
	Instructions string `json:"instructions"`

	// Note is an optional line explaining why this exercise's catalog values
	// are what they are — admin-authored, and shown to an athlete wherever the
	// exercise is read.
	//
	// It exists because W7 ruled five per-side rows that their names could not
	// settle, and a ruling fixes the number while leaving the reason invisible.
	// `single-leg-kettlebell-romanian-deadlift` counts ONE implement while
	// `dumbbell-romanian-deadlift` counts two — deliberately, by human ruling —
	// and that reads as an oversight to everyone who finds it until something
	// says so where the value is displayed.
	//
	// Distinct from Instructions, which says HOW TO PERFORM the movement. This
	// says how the movement is RECORDED, and why. Folding the two together
	// would bury a one-line answer inside a coaching paragraph, and the rows
	// that most need this note are largely rows with no instructions at all.
	//
	// ABSENT IS THE NORMAL CASE — 504 seeded rows carry none — so a client must
	// render nothing rather than an empty section. `omitempty` keeps it off the
	// wire entirely for those rows, which matters on a catalog listing; unlike
	// OfferedGrips there is no absent-versus-empty distinction to preserve,
	// because "no note" is the only thing either state can mean.
	Note  string  `json:"note,omitempty"`
	Media []Media `json:"media"`

	// OfferedGrips is which grips a client should offer for this movement —
	// derived from MovementPattern by `OfferedGrips`, never stored.
	//
	// Served so the rule lives in one place. It was previously reimplemented in
	// both apps against a Go copy that nothing called, with a parity script
	// standing in for a shared package; read `grips.go` for why that trade was
	// made and why serving it is cheaper than policing it (N16).
	//
	// **Absent is not the same as empty**, and clients must keep them apart. An
	// empty array is the server saying "grip is meaningless here" (a squat);
	// absent means the response predates this field — a row cached before it
	// existed — where a client falls back rather than concluding the picker
	// should vanish. `omitempty` is therefore deliberately NOT set: a squat has
	// to serialize `[]`, not disappear into the same shape as a stale row.
	OfferedGrips []string `json:"offered_grips"`

	// Source is "seed" (the embedded JSON owns it, and a deploy rewrites it) or
	// "admin" (authored in the console, the database owns it). Read-only on the
	// wire — the server sets it, so a client cannot promote its own row out of
	// the deploy's reach or demote a seeded one into it.
	//
	// Populated only on /admin/* responses; the public read path does not select
	// it. Do not derive ownership from its absence — see the technique module,
	// where reading it off a public detail response marked every row
	// deploy-owned including the one just written.
	Source string `json:"source,omitempty"`

	// "published" or "draft"; EMPTY MEANS PUBLISHED.
	//
	// The technique catalog's `Status` carries the full reasoning — absence is
	// the common case (504 live rows would otherwise each spell it out), the
	// console creates as draft explicitly because the column default has to
	// describe the backfill, and editing a published row leaves it published so
	// a typo fix does not withdraw the exercise.
	Status string `json:"status,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Filter narrows a catalog listing. A zero Filter lists everything.
type Filter struct {
	Sport string // exact match; empty means any
	Query string // case-insensitive substring of Name; empty means any
}

type Repository interface {
	List(ctx context.Context, f Filter) ([]Exercise, error)
	Get(ctx context.Context, id string) (*Exercise, error)
	// UpsertAll writes catalog content, all-or-nothing. Not exposed over
	// HTTP — it exists for seeding from version-controlled JSON, which is
	// how the catalog grows. Takes the whole set rather than one row so the
	// write can be a single transaction.
	UpsertAll(ctx context.Context, exercises []Exercise) error
}

// NormalizeLoadMode maps an absent or unrecognised value to "total".
//
// Failing CLOSED on the safe side, deliberately: "total" is what the column
// already defaults to and what every pre-existing row means, so an unknown
// value under-reports a dumbbell session rather than inventing weight nobody
// lifted. The database CHECK would reject anything else anyway; this is what
// keeps a seed file with a typo from failing the whole deploy.
// NormalizeImplements maps an absent or impossible count to 1.
//
// Same failing-closed reasoning as NormalizeLoadMode: 1 is what the column
// defaults to and what every pre-existing row means, so an unknown value
// under-reports a pair rather than doubling something held in one hand.
func NormalizeImplements(n int) int {
	if n == 2 {
		return 2
	}
	return 1
}

func NormalizeLoadMode(v string) string {
	if v == LoadModePerSide {
		return LoadModePerSide
	}
	return LoadModeTotal
}

const (
	// LoadModeTotal — the logged weight is the whole load.
	LoadModeTotal = "total"
	// LoadModePerSide — it is one implement of a pair.
	LoadModePerSide = "per_side"
)
