package nutrition

import (
	"errors"
	"strings"
	"testing"
)

// aiFood is a food saved from a confirmed AI draft — what N114's mobile half
// writes when the athlete taps Log.
func aiFood(id, name string) Food {
	f := aFood(id, name, 310)
	f.Source = SourceAI
	return f
}

// THE RULE, ON A REAL DATABASE.
//
// Two spellings — `NormalizeFoodName` in Go, `normalizedNameSQL` in postgres.go
// — and a rule spelled twice is a rule that can disagree with itself. This runs
// the same vectors through both and compares. A Go-only test would pass with
// the SQL saying something completely different, which is precisely the failure
// mode: matching would silently stop working in production and every unit test
// would stay green.
func TestTheSQLNormalisationAgreesWithTheGoOne(t *testing.T) {
	pool := testPool(t)

	// **Built from CODE POINTS, never typed.** The first version of this test
	// carried literal NBSPs in the source and they were folded to ordinary
	// spaces somewhere before the database ever saw them — so every "NBSP"
	// vector was really a plain space, and the broken expression passed a case
	// it could not handle. A vector you cannot see is a vector you have to
	// construct.
	sep := func(r rune) string { return "Pork" + string(r) + "Shashlik" }
	edge := func(r rune) string { return string(r) + "Pork Shashlik" + string(r) }

	vectors := []string{
		"Pork Shashlik",
		"  Pork Shashlik  ",
		"PORK SHASHLIK",
		"Pork  Shashlik",
		"Pork Shashlik (spicy)",
		"Skyr 0%",
		"Café au lait",
		"chicken breast, grilled",
		"2 x 100 g rice",

		// The separators Go folds. Measured 2026-08-21: Postgres' own
		// `[:space:]` does NOT fold U+00A0, U+1680 or U+202F, so these three
		// are the ones that caught the drift. The others are here so the class
		// cannot be narrowed later without something going red.
		sep('\t'), sep('\n'), sep('\v'), sep('\f'), sep('\r'),
		sep('\u00a0'), sep('\u0085'), sep('\u1680'),
		sep('\u2002'), sep('\u2028'), sep('\u202f'), sep('\u205f'), sep('\u3000'),

		// EDGE whitespace, which is the other half and failed for a different
		// reason: `btrim` with no character set removes ordinary spaces only,
		// so trimming before the collapse left a tab behind as a space.
		edge('\t'), edge('\n'), edge('\u00a0'), edge('\u3000'),
	}
	for _, v := range vectors {
		var got string
		// **The production expression itself**, applied to a literal rather than
		// a column. Spelling it out by hand here would compare the Go rule with
		// a COPY of the SQL rule, and drift in the real one would pass —
		// measured, before `normalizedNameSQL` became a function.
		err := pool.QueryRow(ctx(),
			`SELECT `+normalizedNameSQL("$1::text"), v).Scan(&got)
		if err != nil {
			t.Fatalf("normalise %q: %v", v, err)
		}
		if want := NormalizeFoodName(v); got != want {
			t.Errorf("%q (% x): SQL gave %q, Go gave %q — the two halves of one rule have drifted",
				v, v, got, want)
		}
	}
}

