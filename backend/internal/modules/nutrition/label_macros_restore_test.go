package nutrition

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// F37 — THE RESTORE PATH FOR THE FIVE LABEL MACROS.
//
// These tests go through the HTTP HANDLER, and that is the whole point rather
// than an incidental choice. The repository is not the buggy half: SaveEntry
// and SaveFood faithfully write whatever Macros they are handed. The loss
// happens one layer up, where `entryBody`/`foodBody`/`recipeItemBody` have no
// field for saturated_fat_g, sugar_g, added_sugar_g, sodium_mg or
// cholesterol_mg, so the handler hands the repository five nils that the
// ON CONFLICT ... SET clause then writes over real values.
//
// A test written against the repository directly would therefore PASS against
// the broken code — it would set the five itself, and never exercise the
// decode step that drops them. That is the "verify that a check can fail"
// trap in its most inviting form here, so: httptest, a real body, a real
// decode.
//
// This is the FOURTH instance of the `exercise.updateWithin` class CLAUDE.md
// records (load_mode, implements, note). See the ticket, #1027.

// putEntry drives Handler.SaveEntry with a raw JSON body, so a test can OMIT a
// key rather than send its zero value — the distinction the whole ticket turns
// on, and one no typed struct in this package can express.
func putEntry(t *testing.T, h *Handler, userID, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPut, "/v1/nutrition/entries/"+id, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.SetPathValue("id", id)
	r = r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: userID}))
	w := httptest.NewRecorder()
	h.SaveEntry(w, r)
	return w
}

func putFood(t *testing.T, h *Handler, userID, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPut, "/v1/nutrition/foods/"+id, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.SetPathValue("id", id)
	r = r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: userID}))
	w := httptest.NewRecorder()
	h.SaveFood(w, r)
	return w
}

// labelMacros reads the five straight out of the column, not out of the
// response body. The response is assembled by the same handler under test, so
// believing it would be asking the accused for an alibi.
func labelMacros(t *testing.T, repo *PostgresRepository, table, where, id string) [5]*float64 {
	t.Helper()
	var out [5]*float64
	err := repo.pool.QueryRow(context.Background(),
		`SELECT saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg
		   FROM `+table+` WHERE `+where+` = $1`, id).
		Scan(&out[0], &out[1], &out[2], &out[3], &out[4])
	if err != nil {
		t.Fatalf("read back %s %s: %v", table, id, err)
	}
	return out
}

var labelNames = [5]string{"saturated_fat_g", "sugar_g", "added_sugar_g", "sodium_mg", "cholesterol_mg"}

func wantLabelMacros(t *testing.T, got [5]*float64, want [5]float64) {
	t.Helper()
	for i, w := range want {
		if got[i] == nil {
			t.Errorf("%s was BLANKED to NULL; want %v", labelNames[i], w)
			continue
		}
		if *got[i] != w {
			t.Errorf("%s = %v; want %v", labelNames[i], *got[i], w)
		}
	}
}

// The body a barcode scan produces: every label figure stated.
const scannedEntryBody = `{
	"eaten_on": "2026-09-09", "meal": "lunch", "name": "Scanned bar",
	"servings": 1, "serving_label": "1 bar",
	"kcal": 240, "protein_g": 9, "carb_g": 27, "fat_g": 11, "fibre_g": 3,
	"saturated_fat_g": 4.5, "sugar_g": 18, "added_sugar_g": 15,
	"sodium_mg": 210, "cholesterol_mg": 5
}`

// The body web sends for the SAME entry when the athlete fixes a typo in its
// name: `apps/web/src/lib/nutritionApi.ts`'s EntryInput has no field for any of
// the five, so they are absent from the wire, not null on it.
const renamedEntryBody = `{
	"eaten_on": "2026-09-09", "meal": "lunch", "name": "Scanned bar (peanut)",
	"servings": 1, "serving_label": "1 bar",
	"kcal": 240, "protein_g": 9, "carb_g": 27, "fat_g": 11, "fibre_g": 3
}`

