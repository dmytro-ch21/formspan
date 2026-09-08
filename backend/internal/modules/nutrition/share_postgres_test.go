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
	"time"

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

// handle seeds a profile with a username, the way share/postgres_test.go's
// `person` does — this package's repoFor already deletes profiles on the way
// out, so no extra cleanup is registered here.
func handle(t *testing.T, pool *pgxpool.Pool, userID, username string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO profiles (user_id, username) VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET username = $2`, userID, username); err != nil {
		t.Fatalf("seed profile %s: %v", userID, err)
	}
}

// assertSharedBy is the one assertion N532/#963 adds per Copier: the copy
// says who it came from (resolved to the CURRENT handle) and when.
func assertSharedBy(t *testing.T, f Food, wantHandle string, notBefore time.Time) {
	t.Helper()
	if f.SharedAt == nil {
		t.Fatalf("%s: shared_at is nil — the copy does not say it was shared", f.Name)
	}
	if f.SharedAt.Before(notBefore.Add(-time.Second)) || f.SharedAt.After(time.Now().Add(time.Minute)) {
		t.Fatalf("%s: shared_at = %v, want about now (test started %v)", f.Name, *f.SharedAt, notBefore)
	}
	if f.SharedBy == nil || *f.SharedBy != wantHandle {
		t.Fatalf("%s: shared_by = %v, want %q", f.Name, f.SharedBy, wantHandle)
	}
	// Provenance is a SEPARATE fact from source: the copy is still the
	// receiver's own editable row.
	if f.Source != SourceUser {
		t.Fatalf("%s: source = %q, want user — provenance must not change what source means", f.Name, f.Source)
	}
}

// N532/#963: every Copier kind — a logged entry, a plain saved food, a saved
// recipe, and a whole day — records who shared it and when. One test rather
// than four, because the property is "the ONE insertFood every Copier ends
// with records it", and a per-Copier test would let a fifth Copier that
// bypasses insertFood ship untested; here a new kind gets added to the table.
func TestEveryCopierRecordsWhoSharedItAndWhen(t *testing.T) {
	pool := testPool(t)
	r := repoFor(t, "sh_pva", "sh_pvb")
	ctx := context.Background()
	handle(t, pool, "sh_pva", "alice_shares")
	started := time.Now()

	entry, err := r.SaveEntry(ctx, Entry{
		ID: "77777777-7777-4777-8777-777777777701", UserID: "sh_pva",
		EatenOn: "2026-09-01", Meal: MealLunch, Name: "Shared entry",
		Servings: 1, ServingLabel: "100 g", Macros: Macros{Kcal: 100, ProteinG: 10},
	})
	if err != nil {
		t.Fatalf("save entry: %v", err)
	}
	plain, err := r.SaveFood(ctx, Food{
		ID: "77777777-7777-4777-8777-777777777702", UserID: "sh_pva",
		Kind: KindFood, Name: "Shared plain food", ServingLabel: "1 egg",
		Macros: Macros{Kcal: 70, ProteinG: 6},
	})
	if err != nil {
		t.Fatalf("save plain: %v", err)
	}
	recipe, err := r.SaveFood(ctx, Food{
		ID: "77777777-7777-4777-8777-777777777703", UserID: "sh_pva",
		Kind: KindRecipe, Name: "Shared recipe", ServingLabel: "1 bowl", YieldServings: f(1),
		Items: []RecipeItem{{Name: "Rice", Quantity: 1, ServingLabel: "100 g", Macros: Macros{Kcal: 130}}},
	})
	if err != nil {
		t.Fatalf("save recipe: %v", err)
	}

	kinds := []struct {
		name string
		copy func(tx pgx.Tx) (string, bool, error)
	}{
		{"nutrition_entry", func(tx pgx.Tx) (string, bool, error) {
			return NewEntryCopier(pool).CopyTo(ctx, tx, entry.ID, "sh_pva", "sh_pvb")
		}},
		{"nutrition_food (plain)", func(tx pgx.Tx) (string, bool, error) {
			return NewFoodCopier(pool).CopyTo(ctx, tx, plain.ID, "sh_pva", "sh_pvb")
		}},
		{"nutrition_food (recipe)", func(tx pgx.Tx) (string, bool, error) {
			return NewFoodCopier(pool).CopyTo(ctx, tx, recipe.ID, "sh_pva", "sh_pvb")
		}},
		{"nutrition_day", func(tx pgx.Tx) (string, bool, error) {
			return NewDayCopier(pool).CopyTo(ctx, tx, "2026-09-01", "sh_pva", "sh_pvb")
		}},
	}
	for _, k := range kinds {
		newID, ok, err := withTx(t, pool, k.copy)
		if err != nil || !ok {
			t.Fatalf("%s: copy ok=%v err=%v", k.name, ok, err)
		}
		// Through GetFood AND ListFoods — the two reads a client actually
		// uses, and the two SELECTs foodCols has to agree with itself in.
		got, err := r.GetFood(ctx, "sh_pvb", newID)
		if err != nil {
			t.Fatalf("%s: receiver cannot read the copy: %v", k.name, err)
		}
		assertSharedBy(t, got, "alice_shares", started)
		listed, err := r.ListFoods(ctx, "sh_pvb", got.Name, 10)
		if err != nil || len(listed) == 0 {
			t.Fatalf("%s: list: %v %v", k.name, listed, err)
		}
		assertSharedBy(t, listed[0], "alice_shares", started)
	}

	// The SENDER's originals gained no provenance: sharing something is not
	// being shared something.
	mine, err := r.GetFood(ctx, "sh_pva", plain.ID)
	if err != nil || mine.SharedAt != nil || mine.SharedBy != nil {
		t.Fatalf("sender's own food acquired provenance: %+v %v", mine, err)
	}

	// The handle is resolved LIVE: rename the sharer and every copy follows,
	// which is the whole reason the user id is stored and not the handle.
	handle(t, pool, "sh_pva", "alice_renamed")
	after, err := r.ListFoods(ctx, "sh_pvb", "", 10)
	if err != nil || len(after) != 4 {
		t.Fatalf("receiver's list after rename: %d foods, %v", len(after), err)
	}
	for _, g := range after {
		if g.SharedBy == nil || *g.SharedBy != "alice_renamed" {
			t.Fatalf("%s: shared_by = %v after rename, want alice_renamed", g.Name, g.SharedBy)
		}
	}
}

// THE RESTORE PATH — the guard this repo has paid for three times on
// exercise.updateWithin and once on nutrition_foods.source. The receiver
// corrects the copy's macros through the ordinary client write, which never
// mentions provenance, and the provenance survives. A SaveFood that listed
// shared_at in its SET clause would pass every other test in this file and
// fail this one.
func TestEditingACopyKeepsWhoSharedIt(t *testing.T) {
	pool := testPool(t)
	r := repoFor(t, "sh_rpa", "sh_rpb")
	ctx := context.Background()
	handle(t, pool, "sh_rpa", "alice_rp")
	original, err := r.SaveFood(ctx, Food{
		ID: "77777777-7777-4777-8777-777777777711", UserID: "sh_rpa",
		Kind: KindFood, Name: "Oats", ServingLabel: "50 g", Macros: Macros{Kcal: 180},
	})
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	newID, ok, err := withTx(t, pool, func(tx pgx.Tx) (string, bool, error) {
		return NewFoodCopier(pool).CopyTo(ctx, tx, original.ID, "sh_rpa", "sh_rpb")
	})
	if err != nil || !ok {
		t.Fatalf("copy: ok=%v err=%v", ok, err)
	}
	copied, err := r.GetFood(ctx, "sh_rpb", newID)
	if err != nil {
		t.Fatalf("read copy: %v", err)
	}
	sharedAt := *copied.SharedAt

	// What a client PUT carries: the fields, no provenance at all.
	edited := Food{
		ID: newID, UserID: "sh_rpb", Kind: KindFood, Name: "Oats (corrected)",
		ServingLabel: "50 g", Macros: Macros{Kcal: 190},
	}
	saved, err := r.SaveFood(ctx, edited)
	if err != nil {
		t.Fatalf("edit copy: %v", err)
	}
	if saved.Kcal != 190 || saved.Name != "Oats (corrected)" {
		t.Fatalf("edit did not apply: %+v", saved)
	}
	assertSharedBy(t, saved, "alice_rp", sharedAt)
	if !saved.SharedAt.Equal(sharedAt) {
		t.Fatalf("shared_at moved on edit: %v -> %v", sharedAt, *saved.SharedAt)
	}
	// And a client cannot CLAIM provenance either: a food the athlete saves
	// themselves with the fields set on the struct is stored without any.
	claimed := "somebody"
	now := time.Now()
	own, err := r.SaveFood(ctx, Food{
		ID: "77777777-7777-4777-8777-777777777712", UserID: "sh_rpb",
		Kind: KindFood, Name: "My own", ServingLabel: "1", Macros: Macros{Kcal: 1},
		SharedBy: &claimed, SharedAt: &now,
	})
	if err != nil {
		t.Fatalf("save own: %v", err)
	}
	if own.SharedBy != nil || own.SharedAt != nil {
		t.Fatalf("a client write set provenance: %+v", own)
	}
}

// A sharer whose profile has no username (or no profile at all any more)
// still leaves a shared_at behind: the row says it was shared, just not by
// whom. The client keys presence on shared_at for exactly this case.
func TestACopyFromASharerWithoutAHandleStillSaysItWasShared(t *testing.T) {
	pool := testPool(t)
	r := repoFor(t, "sh_nha", "sh_nhb")
	ctx := context.Background()
	// No handle() call for sh_nha — no profiles row exists.
	original, err := r.SaveFood(ctx, Food{
		ID: "77777777-7777-4777-8777-777777777721", UserID: "sh_nha",
		Kind: KindFood, Name: "Anonymous oats", ServingLabel: "50 g", Macros: Macros{Kcal: 180},
	})
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	newID, ok, err := withTx(t, pool, func(tx pgx.Tx) (string, bool, error) {
		return NewFoodCopier(pool).CopyTo(ctx, tx, original.ID, "sh_nha", "sh_nhb")
	})
	if err != nil || !ok {
		t.Fatalf("copy: ok=%v err=%v", ok, err)
	}
	copied, err := r.GetFood(ctx, "sh_nhb", newID)
	if err != nil {
		t.Fatalf("read copy: %v", err)
	}
	if copied.SharedAt == nil {
		t.Fatalf("shared_at nil for a copy — a missing profile must not erase that it was shared")
	}
	if copied.SharedBy != nil {
		t.Fatalf("shared_by = %q with no profile to resolve it from", *copied.SharedBy)
	}
}

func TestFoodCopierDescribeMissingIsNotAnError(t *testing.T) {
	pool := testPool(t)
	c := NewFoodCopier(pool)
	if _, ok, err := c.Describe(context.Background(), "nonexistent", "sh_fdm"); err != nil || ok {
		t.Fatalf("describe: ok=%v err=%v, want false, nil", ok, err)
	}
}
