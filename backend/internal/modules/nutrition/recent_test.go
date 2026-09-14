package nutrition

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

// N194 — the pure half: recognising a pointer, the window, and resolving it.

func mealP(m Meal) *Meal    { return &m }
func intP(n int) *int       { return &n }
func strP(s string) *string { return &s }
func asJSON(v any) string   { b, _ := json.Marshal(v); return string(b) }

// 2026-09-14 is a Monday — asserted rather than assumed, because the weekday
// tests below mean nothing if it is not.
var win14 = RecentWindow{From: "2026-09-01", To: "2026-09-14", Days: 14}

func TestTheFixtureTodayIsAMonday(t *testing.T) {
	d, _ := time.Parse("2006-01-02", win14.To)
	if d.Weekday() != time.Monday {
		t.Fatalf("%s is a %s, not a Monday — the weekday tests are measuring nothing", win14.To, d.Weekday())
	}
}

func logged(id, on string, meal Meal, name string, kcal float64) Entry {
	return Entry{
		ID: id, UserID: "eater", EatenOn: on, Meal: meal, Name: name,
		Servings: 1, ServingLabel: "1 serving",
		Macros: Macros{Kcal: kcal, ProteinG: 10, CarbG: 20, FatG: 5},
	}
}

// ------------------------------------------------------------ recognising

func TestRecognizeReferenceReadsThePlainPointers(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want RecentReference
	}{
		{"the same as yesterday", RecentReference{Day: DayYesterday, FoodWords: []string{}}},
		{"Same as yesterday.", RecentReference{Day: DayYesterday, FoodWords: []string{}}},
		{"yesterday's breakfast again", RecentReference{Day: DayYesterday, Meal: mealP(MealBreakfast), FoodWords: []string{}}},
		// A curly apostrophe is what an iOS keyboard types.
		{"yesterday’s breakfast again", RecentReference{Day: DayYesterday, Meal: mealP(MealBreakfast), FoodWords: []string{}}},
		{"the same lunch as Monday", RecentReference{Day: DayWeekday, Weekday: strP("monday"), Meal: mealP(MealLunch), FoodWords: []string{}}},
		{"my usual post-workout shake", RecentReference{Day: DayUnstated, FoodWords: []string{"shake"}}},
		{"oatmeal again", RecentReference{Day: DayUnstated, FoodWords: []string{"oatmeal"}}},
		{"the same oatmeal as 3 days ago", RecentReference{Day: DayDaysAgo, DaysAgo: intP(3), FoodWords: []string{"oatmeal"}}},
		{"same oatmeal as three days ago", RecentReference{Day: DayDaysAgo, DaysAgo: intP(3), FoodWords: []string{"oatmeal"}}},
		{"what I had for dinner the day before yesterday", RecentReference{Day: DayDaysAgo, DaysAgo: intP(2), Meal: mealP(MealDinner), FoodWords: []string{}}},
		{"same breakfast as today", RecentReference{Day: DayToday, Meal: mealP(MealBreakfast), FoodWords: []string{}}},
		{"repeat supper from sunday", RecentReference{Day: DayWeekday, Weekday: strP("sunday"), Meal: mealP(MealDinner), FoodWords: []string{}}},
	} {
		got, ok := RecognizeReference(tc.in)
		if !ok {
			t.Errorf("%q: declined, want %s", tc.in, asJSON(tc.want))
			continue
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%q: got %s, want %s", tc.in, asJSON(got), asJSON(tc.want))
		}
	}
}