func TestPutEntryKeepsLabelMacrosTheBodyDoesNotMention(t *testing.T) {
	repo := repoFor(t, uid)
	h := NewHandler(repo)

	if w := putEntry(t, h, uid, entryID, scannedEntryBody); w.Code != http.StatusOK {
		t.Fatalf("seed PUT: %d %s", w.Code, w.Body)
	}
	// The seed itself is an assertion: if the five never landed, the restore
	// test below would pass by measuring nothing.
	wantLabelMacros(t, labelMacros(t, repo, "nutrition_entries", "id", entryID),
		[5]float64{4.5, 18, 15, 210, 5})

	if w := putEntry(t, h, uid, entryID, renamedEntryBody); w.Code != http.StatusOK {
		t.Fatalf("rename PUT: %d %s", w.Code, w.Body)
	}
	wantLabelMacros(t, labelMacros(t, repo, "nutrition_entries", "id", entryID),
		[5]float64{4.5, 18, 15, 210, 5})
}

// The other half of the three-state contract, and the reason a plain
// `COALESCE($n, column)` is NOT enough here.
//
// The phone sends all five on EVERY entry push (apps/mobile/lib/foodLog.ts) and
// sends them as `number | null` — so an explicit null from that client is a
// STATEMENT ("nothing told us the sodium"), not an omission. If nil-on-the-wire
// meant "keep", a re-scan that corrected a figure to unknown could never clear
// it, and the row would keep showing a number no source stands behind. Absent
// and null have to stay distinguishable.
func TestPutEntryClearsLabelMacrosSentAsExplicitNull(t *testing.T) {
	repo := repoFor(t, uid)
	h := NewHandler(repo)

	if w := putEntry(t, h, uid, entryID, scannedEntryBody); w.Code != http.StatusOK {
		t.Fatalf("seed PUT: %d %s", w.Code, w.Body)
	}
	const clearing = `{
		"eaten_on": "2026-09-09", "meal": "lunch", "name": "Scanned bar",
		"servings": 1, "serving_label": "1 bar",
		"kcal": 240, "protein_g": 9, "carb_g": 27, "fat_g": 11, "fibre_g": 3,
		"saturated_fat_g": null, "sugar_g": null, "added_sugar_g": null,
		"sodium_mg": null, "cholesterol_mg": null
	}`
	if w := putEntry(t, h, uid, entryID, clearing); w.Code != http.StatusOK {
		t.Fatalf("clearing PUT: %d %s", w.Code, w.Body)
	}
	for i, v := range labelMacros(t, repo, "nutrition_entries", "id", entryID) {
		if v != nil {
			t.Errorf("%s = %v; an explicit null must CLEAR, not be ignored", labelNames[i], *v)
		}
	}
}

const scannedFoodBody = `{
	"kind": "food", "name": "Scanned bar", "brand": "Acme",
	"serving_label": "1 bar",
	"kcal": 240, "protein_g": 9, "carb_g": 27, "fat_g": 11, "fibre_g": 3,
	"saturated_fat_g": 4.5, "sugar_g": 18, "added_sugar_g": 15,
	"sodium_mg": 210, "cholesterol_mg": 5
}`

const renamedFoodBody = `{
	"kind": "food", "name": "Scanned bar (peanut)", "brand": "Acme",
	"serving_label": "1 bar",
	"kcal": 240, "protein_g": 9, "carb_g": 27, "fat_g": 11, "fibre_g": 3
}`

func TestPutFoodKeepsLabelMacrosTheBodyDoesNotMention(t *testing.T) {
	repo := repoFor(t, uid)
	h := NewHandler(repo)

	if w := putFood(t, h, uid, foodID, scannedFoodBody); w.Code != http.StatusOK {
		t.Fatalf("seed PUT: %d %s", w.Code, w.Body)
	}
	wantLabelMacros(t, labelMacros(t, repo, "nutrition_foods", "id", foodID),
		[5]float64{4.5, 18, 15, 210, 5})

	if w := putFood(t, h, uid, foodID, renamedFoodBody); w.Code != http.StatusOK {
		t.Fatalf("rename PUT: %d %s", w.Code, w.Body)
	}
	wantLabelMacros(t, labelMacros(t, repo, "nutrition_foods", "id", foodID),
		[5]float64{4.5, 18, 15, 210, 5})
}

