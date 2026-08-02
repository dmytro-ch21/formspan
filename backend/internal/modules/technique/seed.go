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

//go:embed ibjjf_rulesets.json
var rulesetJSON []byte

// Hand-authored rather than generated from the spreadsheet: ten entries of
// explanatory prose, written for someone who has never trained.
//
//go:embed positions.json
var positionJSON []byte

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

func PositionSeedData() ([]Position, error) {
	var positions []Position
	if err := json.Unmarshal(positionJSON, &positions); err != nil {
		return nil, fmt.Errorf("technique: parse positions: %w", err)
	}
	if err := validatePositions(positions); err != nil {
		return nil, err
	}
	return positions, nil
}

func RulesetSeedData() ([]Ruleset, error) {
	var rulesets []Ruleset
	if err := json.Unmarshal(rulesetJSON, &rulesets); err != nil {
		return nil, fmt.Errorf("technique: parse rulesets: %w", err)
	}
	return rulesets, nil
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

// The families a position may claim, which are exactly the prefixes the
// clients match against techniques.position. Validated because a typo here is
// SILENT: "Back Control" instead of "Back" still seeds, still renders, and just
// returns an empty technique list forever, with nothing anywhere reporting a
// fault. The one field where being wrong looks identical to being right.
//
// This set is duplicated as an enum on the Position schema in
// contracts/public.openapi.yaml — adding a family here without updating it
// there makes real responses invalid against the published contract, and the
// spec linter cannot see the disagreement. TestPositionsResolveAgainstTheLibrary
// is the check that a family is real; this comment is the reminder that the
// contract has its own copy.
var validFamilies = map[string]bool{
	"Standing": true, "Guard": true, "Half Guard": true,
	"Side Control": true, "Mount": true, "North-South": true,
	"Back": true, "Turtle": true,
}

func validatePositions(positions []Position) error {
	// An empty glossary is a parse or embed failure wearing a success: seeding
	// would report "0 upserted" and exit 0, leaving the clients to render a
	// missing feature as an ordinary absent row.
	if len(positions) == 0 {
		return fmt.Errorf("technique: no positions in the glossary")
	}
	seen := make(map[string]bool, len(positions))
	seenAlias := make(map[string]string, len(positions))
	for _, p := range positions {
		switch {
		case p.ID == "":
			return fmt.Errorf("technique: position %q has no id", p.Name)
		case seen[p.ID]:
			return fmt.Errorf("technique: duplicate position id %q", p.ID)
		case p.Name == "":
			return fmt.Errorf("technique: position %q has no name", p.ID)
		case !validFamilies[p.Family]:
			return fmt.Errorf("technique: position %q has unknown family %q", p.ID, p.Family)
		case p.Description == "" || p.Priorities == "":
			return fmt.Errorf("technique: position %q needs description and priorities", p.ID)
		}
		seen[p.ID] = true

		// Aliases exist here for the same reason they do on a technique — the
		// name is one of several things the position is called — which means
		// they will eventually be searched. An alias on two entries resolves
		// ambiguously the day that happens, and "guard" was on both closed and
		// open guard until this caught it.
		for _, a := range p.Aliases {
			if prev, dup := seenAlias[a]; dup {
				return fmt.Errorf("technique: alias %q is on both %q and %q", a, prev, p.ID)
			}
			seenAlias[a] = p.ID
		}
	}
	return nil
}

// SeedPositions is deliberately separate from Seed rather than a step inside
// it. Seed returns the technique count, which callers and tests compare against
// the length of the technique list; folding a second content type into that
// number would quietly break the comparison.
func SeedPositions(ctx context.Context, repo Repository) (int, error) {
	positions, err := PositionSeedData()
	if err != nil {
		return 0, err
	}
	if err := repo.UpsertPositions(ctx, positions); err != nil {
		return 0, err
	}
	return len(positions), nil
}

// Seed upserts the embedded library in one transaction. Idempotent — meant
// to run on every deploy.
func Seed(ctx context.Context, repo Repository) (int, error) {
	techniques, err := SeedData()
	if err != nil {
		return 0, err
	}
	rulesets, err := RulesetSeedData()
	if err != nil {
		return 0, err
	}
	// Every technique carries an FK to a ruleset, so a technique written
	// before its ruleset fails the constraint. Ordering is a correctness
	// requirement here, not a preference.
	if err := validateRulesetRefs(techniques, rulesets); err != nil {
		return 0, err
	}
	if err := repo.UpsertRulesets(ctx, rulesets); err != nil {
		return 0, err
	}
	if err := repo.UpsertAll(ctx, techniques); err != nil {
		return 0, err
	}
	// Rulesets are keyed by a hash of their content, so editing a rule mints a
	// new id and strands the old row. Pruning AFTER the technique upsert is
	// what makes it safe: by then every technique points at a current ruleset,
	// so anything unreferenced is genuinely dead. Left in place they would keep
	// appearing in /v1/techniques/rulesets forever.
	if err := repo.DeleteOrphanRulesets(ctx); err != nil {
		return 0, err
	}
	return len(techniques), nil
}

// A dangling reference would otherwise surface as an opaque FK violation
// partway through the batch, naming a constraint rather than the technique.
func validateRulesetRefs(techniques []Technique, rulesets []Ruleset) error {
	known := make(map[string]bool, len(rulesets))
	for _, r := range rulesets {
		known[r.ID] = true
	}
	for _, t := range techniques {
		if t.IBJJFRulesetID != "" && !known[t.IBJJFRulesetID] {
			return fmt.Errorf("technique: %q references unknown ibjjf ruleset %q", t.ID, t.IBJJFRulesetID)
		}
	}
	return nil
}
