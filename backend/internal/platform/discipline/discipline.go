// Package discipline is the single source of truth for what training
// disciplines VOLA supports and what each one can do.
//
// # Why this exists
//
// Before this package, the same closed set was written down in four
// independent Go representations — a map in session/handler.go, a second map
// in exercise/seed.go, a typed enum plus a switch in workout/workout.go, and a
// media map keyed by sport in exercise/exercise.go — alongside two SQL CHECK
// constraints, five hardcoded prose error strings, nine OpenAPI enums, and six
// mutually inconsistent lists in the clients. Adding a discipline touched
// roughly 31 places, none of which the compiler connected to each other, and
// missing one failed in a different way each time: a silent empty media array
// here, a 500 on write there.
//
// Everything discipline-shaped now derives from Modules below.
//
// # Module is not the same thing as sport
//
// A *sport* is something you log a session of — it appears in
// exercises.sport, workouts.sport and sessions.sport. A *module* is something
// the app offers you. Nutrition is a module and not a sport: it has no
// catalog, no session, no row anywhere, and it must still be togglable. Any
// registry keyed purely on sport cannot express it, which is why IsSport is a
// field rather than an assumption.
//
// # Capabilities, not one boolean
//
// "Is BJJ on?" and "does BJJ have 1RM records?" are different questions.
// Collapsing them means a BJJ-only athlete gets a Records screen whose five
// record kinds are all lift- or run-shaped, and a strength athlete loses the
// Goal picker the moment someone reuses the enabled flag for capability. The
// Capabilities struct keeps them apart.
//
// # What this package must NOT decide
//
// Whether a *metric* applies. The clients already choose volume-vs-time from
// the data present (web's loadMetric, the calendar's session-count fallback),
// which is why an athlete who spent March on the mat sees Time rather than a
// flat zero volume line — even though strength is enabled. The rule is:
//
//	toggles decide what you can reach; data decides what you can read.
//
// Per-item rendering likewise stays keyed on exercises.load_type, not on
// discipline. That mechanism already works and is the reason logging is one
// screen rather than a form per type.
package discipline

import "strings"

// Capabilities describes what a discipline supports. A field here should
// answer a question some screen actually asks; a capability nothing reads is a
// promise with no implementation behind it.
type Capabilities struct {
	// Catalog names the content kind the Library shows for this discipline:
	// "exercises", "techniques", or "" for a module with no catalog at all.
	Catalog string `json:"catalog"`

	// Facets are extra filter axes beyond the catalog's own. BJJ has
	// "position" and "belt"; nothing else does yet.
	Facets []string `json:"facets"`

	// HasGoals gates the powerlifting/hypertrophy/endurance picker. Strength
	// only — those three are all done with the same barbell squat, which is
	// what makes the distinction meaningful there and meaningless elsewhere.
	HasGoals bool `json:"has_goals"`

	// HasProgression gates the double-progression engine. Note the engine
	// itself already declines on load_type != weight_reps; this flag is for
	// hiding the UI, not for deciding the answer.
	HasProgression bool `json:"has_progression"`

	// RecordKinds are the personal-best kinds that mean anything here. Empty
	// for BJJ — "heaviest weight" and "estimated 1RM" are not BJJ facts, and
	// there is no rounds-rolled or mat-time record kind in the model. A
	// discipline with none should not be offered a Records screen.
	RecordKinds []string `json:"record_kinds"`
}

// Module is one discipline.
type Module struct {
	Key string `json:"key"`

	// Label is the display name, and it carries the acronym. Deriving it by
	// capitalising the key gives "Bjj", which is why the clients each grew
	// their own special case for exactly one value.
	Label string `json:"label"`

	// IsSport reports whether this discipline appears as a sport value on
	// exercises, workouts and sessions. See the package doc.
	IsSport bool `json:"is_sport"`

	// DefaultOn is what a user gets before they have ever expressed a
	// preference. This replaces the DEFAULT clauses in migration 000001, so a
	// newly added discipline needs no backfill: a user with no stored row
	// simply falls back to this.
	DefaultOn bool `json:"default_on"`

	Caps Capabilities `json:"capabilities"`
}

