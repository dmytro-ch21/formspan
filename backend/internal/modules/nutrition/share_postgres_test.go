package nutrition

// Postgres integration tests for N116/#505's three Copiers.
//
// These test Describe/CopyTo DIRECTLY rather than only through the share
// package's Create/Accept round trip: CopyTo is where every real decision
// lives (what gets copied, what gets scaled, what gets excluded), and a test
// one level up that only asserts "accept produced A row" cannot tell a
// correct copy from a coincidentally-right one. The end-to-end round trip
// through share.Repository is covered separately in
// internal/modules/share/postgres_test.go, which is where the registry
// itself — and therefore the wiring in cmd/api/main.go — gets exercised.

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// withTx runs fn inside a real transaction and commits it, mirroring exactly
// what share.PostgresRepository.Accept does around every Copier.CopyTo — a
// CopyTo tested outside a transaction would not be testing the thing that
// actually runs.
func withTx(t *testing.T, pool *pgxpool.Pool, fn func(tx pgx.Tx) (string, bool, error)) (string, bool, error) {
	t.Helper()
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	id, ok, err := fn(tx)
	if err != nil {
		_ = tx.Rollback(context.Background())
		return id, ok, err
	}
	if cerr := tx.Commit(context.Background()); cerr != nil {
		t.Fatalf("commit: %v", cerr)
	}
	return id, ok, err
}

func TestEntryCopierDescribeIsScopedToTheOwner(t *testing.T) {
	pool := testPool(t)
	r := repoFor(t, "sh_ea", "sh_eb")
	entry, err := r.SaveEntry(context.Background(), Entry{
		ID: "44444444-4444-4444-8444-444444444401", UserID: "sh_ea",
		EatenOn: "2026-08-18", Meal: MealLunch, Name: "Chicken thigh",
		Servings: 1, ServingLabel: "100 g", Macros: Macros{Kcal: 210, ProteinG: 31},
	})
	if err != nil {
		t.Fatalf("save entry: %v", err)
	}

	c := NewEntryCopier(pool)
	if _, ok, err := c.Describe(context.Background(), "nonexistent-id", "sh_ea"); err != nil || ok {
		t.Fatalf("unknown id: ok=%v err=%v, want ok=false", ok, err)
	}
	// The OTHER user's id can never see it — this is the visibility test, and
	// it is the only one this module has: a personal log has no "shared"
	// state short of an actual accepted share.
	if _, ok, err := c.Describe(context.Background(), entry.ID, "sh_eb"); err != nil || ok {
		t.Fatalf("wrong owner: ok=%v err=%v, want ok=false", ok, err)
	}
	name, ok, err := c.Describe(context.Background(), entry.ID, "sh_ea")
	if err != nil || !ok || name != "Chicken thigh" {
		t.Fatalf("describe = %q, %v, %v; want \"Chicken thigh\", true, nil", name, ok, err)
	}
}

// The core of AC2 ("editing it must not change the sender's, and the sender
// editing theirs must not change the receiver's") plus the per-serving
// scaling an entry->food copy requires.
func TestEntryCopierCopyToScalesToOneServingAndIsIndependent(t *testing.T) {
	pool := testPool(t)
	r := repoFor(t, "sh_eca", "sh_ecb")
	// 1.5 servings logged — ABSOLUTE macros, i.e. already x1.5.
	entry, err := r.SaveEntry(context.Background(), Entry{
		ID: "44444444-4444-4444-8444-444444444402", UserID: "sh_eca",
		EatenOn: "2026-08-18", Meal: MealDinner, Name: "Protein shake",
		Servings: 1.5, ServingLabel: "1 scoop",
		Macros: Macros{Kcal: 300, ProteinG: 45, CarbG: 15, FatG: 6, FibreG: f(3)},
	})
	if err != nil {
		t.Fatalf("save entry: %v", err)
	}

	c := NewEntryCopier(pool)
	newID, ok, err := withTx(t, pool, func(tx pgx.Tx) (string, bool, error) {
		return c.CopyTo(context.Background(), tx, entry.ID, "sh_eca", "sh_ecb")
	})
	if err != nil || !ok {
		t.Fatalf("copy: ok=%v err=%v", ok, err)
	}
	if newID == entry.ID {
		t.Fatalf("the copy reused the sender's id")
	}

	copied, err := r.GetFood(context.Background(), "sh_ecb", newID)
	if err != nil {
		t.Fatalf("bob cannot read his copy: %v", err)
	}
	if copied.Kind != KindFood {
		t.Fatalf("copy kind = %q, want food", copied.Kind)
	}
	// PER SERVING: 300/1.5 = 200, 45/1.5 = 30, fibre 3/1.5 = 2.
	if copied.Kcal != 200 || copied.ProteinG != 30 || copied.CarbG != 10 || copied.FatG != 4 {
		t.Fatalf("copy is not scaled to one serving: %+v", copied.Macros)
	}
	if copied.FibreG == nil || *copied.FibreG != 2 {
		t.Fatalf("fibre not scaled: %+v", copied.FibreG)
	}

	// BIDIRECTIONAL independence. Alice's original entry is untouched by the
	// copy existing at all —
	stillOriginal, err := r.ListEntries(context.Background(), "sh_eca", "2026-08-01", "2026-08-31", 10)
	if err != nil || len(stillOriginal) != 1 || stillOriginal[0].Kcal != 300 {
		t.Fatalf("sender's entry changed: %+v %v", stillOriginal, err)
	}
	// — and Bob editing HIS copy must never reach back into Alice's entry.
	edited := copied
	edited.Kcal = 999
	edited.Name = "Bob's version"
	if _, err := r.SaveFood(context.Background(), edited); err != nil {
		t.Fatalf("bob edits his copy: %v", err)
	}
	stillOriginal2, err := r.ListEntries(context.Background(), "sh_eca", "2026-08-01", "2026-08-31", 10)
	if err != nil || len(stillOriginal2) != 1 || stillOriginal2[0].Kcal != 300 || stillOriginal2[0].Name != "Protein shake" {
		t.Fatalf("bob's edit reached alice's entry: %+v %v", stillOriginal2, err)
	}
}

