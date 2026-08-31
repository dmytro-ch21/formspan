package nutrition

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered BEFORE any cleanup that still needs the pool. t.Cleanup runs
	// LIFO and strictly after every defer in the function, so a
	// `defer pool.Close()` here would close the pool out from under the deletes
	// registered below it.
	t.Cleanup(pool.Close)
	return pool
}

// repoFor cleans up in FK order: entries and recipe items reference foods, and
// bjj details reference sessions, so the children go first.
func repoFor(t *testing.T, userIDs ...string) *PostgresRepository {
	t.Helper()
	pool := testPool(t)
	t.Cleanup(func() {
		ctx := context.Background()
		for _, u := range userIDs {
			_, _ = pool.Exec(ctx, `DELETE FROM nutrition_entries WHERE user_id = $1`, u)
			_, _ = pool.Exec(ctx, `DELETE FROM nutrition_recipe_items
				WHERE food_id IN (SELECT id FROM nutrition_foods WHERE user_id = $1)`, u)
			_, _ = pool.Exec(ctx, `DELETE FROM nutrition_foods WHERE user_id = $1`, u)
			_, _ = pool.Exec(ctx, `DELETE FROM nutrition_targets WHERE user_id = $1`, u)
			_, _ = pool.Exec(ctx, `DELETE FROM bjj_session_details WHERE user_id = $1`, u)
			_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, u)
			_, _ = pool.Exec(ctx, `DELETE FROM body_checkins WHERE user_id = $1`, u)
			_, _ = pool.Exec(ctx, `DELETE FROM body_phases WHERE user_id = $1`, u)
			_, _ = pool.Exec(ctx, `DELETE FROM profiles WHERE user_id = $1`, u)
		}
	})
	return NewPostgresRepository(pool)
}

const (
	uid   = "nutri_test_user"
	other = "nutri_test_other"

	// Fixed UUIDs so a test reads as a story rather than as plumbing.
	foodID   = "11111111-1111-4111-8111-111111111111"
	entryID  = "22222222-2222-4222-8222-222222222222"
	recipeID = "33333333-3333-4333-8333-333333333333"
)

func ctx() context.Context { return context.Background() }

func aFood(id, name string, kcal float64) Food {
	return Food{
		ID: id, UserID: uid, Kind: KindFood, Name: name,
		ServingLabel: "100 g", ServingGrams: f(100),
		Macros: Macros{Kcal: kcal, ProteinG: 25, CarbG: 0, FatG: 8},
		Source: SourceUser,
	}
}

func anEntry(id string, from Food, servings float64) Entry {
	return Entry{
		ID: id, UserID: uid, EatenOn: "2026-08-18", Meal: MealLunch,
		Name: from.Name, Servings: servings, ServingLabel: from.ServingLabel,
		Macros: Macros{
			Kcal: from.Kcal * servings, ProteinG: from.ProteinG * servings,
			CarbG: from.CarbG * servings, FatG: from.FatG * servings,
		},
		SourceFoodID: &from.ID,
	}
}

// THE RULE THIS MODULE EXISTS TO PROTECT.
//
// If any query that returns nutrition ever follows source_food_id, this is the
// test that catches it — and it is the ONLY thing that would. The damage is
// otherwise invisible: correcting a food silently rewrites every entry logged
// from it, along with every average and trend an athlete was reading, and there
// is nothing left to compare against so nothing goes red.
func TestEditingAFoodDoesNotRewriteWhatYouAlreadyAte(t *testing.T) {
	r := repoFor(t, uid)

	food, err := r.SaveFood(ctx(), aFood(foodID, "Chicken thigh", 180))
	if err != nil {
		t.Fatalf("save food: %v", err)
	}
	logged, err := r.SaveEntry(ctx(), anEntry(entryID, food, 1.5))
	if err != nil {
		t.Fatalf("save entry: %v", err)
	}
	wantKcal := logged.Kcal
	wantProtein := logged.ProteinG

	// The athlete corrects the food a month later.
	corrected := aFood(foodID, "Chicken thigh", 210)
	corrected.ProteinG = 31
	if _, err := r.SaveFood(ctx(), corrected); err != nil {
		t.Fatalf("correct food: %v", err)
	}

	back, err := r.ListEntries(ctx(), uid, "2026-08-01", "2026-08-31", 100)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(back) != 1 {
		t.Fatalf("got %d entries", len(back))
	}
	if back[0].Kcal != wantKcal || back[0].ProteinG != wantProtein {
		t.Fatalf("correcting the food rewrote history: entry was %.1f kcal / %.1f g protein, now reads "+
			"%.1f / %.1f. A query is following source_food_id — see the package doc.",
			wantKcal, wantProtein, back[0].Kcal, back[0].ProteinG)
	}
	// And the provenance link itself must survive, or "log this again" breaks.
	if back[0].SourceFoodID == nil || *back[0].SourceFoodID != foodID {
		t.Fatalf("source_food_id was lost: %v", back[0].SourceFoodID)
	}
}

