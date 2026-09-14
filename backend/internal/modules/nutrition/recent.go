package nutrition

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Pointing at something already logged, instead of describing it again (N194).
//
// # The request
//
// Reported from a device: *"The ai text input should be able to look into past
// logs as well, but only recent and add that foods again."* An athlete types
// "the same as yesterday" or "my usual shake" and expects yesterday's food back,
// not a fresh guess at what those words might mean.
//
// # Not N114, and why it cannot share N114's query
//
// N114 (`FindFoodByNormalizedName`, savedmatch.go) answers "which SAVED FOOD is
// named exactly this". This answers "what did I LOG, recently, that these words
// point at". The two differ in every respect that decides a query:
//
//   - the table — `nutrition_entries`, not `nutrition_foods`. Plenty of entries
//     name no saved food at all (typed by hand, copied, logged before N114);
//   - the key — a date range, a meal slot and some words, never one exact name;
//   - the answer — possibly several things, which is why this returns a short
//     list where N114 returns one row or nothing.
//
// So the index behind N114 cannot serve it. What CAN is the query the food log
// already runs: `ListEntries` is scoped to the caller inside its WHERE, bounded,
// ordered, and served by `nutrition_entries_user_day_idx (user_id, eaten_on)`
// from migration 000059. This file reads through that one method rather than
// standing up a second retrieval path, and needs no migration.
//
// # The model never sees the log
//
// The conservative reading while nobody has decided what VOLA may send to a
// provider. There are two ways a reference is RECOGNISED — a narrow phrase
// grammar here, free of charge, and the model for anything the grammar declines
// — and ONE way it is RESOLVED: this file, deterministically, against the
// athlete's own entries, after any model call has already returned. The model
// is told nothing but the athlete's words; it hands back a day, a meal and some
// food words, and never a food, a quantity or a note from the log.
//
// # Never a silent guess
//
// Exactly one plausible match becomes a draft. Several become a short list for
// the athlete to pick from — two different "usual" breakfasts are two different
// meals, and choosing between them is not this code's call. None says so and
// invents nothing. Every one of those still lands on the same confirm screen as
// any other draft; nothing here logs anything.

// RecentWindowDays is how far back a reference may reach: today and the 13 days
// before it, in the athlete's own calendar.
//
// Bounded, and the ticket asks for the bound to be stated rather than implied.
// "The same as yesterday" is a claim about the recent past; searching a year of
// history for every request is slower, and it is also how a reference resolves
// to a meal the athlete stopped eating in the spring.
const RecentWindowDays = 14

// MaxRecentCandidates is the most matches offered to pick from. More than this
// is not a choice an athlete makes standing in a kitchen; the response says how
// many were left out, and naming the meal or the food narrows it.
const MaxRecentCandidates = 5

// recentEntryLimit bounds the read. Fourteen days at thirty-odd entries a day is
// ~420, so this is headroom rather than a cut anyone reaches — and ListEntries'
// LIMIT is not optional in any case (see its own comment). It orders newest
// first, so if it is ever reached it is the OLDEST days that fall off.
const recentEntryLimit = 500

// maxReferenceFoodWords bounds how much of a reference is treated as naming the
// food. More words than this is a description, not a pointer.
const maxReferenceFoodWords = 4

// DayRef is which day a reference points at.
type DayRef string

const (
	// DayUnstated is no day at all — "my usual shake". The whole window.
	DayUnstated  DayRef = "unstated"
	DayToday     DayRef = "today"
	DayYesterday DayRef = "yesterday"
	// DayDaysAgo carries DaysAgo. Zero is today.
	DayDaysAgo DayRef = "days_ago"
	// DayWeekday carries Weekday. EVERY such weekday inside the window matches,
	// not only the latest: on a Tuesday, "the same as Monday" may mean yesterday
	// or the Monday before, and picking one is the silent guess this avoids.
	DayWeekday DayRef = "weekday"
	// DayDate carries MonthDay as "MM-DD" — no year, because the model is never
	// told the date and inventing one would be a guess.
	DayDate DayRef = "date"
	// DayUnrecognised is a day the athlete stated and the model returned in a
	// shape this could not read. It matches NOTHING rather than widening to the
	// whole window, because widening would answer a question they did not ask.
	DayUnrecognised DayRef = "unrecognised"
)

