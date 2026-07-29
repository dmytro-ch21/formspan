package technique

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
)

// Generated from the authored spreadsheet by
// scripts/import-exercise-catalog.py — the spreadsheet is the authoring
// surface, this is the build artifact. Embedded so the binary is
// self-contained and seeding can't fail on a container missing a data dir.
//
//go:embed techniques.json
var seedJSON []byte

func SeedData() ([]Technique, error) {
	var techniques []Technique
	if err := json.Unmarshal(seedJSON, &techniques); err != nil {
		return nil, fmt.Errorf("technique: parse seed: %w", err)
	}
	if err := validate(techniques); err != nil {
		return nil, err
	}
	return techniques, nil
}

// gi_no_gi is the one field with a DB-level CHECK, so a bad value would
// otherwise fail mid-deploy against the constraint rather than here with a
// name attached.
var validGiNoGi = map[string]bool{"Both": true, "Gi Only": true, "No-Gi Only": true}

func validate(techniques []Technique) error {
	seen := make(map[string]bool, len(techniques))
	for _, t := range techniques {
		switch {
		case t.ID == "":
			return fmt.Errorf("technique: entry %q has no id", t.Name)
		case seen[t.ID]:
			return fmt.Errorf("technique: duplicate id %q", t.ID)
		case t.Name == "" || t.Category == "" || t.Position == "":
			return fmt.Errorf("technique: %q needs name, category, and position", t.ID)
		case !validGiNoGi[t.GiNoGi]:
			return fmt.Errorf("technique: %q has unknown gi_no_gi %q", t.ID, t.GiNoGi)
		}
		seen[t.ID] = true
	}
	return nil
}

// Seed upserts the embedded library in one transaction. Idempotent — meant
// to run on every deploy.
func Seed(ctx context.Context, repo Repository) (int, error) {
	techniques, err := SeedData()
	if err != nil {
		return 0, err
	}
	if err := repo.UpsertAll(ctx, techniques); err != nil {
		return 0, err
	}
	return len(techniques), nil
}