// Deleting a favourite must not change what the log says you ate either — the
// FK is ON DELETE SET NULL, so the numbers stay and only the provenance goes.
func TestDeletingAFoodLeavesTheEntryIntact(t *testing.T) {
	r := repoFor(t, uid)
	food, _ := r.SaveFood(ctx(), aFood(foodID, "Chicken thigh", 180))
	logged, _ := r.SaveEntry(ctx(), anEntry(entryID, food, 2))

	if err := r.DeleteFood(ctx(), uid, foodID); err != nil {
		t.Fatalf("delete food: %v", err)
	}
	back, _ := r.ListEntries(ctx(), uid, "2026-08-01", "2026-08-31", 100)
	if len(back) != 1 {
		t.Fatalf("the entry went with the food: %d rows", len(back))
	}
	if back[0].Kcal != logged.Kcal {
		t.Fatalf("kcal changed from %.1f to %.1f", logged.Kcal, back[0].Kcal)
	}
	if back[0].SourceFoodID != nil {
		t.Fatalf("source_food_id should be NULL after the food is gone, got %v", *back[0].SourceFoodID)
	}
}

// THE CROSS-USER BUG THIS CODEBASE HAS ALREADY SHIPPED TWICE.
//
// A client-generated primary key is exactly what re-opens it: without the
// `WHERE user_id` inside the ON CONFLICT, guessing a UUID overwrites somebody
// else's row, and with user_id in the SET list it takes ownership of it.
//
// TWO USERS IS THE WHOLE POINT — a single-user test passes against the bug.
func TestAForeignUUIDIsNotFoundAndWritesNothing(t *testing.T) {
	r := repoFor(t, uid, other)

	food, _ := r.SaveFood(ctx(), aFood(foodID, "Chicken thigh", 180))
	mine, err := r.SaveEntry(ctx(), anEntry(entryID, food, 1))
	if err != nil {
		t.Fatalf("save: %v", err)
	}

	// The other athlete pushes an entry with the same id.
	//
	// The values stay INSIDE every range check on purpose: a fixture that trips
	// a CHECK constraint gets rejected before the ownership predicate is ever
	// reached, so the test would pass without proving anything about it. The
	// first draft used 99 servings, which multiplied protein to 2475 g and did
	// exactly that.
	theirs := anEntry(entryID, food, 1)
	theirs.UserID = other
	theirs.Name = "Overwritten"
	theirs.SourceFoodID = nil // their food, not ours
	theirs.Macros = Macros{Kcal: 1234, ProteinG: 5, CarbG: 5, FatG: 5}

	_, err = r.SaveEntry(ctx(), theirs)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("writing to another athlete's entry returned %v, want ErrNotFound "+
			"(and it must be 404, never 403 — a 403 confirms the row exists to somebody guessing UUIDs)", err)
	}

	back, _ := r.ListEntries(ctx(), uid, "2026-08-01", "2026-08-31", 100)
	if len(back) != 1 {
		t.Fatalf("got %d entries", len(back))
	}
	if back[0].Name != mine.Name || back[0].Kcal != mine.Kcal {
		t.Fatalf("the row was overwritten: %q %.0f kcal", back[0].Name, back[0].Kcal)
	}
	if back[0].UserID != uid {
		t.Fatalf("ownership was taken: user_id is now %q", back[0].UserID)
	}
}