// RecentReference is what the athlete's words point at — never what the log
// contains. It crosses the wire so a surprising answer is checkable.
type RecentReference struct {
	Day      DayRef  `json:"day"`
	DaysAgo  *int    `json:"days_ago"`
	Weekday  *string `json:"weekday"`
	MonthDay *string `json:"month_day"`
	// Meal nil is unstated.
	Meal *Meal `json:"meal"`
	// FoodWords are the words naming the food itself, lowercased, with occasion
	// words ("usual", "post-workout") removed. Empty means the reference is to a
	// whole meal, and resolves to every entry in it.
	FoodWords []string `json:"food_words"`
}

// RecognizedBy says which recogniser read the words. `phrase` spent nothing;
// `model` spent one estimate. The client says so rather than inferring it.
type RecognizedBy string

const (
	RecognizedByPhrase RecognizedBy = "phrase"
	RecognizedByModel  RecognizedBy = "model"
)

// RecentWindow is the span searched, inclusive at both ends.
type RecentWindow struct {
	From string `json:"from"`
	To   string `json:"to"`
	Days int    `json:"days"`
}

// RecentItem is one prior entry, shaped as a draft row.
//
// The EstimatedItem fields are the prior entry's own food and amount, with
// `portion_confidence: high` and an empty assumption — nothing was estimated.
// The rest is what a re-log needs to be as complete as the original: the label
// macros, the saved food it named, its category. **Never its notes.**
type RecentItem struct {
	EstimatedItem
	SaturatedFatG *float64 `json:"saturated_fat_g"`
	SugarG        *float64 `json:"sugar_g"`
	AddedSugarG   *float64 `json:"added_sugar_g"`
	SodiumMG      *float64 `json:"sodium_mg"`
	CholesterolMG *float64 `json:"cholesterol_mg"`
	// SourceFoodID is the saved food the prior entry named, so the re-log names
	// it too and mints no duplicate food. Null when it named none.
	SourceFoodID *string `json:"source_food_id"`
	Category     *string `json:"category"`
	// EntryID is the prior entry, so a match is checkable from the response.
	EntryID string `json:"entry_id"`
}

// RecentCandidate is one thing a reference could mean: a whole meal slot on one
// day when no food was named, or one entry when it was.
type RecentCandidate struct {
	EatenOn string       `json:"eaten_on"`
	Meal    Meal         `json:"meal"`
	Items   []RecentItem `json:"items"`
}

// RecentLogMatch is the resolution, and its PRESENCE on an Estimate is the
// discriminator, exactly as `match` is for N114.
//
// The number of candidates is the outcome: none (nothing matched — the client
// says so), one (a draft), or several (a list to pick from). There is no
// separate status field because a status could disagree with the list.
type RecentLogMatch struct {
	RecognizedBy RecognizedBy      `json:"recognized_by"`
	Window       RecentWindow      `json:"window"`
	Reference    RecentReference   `json:"reference"`
	Candidates   []RecentCandidate `json:"candidates"`
	// More is how many further candidates matched beyond the ones listed.
	More int `json:"more"`
}

// RecentEntryReader is the read this needs, and nothing else.
//
// The SAME method the food log's Repository carries, so `PostgresRepository`
// satisfies it with the query that already exists — scoped to `userID` inside
// its WHERE clause, which is the security property. A one-method port for the
// same reason SavedFoodFinder is one: the estimate handler holds an API key and
// a spend meter, and it must not gain the ability to write the food log.
type RecentEntryReader interface {
	ListEntries(ctx context.Context, userID, from, to string, limit int) ([]Entry, error)
}

// RecentWindowEndingOn is the fourteen days ending on `today`, inclusive.
func RecentWindowEndingOn(today string) (RecentWindow, error) {
	if !isDate(today) {
		return RecentWindow{}, fmt.Errorf("%w: today must be a date as YYYY-MM-DD", ErrInvalidInput)
	}
	t, _ := time.Parse("2006-01-02", today)
	return RecentWindow{
		From: t.AddDate(0, 0, -(RecentWindowDays - 1)).Format("2006-01-02"),
		To:   today,
		Days: RecentWindowDays,
	}, nil
}