// AC4: accepting a shared MEAL stores it as the recipient's own saved item —
// tested here at the storage layer, i.e. the recipe and every one of its
// items really land in nutrition_foods/nutrition_recipe_items owned by the
// recipient, editable independently of the sender's.
func TestFoodCopierCopyToDuplicatesARecipeAndIsIndependent(t *testing.T) {
	pool := testPool(t)
	r := repoFor(t, "sh_fca", "sh_fcb")
	recipe, err := r.SaveFood(context.Background(), Food{
		ID: "55555555-5555-4555-8555-555555555501", UserID: "sh_fca",
		Kind: KindRecipe, Name: "Protein shake", ServingLabel: "1 serving",
		YieldServings: f(1),
		Items: []RecipeItem{
			{Name: "Milk", Quantity: 1, ServingLabel: "250 ml", Macros: Macros{Kcal: 120, ProteinG: 8, CarbG: 12, FatG: 5}},
			{Name: "Protein powder", Quantity: 1, ServingLabel: "1 scoop", Macros: Macros{Kcal: 110, ProteinG: 24, CarbG: 2, FatG: 1}},
		},
	})
	if err != nil {
		t.Fatalf("save recipe: %v", err)
	}

	c := NewFoodCopier(pool)
	newID, ok, err := withTx(t, pool, func(tx pgx.Tx) (string, bool, error) {
		return c.CopyTo(context.Background(), tx, recipe.ID, "sh_fca", "sh_fcb")
	})
	if err != nil || !ok {
		t.Fatalf("copy: ok=%v err=%v", ok, err)
	}
	if newID == recipe.ID {
		t.Fatalf("the copy reused the sender's id")
	}

	copied, err := r.GetFood(context.Background(), "sh_fcb", newID)
	if err != nil {
		t.Fatalf("bob cannot read his copy: %v", err)
	}
	if copied.Kind != KindRecipe || len(copied.Items) != 2 {
		t.Fatalf("copy: %+v", copied)
	}
	if copied.Items[0].Name != "Milk" || copied.Items[1].Name != "Protein powder" {
		t.Fatalf("items lost their identity or order: %+v", copied.Items)
	}
	// Summed macros arrived too — this is "the arithmetic is visible" (N115)
	// surviving a copy, not just the ingredient list.
	if copied.Kcal != 230 || copied.ProteinG != 32 {
		t.Fatalf("copy lost its summed macros: %+v", copied.Macros)
	}

	// Independence, both directions: renaming alice's original must not reach
	// bob's copy, and bob editing his must not reach alice's.
	renamed := recipe
	renamed.Name = "Protein shake (v2)"
	renamed.Items = recipe.Items
	if _, err := r.SaveFood(context.Background(), renamed); err != nil {
		t.Fatalf("alice renames hers: %v", err)
	}
	stillBobs, err := r.GetFood(context.Background(), "sh_fcb", newID)
	if err != nil || stillBobs.Name != "Protein shake" {
		t.Fatalf("alice's rename reached bob's copy: %+v %v", stillBobs, err)
	}
	edited := copied
	edited.Name = "Bob's shake"
	edited.Items = copied.Items
	if _, err := r.SaveFood(context.Background(), edited); err != nil {
		t.Fatalf("bob edits his copy: %v", err)
	}
	stillAlices, err := r.GetFood(context.Background(), "sh_fca", recipe.ID)
	if err != nil || stillAlices.Name != "Protein shake (v2)" {
		t.Fatalf("bob's edit reached alice's original: %+v %v", stillAlices, err)
	}
}