// THE LOOKUP, END TO END: what the athlete typed finds what they saved.
func TestReuseFindsASavedFoodHoweverItWasTyped(t *testing.T) {
	repo := repoFor(t, uid, other)
	if _, err := repo.SaveFood(ctx(), aiFood(foodID, "Pork Shashlik")); err != nil {
		t.Fatalf("save: %v", err)
	}

	// A SECOND row whose STORED name carries surrounding whitespace. The
	// repository does not trim on write (only the HTTP handler does), so this is
	// reachable — and it is the only case that makes the `btrim` half of the
	// expression load-bearing. Without it, dropping `btrim` from the SQL leaves
	// every test green.
	if _, err := repo.SaveFood(ctx(), aiFood(recipeID, "  Chicken Thigh  ")); err != nil {
		t.Fatalf("save padded: %v", err)
	}
	if got, err := repo.FindFoodByNormalizedName(ctx(), uid, NormalizeFoodName("Chicken Thigh")); err != nil {
		t.Fatalf("a stored name with stray whitespace was unreachable: %v", err)
	} else if got.ID != recipeID {
		t.Fatalf("got %s, want %s", got.ID, recipeID)
	}

	for _, typed := range []string{"Pork Shashlik", "pork shashlik", "  PORK   shashlik ", "Pork\tShashlik"} {
		got, err := repo.FindFoodByNormalizedName(ctx(), uid, NormalizeFoodName(typed))
		if err != nil {
			t.Fatalf("typed %q: %v", typed, err)
		}
		if got.ID != foodID {
			t.Errorf("typed %q: got food %s, want %s", typed, got.ID, foodID)
		}
		if got.Source != SourceAI {
			t.Errorf("typed %q: provenance lost, got %q", typed, got.Source)
		}
	}
}

// The negative half, which is the one the ticket actually asks a reviewer to be
// able to explain.
func TestReuseDoesNotSubstituteANearlyIdenticalFood(t *testing.T) {
	repo := repoFor(t, uid, other)
	if _, err := repo.SaveFood(ctx(), aiFood(foodID, "Pork Shashlik")); err != nil {
		t.Fatalf("save: %v", err)
	}
	for _, typed := range []string{
		"Pork Shashlik (spicy)",
		"Pork Shashlik, no sauce",
		"Pork",
		"Shashlik",
		"Pork Shashliks",
	} {
		_, err := repo.FindFoodByNormalizedName(ctx(), uid, NormalizeFoodName(typed))
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("typed %q: want ErrNotFound so it generates instead, got %v", typed, err)
		}
	}
}

// The security property. `user_id` is in the WHERE clause, not a filter applied
// afterwards — without it this method answers "does ANY athlete have a food
// called X", and one athlete's estimate would be answered with another's
// numbers.
func TestOneAthletesSavedFoodIsNotAnotherAthletesReuse(t *testing.T) {
	repo := repoFor(t, uid, other)
	mine := aiFood(foodID, "Pork Shashlik")
	if _, err := repo.SaveFood(ctx(), mine); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := repo.FindFoodByNormalizedName(ctx(), other, "pork shashlik"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a stranger reached my saved food: %v", err)
	}
}

// Two rows that normalise the same way — two offline devices, two
// client-generated ids, one name — must resolve to the SAME row every time.
// An unordered LIMIT 1 would return whichever the plan reached first, so the
// same description could give different numbers on consecutive calls: the
// defect N114 was reported for, reproduced by its own fix.
func TestADuplicateNameResolvesToTheNewestRowEveryTime(t *testing.T) {
	repo := repoFor(t, uid, other)
	older := aiFood(foodID, "Pork Shashlik")
	older.Kcal = 100
	if _, err := repo.SaveFood(ctx(), older); err != nil {
		t.Fatalf("save older: %v", err)
	}
	newer := aiFood(recipeID, "  pork   SHASHLIK ")
	newer.Kcal = 900
	if _, err := repo.SaveFood(ctx(), newer); err != nil {
		t.Fatalf("save newer: %v", err)
	}

	for i := 0; i < 5; i++ {
		got, err := repo.FindFoodByNormalizedName(ctx(), uid, "pork shashlik")
		if err != nil {
			t.Fatalf("lookup %d: %v", i, err)
		}
		if got.ID != recipeID {
			t.Fatalf("lookup %d returned %s, want the newest row %s — the answer is not stable", i, got.ID, recipeID)
		}
	}
}