// TodayIsPlausible reports whether a client's "today" can be its local date
// given the server's clock.
//
// Every timezone in use sits within a day of UTC (UTC−12 to UTC+14), so a local
// date more than one calendar day from UTC's is not a timezone — it is a wrong
// clock or a forged value. Without this, a client could set `today` to last
// spring and walk the window back through the whole history this feature is
// bounded to fourteen days of. Only the caller's own entries either way, but
// the bound is a stated product decision and has to hold.
func TodayIsPlausible(today string, now time.Time) bool {
	t, err := time.Parse("2006-01-02", today)
	if err != nil || len(today) != 10 {
		return false
	}
	u := now.UTC()
	utc := time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
	diff := t.Sub(utc)
	return diff >= -24*time.Hour && diff <= 24*time.Hour
}

// ---------------------------------------------------------------------------
// Recognising a reference from the words alone — the free path.
// ---------------------------------------------------------------------------

// referenceMarkers are the words that make a description a POINTER. Without one
// of them nothing here fires: "oatmeal and a banana" is a meal, and "oatmeal
// yesterday" is a description of when, not a request to repeat it.
var referenceMarkers = map[string]bool{"same": true, "again": true, "repeat": true, "usual": true}

// referenceModifiers mean the athlete is asking for something DIFFERENT from
// what they logged — "the same but with two eggs". The grammar declines those
// rather than silently dropping the change; the model path still reads them,
// and the draft stays editable either way.
var referenceModifiers = map[string]bool{
	"but": true, "with": true, "without": true, "plus": true, "and": true, "extra": true,
	"less": true, "more": true, "half": true, "double": true, "instead": true, "except": true,
	"no": true, "not": true, "minus": true, "only": true, "twice": true, "bigger": true,
	"smaller": true, "larger": true,
}

var weekdayNames = map[string]time.Weekday{
	"monday": time.Monday, "tuesday": time.Tuesday, "wednesday": time.Wednesday,
	"thursday": time.Thursday, "friday": time.Friday, "saturday": time.Saturday, "sunday": time.Sunday,
}

var mealWords = map[string]Meal{
	"breakfast": MealBreakfast, "breakfasts": MealBreakfast,
	"lunch": MealLunch, "lunches": MealLunch,
	"dinner": MealDinner, "dinners": MealDinner, "supper": MealDinner, "suppers": MealDinner,
	"snack": MealSnack, "snacks": MealSnack,
}

var countWords = map[string]int{
	"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
	"eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
}

// referenceStopWords never name a food. Occasion words are here on purpose:
// "my usual post-workout shake" is a shake, and requiring "post" and "workout"
// to appear in an entry's name would miss the "Protein shake" it means.
var referenceStopWords = map[string]bool{
	"the": true, "a": true, "an": true, "my": true, "me": true, "i": true, "id": true, "ive": true,
	"im": true, "ill": true, "same": true, "as": true, "again": true, "repeat": true, "usual": true,
	"what": true, "had": true, "have": true, "ate": true, "eat": true, "eaten": true, "logged": true,
	"log": true, "add": true, "for": true, "on": true, "at": true, "from": true, "like": true,
	"last": true, "of": true, "please": true, "just": true, "it": true, "that": true, "this": true,
	"one": true, "meal": true, "time": true, "in": true, "to": true, "is": true, "was": true,
	"food": true, "thing": true, "things": true, "stuff": true, "exactly": true, "identical": true,
	"regular": true, "normal": true, "typical": true, "morning": true, "afternoon": true,
	"evening": true, "night": true, "post": true, "pre": true, "workout": true, "training": true,
	"gym": true, "session": true, "day": true, "days": true, "ago": true, "before": true,
	"do": true, "did": true, "lets": true, "let": true, "we": true, "our": true, "usually": true,
	"today": true, "todays": true, "yesterday": true, "yesterdays": true,
}

// referenceTokens lowercases and splits on anything that is not a letter or a
// digit. An apostrophe is REMOVED rather than split on, so a possessive stays
// one token: "yesterday's" is `yesterdays`, which the day table knows.
func referenceTokens(s string) []string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r == '\'' || r == '’' || r == '‘':
			// dropped
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		default:
			b.WriteRune(' ')
		}
	}
	return strings.Fields(b.String())
}