func TestAForeignFoodIsNotFoundAndWritesNothing(t *testing.T) {
	r := repoFor(t, uid, other)
	mine, _ := r.SaveFood(ctx(), aFood(foodID, "Chicken thigh", 180))

	theirs := aFood(foodID, "Overwritten", 9999)
	theirs.UserID = other
	if _, err := r.SaveFood(ctx(), theirs); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
	back, err := r.GetFood(ctx(), uid, foodID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if back.Name != mine.Name || back.Kcal != mine.Kcal {
		t.Fatalf("overwritten: %q %.0f", back.Name, back.Kcal)
	}
}

// Provenance cannot point at somebody else's food, and — the part that matters
// — a foreign id and a nonexistent one produce the SAME answer.
//
// A plain single-column FK succeeds for a foreign id and errors for a
// nonexistent one, which turns the column into an oracle for "does any athlete
// have this food id". The FK is composite on (user_id, source_food_id) for that
// reason. Raised in review.
func TestProvenanceCannotNameAnotherAthletesFood(t *testing.T) {
	r := repoFor(t, uid, other)

	theirs := aFood(foodID, "Theirs", 180)
	theirs.UserID = other
	if _, err := r.SaveFood(ctx(), theirs); err != nil {
		t.Fatalf("save theirs: %v", err)
	}

	foreign := anEntry(entryID, theirs, 1)
	foreign.UserID = uid // my entry, pointing at their food
	_, errForeign := r.SaveEntry(ctx(), foreign)

	nonexistent := anEntry(entryID, theirs, 1)
	nonexistent.UserID = uid
	missing := "99999999-9999-4999-8999-999999999999"
	nonexistent.SourceFoodID = &missing
	_, errMissing := r.SaveEntry(ctx(), nonexistent)

	if errForeign == nil {
		t.Fatal("stored provenance pointing at another athlete's food")
	}
	if errMissing == nil {
		t.Fatal("stored provenance pointing at a food that does not exist")
	}
	if errForeign.Error() != errMissing.Error() {
		t.Fatalf("the two cases are distinguishable, which makes the column an "+
			"existence oracle:\n  foreign:     %v\n  nonexistent: %v", errForeign, errMissing)
	}
}

// Deleting a food nulls ONLY the provenance column. The unqualified SET NULL
// form nulls every referencing column, and user_id is NOT NULL — which would
// fail at delete time rather than at migration time.
func TestDeletingAFoodNullsOnlyTheProvenanceColumn(t *testing.T) {
	r := repoFor(t, uid)
	food, _ := r.SaveFood(ctx(), aFood(foodID, "Chicken thigh", 180))
	if _, err := r.SaveEntry(ctx(), anEntry(entryID, food, 2)); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := r.DeleteFood(ctx(), uid, foodID); err != nil {
		t.Fatalf("delete food: %v", err)
	}
	back, err := r.ListEntries(ctx(), uid, "2026-08-01", "2026-08-31", 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(back) != 1 {
		t.Fatalf("got %d entries", len(back))
	}
	if back[0].UserID != uid {
		t.Fatalf("user_id was nulled to %q", back[0].UserID)
	}
	if back[0].SourceFoodID != nil {
		t.Fatalf("provenance survived the delete: %v", *back[0].SourceFoodID)
	}
}

// Idempotent, because an outbox retries. A second delete recording a permanent
// failure would leave a correctly-gone row stuck on the athlete's sync screen.
func TestDeletingTwiceIsNotAnError(t *testing.T) {
	r := repoFor(t, uid)
	food, _ := r.SaveFood(ctx(), aFood(foodID, "Chicken thigh", 180))
	if _, err := r.SaveEntry(ctx(), anEntry(entryID, food, 1)); err != nil {
		t.Fatalf("save: %v", err)
	}
	for i := 1; i <= 2; i++ {
		if err := r.DeleteEntry(ctx(), uid, entryID); err != nil {
			t.Fatalf("delete #%d: %v", i, err)
		}
	}
	// Deleting an id that never existed is also fine, and deliberately
	// indistinguishable from deleting somebody else's.
	if err := r.DeleteEntry(ctx(), uid, "44444444-4444-4444-8444-444444444444"); err != nil {
		t.Fatalf("delete unknown: %v", err)
	}
}

// A re-sent offline write is the same as sending it once: one row, updated.
func TestSaveEntryIsAnUpsertOnTheClientID(t *testing.T) {
	r := repoFor(t, uid)
	food, _ := r.SaveFood(ctx(), aFood(foodID, "Chicken thigh", 180))

	first, err := r.SaveEntry(ctx(), anEntry(entryID, food, 1))
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	edited := anEntry(entryID, food, 2)
	edited.Meal = MealDinner
	second, err := r.SaveEntry(ctx(), edited)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if first.ID != second.ID {
		t.Fatal("the id changed")
	}
	if second.Meal != MealDinner || second.Servings != 2 {
		t.Fatalf("not updated: meal %q servings %v", second.Meal, second.Servings)
	}
	back, _ := r.ListEntries(ctx(), uid, "2026-08-01", "2026-08-31", 100)
	if len(back) != 1 {
		t.Fatalf("upsert created %d rows", len(back))
	}
}

// Category is COPIED onto the entry (N124/N113), the same rule as every macro
// on this table — see the package doc's "a logged row owns its numbers" and
// Entry.Category's own comment. This is the entries-side mirror of
// TestEditingAFoodDoesNotRewriteWhatYouAlreadyAte above: correcting the food
// this entry was logged from must not repaint the glyph a device is already
// showing for it, because nothing here may re-derive category from a join.
func TestEntryCategoryIsCopiedAndSurvivesAnEditToTheFood(t *testing.T) {
	r := repoFor(t, uid)

	food, err := r.SaveFood(ctx(), aFood(foodID, "Chicken thigh", 180))
	if err != nil {
		t.Fatalf("save food: %v", err)
	}

	e := anEntry(entryID, food, 1)
	e.Category = strPtr("poultry")
	logged, err := r.SaveEntry(ctx(), e)
	if err != nil {
		t.Fatalf("save entry: %v", err)
	}
	if logged.Category == nil || *logged.Category != "poultry" {
		t.Fatalf("category %v after create, want \"poultry\" — the column exists but "+
			"the write or read drops it", logged.Category)
	}

	// Correct the food a month later — same shape as the sibling test. Category
	// has no relationship to `Food` at all in this schema (`nutrition_foods` has
	// no category column of its own), so this also proves the read is not
	// joining anywhere: there is nothing on the food side for it to follow.
	corrected := aFood(foodID, "Chicken thigh", 210)
	if _, err := r.SaveFood(ctx(), corrected); err != nil {
		t.Fatalf("correct food: %v", err)
	}

	back, err := r.ListEntries(ctx(), uid, "2026-08-01", "2026-08-31", 100)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(back) != 1 {
		t.Fatalf("got %d entries", len(back))
	}
	if back[0].Category == nil || *back[0].Category != "poultry" {
		t.Fatalf("category was %v after correcting the food, want unchanged \"poultry\"",
			back[0].Category)
	}

	// SAVE IT AGAIN with a changed category, exercising the ON CONFLICT DO
	// UPDATE path — mirroring TestLabelMacrosPersistThroughAnEntry's own note:
	// a single save only ever inserts, so the update half of the SET clause is
	// otherwise never covered, and that is exactly the class of bug this table
	// has shipped three times (see the module pattern's `updateWithin` note).
	e.Category = strPtr("red_meat")
	if _, err := r.SaveEntry(ctx(), e); err != nil {
		t.Fatalf("re-save entry: %v", err)
	}
	edited, err := r.ListEntries(ctx(), uid, "2026-08-01", "2026-08-31", 100)
	if err != nil {
		t.Fatalf("list after re-save: %v", err)
	}
	if len(edited) != 1 || edited[0].Category == nil || *edited[0].Category != "red_meat" {
		t.Fatalf("category after re-save = %v, want \"red_meat\" — missing from the "+
			"upsert's SET clause would silently keep the old value", edited)
	}

	// And a category-less entry — the ordinary case for a saved food or an AI
	// draft today — must read back null, never an empty string or a guess.
	noCategory := anEntry("44444444-4444-4444-8444-444444444444", food, 1)
	saved, err := r.SaveEntry(ctx(), noCategory)
	if err != nil {
		t.Fatalf("save entry with no category: %v", err)
	}
	if saved.Category != nil {
		t.Fatalf("category = %v for an entry that stated none — null became a guess", *saved.Category)
	}
}

func strPtr(s string) *string { return &s }

// THE CARRY-IN ROW. A target set three months ago means a week-long window
// contains no rows at all, and the client would then report "no target" for a
// week the athlete was very much eating to one — a bug that only appears for
// people who have NOT changed their target recently, which is to say the ones
// doing it right.
func TestListTargetsCarriesInTheOneLiveAtTheStartOfTheWindow(t *testing.T) {
	r := repoFor(t, uid)
	old := Target{UserID: uid, EffectiveOn: "2026-05-01", Kcal: 2400,
		ProteinG: 180, CarbG: 250, FatG: 70, Source: TargetDerived}
	if _, err := r.SaveTarget(ctx(), old); err != nil {
		t.Fatalf("save: %v", err)
	}

	got, err := r.ListTargets(ctx(), uid, "2026-08-01", "2026-08-31")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d targets, want the carry-in row — a window with no rows "+
			"of its own must still report what the athlete was eating to", len(got))
	}
	if got[0].EffectiveOn != "2026-05-01" || got[0].Kcal != 2400 {
		t.Fatalf("wrong row: %s %d kcal", got[0].EffectiveOn, got[0].Kcal)
	}
}