// Recipe ITEMS are the third site, and they are deliberately NOT three-state.
//
// An item list has no stable identity to preserve against — the server replaces
// it wholesale (DELETE then INSERT inside one transaction), so "the value this
// item had before" is not a question that has an answer. What was broken here
// is simpler and needs no restore path: `recipeItemBody` had no field for the
// five, so figures the client DID send were dropped on the floor.
//
// And the loss compounds, which is why this is worth its own test: a recipe's
// own per-serving macros are DERIVED from its items (`Food.PerServing`), so
// five nil items make a parent recipe that reports "not stated" for every label
// figure its ingredients actually carry.
func TestPutRecipeStoresTheLabelMacrosItsItemsState(t *testing.T) {
	repo := repoFor(t, uid)
	h := NewHandler(repo)

	const recipeBody = `{
		"kind": "recipe", "name": "Two-bar shake", "serving_label": "1 shake",
		"yield_servings": 2,
		"kcal": 0, "protein_g": 0, "carb_g": 0, "fat_g": 0,
		"items": [{
			"name": "Scanned bar", "quantity": 2, "serving_label": "1 bar",
			"kcal": 240, "protein_g": 9, "carb_g": 27, "fat_g": 11, "fibre_g": 3,
			"saturated_fat_g": 4.5, "sugar_g": 18, "added_sugar_g": 15,
			"sodium_mg": 210, "cholesterol_mg": 5
		}]
	}`
	w := putFood(t, h, uid, recipeID, recipeBody)
	if w.Code != http.StatusOK {
		t.Fatalf("recipe PUT: %d %s", w.Code, w.Body)
	}

	// Keyed by (food_id, position) — this table has no id of its own.
	wantLabelMacros(t, labelMacros(t, repo, "nutrition_recipe_items", "food_id", recipeID),
		[5]float64{4.5, 18, 15, 210, 5})

	// And the consequence: two bars over two servings is one bar per serving,
	// so the derived recipe carries the bar's own figures unchanged.
	var got Food
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	per := got.PerServing()
	for i, v := range [5]*float64{
		per.SaturatedFatG, per.SugarG, per.AddedSugarG, per.SodiumMG, per.CholesterolMG,
	} {
		if v == nil {
			t.Errorf("derived %s is nil; the recipe lost what its ingredient stated", labelNames[i])
		}
	}
}

// The direction the "keep" rule would get wrong if a recipe were allowed to
// have one (F37) — and the only test that fails if SaveFood's `if derived`
// branch is deleted.
//
// Drop the one sodium-carrying ingredient out of a recipe and the derivation
// correctly reports that nothing states sodium any more. A recipe treated like
// a plain food would read that nil as "the client did not mention sodium" and
// hold on to the total from back when something did — a figure no ingredient
// stands behind, on a recipe that no longer contains the thing that produced it.
func TestEditingARecipeDownToItemsThatStateNothingClearsTheDerivedLabel(t *testing.T) {
	repo := repoFor(t, uid)
	h := NewHandler(repo)

	const withSalt = `{
		"kind": "recipe", "name": "Shake", "serving_label": "1 shake",
		"yield_servings": 1,
		"kcal": 0, "protein_g": 0, "carb_g": 0, "fat_g": 0,
		"items": [
			{"name": "Salted bar", "quantity": 1, "serving_label": "1 bar",
			 "kcal": 240, "protein_g": 9, "carb_g": 27, "fat_g": 11,
			 "saturated_fat_g": 4.5, "sugar_g": 18, "added_sugar_g": 15,
			 "sodium_mg": 210, "cholesterol_mg": 5},
			{"name": "Water", "quantity": 1, "serving_label": "1 cup",
			 "kcal": 0, "protein_g": 0, "carb_g": 0, "fat_g": 0}
		]
	}`
	if w := putFood(t, h, uid, recipeID, withSalt); w.Code != http.StatusOK {
		t.Fatalf("seed PUT: %d %s", w.Code, w.Body)
	}
	wantLabelMacros(t, labelMacros(t, repo, "nutrition_foods", "id", recipeID),
		[5]float64{4.5, 18, 15, 210, 5})

	// The athlete removes the bar. Water states nothing, so the recipe now
	// states nothing.
	const waterOnly = `{
		"kind": "recipe", "name": "Shake", "serving_label": "1 shake",
		"yield_servings": 1,
		"kcal": 0, "protein_g": 0, "carb_g": 0, "fat_g": 0,
		"items": [
			{"name": "Water", "quantity": 1, "serving_label": "1 cup",
			 "kcal": 0, "protein_g": 0, "carb_g": 0, "fat_g": 0}
		]
	}`
	if w := putFood(t, h, uid, recipeID, waterOnly); w.Code != http.StatusOK {
		t.Fatalf("edit PUT: %d %s", w.Code, w.Body)
	}
	for i, v := range labelMacros(t, repo, "nutrition_foods", "id", recipeID) {
		if v != nil {
			t.Errorf("derived %s = %v; no ingredient states it any more, so it must be NULL",
				labelNames[i], *v)
		}
	}
}