// The half that matters more: a description must never be read as a pointer,
// or "two eggs and toast" comes back as last Tuesday's breakfast.
func TestRecognizeReferenceDeclinesAnythingThatIsADescription(t *testing.T) {
	for _, in := range []string{
		"",
		"two eggs and toast",
		"chicken and rice",
		"oatmeal yesterday",                   // when, not a pointer — no marker
		"same as yesterday but with two eggs", // a change
		"two eggs again",                      // a quantity
		"2 eggs again",                        // a quantity, in digits
		"the same",                            // nothing to look up
		"same breakfast and lunch as yesterday",
		"same as monday or tuesday",           // two days
		"same breakfast as yesterday's lunch", // two meals
		"my usual chicken rice beans salsa guacamole bowl", // five food words
		// A change with no count, no second meal and no second day in it, so
		// ONLY the modifier rule can decline these. Every modifier vector above
		// was already refused by some other rule, which let a mutation deleting
		// the modifier check survive this whole test — the guard was real and
		// nothing exercised it.
		"same as yesterday but bigger",
		"the same oatmeal without sugar",
	} {
		if got, ok := RecognizeReference(in); ok {
			t.Errorf("%q was read as a pointer (%s) — it must go to the model, or be estimated", in, asJSON(got))
		}
	}
}

// ------------------------------------------------------------ the window

func TestTheWindowIsFourteenDaysEndingToday(t *testing.T) {
	for _, tc := range []struct{ today, from string }{
		{"2026-09-14", "2026-09-01"},
		// Across a month boundary, in a year February has 28 days.
		{"2026-03-05", "2026-02-20"},
	} {
		got, err := RecentWindowEndingOn(tc.today)
		if err != nil {
			t.Fatalf("%s: %v", tc.today, err)
		}
		want := RecentWindow{From: tc.from, To: tc.today, Days: 14}
		if got != want {
			t.Errorf("%s: window %+v, want %+v", tc.today, got, want)
		}
	}
	if _, err := RecentWindowEndingOn("yesterday"); err == nil {
		t.Error("a window was built from a non-date")
	}
}

func TestTodayMustBeWithinADayOfUTC(t *testing.T) {
	now := time.Date(2026, 9, 14, 2, 0, 0, 0, time.UTC)
	for today, want := range map[string]bool{
		"2026-09-14": true,
		"2026-09-13": true, // UTC−x, still the evening before
		"2026-09-15": true, // UTC+14
		"2026-09-12": false,
		"2026-09-16": false,
		"2025-09-14": false, // walking the window back a year
		"2026-9-14":  false,
		"garbage":    false,
	} {
		if got := TodayIsPlausible(today, now); got != want {
			t.Errorf("TodayIsPlausible(%q) = %v, want %v", today, got, want)
		}
	}
}

// ------------------------------------------------------------ resolving

// Decision 4: a meal reference is EVERY entry in that meal, in the meal's own
// order, as one set of drafts.
func TestAMealReferenceResolvesToEveryEntryInThatMeal(t *testing.T) {
	oats := logged("e1", "2026-09-13", MealBreakfast, "Oatmeal", 300)
	oats.Position = 1024
	banana := logged("e2", "2026-09-13", MealBreakfast, "Banana", 105)
	banana.Position = 2048
	lunch := logged("e3", "2026-09-13", MealLunch, "Chicken wrap", 520)

	// Deliberately handed in the WRONG order, so the sort is exercised.
	cands, more := ResolveRecent("eater", []Entry{banana, lunch, oats},
		RecentReference{Day: DayYesterday, Meal: mealP(MealBreakfast)}, win14)
	if len(cands) != 1 || more != 0 {
		t.Fatalf("got %d candidates (+%d), want exactly one meal", len(cands), more)
	}
	c := cands[0]
	if c.EatenOn != "2026-09-13" || c.Meal != MealBreakfast {
		t.Fatalf("candidate is %s %s", c.EatenOn, c.Meal)
	}
	if got := []string{c.Items[0].Name, c.Items[1].Name}; len(c.Items) != 2 || got[0] != "Oatmeal" || got[1] != "Banana" {
		t.Fatalf("items %s, want Oatmeal then Banana — every entry, in position order", asJSON(c.Items))
	}
}

