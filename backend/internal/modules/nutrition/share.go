package nutrition

// N116/#505 — sending a food, a meal or a day's log to a friend as an
// independent, editable copy.
//
// This file adds THREE Copiers rather than inventing a second sharing
// mechanism: the share package (see its own doc comment) already knows how
// to hold a pending row, check friendship, and copy a resource atomically
// inside one transaction the moment it is accepted. Every module that wants
// in implements Describe/CopyTo and gets a line in cmd/api/main.go's
// registry — sequence and workout (N80/#414) already did exactly this. What
// follows is nutrition doing the same, three times over, because nutrition
// has three different things worth sending.
//
// # Why three Copiers and not one
//
// Go has no method overloading, so one struct cannot carry three
// Describe/CopyTo pairs — each resource kind is its own small type, all
// backed by the same *pgxpool.Pool, none of them importing the share
// package (structural typing is the whole point of that architecture; see
// workout/postgres.go and sequence/postgres.go for the precedent).
//
//   - EntryCopier  ("nutrition_entry") — one specific logged Entry: "the
//     chicken I ate at lunch". An Entry is this module's HISTORICAL record of
//     what somebody ate on a specific day (see the "a logged row owns its
//     numbers" rule in migration 000059) — the day it happened is a fact
//     about the SENDER, not something a recipient can honestly inherit. So
//     accepting one does not create a dated log row; it creates a new SAVED
//     FOOD (kind=food) in the recipient's own library, scaled down to one
//     serving, which they can log whenever they actually eat it and edit
//     freely. That is what "she should be able to modify it" (the reported
//     issue, verbatim) is asking for.
//
//   - FoodCopier ("nutrition_food") — an already-saved Food, either a plain
//     food OR a recipe (kind=recipe is what N115/#504's "combine into a
//     meal" screen, food/combine.tsx, already produces). This is the ONE
//     Copier that satisfies #505's AC "accepting a shared meal stores it as
//     their own saved item" literally: CopyTo inserts a new row into the
//     recipient's OWN nutrition_foods, with its recipe items if any — the
//     exact storage N115 already built, reused rather than reinvented.
//
//   - DayCopier ("nutrition_day") — a whole day's worth of entries, i.e. "the
//     dinner we had" scaled up to a full day. There is no single row a "day"
//     lives in, so the resourceID is the date itself ("YYYY-MM-DD"), scoped
//     to the sharer inside Describe/CopyTo exactly like every other lookup in
//     this module. Accepting bundles that day's entries into ONE new saved
//     recipe (kind=recipe, yield_servings=1) — the same shape `combineEntries`
//     already builds client-side for N115, just built from a whole day
//     instead of a hand-picked selection. That sidesteps two problems a
//     dated copy would have created: WHICH date the copy should land on for
//     the recipient (their timezone is not knowable server-side — see
//     Entry.EatenOn's own doc comment on why that is never derived here), and
//     whether inserting rows straight into somebody's real day-by-day history
//     under a date they did not actually eat those things on is an honest
//     thing to do to their log. A saved recipe has neither problem: no date,
//     freely editable, loggable whenever they choose.
//
//     BUILT FROM nutrition_entries ONLY — DayCopier's CopyTo never reads
//     nutrition_targets or body_checkins, which is what makes the privacy
//     boundary in #505's acceptance criteria ("shares what was eaten, not the
//     athlete's targets or weight") a structural fact rather than a filter
//     that could be forgotten: there is no code path here that could leak
//     either, because neither table is ever queried.
//
// # What none of the three copy
//
// `source` is always forced to 'user' on the new row, never read from the
// original — the same reasoning workout.CopyTo documents for its own
// `source` column: a copy claiming 'seed' or 'ai' would misattribute
// provenance nothing downstream can reconstruct, and 'ai' specifically is
// what N40/#313 exists to keep permanently distinguishable from something a
// human actually verified. `external_id`/`barcode` are always nulled: they
// carry a UNIQUE constraint (`nutrition_foods_external_idx`) scoped globally
// rather than per-athlete, so copying either across users risks colliding
// with the recipient's own scanned history.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// divPtr scales a nullable macro by a factor, preserving nil — "nobody
// stated this" must stay "nobody stated this" through a copy, exactly as
// Macros' own doc comment requires: nil is a fact about what we know, never
// a fact about the food, and multiplying a nil by anything must still be nil
// rather than inventing a zero.
func divPtr(v *float64, factor float64) *float64 {
	if v == nil {
		return nil
	}
	out := *v * factor
	return &out
}