// The window must return its OWN rows as well as the carry-in.
//
// This is the case the carry-in test above cannot see: with no in-window rows,
// one row is the right answer whether the query is correct or not. Postgres
// binds an ORDER BY / LIMIT written after a UNION ALL to the WHOLE union, so
// the first version of this query returned exactly one row — the newest target
// overall — and silently dropped every target set inside the window. A month
// on web would have rendered one target and attributed it to every day.
func TestListTargetsReturnsInWindowRowsAsWellAsTheCarryIn(t *testing.T) {
	r := repoFor(t, uid)
	for _, tgt := range []Target{
		{UserID: uid, EffectiveOn: "2026-05-01", Kcal: 2400, ProteinG: 180, CarbG: 250, FatG: 70, Source: TargetDerived},
		{UserID: uid, EffectiveOn: "2026-08-05", Kcal: 2300, ProteinG: 180, CarbG: 230, FatG: 68, Source: TargetAdjustment},
		{UserID: uid, EffectiveOn: "2026-08-12", Kcal: 2200, ProteinG: 175, CarbG: 210, FatG: 66, Source: TargetAdjustment},
	} {
		if _, err := r.SaveTarget(ctx(), tgt); err != nil {
			t.Fatalf("save %s: %v", tgt.EffectiveOn, err)
		}
	}

	got, err := r.ListTargets(ctx(), uid, "2026-08-01", "2026-08-31")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var on []string
	for _, g := range got {
		on = append(on, g.EffectiveOn)
	}
	if len(got) != 3 {
		t.Fatalf("got %d targets (%v), want 3: both August rows plus the May carry-in", len(got), on)
	}
	// Newest first, and the carry-in last — a client reading these in order is
	// walking backwards through the athlete's history.
	for i, want := range []string{"2026-08-12", "2026-08-05", "2026-05-01"} {
		if got[i].EffectiveOn != want {
			t.Errorf("position %d is %s, want %s (order: %v)", i, got[i].EffectiveOn, want, on)
		}
	}
}

// Exactly one carry-in, never a second. Two targets before the window must not
// both ride along — the client only needs what was live at the start.
func TestListTargetsCarriesInAtMostOneRow(t *testing.T) {
	r := repoFor(t, uid)
	for _, on := range []string{"2026-03-01", "2026-04-01", "2026-05-01"} {
		if _, err := r.SaveTarget(ctx(), Target{UserID: uid, EffectiveOn: on,
			Kcal: 2400, ProteinG: 180, CarbG: 250, FatG: 70, Source: TargetDerived}); err != nil {
			t.Fatalf("save: %v", err)
		}
	}
	got, err := r.ListTargets(ctx(), uid, "2026-08-01", "2026-08-31")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d rows, want exactly 1 carry-in", len(got))
	}
	if got[0].EffectiveOn != "2026-05-01" {
		t.Fatalf("carried in %s, want the newest before the window (2026-05-01)", got[0].EffectiveOn)
	}
}