// The index exists AND is used. A correctness test cannot see this: the lookup
// returns the right row either way, and the only symptom of a drifted
// expression is that every reuse scans the athlete's whole food list. Same
// reasoning as `nutrition_estimates_user_window_idx` in migration 000067.
func TestTheReuseLookupUsesItsIndex(t *testing.T) {
	repo := repoFor(t, uid, other)
	if _, err := repo.SaveFood(ctx(), aiFood(foodID, "Pork Shashlik")); err != nil {
		t.Fatalf("save: %v", err)
	}

	// **`FORMAT JSON`, and this is the apparatus half of the test.** The text
	// format returns ONE ROW PER LINE, so `QueryRow` reads `Limit (cost=…)` and
	// nothing else — a plan that never contains any scan node, which reports
	// "the index cannot serve this query" no matter what the planner did. That
	// is a check that could not succeed, and it failed exactly that way here
	// before this comment existed. JSON is a single row.
	//
	// A transaction, because `SET LOCAL` outside one is a no-op AND a pool
	// hands out a different connection per statement — two ways for the setting
	// to silently not apply to the EXPLAIN it is supposed to bind.
	tx, err := repo.pool.Begin(ctx())
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx()) }()

	// The planner will pick a sequential scan on a table this small however
	// good the index is, so its choice is not the question. The question is
	// whether the index CAN serve the query at all — i.e. whether its
	// expression still matches `normalizedNameSQL`. Forcing the planner's hand
	// is what asks that.
	if _, err := tx.Exec(ctx(), `SET LOCAL enable_seqscan = off`); err != nil {
		t.Fatalf("disable seqscan: %v", err)
	}
	var plan string
	err = tx.QueryRow(ctx(), `
		EXPLAIN (FORMAT JSON)
		SELECT id FROM nutrition_foods
		WHERE user_id = $1 AND `+normalizedNameSQL("name")+` = $2
		ORDER BY updated_at DESC, id
		LIMIT 1`, uid, "pork shashlik").Scan(&plan)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	// The apparatus proves it can see a scan node before its verdict is worth
	// anything — otherwise "no index in the plan" and "no plan" read alike.
	if !strings.Contains(plan, "Node Type") {
		t.Fatalf("the plan carries no nodes, so this test measured nothing: %s", plan)
	}
	if !strings.Contains(plan, "nutrition_foods_user_normalized_name_idx") {
		t.Fatalf("the index was not used at all.\nplan: %s", plan)
	}
	// **The index NAME is not enough, and this is the whole point of the test.**
	// The index leads on `user_id`, so Postgres will happily use it for that
	// column alone and re-check the name in a Filter — which means a drifted
	// expression still puts the index in the plan while reading every row the
	// athlete owns. Measured: swapping `btrim(lower(…))` for `lower(btrim(…))`
	// left the name-only assertion green.
	//
	// The name has to be in the `Index Cond`, which is where a matched
	// expression lands and where a drifted one never can.
	cond := plan
	if i := strings.Index(plan, `"Index Cond"`); i >= 0 {
		cond = plan[i:]
		if j := strings.Index(cond, "\n"); j >= 0 {
			cond = cond[:j]
		}
	} else {
		t.Fatalf("no Index Cond in the plan, so the name is being re-checked as a Filter — "+
			"migration 000074's expression has drifted from normalizedNameSQL, and every reuse "+
			"now scans the athlete's whole food list.\nplan: %s", plan)
	}
	if !strings.Contains(cond, "regexp_replace") {
		t.Fatalf("the normalised name is not in the Index Cond, so it is filtered rather than "+
			"looked up: %s\nplan: %s", cond, plan)
	}
}

// ------------------------------------------------------- the restore path