// With no meal named, each meal that day is its own thing to pick.
func TestADayWithSeveralMealsIsAListNotAGuess(t *testing.T) {
	cands, _ := ResolveRecent("eater", []Entry{
		logged("e1", "2026-09-13", MealDinner, "Salmon", 600),
		logged("e2", "2026-09-13", MealBreakfast, "Oatmeal", 300),
	}, RecentReference{Day: DayYesterday}, win14)
	if len(cands) != 2 {
		t.Fatalf("got %d candidates, want 2 — one per meal", len(cands))
	}
	if cands[0].Meal != MealBreakfast || cands[1].Meal != MealDinner {
		t.Fatalf("meals %s, %s — want the day's own order", cands[0].Meal, cands[1].Meal)
	}
}

func TestTheSameFoodLoggedTheSameWayIsOneCandidate(t *testing.T) {
	var es []Entry
	for i, d := range []string{"2026-09-13", "2026-09-11", "2026-09-09", "2026-09-05"} {
		es = append(es, logged("e"+string(rune('a'+i)), d, MealSnack, "Protein shake", 240))
	}
	cands, more := ResolveRecent("eater", es, RecentReference{Day: DayUnstated, FoodWords: []string{"shake"}}, win14)
	if len(cands) != 1 || more != 0 {
		t.Fatalf("got %d (+%d) — four identical shakes are one thing to offer", len(cands), more)
	}
	if cands[0].EatenOn != "2026-09-13" {
		t.Fatalf("the newest should stand for it, got %s", cands[0].EatenOn)
	}
}

// Decision 3: never silently guess between two different "usual" breakfasts.
func TestTwoDifferentUsualsAreAListNeverAGuess(t *testing.T) {
	cands, _ := ResolveRecent("eater", []Entry{
		logged("e1", "2026-09-10", MealBreakfast, "Usual smoothie", 320),
		logged("e2", "2026-09-12", MealBreakfast, "Smoothie", 410),
	}, RecentReference{Day: DayUnstated, FoodWords: []string{"smoothie"}}, win14)
	if len(cands) != 2 {
		t.Fatalf("got %d candidates, want both smoothies offered", len(cands))
	}
	if cands[0].EatenOn != "2026-09-12" {
		t.Fatalf("newest first, got %s", cands[0].EatenOn)
	}
}

func TestTheListIsCappedAtFiveAndSaysHowManyMore(t *testing.T) {
	var es []Entry
	for i := 0; i < 8; i++ {
		es = append(es, logged("e"+string(rune('a'+i)), "2026-09-10", MealSnack, "Shake", float64(200+i)))
	}
	cands, more := ResolveRecent("eater", es, RecentReference{Day: DayUnstated, FoodWords: []string{"shake"}}, win14)
	if len(cands) != MaxRecentCandidates || more != 3 {
		t.Fatalf("got %d (+%d), want %d (+3)", len(cands), more, MaxRecentCandidates)
	}
	if MaxRecentCandidates != 5 {
		t.Fatalf("the cap is %d; the decision was at most 5", MaxRecentCandidates)
	}
}

// Decision 3: nothing matching is an empty LIST, which the client says out
// loud. `[]`, never `null` — a client iterating it must not have to guess.
func TestNothingMatchingIsAnEmptyListAndInventsNothing(t *testing.T) {
	cands, more := ResolveRecent("eater", []Entry{
		logged("e1", "2026-09-13", MealBreakfast, "Oatmeal", 300),
	}, RecentReference{Day: DayUnstated, FoodWords: []string{"granola"}}, win14)
	if len(cands) != 0 || more != 0 {
		t.Fatalf("granola resolved to %s", asJSON(cands))
	}
	if got := asJSON(RecentLogMatch{Candidates: cands}); !strings.Contains(got, `"candidates":[]`) {
		t.Fatalf("an empty result serialises as %s, want candidates:[]", got)
	}
}