func TestTargetOnResolvesTheNewestOnOrBeforeTheDay(t *testing.T) {
	r := repoFor(t, uid)
	for _, tgt := range []Target{
		{UserID: uid, EffectiveOn: "2026-05-01", Kcal: 2400, ProteinG: 180, CarbG: 250, FatG: 70, Source: TargetDerived},
		{UserID: uid, EffectiveOn: "2026-08-10", Kcal: 2200, ProteinG: 180, CarbG: 200, FatG: 65, Source: TargetAdjustment},
	} {
		if _, err := r.SaveTarget(ctx(), tgt); err != nil {
			t.Fatalf("save: %v", err)
		}
	}
	for _, tc := range []struct {
		on   string
		want int
	}{
		{"2026-05-01", 2400},
		{"2026-08-09", 2400},
		{"2026-08-10", 2200},
		{"2026-12-25", 2200},
	} {
		got, err := r.TargetOn(ctx(), uid, tc.on)
		if err != nil {
			t.Fatalf("%s: %v", tc.on, err)
		}
		if got.Kcal != tc.want {
			t.Errorf("on %s got %d kcal, want %d", tc.on, got.Kcal, tc.want)
		}
	}
	if _, err := r.TargetOn(ctx(), uid, "2026-04-30"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("before any target: got %v, want ErrNotFound", err)
	}
}

// The basis is stored and comes back, because it IS the explanation — a target
// whose arithmetic was lost cannot be argued with.
func TestTargetBasisSurvivesARoundTrip(t *testing.T) {
	r := repoFor(t, uid)
	tgt := Target{
		UserID: uid, EffectiveOn: "2026-08-18", Kcal: 1950,
		ProteinG: 175, CarbG: 130, FatG: 65, Source: TargetDerived,
		Basis: &Basis{RMRKcal: 1780, TDEEKcal: 2614, PhaseKind: PhaseCut, ActivityFactor: 1.30},
	}
	if _, err := r.SaveTarget(ctx(), tgt); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := r.TargetOn(ctx(), uid, "2026-08-18")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if got.Basis == nil {
		t.Fatal("the basis was lost")
	}
	if got.Basis.RMRKcal != 1780 || got.Basis.TDEEKcal != 2614 || got.Basis.PhaseKind != PhaseCut {
		t.Fatalf("basis came back wrong: %+v", *got.Basis)
	}
}