// AC6's privacy boundary: a shared LOG carries what was eaten and nothing
// else. Built with a distinctive target and a distinctive body weight
// sitting right next to the entries it DOES read, so a version that
// accidentally joined either would show up as a wrong number rather than a
// coincidentally-right one.
func TestDayCopierExcludesTargetsAndBodyWeight(t *testing.T) {
	pool := testPool(t)
	r := repoFor(t, "sh_dpa", "sh_dpb")
	ctx := context.Background()
	const day = "2026-08-19"

	if _, err := r.SaveEntry(ctx, Entry{
		ID: "66666666-6666-4666-8666-666666666601", UserID: "sh_dpa",
		EatenOn: day, Meal: MealBreakfast, Name: "Oats", Servings: 1, ServingLabel: "100 g",
		Macros: Macros{Kcal: 150, ProteinG: 5, CarbG: 27, FatG: 3},
	}); err != nil {
		t.Fatalf("save entry 1: %v", err)
	}
	if _, err := r.SaveEntry(ctx, Entry{
		ID: "66666666-6666-4666-8666-666666666602", UserID: "sh_dpa",
		EatenOn: day, Meal: MealDinner, Name: "Salmon", Servings: 1, ServingLabel: "150 g",
		Macros: Macros{Kcal: 350, ProteinG: 34, CarbG: 0, FatG: 22},
	}); err != nil {
		t.Fatalf("save entry 2: %v", err)
	}
	// A wildly distinctive target — if this leaked into the copy in any form
	// (as a third recipe item, or folded into the totals), the assertions
	// below catch it by number.
	if _, err := r.SaveTarget(ctx, Target{
		UserID: "sh_dpa", EffectiveOn: day, Kcal: 7500, ProteinG: 450, CarbG: 1100, FatG: 380,
		Source: TargetManual,
	}); err != nil {
		t.Fatalf("save target: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO body_checkins (user_id, measured_on, weight_kg) VALUES ($1, $2, $3)`,
		"sh_dpa", day, 88.8); err != nil {
		t.Fatalf("save checkin: %v", err)
	}

	c := NewDayCopier(pool)
	newID, ok, err := withTx(t, pool, func(tx pgx.Tx) (string, bool, error) {
		return c.CopyTo(ctx, tx, day, "sh_dpa", "sh_dpb")
	})
	if err != nil || !ok {
		t.Fatalf("copy: ok=%v err=%v", ok, err)
	}

	copied, err := r.GetFood(ctx, "sh_dpb", newID)
	if err != nil {
		t.Fatalf("bob cannot read his copy: %v", err)
	}
	if len(copied.Items) != 2 {
		t.Fatalf("got %d items, want exactly the 2 entries — a leaked target or checkin would add a third", len(copied.Items))
	}
	// 150+350 = 500 kcal, 5+34 = 39 g protein. Nowhere near the target's 9999.
	if copied.Kcal != 500 || copied.ProteinG != 39 {
		t.Fatalf("totals = %+v, want exactly the two entries summed (target must not have contributed)", copied.Macros)
	}

	// Bob's own rows are untouched: nothing was inserted into HIS targets or
	// checkins as a side effect of accepting a food log.
	var bobTargets, bobCheckins int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM nutrition_targets WHERE user_id = $1`, "sh_dpb").Scan(&bobTargets)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM body_checkins WHERE user_id = $1`, "sh_dpb").Scan(&bobCheckins)
	if bobTargets != 0 {
		t.Fatalf("bob acquired %d targets from accepting a food log", bobTargets)
	}
	if bobCheckins != 0 {
		t.Fatalf("bob acquired %d body checkins from accepting a food log", bobCheckins)
	}
}

func TestDayCopierDescribeAndCopyOnAnEmptyDayAreBothNotFound(t *testing.T) {
	pool := testPool(t)
	_ = repoFor(t, "sh_dea", "sh_deb")
	c := NewDayCopier(pool)

	if _, ok, err := c.Describe(context.Background(), "2026-01-01", "sh_dea"); err != nil || ok {
		t.Fatalf("describe empty day: ok=%v err=%v, want false", ok, err)
	}
	_, ok, err := withTx(t, pool, func(tx pgx.Tx) (string, bool, error) {
		return c.CopyTo(context.Background(), tx, "2026-01-01", "sh_dea", "sh_deb")
	})
	if err != nil || ok {
		t.Fatalf("copy empty day: ok=%v err=%v, want false", ok, err)
	}
}

func TestFoodCopierDescribeMissingIsNotAnError(t *testing.T) {
	pool := testPool(t)
	c := NewFoodCopier(pool)
	if _, ok, err := c.Describe(context.Background(), "nonexistent", "sh_fdm"); err != nil || ok {
		t.Fatalf("describe: ok=%v err=%v, want false, nil", ok, err)
	}
}