// A pointer that names nothing identifies nothing. The model is told to leave
// unstated what was not said, so "log my usual" can arrive here with no day,
// no meal and no food words — and must not come back as the athlete's five
// most recent meals presented as candidates. Raised in review.
func TestAPointerThatNamesNothingMatchesNothing(t *testing.T) {
	es := []Entry{
		logged("e1", "2026-09-13", MealBreakfast, "Oatmeal", 300),
		logged("e2", "2026-09-12", MealLunch, "Soup", 310),
	}
	cands, more := ResolveRecent("eater", es, RecentReference{Day: DayUnstated, FoodWords: []string{}}, win14)
	if len(cands) != 0 || more != 0 {
		t.Fatalf("an empty pointer resolved to %s (+%d)", asJSON(cands), more)
	}
	if got := asJSON(RecentLogMatch{Candidates: cands}); !strings.Contains(got, `"candidates":[]`) {
		t.Fatalf("serialises as %s, want candidates:[]", got)
	}
	// Control: the same entries DO resolve once anything at all is named.
	if cands, _ := ResolveRecent("eater", es, RecentReference{Day: DayUnstated, FoodWords: []string{"soup"}}, win14); len(cands) != 1 {
		t.Fatalf("the control failed, so the empty result above proves nothing: %s", asJSON(cands))
	}
}

// The window, enforced HERE as well as in the query: an entry the reader
// should never have returned still never resolves.
func TestEntriesOutsideTheWindowNeverResolve(t *testing.T) {
	cands, _ := ResolveRecent("eater", []Entry{
		logged("old", "2026-08-31", MealSnack, "Kefir", 131),    // the day before the window
		logged("edge", "2026-09-01", MealSnack, "Kefir", 101),   // its first day
		logged("today", "2026-09-14", MealSnack, "Kefir", 114),  // its last
		logged("future", "2026-09-15", MealSnack, "Kefir", 115), // past "today"
	}, RecentReference{Day: DayUnstated, FoodWords: []string{"kefir"}}, win14)
	var got []string
	for _, c := range cands {
		got = append(got, c.EatenOn)
	}
	if !reflect.DeepEqual(got, []string{"2026-09-14", "2026-09-01"}) {
		t.Fatalf("resolved %v, want exactly the two inside the window", got)
	}
}

// The authorization property, enforced HERE as well as in the query.
func TestAnotherAthletesEntriesNeverResolve(t *testing.T) {
	stranger := logged("s1", "2026-09-13", MealBreakfast, "Oatmeal", 300)
	stranger.UserID = "stranger"
	cands, _ := ResolveRecent("eater", []Entry{stranger},
		RecentReference{Day: DayYesterday, Meal: mealP(MealBreakfast)}, win14)
	if len(cands) != 0 {
		t.Fatalf("another athlete's breakfast resolved: %s", asJSON(cands))
	}
}

// On a Monday, "the same lunch as Monday" is today or a week ago. Both are
// offered; picking one would be the silent guess.
func TestAWeekdayMatchesEveryOccurrenceInTheWindow(t *testing.T) {
	cands, _ := ResolveRecent("eater", []Entry{
		logged("m1", "2026-09-14", MealLunch, "Poke bowl", 640),
		logged("m2", "2026-09-07", MealLunch, "Burrito", 900),
		logged("t1", "2026-09-08", MealLunch, "Soup", 300), // a Tuesday
	}, RecentReference{Day: DayWeekday, Weekday: strP("monday"), Meal: mealP(MealLunch)}, win14)
	if len(cands) != 2 || cands[0].EatenOn != "2026-09-14" || cands[1].EatenOn != "2026-09-07" {
		t.Fatalf("got %s, want both Mondays, newest first", asJSON(cands))
	}
}