// A recipe's per-serving macros are DERIVED at write time and stored, so the
// picker never joins. This checks the arithmetic survives the round trip.
func TestARecipeStoresItsPerServingMacros(t *testing.T) {
	r := repoFor(t, uid)
	recipe := Food{
		ID: recipeID, UserID: uid, Kind: KindRecipe, Name: "Chilli",
		ServingLabel: "1 portion", YieldServings: f(4), Source: SourceUser,
		Items: []RecipeItem{
			{Name: "Beef mince", Quantity: 5, ServingLabel: "100 g",
				Macros: Macros{Kcal: 250, ProteinG: 26, CarbG: 0, FatG: 15}},
			{Name: "Kidney beans", Quantity: 2, ServingLabel: "1 tin",
				Macros: Macros{Kcal: 300, ProteinG: 20, CarbG: 45, FatG: 1, FibreG: f(18)}},
		},
	}
	saved, err := r.SaveFood(ctx(), recipe)
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	// (250*5 + 300*2) / 4 = 462.5 kcal per portion.
	if saved.Kcal != 462.5 {
		t.Errorf("kcal %.2f, want 462.5", saved.Kcal)
	}
	// (26*5 + 20*2) / 4 = 42.5 g protein.
	if saved.ProteinG != 42.5 {
		t.Errorf("protein %.2f, want 42.5", saved.ProteinG)
	}
	// Only one item states fibre: (18*2)/4 = 9.
	if saved.FibreG == nil || *saved.FibreG != 9 {
		t.Errorf("fibre %v, want 9", saved.FibreG)
	}

	back, err := r.GetFood(ctx(), uid, recipeID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(back.Items) != 2 {
		t.Fatalf("got %d items", len(back.Items))
	}
	if back.Items[0].Name != "Beef mince" {
		t.Errorf("items came back out of order: %q first", back.Items[0].Name)
	}
	if back.Kcal != 462.5 {
		t.Errorf("stored kcal %.2f", back.Kcal)
	}
}

// Editing a recipe replaces its items wholesale rather than accumulating them.
func TestSavingARecipeReplacesItsItems(t *testing.T) {
	r := repoFor(t, uid)
	recipe := Food{
		ID: recipeID, UserID: uid, Kind: KindRecipe, Name: "Chilli",
		ServingLabel: "1 portion", YieldServings: f(2), Source: SourceUser,
		Items: []RecipeItem{
			{Name: "A", Quantity: 1, ServingLabel: "1", Macros: Macros{Kcal: 100}},
			{Name: "B", Quantity: 1, ServingLabel: "1", Macros: Macros{Kcal: 100}},
		},
	}
	if _, err := r.SaveFood(ctx(), recipe); err != nil {
		t.Fatalf("first: %v", err)
	}
	recipe.Items = []RecipeItem{{Name: "C", Quantity: 1, ServingLabel: "1", Macros: Macros{Kcal: 50}}}
	if _, err := r.SaveFood(ctx(), recipe); err != nil {
		t.Fatalf("second: %v", err)
	}
	back, _ := r.GetFood(ctx(), uid, recipeID)
	if len(back.Items) != 1 || back.Items[0].Name != "C" {
		t.Fatalf("items accumulated instead of being replaced: %+v", back.Items)
	}
	if back.Kcal != 25 {
		t.Errorf("per-serving kcal %.2f, want 25 — it was not recomputed from the new items", back.Kcal)
	}
}

// DayTotals pairs each day with the target that was live THAT day, not with one
// figure for the window. A target changed mid-window otherwise misattributes
// every day before it.
func TestDayTotalsUsesTheTargetLiveOnEachDay(t *testing.T) {
	r := repoFor(t, uid)
	for _, tgt := range []Target{
		{UserID: uid, EffectiveOn: "2026-08-01", Kcal: 2400, ProteinG: 180, CarbG: 250, FatG: 70, Source: TargetDerived},
		{UserID: uid, EffectiveOn: "2026-08-18", Kcal: 2100, ProteinG: 175, CarbG: 200, FatG: 65, Source: TargetAdjustment},
	} {
		if _, err := r.SaveTarget(ctx(), tgt); err != nil {
			t.Fatalf("target: %v", err)
		}
	}
	food, _ := r.SaveFood(ctx(), aFood(foodID, "Chicken thigh", 180))
	for i, day := range []string{"2026-08-17", "2026-08-18"} {
		e := anEntry([]string{entryID, "55555555-5555-4555-8555-555555555555"}[i], food, 2)
		e.EatenOn = day
		if _, err := r.SaveEntry(ctx(), e); err != nil {
			t.Fatalf("entry: %v", err)
		}
	}

	days, err := r.DayTotals(ctx(), uid, "2026-08-01", "2026-08-31")
	if err != nil {
		t.Fatalf("totals: %v", err)
	}
	if len(days) != 2 {
		t.Fatalf("got %d days", len(days))
	}
	if days[0].TargetKcal == nil || *days[0].TargetKcal != 2400 {
		t.Errorf("17th got target %v, want 2400", days[0].TargetKcal)
	}
	if days[1].TargetKcal == nil || *days[1].TargetKcal != 2100 {
		t.Errorf("18th got target %v, want 2100 — the target is not resolved per day", days[1].TargetKcal)
	}
	if days[0].Kcal != 360 || days[0].Entries != 1 {
		t.Errorf("17th summed to %.0f kcal over %d entries", days[0].Kcal, days[0].Entries)
	}
}

// TargetInputs reaches into profiles, body_checkins, body_phases and sessions.
// Go does not type-check SQL, so this is the only thing that proves those
// queries run at all — an earlier draft filtered on a `warmup` column that does
// not exist and compiled perfectly.
//
// **The fixture is a BJJ session, deliberately.** session_sets.exercise_id is a
// NO ACTION foreign key into `exercises`, so a strength fixture would have to
// seed catalog rows — and borrowing catalog ids without owning them is the trap
// CLAUDE.md documents at length. A BJJ session plus its details row has no
// catalog dependency at all.
func TestTargetInputsReadsProfileWeightPhaseAndTraining(t *testing.T) {
	r := repoFor(t, uid)
	pool := testPool(t)

	mustExec(t, pool, `INSERT INTO profiles (user_id, date_of_birth, sex, height_cm)
		VALUES ($1, '1996-08-17', 'male', 180)`, uid)
	mustExec(t, pool, `INSERT INTO body_checkins (user_id, measured_on, weight_kg)
		VALUES ($1, '2026-08-10', 82.4), ($1, '2026-08-17', 81.9)`, uid)
	mustExec(t, pool, `INSERT INTO body_phases (id, user_id, kind, started_on, target_on, target_weight_kg)
		VALUES ('66666666-6666-4666-8666-666666666666', $1, 'making_weight', '2026-07-01', '2026-09-15', 77.1)`, uid)
	mustExec(t, pool, `INSERT INTO sessions (id, user_id, sport, name, started_at, ended_at)
		VALUES ('sess_nutri_1', $1, 'bjj', 'Evening class',
		        '2026-08-16 18:00:00+00', '2026-08-16 19:30:00+00')`, uid)
	mustExec(t, pool, `INSERT INTO bjj_session_details (session_id, user_id, kind, rounds, round_minutes)
		VALUES ('sess_nutri_1', $1, 'gi', 5, 6)`, uid)

	in, err := r.TargetInputs(ctx(), uid, "2026-08-18")
	if err != nil {
		t.Fatalf("target inputs: %v", err)
	}

	// The weight is the latest ON OR BEFORE the day, which makes re-deriving an
	// old target reproducible rather than quietly using today's body.
	if in.WeightKG == nil || *in.WeightKG != 81.9 {
		t.Errorf("weight %v, want 81.9", in.WeightKG)
	}
	if in.WeightMeasuredOn != "2026-08-17" {
		t.Errorf("measured_on %q", in.WeightMeasuredOn)
	}
	if in.HeightCM == nil || *in.HeightCM != 180 {
		t.Errorf("height %v", in.HeightCM)
	}
	if in.Sex == nil || *in.Sex != "male" {
		t.Errorf("sex %v", in.Sex)
	}
	if in.PhaseKind != PhaseMakingWeight {
		t.Errorf("phase %q, want making_weight", in.PhaseKind)
	}
	if in.PhaseTargetWeightKG == nil || *in.PhaseTargetWeightKG != 77.1 {
		t.Errorf("phase target weight %v", in.PhaseTargetWeightKG)
	}
	if in.TrainingSessions != 1 {
		t.Errorf("training sessions %d, want 1", in.TrainingSessions)
	}
	if in.TrainingKcalPerDay <= 0 {
		t.Errorf("training kcal/day %v — a 90-minute BJJ session should cost something", in.TrainingKcalPerDay)
	}
	if in.TrainingDaysCovered != TrainingWindowDays {
		t.Errorf("days covered %d, want %d", in.TrainingDaysCovered, TrainingWindowDays)
	}
}

// An older weigh-in must not be picked up when a newer one exists, and a weight
// recorded AFTER the day being derived for must not leak backwards.
func TestTargetInputsIgnoresWeightsAfterTheDay(t *testing.T) {
	r := repoFor(t, uid)
	pool := testPool(t)
	mustExec(t, pool, `INSERT INTO profiles (user_id, date_of_birth, sex, height_cm)
		VALUES ($1, '1996-08-17', 'male', 180)`, uid)
	mustExec(t, pool, `INSERT INTO body_checkins (user_id, measured_on, weight_kg)
		VALUES ($1, '2026-08-10', 82.4), ($1, '2026-08-25', 79.0)`, uid)

	in, err := r.TargetInputs(ctx(), uid, "2026-08-18")
	if err != nil {
		t.Fatalf("inputs: %v", err)
	}
	if in.WeightKG == nil || *in.WeightKG != 82.4 {
		t.Fatalf("weight %v, want 82.4 — a check-in from a week in the future was used", in.WeightKG)
	}
}

// No profile at all is a legitimate state for a brand-new athlete asking what
// they should eat, not an error.
func TestTargetInputsWithNoProfileIsNotAnError(t *testing.T) {
	r := repoFor(t, uid)
	in, err := r.TargetInputs(ctx(), uid, "2026-08-18")
	if err != nil {
		t.Fatalf("no profile should not error: %v", err)
	}
	if in.WeightKG != nil {
		t.Errorf("weight %v out of nowhere", in.WeightKG)
	}
}

// Foods are scoped and searchable. The ILIKE is over lower(name), which is the
// indexed expression — a search that bypassed it would still pass this test,
// but the query shape is pinned by it running at all.
func TestListFoodsIsScopedAndSearchable(t *testing.T) {
	r := repoFor(t, uid, other)
	if _, err := r.SaveFood(ctx(), aFood(foodID, "Chicken thigh", 180)); err != nil {
		t.Fatalf("save: %v", err)
	}
	mine2 := aFood("77777777-7777-4777-8777-777777777777", "Greek yoghurt", 60)
	if _, err := r.SaveFood(ctx(), mine2); err != nil {
		t.Fatalf("save: %v", err)
	}
	theirs := aFood("88888888-8888-4888-8888-888888888888", "Chicken breast", 165)
	theirs.UserID = other
	if _, err := r.SaveFood(ctx(), theirs); err != nil {
		t.Fatalf("save theirs: %v", err)
	}

	all, err := r.ListFoods(ctx(), uid, "", 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("got %d foods, want 2 — another athlete's rows are visible", len(all))
	}
	hits, err := r.ListFoods(ctx(), uid, "CHICK", 50)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 1 || hits[0].Name != "Chicken thigh" {
		t.Fatalf("search returned %+v", hits)
	}
}

// The athlete's own text is not a LIKE pattern.
//
// Without escaping, searching for "100%" matches everything and
// "protein_shake" matches "protein-shake" — which reads as broken search
// rather than as an escaping bug, so nobody reports it as one. Raised in
// review.
func TestSearchDoesNotTreatTheQueryAsAPattern(t *testing.T) {
	r := repoFor(t, uid)
	for id, name := range map[string]string{
		"aaaaaaaa-1111-4111-8111-111111111111": "Milk 100% whole",
		"bbbbbbbb-1111-4111-8111-111111111111": "Chicken thigh",
		"cccccccc-1111-4111-8111-111111111111": "protein_shake",
		"dddddddd-1111-4111-8111-111111111111": "protein-shake",
	} {
		if _, err := r.SaveFood(ctx(), aFood(id, name, 100)); err != nil {
			t.Fatalf("save %q: %v", name, err)
		}
	}

	for _, tc := range []struct {
		q     string
		want  int
		notes string
	}{
		{"100%", 1, "a literal percent must not become a wildcard"},
		// One, not zero and not four: escaped, "%" is a literal character, and
		// exactly one saved food has one in its name. Zero was the first
		// expectation here and it was wrong — "matches nothing" is what an
		// over-escaped pattern would do.
		{"%", 1, "a bare percent matches names containing a percent, not everything"},
		{"protein_shake", 1, "an underscore must not match any character"},
		{"chicken", 1, "ordinary search still works"},
		{"", 4, "an empty query still returns everything"},
	} {
		t.Run(tc.q, func(t *testing.T) {
			got, err := r.ListFoods(ctx(), uid, tc.q, 50)
			if err != nil {
				t.Fatalf("search %q: %v", tc.q, err)
			}
			if len(got) != tc.want {
				var names []string
				for _, g := range got {
					names = append(names, g.Name)
				}
				t.Fatalf("%q returned %d rows %v, want %d — %s", tc.q, len(got), names, tc.want, tc.notes)
			}
		})
	}
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("fixture: %v", err)
	}
}