// derefOr0 is for a SQL sum() the caller has already established cannot
// really be nil (count > 0 over a NOT NULL column) — a safe default rather
// than a panic if that invariant is ever wrong.
func derefOr0(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// scaleMacros multiplies every stated field by factor. Used to turn an
// entry's ABSOLUTE numbers (already multiplied by however many servings were
// eaten) back into PER-SERVING ones for a saved Food, which is the unit
// nutrition_foods stores in.
func scaleMacros(m Macros, factor float64) Macros {
	return Macros{
		Kcal:          m.Kcal * factor,
		ProteinG:      m.ProteinG * factor,
		CarbG:         m.CarbG * factor,
		FatG:          m.FatG * factor,
		FibreG:        divPtr(m.FibreG, factor),
		SaturatedFatG: divPtr(m.SaturatedFatG, factor),
		SugarG:        divPtr(m.SugarG, factor),
		AddedSugarG:   divPtr(m.AddedSugarG, factor),
		SodiumMG:      divPtr(m.SodiumMG, factor),
		CholesterolMG: divPtr(m.CholesterolMG, factor),
	}
}

// insertFood is the one INSERT every Copier's CopyTo below ends with — a new,
// server-generated id, always 'user'-sourced, always private to newOwnerID,
// external_id/barcode always nulled. Shared so the "what we deliberately do
// not copy" list above is enforced in exactly one place.
func insertFood(ctx context.Context, tx pgx.Tx, newOwnerID, kind, name, brand, servingLabel string,
	servingGrams *float64, m Macros, yieldServings *float64) (string, error) {
	var newID string
	err := tx.QueryRow(ctx, `
		INSERT INTO nutrition_foods (
			id, user_id, kind, name, brand,
			serving_label, serving_grams,
			kcal, protein_g, carb_g, fat_g, fibre_g,
			saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
			yield_servings, source, external_id, barcode)
		VALUES (gen_random_uuid(), $1, $2, $3, $4,
		        $5, $6, $7, $8, $9, $10, $11,
		        $12, $13, $14, $15, $16,
		        $17, 'user', NULL, NULL)
		RETURNING id::text`,
		newOwnerID, kind, name, brand,
		servingLabel, servingGrams, m.Kcal, m.ProteinG, m.CarbG, m.FatG, m.FibreG,
		m.SaturatedFatG, m.SugarG, m.AddedSugarG, m.SodiumMG, m.CholesterolMG,
		yieldServings).Scan(&newID)
	return newID, err
}

// EntryCopier shares one logged Entry — see the package doc above.
type EntryCopier struct {
	pool *pgxpool.Pool
}

func NewEntryCopier(pool *pgxpool.Pool) EntryCopier { return EntryCopier{pool: pool} }

// Describe names the entry for the recipient's inbox card. Scoped to
// user_id, like every read in this module — a personal log has no notion of
// "visible to a stranger" the way a VOLA-authored workout does, so ownership
// IS the visibility test here.
func (c EntryCopier) Describe(ctx context.Context, resourceID, sharerID string) (string, bool, error) {
	// A malformed id is a miss, not a 500 — the column is UUID-typed, so an
	// unvalidated string would otherwise reach Postgres as a type error
	// (22P02) rather than the ordinary "not found" every other bad id in
	// this package already collapses to.
	if !isUUID(resourceID) {
		return "", false, nil
	}
	var name string
	err := c.pool.QueryRow(ctx, `
		SELECT name FROM nutrition_entries WHERE user_id = $1 AND id = $2`,
		sharerID, resourceID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("nutrition: describe entry: %w", err)
	}
	return name, true, nil
}

// CopyTo turns a shared entry into a new saved Food (kind=food) in the
// recipient's library — see the package doc for why this lands as a saved
// food rather than a dated log row.
//
// The entry's macros are ABSOLUTE for however many servings were logged
// (servings x per-serving), and a saved Food's macros are PER SERVING —
// dividing by `servings` here is not optional, it is what stops "1.5 x
// protein shake" being handed to a friend as "1 x protein shake" at 50% more
// protein than it actually has.
func (c EntryCopier) CopyTo(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
	if !isUUID(resourceID) {
		return "", false, nil
	}
	var (
		name, servingLabel string
		servings           float64
		m                  Macros
	)
	err := tx.QueryRow(ctx, `
		SELECT name, servings, serving_label,
		       kcal, protein_g, carb_g, fat_g, fibre_g,
		       saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg
		FROM nutrition_entries WHERE user_id = $1 AND id = $2`,
		sharerID, resourceID).Scan(
		&name, &servings, &servingLabel,
		&m.Kcal, &m.ProteinG, &m.CarbG, &m.FatG, &m.FibreG,
		&m.SaturatedFatG, &m.SugarG, &m.AddedSugarG, &m.SodiumMG, &m.CholesterolMG)
	if errors.Is(err, pgx.ErrNoRows) {
		// Deleted between sending and accepting, or never the sharer's — the
		// share module turns this into ErrGone rather than retrying forever.
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("nutrition: copy entry read: %w", err)
	}
	if servings <= 0 {
		servings = 1
	}
	per := scaleMacros(m, 1/servings)

	newID, err := insertFood(ctx, tx, newOwnerID, string(KindFood), name, "", servingLabel, nil, per, nil)
	if err != nil {
		return "", false, fmt.Errorf("nutrition: copy entry insert: %w", err)
	}
	return newID, true, nil
}

// FoodCopier shares an already-saved Food — a plain food, or a "meal"
// (N115's recipe). See the package doc above.
type FoodCopier struct {
	pool *pgxpool.Pool
}

func NewFoodCopier(pool *pgxpool.Pool) FoodCopier { return FoodCopier{pool: pool} }

func (c FoodCopier) Describe(ctx context.Context, resourceID, sharerID string) (string, bool, error) {
	if !isUUID(resourceID) {
		return "", false, nil
	}
	var name string
	err := c.pool.QueryRow(ctx, `
		SELECT name FROM nutrition_foods WHERE user_id = $1 AND id = $2`,
		sharerID, resourceID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("nutrition: describe food: %w", err)
	}
	return name, true, nil
}

// CopyTo duplicates the Food row and, for a recipe, its items — atomically,
// inside the share module's transaction, exactly like workout.CopyTo and
// sequence.CopyTo.
//
// The items are copied with ONE INSERT ... SELECT rather than a read-then-
// loop-insert — the same shape workout.CopyTo already uses for its own
// ordered children (see that method's comment: "the items never leave the
// database, so a long template costs one round trip and cannot half-copy").
// A no-op for a plain food, which has no rows in nutrition_recipe_items to
// match.
func (c FoodCopier) CopyTo(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
	if !isUUID(resourceID) {
		return "", false, nil
	}
	var (
		kind, name, brand, servingLabel string
		servingGrams, yieldServings     *float64
		m                               Macros
	)
	err := tx.QueryRow(ctx, `
		SELECT kind, name, brand, serving_label, serving_grams,
		       kcal, protein_g, carb_g, fat_g, fibre_g,
		       saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg,
		       yield_servings
		FROM nutrition_foods WHERE user_id = $1 AND id = $2`,
		sharerID, resourceID).Scan(
		&kind, &name, &brand, &servingLabel, &servingGrams,
		&m.Kcal, &m.ProteinG, &m.CarbG, &m.FatG, &m.FibreG,
		&m.SaturatedFatG, &m.SugarG, &m.AddedSugarG, &m.SodiumMG, &m.CholesterolMG,
		&yieldServings)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("nutrition: copy food read: %w", err)
	}

	newID, err := insertFood(ctx, tx, newOwnerID, kind, name, brand, servingLabel, servingGrams, m, yieldServings)
	if err != nil {
		return "", false, fmt.Errorf("nutrition: copy food insert: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO nutrition_recipe_items (
			food_id, position, name, quantity, serving_label,
			kcal, protein_g, carb_g, fat_g, fibre_g,
			saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg, source_food_id)
		SELECT $1, row_number() OVER (ORDER BY position) - 1,
		       name, quantity, serving_label,
		       kcal, protein_g, carb_g, fat_g, fibre_g,
		       saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg, NULL
		FROM nutrition_recipe_items WHERE food_id = $2`,
		newID, resourceID); err != nil {
		return "", false, fmt.Errorf("nutrition: copy food items: %w", err)
	}
	return newID, true, nil
}

// DayCopier shares a whole day's entries — "a log" — as one new saved
// recipe. See the package doc above for why a day is a date-keyed resource
// and why the copy has no date of its own.
type DayCopier struct {
	pool *pgxpool.Pool
}

func NewDayCopier(pool *pgxpool.Pool) DayCopier { return DayCopier{pool: pool} }

// maxDayEntries reuses the recipe item cap: a day copy is a recipe under the
// hood, so it cannot hold more items than any other one.
const maxDayEntries = maxRecipeItems

// Describe names the day and counts what is in it — never anything from
// nutrition_targets or body_checkins, see the package doc's privacy-boundary
// paragraph. ok is false for a day with no entries: there is nothing to
// send, and treating an empty day as "not found" is the same non-oracle
// answer every other miss in this module already gives.
func (c DayCopier) Describe(ctx context.Context, resourceID, sharerID string) (string, bool, error) {
	// A malformed date is a miss, not a 500 — matching EntryCopier/
	// FoodCopier's isUUID() short-circuit above and for the identical
	// reason: without this, a non-date resource_id reaches Postgres as
	// `eaten_on = $2::date` and comes back 22007/22008 (invalid_datetime_format),
	// which is not pgx.ErrNoRows, so it would surface as a 500 instead of
	// the 400/404 every other bad id in this module resolves to.
	if _, err := time.Parse("2006-01-02", resourceID); err != nil {
		return "", false, nil
	}
	var count int
	err := c.pool.QueryRow(ctx, `
		SELECT count(*) FROM nutrition_entries WHERE user_id = $1 AND eaten_on = $2::date`,
		sharerID, resourceID).Scan(&count)
	if err != nil {
		return "", false, fmt.Errorf("nutrition: describe day: %w", err)
	}
	if count == 0 {
		return "", false, nil
	}
	noun := "entries"
	if count == 1 {
		noun = "entry"
	}
	return fmt.Sprintf("%s (%d %s)", resourceID, count, noun), true, nil
}

// CopyTo bundles the sharer's entries for resourceID (a "YYYY-MM-DD" date)
// into ONE new recipe, one serving, in the recipient's library — the same
// shape food/combine.tsx already builds client-side for a hand-picked
// selection (N115), built here from a whole day instead.
//
// STRUCTURALLY excludes targets and body weight: every statement below names
// only nutrition_entries. There is no query anywhere in this method that
// could reach nutrition_targets or body_checkins, which is what makes #505's
// "shares what was eaten, not targets or weight" a fact about the code rather
// than a filter someone could forget to apply.
//
// ONE INSERT ... SELECT for the items, not a read-then-loop — the same shape
// workout.CopyTo already uses for its own ordered children, and for the
// identical reason its comment states: "the items never leave the database,
// so a long [day] costs one round trip and cannot half-copy." The totals are
// summed in SQL first (one round trip, SUM() skipping NULLs exactly as
// DayTotals' own query already documents — nil stays nil unless at least one
// entry stated a value), so the parent row is inserted with its real numbers
// the first time rather than zeroed-then-corrected.
func (c DayCopier) CopyTo(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
	if _, err := time.Parse("2006-01-02", resourceID); err != nil {
		return "", false, nil
	}
	// sum() over ZERO rows is NULL regardless of the column's own
	// nullability — even kcal, which nutrition_entries declares NOT NULL —
	// so every destination has to be a pointer here, count==0 checked
	// BEFORE any of them are dereferenced below.
	var (
		count                                  int
		kcalSum, proteinSum, carbSum, fatSum   *float64
		fibre, sat, sugar, added, sodium, chol *float64
	)
	err := tx.QueryRow(ctx, `
		SELECT count(*),
		       sum(kcal), sum(protein_g), sum(carb_g), sum(fat_g),
		       sum(fibre_g), sum(saturated_fat_g), sum(sugar_g), sum(added_sugar_g),
		       sum(sodium_mg), sum(cholesterol_mg)
		FROM nutrition_entries WHERE user_id = $1 AND eaten_on = $2::date`,
		sharerID, resourceID).Scan(
		&count,
		&kcalSum, &proteinSum, &carbSum, &fatSum,
		&fibre, &sat, &sugar, &added, &sodium, &chol)
	if err != nil {
		return "", false, fmt.Errorf("nutrition: copy day totals: %w", err)
	}
	if count == 0 {
		// Gone between sending and accepting — every entry that day was
		// deleted (or it was never real). Same ErrGone treatment as a
		// deleted food or entry.
		return "", false, nil
	}
	// A day with more entries than a recipe can hold (100, N115's own limit)
	// is not silently truncated: refuse the whole copy rather than hand over
	// a day that quietly lost its last few entries.
	if count > maxDayEntries {
		return "", false, fmt.Errorf("nutrition: day %s has more than %d entries, too many to share as one meal", resourceID, maxDayEntries)
	}
	// count > 0 and kcal/protein_g/carb_g/fat_g are all NOT NULL columns, so
	// each sum is guaranteed non-nil here — derefOr0 is a defensive default,
	// never actually reached at nil.
	total := Macros{
		Kcal: derefOr0(kcalSum), ProteinG: derefOr0(proteinSum),
		CarbG: derefOr0(carbSum), FatG: derefOr0(fatSum),
		FibreG: fibre, SaturatedFatG: sat, SugarG: sugar, AddedSugarG: added,
		SodiumMG: sodium, CholesterolMG: chol,
	}

	yield := 1.0
	newID, err := insertFood(ctx, tx, newOwnerID, string(KindRecipe),
		fmt.Sprintf("Shared day — %s", resourceID), "", "1 day", nil, total, &yield)
	if err != nil {
		return "", false, fmt.Errorf("nutrition: copy day insert: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO nutrition_recipe_items (
			food_id, position, name, quantity, serving_label,
			kcal, protein_g, carb_g, fat_g, fibre_g,
			saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg, source_food_id)
		SELECT $1, row_number() OVER (ORDER BY meal, created_at, id) - 1,
		       name, servings, serving_label,
		       kcal, protein_g, carb_g, fat_g, fibre_g,
		       saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg, NULL
		FROM nutrition_entries WHERE user_id = $2 AND eaten_on = $3::date`,
		newID, sharerID, resourceID); err != nil {
		return "", false, fmt.Errorf("nutrition: copy day items: %w", err)
	}
	return newID, true, nil
}