// THE TRAP GUARD, and it is written because this repo has paid for the same
// mechanism three times on `exercises.updateWithin`: a column in an UPDATE's
// SET clause that a caller does not supply gets overwritten with an empty one,
// and nothing goes red.
//
// N114 makes `source` client-settable, so it becomes exactly that column. The
// mobile edit screen corrects a food's macros; if that write also reset the
// provenance, an AI-drafted food would silently become one the athlete
// measured, and nothing downstream could ever tell them apart again — which is
// the property `nutrition.Source`'s own comment spends a paragraph defending.
func TestEditingAFoodWithoutSayingItsSourceKeepsIt(t *testing.T) {
	repo := repoFor(t, uid, other)
	if _, err := repo.SaveFood(ctx(), aiFood(foodID, "Pork Shashlik")); err != nil {
		t.Fatalf("save: %v", err)
	}

	// The athlete corrects the macros. The client says nothing about source —
	// which is what every client written before N114 does.
	corrected := aFood(foodID, "Pork Shashlik", 415)
	corrected.Source = ""
	got, err := repo.SaveFood(ctx(), corrected)
	if err != nil {
		t.Fatalf("edit: %v", err)
	}
	if got.Kcal != 415 {
		t.Fatalf("the correction did not land: %v kcal", got.Kcal)
	}
	if got.Source != SourceAI {
		t.Fatalf("provenance was blanked by an unrelated edit: %q — this is the updateWithin trap", got.Source)
	}
}

// The other half: an unstated source on a NEW row is `user`, not empty. The
// column is NOT NULL with a CHECK, so getting this wrong is a write failure
// rather than a silent one — stated here so the COALESCE's second arm is
// covered as well as its first.
func TestANewFoodWithNoStatedSourceIsTheAthletesOwn(t *testing.T) {
	repo := repoFor(t, uid, other)
	f := aFood(foodID, "Chicken breast", 165)
	f.Source = ""
	got, err := repo.SaveFood(ctx(), f)
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if got.Source != SourceUser {
		t.Fatalf("source = %q, want user", got.Source)
	}
}

// And a STATED source still wins, or the guard above would have made the field
// unwritable — a fix that quietly disables the feature it was written for.
func TestAStatedSourceIsWritten(t *testing.T) {
	repo := repoFor(t, uid, other)
	if _, err := repo.SaveFood(ctx(), aFood(foodID, "Pork Shashlik", 310)); err != nil {
		t.Fatalf("save: %v", err)
	}
	changed := aiFood(foodID, "Pork Shashlik")
	got, err := repo.SaveFood(ctx(), changed)
	if err != nil {
		t.Fatalf("restate: %v", err)
	}
	if got.Source != SourceAI {
		t.Fatalf("source = %q, want ai — a stated provenance must be written", got.Source)
	}
}

// The rule the whole module rests on, re-asserted for the path N114 creates:
// correcting a saved food corrects FUTURE logs and leaves past ones alone. The
// package already pins this for hand-typed foods; N114's ticket asks for it in
// so many words, and the reuse path is a new way to reach the same write.
func TestCorrectingAReusedFoodLeavesWhatWasAlreadyLoggedAlone(t *testing.T) {
	repo := repoFor(t, uid, other)
	saved := aiFood(foodID, "Pork Shashlik")
	if _, err := repo.SaveFood(ctx(), saved); err != nil {
		t.Fatalf("save: %v", err)
	}
	logged := anEntry(entryID, saved, 1)
	logged.SourceFoodID = &saved.ID
	if _, err := repo.SaveEntry(ctx(), logged); err != nil {
		t.Fatalf("log: %v", err)
	}

	corrected := aiFood(foodID, "Pork Shashlik")
	corrected.Kcal = 415
	if _, err := repo.SaveFood(ctx(), corrected); err != nil {
		t.Fatalf("correct: %v", err)
	}

	entries, err := repo.ListEntries(ctx(), uid, "2026-08-18", "2026-08-18", 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("want 1 entry, got %d", len(entries))
	}
	if entries[0].Kcal != saved.Kcal {
		t.Fatalf("a past log changed when the food was corrected: %v, want %v — a log is what was eaten that day",
			entries[0].Kcal, saved.Kcal)
	}

	// And the correction IS live for the next reuse.
	next, err := repo.FindFoodByNormalizedName(ctx(), uid, "pork shashlik")
	if err != nil {
		t.Fatalf("reuse after correction: %v", err)
	}
	if next.Kcal != 415 {
		t.Fatalf("the correction did not reach the next reuse: %v", next.Kcal)
	}
}