// The label macros persist through an entry (N52).
//
// **This test exists because review caught the exact bug it guards.** The
// migration added the columns, `Macros` gained the fields and `validate`
// bounded them — and no SQL in this module was widened, so an entry carrying
// `sodium_mg: 536` validated, inserted without it, and read back null. A stated
// value silently became an absence, which is the failure class this whole change
// is written against, arriving inside the change itself.
//
// Nothing else would have caught it: the food module's tests cover the catalog
// and the barcode boundary, the handler tests never reach SQL, and the value
// round-trips as `null` rather than erroring.
func TestLabelMacrosPersistThroughAnEntry(t *testing.T) {
	r := repoFor(t, uid)

	food := aFood(foodID, "Crisps", 536)
	food.SaturatedFatG = f(9)
	food.SugarG = f(1)
	food.AddedSugarG = f(0) // a stated zero, not an absence
	food.SodiumMG = f(536)
	// CholesterolMG deliberately unset — the ordinary case for a scan.
	if _, err := r.SaveFood(ctx(), food); err != nil {
		t.Fatalf("save food: %v", err)
	}
	got, err := r.GetFood(ctx(), uid, foodID)
	if err != nil {
		t.Fatalf("get food: %v", err)
	}
	if got.SodiumMG == nil || *got.SodiumMG != 536 {
		t.Fatalf("food sodium %v, want 536 — the column exists but the write or read drops it", got.SodiumMG)
	}
	if got.AddedSugarG == nil {
		t.Error("a stated zero became null on the food — a fact turned into an absence")
	}
	if got.CholesterolMG != nil {
		t.Errorf("food cholesterol %v for a value never stated — null became a claim", *got.CholesterolMG)
	}

	// SAVE IT AGAIN with a changed value, so the ON CONFLICT DO UPDATE path is
	// exercised and not just the INSERT.
	//
	// Added after mutation testing showed this test passing with sodium removed
	// from the upsert's SET clause: a single save only ever inserts, so the
	// whole update half of that statement was uncovered. An edit to a saved
	// food is the ordinary case — correcting a number off a packet — so the
	// path that silently would not have written it is the more likely one.
	food.SodiumMG = f(410)
	if _, err := r.SaveFood(ctx(), food); err != nil {
		t.Fatalf("re-save food: %v", err)
	}
	edited, err := r.GetFood(ctx(), uid, foodID)
	if err != nil {
		t.Fatalf("get edited food: %v", err)
	}
	if edited.SodiumMG == nil || *edited.SodiumMG != 410 {
		t.Fatalf("edited food sodium %v, want 410 — the column is missing from "+
			"the upsert's SET clause, so an edit silently keeps the old value", edited.SodiumMG)
	}

	entry := anEntry(entryID, food, 2)
	entry.SaturatedFatG = f(18)
	entry.SugarG = f(2)
	entry.AddedSugarG = f(0)
	entry.SodiumMG = f(1072)
	if _, err := r.SaveEntry(ctx(), entry); err != nil {
		t.Fatalf("save entry: %v", err)
	}
	// Read back through the LIST path, which is the one a client actually uses
	// and the one whose projection would silently omit a column.
	list, err := r.ListEntries(ctx(), uid, "2026-08-18", "2026-08-18", 50)
	if err != nil {
		t.Fatalf("list entries: %v", err)
	}
	var back Entry
	for _, e := range list {
		if e.ID == entryID {
			back = e
		}
	}
	if back.ID == "" {
		t.Fatalf("the entry just saved is not in the day's list")
	}
	if back.SodiumMG == nil || *back.SodiumMG != 1072 {
		t.Fatalf("entry sodium %v, want 1072 — an entry accepted the value and discarded it", back.SodiumMG)
	}
	if back.SaturatedFatG == nil || *back.SaturatedFatG != 18 {
		t.Errorf("entry saturated fat %v, want 18", back.SaturatedFatG)
	}
	if back.AddedSugarG == nil {
		t.Error("a stated zero became null on the entry")
	}
	if back.CholesterolMG != nil {
		t.Errorf("entry cholesterol %v for a value never stated", *back.CholesterolMG)
	}

	// And the entry's own ON CONFLICT DO UPDATE path, for the same reason the
	// food's is exercised above: correcting a logged entry is ordinary, and a
	// single save only ever reaches the INSERT half of the statement. Mutation
	// testing found BOTH of these uncovered — the first version of this test
	// passed with the macros removed from either SET clause.
	entry.SodiumMG = f(820)
	if _, err := r.SaveEntry(ctx(), entry); err != nil {
		t.Fatalf("re-save entry: %v", err)
	}
	list2, err := r.ListEntries(ctx(), uid, "2026-08-18", "2026-08-18", 50)
	if err != nil {
		t.Fatalf("list entries again: %v", err)
	}
	for _, e := range list2 {
		if e.ID != entryID {
			continue
		}
		if e.SodiumMG == nil || *e.SodiumMG != 820 {
			t.Fatalf("edited entry sodium %v, want 820 — the column is missing "+
				"from the entry upsert's SET clause, so a correction is discarded", e.SodiumMG)
		}
	}
}
