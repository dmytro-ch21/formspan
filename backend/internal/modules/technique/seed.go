package technique

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
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
	// A key absent from the JSON leaves a nil slice, and pgx encodes nil as SQL
	// NULL — which the NOT NULL columns reject mid-batch, naming a constraint
	// rather than the entry. Most entries omit the two detail keys entirely, so
	// this is the common path, not an edge case. Normalised here so the domain
	// object is well-formed for every consumer, not just the writer.
	for i := range positions {
		if positions[i].Aliases == nil {
			positions[i].Aliases = []string{}
		}
		if positions[i].DetailIncludes == nil {
			positions[i].DetailIncludes = []string{}
		}
		if positions[i].DetailExcludes == nil {
			positions[i].DetailExcludes = []string{}
		}
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

// ValidateFields is every rule that can be judged from ONE technique, with no
// view of the rest of the library.
//
// Exported and split out because the admin console writes techniques too, and
// two validators for one catalog is how a vocabulary drifts. A family or a
// function verb the clients do not recognise is the worst kind of bad data
// here: it seeds, it renders, and it silently returns nothing forever — the
// one field where being wrong looks identical to being right.
//
// Cross-entry rules need the whole catalog and stay in validate(); the admin
// path checks those against the database instead. `position` is one of them,
// NOT a per-field rule: the shipped catalog holds 16 distinct values, 15
// family-derived and one literal "Other" (the technical standup, which happens
// from nowhere in particular). Requiring a known family here rejects real
// content — which is how this was first written, and three tests caught it.
func ValidateFields(t Technique) error {
	switch {
	case t.ID == "":
		return fmt.Errorf("technique: entry %q has no id", t.Name)
	case t.Name == "" || t.Category == "" || t.Position == "":
		return fmt.Errorf("technique: %q needs name, category, and position", t.ID)
	case !validGiNoGi[t.GiNoGi]:
		return fmt.Errorf("technique: %q has unknown gi_no_gi %q", t.ID, t.GiNoGi)
	case t.Function != "" && !validFunctions[t.Function]:
		// The column has no CHECK constraint (see migration 000028), so this
		// is the only thing standing between a typo and a value no client
		// knows how to render. Empty is legal and means "not a technique" —
		// the breakfalls and the grappling stance.
		return fmt.Errorf("technique: %q has unknown function %q", t.ID, t.Function)
	}
	return nil
}

// FamilyOf reduces "Half Guard - Bottom" to "Half Guard" — the prefix the
// clients' filter chips match on. Duplicated in each client because they need
// it offline; this is the server's copy and the one the validators use.
func FamilyOf(position string) string {
	for family := range validFamilies {
		if position == family || strings.HasPrefix(position, family+" - ") {
			return family
		}
	}
	return ""
}

func validate(techniques []Technique) error {
	// The `techniques.position` vocabulary — the destinations a to_position
	// may name. Derived from the library itself rather than hardcoded: the
	// set grew by one when leg entanglement was promoted, and a second list
	// to keep in step is a second list to forget.
	//
	// LOCAL, deliberately. As package state it never reset and only ever
	// grew, which made validate() order-dependent — a bad to_position was
	// rejected in a clean process and accepted after any earlier SeedData(),
	// so a validator test would pass alone and go silently weaker in the
	// suite. It was also a concurrent map write under -race.
	known := make(map[string]bool, len(techniques))
	for _, t := range techniques {
		if t.Position != "" {
			known[t.Position] = true
		}
	}

	seen := make(map[string]bool, len(techniques))
	for _, t := range techniques {
		if err := ValidateFields(t); err != nil {
			return err
		}
		switch {
		case seen[t.ID]:
			return fmt.Errorf("technique: duplicate id %q", t.ID)
		case t.ToPosition != "" && !known[t.ToPosition]:
			// A typo here is SILENT and total: "Side Control" instead of
			// "Side Control - Top" produces an edge pointing at a position
			// that does not exist, so every traversal through it returns
			// nothing and nothing reports a fault. Same failure shape as the
			// family typo this file already guards, one column over.
			return fmt.Errorf("technique: %q has unknown to_position %q", t.ID, t.ToPosition)
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
	"Back": true, "Turtle": true, "Leg Entanglement": true,
}

// The five things a technique can do. See migration 000028 for why this is
// separate from Category and why it is validated here rather than by a CHECK.
//
// Same duplication warning as validFamilies: this set is also an enum on the
// Technique schema in contracts/public.openapi.yaml.
//
//nolint:gochecknoglobals // vocabulary, not state
var validFunctions = map[string]bool{
	"advance": true, "reverse": true, "escape": true,
	"control": true, "finish": true,
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
		case len(p.DetailIncludes) > 0 && len(p.DetailExcludes) > 0:
			// A whitelist already excludes everything not on it, so pairing the
			// two means one of them is doing nothing — and which one is not
			// obvious from reading the entry.
			return fmt.Errorf("technique: position %q sets both detail_includes and detail_excludes", p.ID)
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