func isDigits(s string) bool {
	for _, r := range s {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return s != ""
}

// RecognizeReference reads an unambiguous pointer out of the words alone, or
// declines.
//
// **Declining is the common case and it is safe**: a declined description goes
// on to the model exactly as it always did, and the model recognises references
// too. This grammar exists so the plainest phrasings — "the same as yesterday",
// "yesterday's breakfast again", "oatmeal again" — cost nothing. It is narrow
// on purpose, and every rule below makes it decline MORE, never guess more:
//
//   - a marker word is required (same / again / repeat / usual, or "what I
//     had");
//   - any quantity or modifier declines — "two eggs again" is a description
//     with a count, "the same but bigger" asks for a change;
//   - two days or two meals decline — a reference is to one thing;
//   - more than four food words declines — that is a description;
//   - a marker with nothing after it ("the same") declines — there is nothing
//     to look up, and the model gets a chance to read the context.
//
// English only. Anything else declines and reaches the model, which is not.
func RecognizeReference(description string) (RecentReference, bool) {
	toks := referenceTokens(description)
	if len(toks) == 0 || len(toks) > 14 {
		return RecentReference{}, false
	}

	marker := false
	for i, w := range toks {
		if referenceMarkers[w] {
			marker = true
		}
		if w == "what" && i+2 < len(toks) && toks[i+1] == "i" {
			switch toks[i+2] {
			case "had", "ate", "logged", "eaten":
				marker = true
			}
		}
	}
	if !marker {
		return RecentReference{}, false
	}

	ref := RecentReference{Day: DayUnstated}
	days, meals := 0, 0
	setDay := func(d DayRef) { ref.Day = d; days++ }
	used := make([]bool, len(toks))

	for i := 0; i < len(toks); i++ {
		w := toks[i]
		if referenceModifiers[w] {
			return RecentReference{}, false
		}
		// "the day before yesterday"
		if w == "day" && i+2 < len(toks) && toks[i+1] == "before" &&
			(toks[i+2] == "yesterday" || toks[i+2] == "yesterdays") {
			n := 2
			setDay(DayDaysAgo)
			ref.DaysAgo = &n
			used[i], used[i+1], used[i+2] = true, true, true
			i += 2
			continue
		}
		// "3 days ago", "three days ago"
		n, isCount := countWords[w]
		if isDigits(w) {
			v, err := strconv.Atoi(w)
			n, isCount = v, err == nil
		}
		if isCount {
			if i+2 < len(toks) && (toks[i+1] == "days" || toks[i+1] == "day") && toks[i+2] == "ago" {
				setDay(DayDaysAgo)
				ref.DaysAgo = &n
				used[i], used[i+1], used[i+2] = true, true, true
				i += 2
				continue
			}
			// Any other count is a quantity, and a quantity is a description.
			return RecentReference{}, false
		}
		switch {
		case w == "today" || w == "todays":
			setDay(DayToday)
			used[i] = true
		case w == "yesterday" || w == "yesterdays":
			setDay(DayYesterday)
			used[i] = true
		default:
			if wd, ok := weekdayName(w); ok {
				setDay(DayWeekday)
				name := wd
				ref.Weekday = &name
				used[i] = true
			} else if m, ok := mealWords[w]; ok {
				if ref.Meal != nil && *ref.Meal != m {
					return RecentReference{}, false
				}
				if ref.Meal == nil {
					meals++
				}
				mm := m
				ref.Meal = &mm
				used[i] = true
			}
		}
	}
	if days > 1 || meals > 1 {
		return RecentReference{}, false
	}

	var rest []string
	for i, w := range toks {
		if !used[i] {
			rest = append(rest, w)
		}
	}
	ref.FoodWords = normalizeFoodWords(rest)
	if len(ref.FoodWords) > maxReferenceFoodWords {
		return RecentReference{}, false
	}
	if ref.Day == DayUnstated && ref.Meal == nil && len(ref.FoodWords) == 0 {
		return RecentReference{}, false
	}
	return ref, true
}

// weekdayName accepts "monday" and the possessive "mondays".
func weekdayName(w string) (string, bool) {
	if _, ok := weekdayNames[w]; ok {
		return w, true
	}
	if base := strings.TrimSuffix(w, "s"); base != w {
		if _, ok := weekdayNames[base]; ok {
			return base, true
		}
	}
	return "", false
}

// normalizeFoodWords is the ONE treatment both recognisers' food words go
// through, so a phrase and a model reading of the same words resolve alike:
// each is split into tokens, stop words and markers are dropped, and duplicates
// removed in order. Nothing is stemmed here; plural tolerance is the matcher's.
func normalizeFoodWords(words []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, w := range words {
		for _, t := range referenceTokens(w) {
			if referenceStopWords[t] || referenceMarkers[t] || referenceModifiers[t] || seen[t] {
				continue
			}
			if _, isMeal := mealWords[t]; isMeal {
				continue
			}
			if _, isDay := weekdayName(t); isDay {
				continue
			}
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Resolving a reference against the athlete's own entries.
// ---------------------------------------------------------------------------

// ResolveRecent turns a reference into candidates, deterministically.
//
// Pure: the caller reads the entries (see RecentEntryReader) and hands them in,
// which is what makes every rule here testable without a database and what
// keeps the model call — which happens BEFORE this, if at all — structurally
// unable to see them.
//
// Two checks here duplicate what the query already guarantees, and are kept
// because the query is not this function's to trust: an entry belonging to
// anybody but `userID` is dropped, and so is one dated outside the window. A
// reader that ever broadened would otherwise surface another athlete's lunch,
// or a meal from last year, as "yesterday's".
func ResolveRecent(userID string, entries []Entry, ref RecentReference, win RecentWindow) ([]RecentCandidate, int) {
	// A pointer that names NOTHING — no day, no meal, no food — identifies
	// nothing, and matches nothing. Without this the whole window would come
	// back as "candidates": five arbitrary recent meals presented as what the
	// athlete meant. The phrase grammar already declines this shape; the
	// model is told to leave unstated what was not said, so "log my usual"
	// reaches here from that side, and both recognisers must resolve alike.
	// Raised in review.
	if ref.Day == DayUnstated && ref.Meal == nil && len(ref.FoodWords) == 0 {
		return []RecentCandidate{}, 0
	}
	dates, all := datesFor(ref, win)

	var kept []Entry
	for _, e := range entries {
		if e.UserID != userID {
			continue
		}
		if e.EatenOn < win.From || e.EatenOn > win.To {
			continue
		}
		if !all && !dates[e.EatenOn] {
			continue
		}
		if ref.Meal != nil && e.Meal != *ref.Meal {
			continue
		}
		if len(ref.FoodWords) > 0 && !nameMatches(e.Name, ref.FoodWords) {
			continue
		}
		kept = append(kept, e)
	}

	// Newest day first, then the day's own meal order, then the order within
	// the meal — re-sorted here rather than trusting the reader's ORDER BY.
	sort.SliceStable(kept, func(i, j int) bool {
		a, b := kept[i], kept[j]
		if a.EatenOn != b.EatenOn {
			return a.EatenOn > b.EatenOn
		}
		if ai, bi := mealIndex(a.Meal), mealIndex(b.Meal); ai != bi {
			return ai < bi
		}
		if a.Position != b.Position {
			return a.Position < b.Position
		}
		if !a.CreatedAt.Equal(b.CreatedAt) {
			return a.CreatedAt.Before(b.CreatedAt)
		}
		return a.ID < b.ID
	})

	var cands []RecentCandidate
	if len(ref.FoodWords) == 0 {
		// A reference to a MEAL: every entry in that slot on that day, as one
		// set of drafts.
		idx := map[string]int{}
		for _, e := range kept {
			key := e.EatenOn + "|" + string(e.Meal)
			i, ok := idx[key]
			if !ok {
				i = len(cands)
				idx[key] = i
				cands = append(cands, RecentCandidate{EatenOn: e.EatenOn, Meal: e.Meal, Items: []RecentItem{}})
			}
			cands[i].Items = append(cands[i].Items, recentItemFrom(e))
		}
	} else {
		// A reference to a FOOD: each matching entry on its own.
		for _, e := range kept {
			cands = append(cands, RecentCandidate{EatenOn: e.EatenOn, Meal: e.Meal, Items: []RecentItem{recentItemFrom(e)}})
		}
	}

	// The same food logged the same way on five days is ONE thing to offer, not
	// five — the newest stands for it. Two different amounts are two things.
	seen := map[string]bool{}
	deduped := []RecentCandidate{}
	for _, c := range cands {
		sig := candidateSignature(c)
		if seen[sig] {
			continue
		}
		seen[sig] = true
		deduped = append(deduped, c)
	}

	more := 0
	if len(deduped) > MaxRecentCandidates {
		more = len(deduped) - MaxRecentCandidates
		deduped = deduped[:MaxRecentCandidates]
	}
	return deduped, more
}

// datesFor is the set of window dates a reference allows; `all` is the whole
// window. An unusable day yields an EMPTY set, never `all`.
func datesFor(ref RecentReference, win RecentWindow) (map[string]bool, bool) {
	to, err := time.Parse("2006-01-02", win.To)
	if err != nil {
		return map[string]bool{}, false
	}
	set := map[string]bool{}
	day := func(n int) string { return to.AddDate(0, 0, -n).Format("2006-01-02") }
	switch ref.Day {
	case DayUnstated:
		return nil, true
	case DayToday:
		set[day(0)] = true
	case DayYesterday:
		set[day(1)] = true
	case DayDaysAgo:
		if ref.DaysAgo != nil && *ref.DaysAgo >= 0 && *ref.DaysAgo < win.Days {
			set[day(*ref.DaysAgo)] = true
		}
	case DayWeekday:
		if ref.Weekday != nil {
			if wd, ok := weekdayNames[*ref.Weekday]; ok {
				for n := 0; n < win.Days; n++ {
					if d := to.AddDate(0, 0, -n); d.Weekday() == wd {
						set[d.Format("2006-01-02")] = true
					}
				}
			}
		}
	case DayDate:
		if ref.MonthDay != nil {
			for n := 0; n < win.Days; n++ {
				if d := to.AddDate(0, 0, -n); d.Format("01-02") == *ref.MonthDay {
					set[d.Format("2006-01-02")] = true
				}
			}
		}
	}
	return set, false
}

// nameMatches is true when EVERY food word appears as a word of the entry's
// name, allowing a trailing "s" or "es" either way — "eggs" finds "Egg",
// "oats" finds "Overnight oats". Nothing looser: a partial word ("oat" in
// "boat") or one word of two ("chicken" alone for "chicken curry") is not
// offered, because what is offered is a claim that this is what they meant.
func nameMatches(name string, words []string) bool {
	toks := referenceTokens(name)
	for _, w := range words {
		found := false
		for _, t := range toks {
			if t == w || t+"s" == w || w+"s" == t || t+"es" == w || w+"es" == t {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func mealIndex(m Meal) int {
	for i, v := range Meals {
		if v == m {
			return i
		}
	}
	return len(Meals)
}

func candidateSignature(c RecentCandidate) string {
	parts := make([]string, 0, len(c.Items))
	for _, it := range c.Items {
		parts = append(parts, fmt.Sprintf("%s|%s|%g|%.1f",
			NormalizeFoodName(it.Name), NormalizeFoodName(it.ServingLabel), it.Servings, it.Kcal))
	}
	sort.Strings(parts)
	return strings.Join(parts, "\n")
}

// recentItemFrom is a prior entry as a draft row: its own food and its own
// amount, marked as nothing having been estimated. The entry's notes are
// deliberately not carried — they are the athlete's own words about that day,
// not part of what gets logged again.
func recentItemFrom(e Entry) RecentItem {
	return RecentItem{
		EstimatedItem: EstimatedItem{
			Name:              e.Name,
			ServingLabel:      e.ServingLabel,
			Servings:          e.Servings,
			Kcal:              e.Kcal,
			ProteinG:          e.ProteinG,
			CarbG:             e.CarbG,
			FatG:              e.FatG,
			FibreG:            e.FibreG,
			PortionConfidence: ConfidenceHigh,
			Assumption:        "",
		},
		SaturatedFatG: e.SaturatedFatG,
		SugarG:        e.SugarG,
		AddedSugarG:   e.AddedSugarG,
		SodiumMG:      e.SodiumMG,
		CholesterolMG: e.CholesterolMG,
		SourceFoodID:  e.SourceFoodID,
		Category:      e.Category,
		EntryID:       e.ID,
	}
}

// ---------------------------------------------------------------------------
// The model's half: recognising, never resolving.
// ---------------------------------------------------------------------------

// modelReference is the `reference` object the model returns when the athlete
// pointed at a past log. Plain types only, so the schema below is one both
// providers' strict modes accept.
type modelReference struct {
	RefersToLoggedFood bool     `json:"refers_to_logged_food"`
	Day                string   `json:"day"`
	DaysAgo            int      `json:"days_ago"`
	Weekday            string   `json:"weekday"`
	MonthDay           string   `json:"month_day"`
	Meal               string   `json:"meal"`
	FoodWords          []string `json:"food_words"`
}

// toReference reads the model's answer into the one reference type, checking
// every value a schema cannot range-check. Anything unusable becomes
// DayUnrecognised — a reference that matches nothing — rather than being
// widened into a search the athlete did not ask for.
func (m modelReference) toReference() RecentReference {
	ref := RecentReference{Day: DayUnstated}
	switch DayRef(m.Day) {
	case DayUnstated, "":
	case DayToday, DayYesterday:
		ref.Day = DayRef(m.Day)
	case DayDaysAgo:
		// Kept as stated even when outside the window: "three weeks ago" is a
		// real answer, and `datesFor` matches no date for it rather than this
		// rewriting it into something nearer.
		n := m.DaysAgo
		ref.Day = DayDaysAgo
		ref.DaysAgo = &n
	case DayWeekday:
		w := strings.ToLower(strings.TrimSpace(m.Weekday))
		if _, ok := weekdayNames[w]; !ok {
			ref.Day = DayUnrecognised
			break
		}
		ref.Day = DayWeekday
		ref.Weekday = &w
	case DayDate:
		md := strings.TrimSpace(m.MonthDay)
		if _, err := time.Parse("01-02", md); err != nil || len(md) != 5 {
			ref.Day = DayUnrecognised
			break
		}
		ref.Day = DayDate
		ref.MonthDay = &md
	default:
		ref.Day = DayUnrecognised
	}

	switch m.Meal {
	case "", "unstated":
	default:
		meal := Meal(m.Meal)
		if !meal.valid() {
			ref.Day = DayUnrecognised
			break
		}
		ref.Meal = &meal
	}

	ref.FoodWords = normalizeFoodWords(m.FoodWords)
	// Bounded so a model returning a paragraph of words cannot make the
	// matcher do unbounded work; more words only ever NARROW a match.
	if len(ref.FoodWords) > 8 {
		ref.FoodWords = ref.FoodWords[:8]
	}
	return ref
}

// referenceSchema is the `reference` property added to the estimate schema when
// a request may point at a past log. It asks for what the WORDS say and nothing
// else — the model has no log to consult and is never given one.
func referenceSchema() map[string]any {
	weekdays := []any{"none", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"refers_to_logged_food": map[string]any{
				"type": "boolean",
				"description": "True only when the athlete is pointing at food they logged before instead of describing it — " +
					"'the same as yesterday', 'my usual shake', 'the same lunch as Monday'. False for any description of food, " +
					"even food they eat often.",
			},
			"day": map[string]any{
				"type":        "string",
				"enum":        []any{"unstated", "today", "yesterday", "days_ago", "weekday", "date"},
				"description": "Which day they pointed at, from their words only. 'unstated' when they named no day.",
			},
			"days_ago": map[string]any{
				"type":        "integer",
				"description": "How many days ago, when day is 'days_ago'. 0 otherwise.",
			},
			"weekday": map[string]any{
				"type":        "string",
				"enum":        weekdays,
				"description": "The weekday they named, when day is 'weekday'. 'none' otherwise.",
			},
			"month_day": map[string]any{
				"type":        "string",
				"description": "The date they named as MM-DD, when day is 'date'. Empty string otherwise. Never guess a year.",
			},
			"meal": map[string]any{
				"type":        "string",
				"enum":        []any{"unstated", "breakfast", "lunch", "dinner", "snack"},
				"description": "The meal they named, if any. 'unstated' when they named none.",
			},
			"food_words": map[string]any{
				"type":  "array",
				"items": map[string]any{"type": "string"},
				"description": "The athlete's own words for the food itself, if they named one — 'oatmeal', 'shake'. " +
					"Not occasions or habits like 'usual' or 'post-workout'. Empty when they pointed at a whole meal or day.",
			},
		},
		"required":             []any{"refers_to_logged_food", "day", "days_ago", "weekday", "month_day", "meal", "food_words"},
		"additionalProperties": false,
	}
}