// modules is the registry. THIS IS THE LIST. Adding a discipline means adding
// an entry here and building its screens — nothing else in Go, and no
// migration, because per-user enablement is stored as rows keyed on Key.
//
// Order is display order; the clients render in this sequence.
var modules = []Module{
	{
		Key:       "strength",
		Label:     "Strength",
		IsSport:   true,
		DefaultOn: true,
		Caps: Capabilities{
			Catalog:        "exercises",
			HasGoals:       true,
			HasProgression: true,
			RecordKinds: []string{
				"heaviest_weight", "estimated_1rm", "most_reps",
			},
		},
	},
	{
		Key:       "bjj",
		Label:     "BJJ",
		IsSport:   true,
		DefaultOn: true,
		Caps: Capabilities{
			// The technique library, not the exercise catalog. Migration
			// 000019 removed the last BJJ entries from `exercises`, so this is
			// now literally true rather than aspirational.
			Catalog: "techniques",
			// "belt" filters the already-fetched technique list by
			// `typical_belt` client-side — no query param, no new endpoint.
			// See docs/decisions/history.md for why: the library already
			// fetches its catalog once and filters locally (position, sport,
			// search all work this way), and `typical_belt` is already on
			// every summary row.
			Facets: []string{"position", "belt"},
			// Deliberately empty — see Capabilities.RecordKinds.
			RecordKinds: []string{},
		},
	},
	{
		Key:       "running",
		Label:     "Running",
		IsSport:   true,
		DefaultOn: false,
		Caps: Capabilities{
			Catalog:     "exercises",
			RecordKinds: []string{"longest_time", "furthest_distance"},
		},
	},
	{
		Key:     "nutrition",
		Label:   "Nutrition",
		IsSport: false, // no catalog, no session, no row — a module only
		// On by default since migration 000001, and left that way: changing a
		// default silently flips it for every user who never touched it.
		DefaultOn: true,
		Caps: Capabilities{
			Catalog:     "",
			RecordKinds: []string{},
		},
	},
}

var byKey = func() map[string]Module {
	m := make(map[string]Module, len(modules))
	for _, mod := range modules {
		m[mod.Key] = mod
	}
	return m
}()

// All returns every module in display order.
//
// Returns a copy: the registry is package state, and a caller that sorted or
// filtered the slice in place would silently reorder it for everyone else.
func All() []Module {
	out := make([]Module, len(modules))
	copy(out, modules)
	return out
}

// Sports returns only the modules that appear as a sport value on exercises,
// workouts and sessions.
func Sports() []Module {
	out := make([]Module, 0, len(modules))
	for _, m := range modules {
		if m.IsSport {
			out = append(out, m)
		}
	}
	return out
}

// Get returns the module for key, and whether it is known.
func Get(key string) (Module, bool) {
	m, ok := byKey[key]
	return m, ok
}

// Valid reports whether key names a known module. Use this for module
// toggles; use ValidSport for anything writing exercises/workouts/sessions.
func Valid(key string) bool {
	_, ok := byKey[key]
	return ok
}

// ValidSport reports whether key names a discipline that can be a sport.
//
// Distinct from Valid on purpose: "nutrition" is a real module, but a session
// with sport="nutrition" is nonsense and must be rejected at the handler.
func ValidSport(key string) bool {
	m, ok := byKey[key]
	return ok && m.IsSport
}

// SportKeys returns the sport keys in display order.
func SportKeys() []string {
	out := make([]string, 0, len(modules))
	for _, m := range modules {
		if m.IsSport {
			out = append(out, m.Key)
		}
	}
	return out
}

// SportList renders the valid sports for an error message — "strength, bjj,
// running". This string was hardcoded in five handlers, so a new discipline
// used to mean five prose edits that nothing would catch if missed.
func SportList() string {
	return strings.Join(SportKeys(), ", ")
}

// Defaults returns the default enablement for every module, for a user who has
// never expressed a preference.
func Defaults() map[string]bool {
	out := make(map[string]bool, len(modules))
	for _, m := range modules {
		out[m.Key] = m.DefaultOn
	}
	return out
}
