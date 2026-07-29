package exercise

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
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

// validate catches the content mistakes that are easy to make by hand and
// annoying to debug later — a duplicate slug silently overwriting a
// different exercise, or a load_type the clients have no renderer for.
// Cheap to check here, versus a CHECK constraint failure mid-deploy.
func validate(exercises []Exercise) error {
	valid := map[LoadType]bool{
		LoadTypeWeightReps: true, LoadTypeReps: true, LoadTypeTime: true,
		LoadTypeDistance: true, LoadTypeDistanceTime: true,
	}
	seen := make(map[string]bool, len(exercises))
	for _, e := range exercises {
		switch {
		case e.ID == "":
			return fmt.Errorf("exercise: seed entry %q has no id", e.Name)
		case seen[e.ID]:
			return fmt.Errorf("exercise: duplicate seed id %q", e.ID)
		case e.Name == "" || e.Sport == "" || e.MovementPattern == "":
			return fmt.Errorf("exercise: seed %q needs name, sport, and movement_pattern", e.ID)
		case !valid[e.LoadType]:
			return fmt.Errorf("exercise: seed %q has unknown load_type %q", e.ID, e.LoadType)
		}
		seen[e.ID] = true
	}
	return nil
}

// Seed upserts the embedded catalog. Idempotent — safe to run on every
// deploy, and re-running after editing the JSON is how the catalog is
// updated.
func Seed(ctx context.Context, repo Repository) (int, error) {
	exercises, err := SeedData()
	if err != nil {
		return 0, err
	}
	for _, e := range exercises {
		if err := repo.Upsert(ctx, e); err != nil {
			return 0, err
		}
	}
	return len(exercises), nil
}