func TestADayOutsideTheWindowOrUnreadableMatchesNothing(t *testing.T) {
	es := []Entry{
		logged("e1", "2026-08-31", MealLunch, "Soup", 300),
		logged("e2", "2026-09-10", MealLunch, "Soup", 310),
	}
	for name, ref := range map[string]RecentReference{
		"fourteen days ago": {Day: DayDaysAgo, DaysAgo: intP(14)},
		"negative days":     {Day: DayDaysAgo, DaysAgo: intP(-1)},
		"unrecognised":      {Day: DayUnrecognised},
		"a date outside":    {Day: DayDate, MonthDay: strP("08-31")},
	} {
		if cands, _ := ResolveRecent("eater", es, ref, win14); len(cands) != 0 {
			t.Errorf("%s resolved to %s — an unusable day must never widen to the window", name, asJSON(cands))
		}
	}
	// And the positive control, so the empties above are not simply a broken
	// resolver.
	if cands, _ := ResolveRecent("eater", es, RecentReference{Day: DayDate, MonthDay: strP("09-10")}, win14); len(cands) != 1 {
		t.Fatalf("a date inside the window did not resolve: %s", asJSON(cands))
	}
	if cands, _ := ResolveRecent("eater", es, RecentReference{Day: DayDaysAgo, DaysAgo: intP(4)}, win14); len(cands) != 1 {
		t.Fatalf("four days ago did not resolve: %s", asJSON(cands))
	}
}

func TestFoodWordsMatchWholeWordsAllowingPlurals(t *testing.T) {
	for _, tc := range []struct {
		name  string
		words []string
		want  bool
	}{
		{"Egg", []string{"eggs"}, true},
		{"Scrambled eggs", []string{"egg"}, true},
		{"Overnight oats", []string{"oats"}, true},
		{"Tomatoes", []string{"tomato"}, true},
		{"Oatmeal", []string{"oat"}, false},
		{"Boat noodles", []string{"oat"}, false},
		{"Chicken salad", []string{"chicken", "curry"}, false},
		{"Chicken curry", []string{"curry", "chicken"}, true},
	} {
		if got := nameMatches(tc.name, tc.words); got != tc.want {
			t.Errorf("nameMatches(%q, %v) = %v, want %v", tc.name, tc.words, got, tc.want)
		}
	}
}

// Decision 5: a resolved draft carries the prior entry's food and amount — and
// nothing of the athlete's notes about that day.
func TestADraftFromTheLogCarriesThePriorFoodAndAmountAndNoNotes(t *testing.T) {
	sodium, fibre := 410.0, 6.5
	food, cat := "99999999-9999-4999-8999-999999999999", "grain"
	e := logged("77777777-7777-4777-8777-777777777777", "2026-09-13", MealBreakfast, "Oatmeal", 412)
	e.Servings, e.ServingLabel = 1.5, "1 cup"
	e.SodiumMG, e.FibreG, e.SourceFoodID, e.Category = &sodium, &fibre, &food, &cat
	e.Notes = "ate it at my desk, felt rough"

	cands, _ := ResolveRecent("eater", []Entry{e}, RecentReference{Day: DayYesterday}, win14)
	if len(cands) != 1 {
		t.Fatalf("got %d candidates", len(cands))
	}
	it := cands[0].Items[0]
	if it.Servings != 1.5 || it.ServingLabel != "1 cup" || it.Kcal != 412 || *it.FibreG != 6.5 {
		t.Fatalf("the amount changed on the way: %s", asJSON(it))
	}
	if it.SodiumMG == nil || *it.SodiumMG != 410 || it.SourceFoodID == nil || *it.SourceFoodID != food ||
		it.Category == nil || *it.Category != cat || it.EntryID != e.ID {
		t.Fatalf("provenance or a label macro was dropped: %s", asJSON(it))
	}
	if it.PortionConfidence != ConfidenceHigh || it.Assumption != "" {
		t.Fatalf("a logged amount must not read as a guess: %s", asJSON(it))
	}
	if body := asJSON(cands); strings.Contains(body, "desk") || strings.Contains(body, "notes") {
		t.Fatalf("the entry's notes reached the draft: %s", body)
	}
}

