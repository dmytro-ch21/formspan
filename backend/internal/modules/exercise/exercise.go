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
}

// ErrNotFound means no exercise exists with the requested ID.
var ErrNotFound = errors.New("exercise: not found")

type Exercise struct {
	ID               string    `json:"id"` // stable slug, e.g. "barbell-back-squat"
	Name             string    `json:"name"`
	Sport            string    `json:"sport"`
	MovementPattern  string    `json:"movement_pattern"`
	PrimaryMuscles   []string  `json:"primary_muscles"`
	SecondaryMuscles []string  `json:"secondary_muscles"`
	Equipment        []string  `json:"equipment"`
	LoadType         LoadType  `json:"load_type"`
	IsUnilateral     bool      `json:"is_unilateral"`
	Instructions     string    `json:"instructions"`
	Media            []Media   `json:"media"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
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
