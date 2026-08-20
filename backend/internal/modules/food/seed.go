package food

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// The catalog lives in version-controlled JSON, like `exercises.json` and
// `techniques.json`: content stays diffable and code-reviewed, deploys are
// reproducible, and the console can edit a row without a deploy reverting it.
//
// Produced by `scripts/import_usda_foods.py` from USDA SR Legacy and FNDDS —
// public-domain (CC0) datasets. Read that script's docstring before editing
// this file by hand; the `external_id` on every row records which USDA row each
// number came from, and hand-editing breaks the ability to check one.
//
// **12,651 rows since N88**, of which 177 are the hand-curated set the file used
// to hold in full. At ~5.6 MB this is by far the largest embedded asset in the
// binary; `techniques.json` is 669 KB and `exercises.json` 382 KB.
//
// Embedded rather than read from disk so the binary is self-contained and a
// deploy cannot fail on a container that did not copy a data directory.
//
//go:embed foods.json
var seedJSON []byte

// seedFood is the JSON shape, which is deliberately NOT the domain shape.
//
// Two fields differ and both are on purpose. `serving_label` is not in the
// file because every seeded row is per 100 g — repeating "100 g" 12,651 times
// would invite one of them to be wrong. `usda_description` is in the file and
// not in the domain: it is there so a reviewer can see which USDA row a number
// came from without fetching anything, and the API has no reason to serve it.
type seedFood struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Category string `json:"category"`
	// RankTier is 0 for the 177 hand-curated foods and 1 for the bulk USDA
	// import. Written by scripts/import_usda_foods.py, never by hand.
	//
	// NOT a pointer, and the zero value is load-bearing in the WRONG direction
	// — an absent `rank_tier` in the JSON unmarshals to 0, which is the CURATED
	// tier. `validate` therefore requires the field to be present rather than
	// trusting the default, because a seed file that lost the field would
	// silently promote all 12,651 rows to tier 0 and undo the ranking entirely.
	RankTier *int     `json:"rank_tier"`
	Aliases  []string `json:"aliases"`
	KCal     float64  `json:"kcal"`
	ProteinG float64  `json:"protein_g"`
	CarbG    float64  `json:"carb_g"`
	FatG     float64  `json:"fat_g"`
	FibreG   *float64 `json:"fibre_g"`
	// The label macros (N52). Nullable because USDA does not state every
	// nutrient for every food. Measured coverage across the two imported
	// datasets (N88): SR Legacy states saturated fat on 96% of rows, sugar on
	// 77%, sodium on 99% and cholesterol on 95%; FNDDS states all four on 100%.
	// Absence is carried through as NULL rather than 0.
	//
	// `added_sugar_g` is deliberately NOT here: measured at N88, NOT ONE of the
	// 13,620 rows across SR Legacy, FNDDS and Foundation states it. It is null
	// for every seeded food and populated only by Open Food Facts on a scan. A
	// field in this struct that could never be non-nil would read as an import
	// that silently never fires.
	SaturatedFatG   *float64 `json:"saturated_fat_g"`
	SugarG          *float64 `json:"sugar_g"`
	SodiumMG        *float64 `json:"sodium_mg"`
	CholesterolMG   *float64 `json:"cholesterol_mg"`
	ServingGrams    float64  `json:"serving_grams"`
	Market          string   `json:"market"`
	ExternalID      string   `json:"external_id"`
	USDADescription string   `json:"usda_description"`
	// Portions is absent on the 268 rows USDA states none for, which is a
	// legitimate state — 100 g still works. Not a pointer, because unlike
	// RankTier the zero value (nil) means exactly what an absent field means.
	Portions []seedPortion `json:"portions"`
}

// seedPortion is one household measure, as it sits in the JSON.
type seedPortion struct {
	Seq   int     `json:"seq"`
	Label string  `json:"label"`
	Grams float64 `json:"grams"`
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
			SaturatedFatG:  s.SaturatedFatG,
			SugarG:         s.SugarG,
			SodiumMG:       s.SodiumMG,
			CholesterolMG:  s.CholesterolMG,
			Market:         s.Market,
			RankTier:       *s.RankTier,
			Portions:       portionsOf(s),
			Source:         SourceSeed,
			ExternalID:     &externalID,
			ExternalSource: &externalSource,
		})
	}
	return foods, nil
}

// portionsOf converts one row's portions, preserving the file's order.
//
// Returns nil rather than an empty slice for a food with none, so the wire
// omits the field entirely (see Food.Portions) instead of sending `[]`.
func portionsOf(s seedFood) []Portion {
	if len(s.Portions) == 0 {
		return nil
	}
	out := make([]Portion, 0, len(s.Portions))
	for _, p := range s.Portions {
		out = append(out, Portion{Seq: p.Seq, Label: p.Label, Grams: p.Grams})
	}
	return out
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
		case f.RankTier == nil:
			// Absence is checked, not defaulted. An `int` here would read a
			// missing field as 0 — the CURATED tier — so a seed file that lost
			// the field would silently promote all 12,651 rows ahead of nothing
			// and disable the ranking, with no error anywhere.
			return fmt.Errorf("food: seed %q has no rank_tier", f.ID)
		case *f.RankTier < 0:
			return fmt.Errorf("food: seed %q has a negative rank_tier", f.ID)
		case f.ServingGrams <= 0:
			return fmt.Errorf("food: seed %q has a non-positive serving_grams", f.ID)
		case f.KCal < 0 || f.ProteinG < 0 || f.CarbG < 0 || f.FatG < 0:
			return fmt.Errorf("food: seed %q has a negative macro", f.ID)
		}
		seen[f.ID] = true

		// Portions get their own pass rather than another switch arm, because
		// each row has many and the error has to name which one.
		seqs := make(map[int]bool, len(f.Portions))
		for _, p := range f.Portions {
			switch {
			case p.Grams <= 0:
				// The one rule that matters. A portion with no weight cannot be
				// logged against a target, and FNDDS really does ship one
				// (gramWeight 0 on "Milk, human"). The column CHECKs this too;
				// failing here names the food instead of the constraint.
				return fmt.Errorf("food: seed %q portion %q has a non-positive gram weight", f.ID, p.Label)
			case strings.TrimSpace(p.Label) == "":
				return fmt.Errorf("food: seed %q has a portion with no label", f.ID)
			case p.Seq < 0:
				return fmt.Errorf("food: seed %q portion %q has a negative seq", f.ID, p.Label)
			case seqs[p.Seq]:
				// seq is half the primary key, so a duplicate would be a
				// constraint violation mid-deploy naming only the constraint.
				return fmt.Errorf("food: seed %q has two portions at seq %d", f.ID, p.Seq)
			}
			seqs[p.Seq] = true
		}
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