// ------------------------------------------------------------ the model's half

func TestTheModelsReferenceIsCheckedNotTrusted(t *testing.T) {
	for name, tc := range map[string]struct {
		in   modelReference
		want RecentReference
	}{
		"a plain reading": {
			modelReference{RefersToLoggedFood: true, Day: "yesterday", Weekday: "none", Meal: "lunch", FoodWords: []string{}},
			RecentReference{Day: DayYesterday, Meal: mealP(MealLunch), FoodWords: []string{}},
		},
		"occasion words are not food": {
			modelReference{RefersToLoggedFood: true, Day: "unstated", Weekday: "none", Meal: "unstated", FoodWords: []string{"usual", "post-workout shake"}},
			RecentReference{Day: DayUnstated, FoodWords: []string{"shake"}},
		},
		"an invented weekday": {
			modelReference{RefersToLoggedFood: true, Day: "weekday", Weekday: "funday", Meal: "unstated"},
			RecentReference{Day: DayUnrecognised, FoodWords: []string{}},
		},
		"a malformed date": {
			modelReference{RefersToLoggedFood: true, Day: "date", MonthDay: "13-45", Weekday: "none", Meal: "unstated"},
			RecentReference{Day: DayUnrecognised, FoodWords: []string{}},
		},
		"a meal that is not a slot": {
			modelReference{RefersToLoggedFood: true, Day: "unstated", Weekday: "none", Meal: "brunch"},
			RecentReference{Day: DayUnrecognised, FoodWords: []string{}},
		},
		"weeks ago stays weeks ago": {
			modelReference{RefersToLoggedFood: true, Day: "days_ago", DaysAgo: 20, Weekday: "none", Meal: "unstated"},
			RecentReference{Day: DayDaysAgo, DaysAgo: intP(20), FoodWords: []string{}},
		},
	} {
		if got := tc.in.toReference(); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %s, want %s", name, asJSON(got), asJSON(tc.want))
		}
	}
}

func TestTheReferenceSchemaMeetsWhatStructuredOutputsRequire(t *testing.T) {
	s := EstimateSchemaWithReference()
	assertClosed(t, "root", s)
	ref := s["properties"].(map[string]any)["reference"].(map[string]any)
	assertClosed(t, "reference", ref)
	if _, err := json.Marshal(s); err != nil {
		t.Fatalf("schema does not marshal: %v", err)
	}
	var walk func(any)
	walk = func(n any) {
		switch v := n.(type) {
		case map[string]any:
			for k, child := range v {
				if k == "minimum" || k == "maximum" || k == "minLength" || k == "maxLength" {
					t.Fatalf("reference schema carries %q, which structured outputs reject", k)
				}
				walk(child)
			}
		case []any:
			for _, child := range v {
				walk(child)
			}
		}
	}
	walk(s)
	// And building it did not mutate the ordinary schema it was built from.
	if _, leaked := EstimateSchema()["properties"].(map[string]any)["reference"]; leaked {
		t.Fatal("EstimateSchema now carries `reference` — every request would be asked the question")
	}
}

func TestReferencesAreAllowedOnlyForADescriptionWithADate(t *testing.T) {
	base := EstimateInput{Description: "the same as yesterday", Today: "2026-09-14", ResolveRecent: true}
	if !base.ReferencesAllowed() {
		t.Fatal("the ordinary case is not allowed — every test built on it measures nothing")
	}
	for name, in := range map[string]EstimateInput{
		"no date":          {Description: base.Description, ResolveRecent: true},
		"the escape hatch": {Description: base.Description, Today: base.Today},
		"a photo":          {Description: base.Description, Today: base.Today, ResolveRecent: true, Image: []byte{1}},
		"nothing typed":    {Description: "  ", Today: base.Today, ResolveRecent: true},
	} {
		if in.ReferencesAllowed() {
			t.Errorf("%s: references allowed", name)
		}
	}
}
