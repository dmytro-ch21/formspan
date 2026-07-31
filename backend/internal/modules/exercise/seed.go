package exercise

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
)

// The catalog lives in version-controlled JSON rather than behind an
// authoring API: content stays diffable and code-reviewed, deploys are
// reproducible across environments, and no editor UI has to exist for the
// catalog to grow. Swap this for a real CMS when people who don't use git
// need to author it — not before.
//
// Embedded rather than read from disk so the binary is self-contained and
// the seed can't fail on a container that didn't copy a data directory.
//
//go:embed exercises.json
var seedJSON []byte

// SeedData parses the embedded catalog. Exported separately from Seed so
// tests can validate the content without needing a database.
func SeedData() ([]Exercise, error) {
	var exercises []Exercise
	if err := json.Unmarshal(seedJSON, &exercises); err != nil {
		return nil, fmt.Errorf("exercise: parse seed: %w", err)
	}
	if err := validate(exercises); err != nil {
		return nil, err
	}
	return exercises, nil
}

// Closed vocabularies. The JSON *is* the authoring interface — there's no
// admin UI and no review step beyond the diff — so a typo has to fail loudly
// here or it fails silently forever. `"strenght"` would seed a row that no
// `?sport=strength` filter can ever return, and a mistyped movement_pattern
// is worse: it's the field the cross-sport rules reason over, so it would
// quietly break a future rule rather than anything visible today.
var (
	validSports = map[string]bool{
		"strength": true, "bjj": true, "running": true,
	}
	// The COARSE vocabulary — the level cross-sport rules are written
	// against. The source catalog's own 75 patterns are preserved per row in
	// MovementPatternDetail; this list stays deliberately small, because a
	// rule that has to enumerate "Scapular Elevation" is a rule nobody will
	// maintain. "isolation" is the honest bucket for the single-joint long
	// tail rather than inventing precision the rules can't use.
	validMovementPatterns = map[string]bool{
		"squat": true, "hinge": true, "lunge": true,
		"horizontal_push": true, "vertical_push": true,
		"horizontal_pull": true, "vertical_pull": true,
		"carry": true, "core": true, "rotation": true,
		"locomotion": true, "grappling": true, "olympic": true,
		"jump": true, "mobility": true, "isolation": true,
	}
	validLoadTypes = map[LoadType]bool{
		LoadTypeWeightReps: true, LoadTypeReps: true, LoadTypeTime: true,
		LoadTypeDistance: true, LoadTypeDistanceTime: true,
	}
)

// validate catches the content mistakes that are easy to make by hand and
// annoying to debug later — a duplicate slug silently overwriting a
// different exercise, or a load_type no client has a renderer for. Cheap to
// check here, versus a CHECK constraint failure mid-deploy.
func validate(exercises []Exercise) error {
	seen := make(map[string]bool, len(exercises))
	for _, e := range exercises {
		switch {
		case e.ID == "":
			return fmt.Errorf("exercise: seed entry %q has no id", e.Name)
		case seen[e.ID]:
			return fmt.Errorf("exercise: duplicate seed id %q", e.ID)
		case e.Name == "":
			return fmt.Errorf("exercise: seed %q has no name", e.ID)
		case !validSports[e.Sport]:
			return fmt.Errorf("exercise: seed %q has unknown sport %q", e.ID, e.Sport)
		case !validMovementPatterns[e.MovementPattern]:
			return fmt.Errorf("exercise: seed %q has unknown movement_pattern %q", e.ID, e.MovementPattern)
		case !validLoadTypes[e.LoadType]:
			return fmt.Errorf("exercise: seed %q has unknown load_type %q", e.ID, e.LoadType)
		}
		for _, m := range e.Media {
			if !validStorageKey.MatchString(m.StorageKey) {
				return fmt.Errorf(
					"exercise: seed %q has an unusable storage_key %q for %s media — "+
						"allowed characters are a-z 0-9 / . _ -", e.ID, m.StorageKey, m.Kind)
			}
		}
		seen[e.ID] = true
	}
	return nil
}

// validStorageKey bounds what may appear in a bucket path, because two
// characters break the assembled URL in ways nothing would report.
//
// The URL is `MEDIA_BASE_URL + "/" + storage_key + "?v=..."`. A `?` in the key
// truncates the path at the first one — the object lookup fails and the
// version parameter becomes trailing noise. A `#` is worse: everything after
// it is a fragment, never sent to the server, so cache-busting silently stops
// working for that one asset and nothing anywhere says so.
//
// Rejected at seed time rather than escaped at read time on purpose.
// Percent-encoding the key would make both cases "work" while producing a URL
// nobody intended, and identifiers in a bucket path have no business
// containing either character. Failing loudly here matches how this file
// already treats a typo'd sport or load type.
var validStorageKey = regexp.MustCompile(`^[a-z0-9/._-]+$`)

// Seed upserts the embedded catalog in one transaction. Idempotent — safe to
// run on every deploy, and re-running after editing the JSON is how the
// catalog is updated.
//
// Known gap, deliberate: this never deletes. Removing an entry from the JSON
// leaves its row in place, and renaming a slug creates a second row rather
// than renaming. So the JSON is authoritative for *content* but not yet for
// *membership*. Hard deletion gets risky once logged activities reference an
// exercise ID, so the answer is probably an `archived_at` column rather than
// a DELETE — but that's a decision, not an oversight.
func Seed(ctx context.Context, repo Repository) (int, error) {
	exercises, err := SeedData()
	if err != nil {
		return 0, err
	}
	if err := repo.UpsertAll(ctx, exercises); err != nil {
		return 0, err
	}
	return len(exercises), nil
}
