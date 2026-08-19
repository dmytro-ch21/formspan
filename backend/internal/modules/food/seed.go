package food

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
)

// The catalog lives in version-controlled JSON, like `exercises.json` and
// `techniques.json`: content stays diffable and code-reviewed, deploys are
// reproducible, and the console can edit a row without a deploy reverting it.
//
// Produced by `scripts/import_usda_foods.py` from USDA SR Legacy — a frozen,
// public-domain dataset. Read that script's docstring before editing this file
// by hand; the `external_id` on every row records which USDA row each number
// came from, and hand-editing breaks the ability to check one.
//
// Embedded rather than read from disk so the binary is self-contained and a
// deploy cannot fail on a container that did not copy a data directory.
//
//go:embed foods.json
var seedJSON []byte

// seedFood is the JSON shape, which is deliberately NOT the domain shape.
//
// Two fields differ and both are on purpose. `serving_label` is not in the
// file because every seeded row is per 100 g — repeating "100 g" 173 times
// would invite one of them to be wrong. `usda_description` is in the file and
// not in the domain: it is there so a reviewer can see which USDA row a number
// came from without fetching anything, and the API has no reason to serve it.
type seedFood struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Category        string   `json:"category"`
	Aliases         []string `json:"aliases"`
	KCal            float64  `json:"kcal"`
	ProteinG        float64  `json:"protein_g"`
	CarbG           float64  `json:"carb_g"`
	FatG            float64  `json:"fat_g"`
	FibreG          *float64 `json:"fibre_g"`
	ServingGrams    float64  `json:"serving_grams"`
	Market          string   `json:"market"`
	ExternalID      string   `json:"external_id"`
	USDADescription string   `json:"usda_description"`
}

// SeedServingLabel is the serving every seeded row carries.
//
// USDA states every value per 100 g of edible portion, so that is what these
// rows are. Household portions ("1 medium banana, 118 g") do exist in the
// source and are deliberately not imported — a known gap, not an oversight.
const SeedServingLabel = "100 g"

const seedExternalSource = "usda"

// SeedData parses the embedded catalog. Exported separately from Seed so tests
// can validate the content without a database — which is what lets the
// validation below run in CI on a machine with no Postgres.
func SeedData() ([]Food, error) {
	var raw []seedFood
	if err := json.Unmarshal(seedJSON, &raw); err != nil {
		return nil, fmt.Errorf("food: parse seed: %w", err)
	}
	if err := validate(raw); err != nil {
		return nil, err
	}
	foods := make([]Food, 0, len(raw))
	for _, s := range raw {
		s := s
		grams := s.ServingGrams
		aliases := s.Aliases
		if aliases == nil {
			aliases = []string{}
		}
		externalID := s.ExternalID
		externalSource := seedExternalSource
		foods = append(foods, Food{
			ID:             s.ID,
			Name:           s.Name,
			Category:       s.Category,
			Aliases:        aliases,
			ServingLabel:   SeedServingLabel,
			ServingGrams:   &grams,
			KCal:           s.KCal,
			ProteinG:       s.ProteinG,
			CarbG:          s.CarbG,
			FatG:           s.FatG,
			FibreG:         s.FibreG,
			Market:         s.Market,
			Source:         SourceSeed,
			ExternalID:     &externalID,
			ExternalSource: &externalSource,
		})
	}
	return foods, nil
}

// validSlug matches the column's own CHECK. Enforced here too so a bad id
// fails with a sentence naming the row, rather than as a constraint violation
// mid-deploy that names only the constraint.
var validSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// validate catches the content mistakes that are easy to make and annoying to
// debug later. The JSON is generated, but it is also editable, and a duplicate
// slug silently overwriting a different food is exactly the kind of thing a
// diff does not show.
//
// **Every row must carry an external_id**, which is stricter than the column.
// A seeded row with no provenance is a nutrition figure nobody can check
// against a source, and for a catalog whose whole selling point over the AI
// estimator is that it is exact, an uncheckable number is the one thing that
// must not ship.
func validate(foods []seedFood) error {
	if len(foods) == 0 {
		// A seed file that parsed to nothing would seed nothing, and the
		// catalog would report itself empty at runtime. Failing here makes
		// that a deploy failure instead of a mystery.
		return fmt.Errorf("food: seed file is empty")
	}
	seen := make(map[string]bool, len(foods))
	for _, f := range foods {
		switch {
		case f.ID == "":
			return fmt.Errorf("food: seed entry %q has no id", f.Name)
		case !validSlug.MatchString(f.ID):
			return fmt.Errorf("food: seed id %q is not a slug (a-z, 0-9, -)", f.ID)
		case seen[f.ID]:
			return fmt.Errorf("food: duplicate seed id %q", f.ID)
		case f.Name == "":
			return fmt.Errorf("food: seed %q has no name", f.ID)
		case f.Category == "":
			return fmt.Errorf("food: seed %q has no category", f.ID)
		case f.Market == "":
			return fmt.Errorf("food: seed %q has no market", f.ID)
		case f.ExternalID == "":
			return fmt.Errorf("food: seed %q has no external_id — every number must be checkable against its source", f.ID)
		case f.ServingGrams <= 0:
			return fmt.Errorf("food: seed %q has a non-positive serving_grams", f.ID)
		case f.KCal < 0 || f.ProteinG < 0 || f.CarbG < 0 || f.FatG < 0:
			return fmt.Errorf("food: seed %q has a negative macro", f.ID)
		}
		seen[f.ID] = true
	}
	return nil
}

// Seed upserts the embedded catalog in one transaction. Idempotent — safe on
// every deploy, and re-running after regenerating the JSON is how the catalog
// is updated.
//
// Known gap, deliberate and shared with the exercise catalog: this never
// deletes. Removing an entry from the JSON leaves its row in place, and
// renaming a slug creates a second row rather than renaming. The JSON is
// authoritative for content but not for membership.
func Seed(ctx context.Context, repo Repository) (int, error) {
	foods, err := SeedData()
	if err != nil {
		return 0, err
	}
	if err := repo.UpsertAll(ctx, foods); err != nil {
		return 0, err
	}
	return len(foods), nil
}
