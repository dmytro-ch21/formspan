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

// insertRecipeItem writes one component of a copied recipe. `position` is
// the caller's loop index, re-derived from read order rather than carried —
// the same densification workout.CopyTo and sequence.CopyTo both already do
// for their own ordered children.
//
// source_food_id is always NULL on a copy: it is provenance pointing back at
// the SENDER's own saved foods (see the FK's own comment in migration
// 000059 on why it is deliberately not enforced), and a raw id copied across
// owners would name nothing the recipient has, or worse, something they own
// that merely shares that uuid by coincidence.
func insertRecipeItem(ctx context.Context, tx pgx.Tx, foodID string, position int,
	name, servingLabel string, quantity float64, m Macros) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO nutrition_recipe_items (
			food_id, position, name, quantity, serving_label,
			kcal, protein_g, carb_g, fat_g, fibre_g,
			saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg, source_food_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NULL)`,
		foodID, position, name, quantity, servingLabel,
		m.Kcal, m.ProteinG, m.CarbG, m.FatG, m.FibreG,
		m.SaturatedFatG, m.SugarG, m.AddedSugarG, m.SodiumMG, m.CholesterolMG)
	return err
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
// sequence.CopyTo. A plain food has no items and the loop below is a no-op.
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

	type item struct {
		name, servingLabel string
		quantity           float64
		m                  Macros
	}
	var items []item
	if kind == string(KindRecipe) {
		rows, err := tx.Query(ctx, `
			SELECT name, quantity, serving_label,
			       kcal, protein_g, carb_g, fat_g, fibre_g,
			       saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg
			FROM nutrition_recipe_items WHERE food_id = $1 ORDER BY position`, resourceID)
		if err != nil {
			return "", false, fmt.Errorf("nutrition: copy food items read: %w", err)
		}
		for rows.Next() {
			var it item
			if err := rows.Scan(&it.name, &it.quantity, &it.servingLabel,
				&it.m.Kcal, &it.m.ProteinG, &it.m.CarbG, &it.m.FatG, &it.m.FibreG,
				&it.m.SaturatedFatG, &it.m.SugarG, &it.m.AddedSugarG, &it.m.SodiumMG, &it.m.CholesterolMG); err != nil {
				rows.Close()
				return "", false, fmt.Errorf("nutrition: copy food items scan: %w", err)
			}
			items = append(items, it)
		}
		rowsErr := rows.Err()
		rows.Close()
		if rowsErr != nil {
			return "", false, fmt.Errorf("nutrition: copy food items: %w", rowsErr)
		}
	}

	newID, err := insertFood(ctx, tx, newOwnerID, kind, name, brand, servingLabel, servingGrams, m, yieldServings)
	if err != nil {
		return "", false, fmt.Errorf("nutrition: copy food insert: %w", err)
	}
	for i, it := range items {
		if err := insertRecipeItem(ctx, tx, newID, i, it.name, it.servingLabel, it.quantity, it.m); err != nil {
			return "", false, fmt.Errorf("nutrition: copy food item insert: %w", err)
		}
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

// CopyTo reads the sharer's entries for resourceID (a "YYYY-MM-DD" date) and
// bundles them into ONE new recipe, one serving, in the recipient's library —
// the same shape food/combine.tsx already builds client-side for a
// hand-picked selection (N115), built here from a whole day instead.
//
// STRUCTURALLY excludes targets and body weight: this method names only
// nutrition_entries. There is no second query anywhere here that could reach
// nutrition_targets or body_checkins, which is what makes #505's "shares
// what was eaten, not targets or weight" a fact about the code rather than a
// filter someone could forget to apply.
func (c DayCopier) CopyTo(ctx context.Context, tx pgx.Tx, resourceID, sharerID, newOwnerID string) (string, bool, error) {
	rows, err := tx.Query(ctx, `
		SELECT name, servings, serving_label,
		       kcal, protein_g, carb_g, fat_g, fibre_g,
		       saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg
		FROM nutrition_entries
		WHERE user_id = $1 AND eaten_on = $2::date
		ORDER BY meal, created_at, id
		LIMIT $3`, sharerID, resourceID, maxDayEntries+1)
	if err != nil {
		return "", false, fmt.Errorf("nutrition: copy day read: %w", err)
	}
	type item struct {
		name, servingLabel string
		servings           float64
		m                  Macros
	}
	var items []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.name, &it.servings, &it.servingLabel,
			&it.m.Kcal, &it.m.ProteinG, &it.m.CarbG, &it.m.FatG, &it.m.FibreG,
			&it.m.SaturatedFatG, &it.m.SugarG, &it.m.AddedSugarG, &it.m.SodiumMG, &it.m.CholesterolMG); err != nil {
			rows.Close()
			return "", false, fmt.Errorf("nutrition: copy day scan: %w", err)
		}
		items = append(items, it)
	}
	rowsErr := rows.Err()
	rows.Close()
	if rowsErr != nil {
		return "", false, fmt.Errorf("nutrition: copy day: %w", rowsErr)
	}
	if len(items) == 0 {
		// Gone between sending and accepting — every entry that day was
		// deleted. Same ErrGone treatment as a deleted food or entry.
		return "", false, nil
	}
	// A day with more entries than a recipe can hold (100, N115's own limit)
	// is not silently truncated: refuse the whole copy rather than hand over
	// a day that quietly lost its last few entries.
	if len(items) > maxDayEntries {
		return "", false, fmt.Errorf("nutrition: day %s has more than %d entries, too many to share as one meal", resourceID, maxDayEntries)
	}

	yield := 1.0
	newID, err := insertFood(ctx, tx, newOwnerID, string(KindRecipe),
		fmt.Sprintf("Shared day — %s", resourceID), "", "1 day", nil, Macros{}, &yield)
	if err != nil {
		return "", false, fmt.Errorf("nutrition: copy day insert: %w", err)
	}
	var total Macros
	sums := map[string]float64{}
	stated := map[string]bool{}
	add := func(key string, v *float64) {
		if v == nil {
			return
		}
		sums[key] += *v
		stated[key] = true
	}
	for i, it := range items {
		if err := insertRecipeItem(ctx, tx, newID, i, it.name, it.servingLabel, it.servings, it.m); err != nil {
			return "", false, fmt.Errorf("nutrition: copy day item insert: %w", err)
		}
		total.Kcal += it.m.Kcal
		total.ProteinG += it.m.ProteinG
		total.CarbG += it.m.CarbG
		total.FatG += it.m.FatG
		add("fibre", it.m.FibreG)
		add("sat", it.m.SaturatedFatG)
		add("sugar", it.m.SugarG)
		add("added", it.m.AddedSugarG)
		add("sodium", it.m.SodiumMG)
		add("chol", it.m.CholesterolMG)
	}
	per := func(key string) *float64 {
		if !stated[key] {
			return nil
		}
		v := sums[key]
		return &v
	}
	total.FibreG = per("fibre")
	total.SaturatedFatG = per("sat")
	total.SugarG = per("sugar")
	total.AddedSugarG = per("added")
	total.SodiumMG = per("sodium")
	total.CholesterolMG = per("chol")
	// The parent row was inserted with zeroed macros above (items did not
	// exist yet to sum), so it is corrected here to the real total — one
	// serving of a one-serving recipe IS the sum of its items, the identical
	// rule food/combine.tsx's `draftToFood` already applies client-side for
	// N115.
	if _, err := tx.Exec(ctx, `
		UPDATE nutrition_foods SET
			kcal = $2, protein_g = $3, carb_g = $4, fat_g = $5, fibre_g = $6,
			saturated_fat_g = $7, sugar_g = $8, added_sugar_g = $9, sodium_mg = $10, cholesterol_mg = $11
		WHERE id = $1`,
		newID, total.Kcal, total.ProteinG, total.CarbG, total.FatG, total.FibreG,
		total.SaturatedFatG, total.SugarG, total.AddedSugarG, total.SodiumMG, total.CholesterolMG); err != nil {
		return "", false, fmt.Errorf("nutrition: copy day totals: %w", err)
	}
	return newID, true, nil
}
