package food

import (
	"fmt"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// Finding a food by the words a person would actually type.
//
// This repo has already paid for getting this wrong once. The technique
// library folded every field into one string and ran a contiguous match, so
// `arm bar` found nothing while `armbar` found 21 — "a space the catalog does
// not have". The exercise catalog had the same defect against a different
// vocabulary: `ez bar curls` missed `EZ-Bar Curl`.
//
// A food catalog fails in both of those ways plus a third, because its rows
// are written by a US government nutrient database and read by a person
// standing in a kitchen:
//
//	typed              catalog row
//	"chicken breast"   "Chicken, broiler or fryers, breast, skinless, ..."
//	"greek yoghurt"    "Yogurt, Greek, plain, nonfat"
//	"courgette"        "Squash, summer, zucchini, includes skin, raw"
//
// Three different failures. Word order, spelling, and vocabulary — and only
// the first is fixed by fuzzy matching.
//
// # Word order — match each word independently
//
// "chicken breast" is both words of the stored name in the right order and
// still not a contiguous substring, because USDA puts a comma and three
// qualifiers between them. Matching each token separately fixes this class,
// and it is the largest one here.
//
// # Vocabulary — synonyms, and they are NOT fixable by fuzzy matching
//
// "courgette" and "zucchini" share no letters worth counting; no amount of
// trigram similarity bridges them. Two mechanisms handle it, and they are for
// different things:
//
//   - `synonyms` below is a closed list of GENERAL food vocabulary — the
//     British/American split, and the words a person says instead of the word
//     a nutrient database prints. It is small and hand-maintained on purpose,
//     the same bargain the exercise catalog struck: it grows when a word is
//     genuinely ambiguous, not when a row is added.
//   - `aliases` on the row is for THAT FOOD ONLY, and is where a per-row name
//     goes. "Aubergine" is general; "ahi" for yellowfin tuna is not.
//
// Putting a per-food name in `synonyms` would apply it to every query in the
// catalog, which is how a synonym list becomes unmaintainable.
var synonyms = map[string][]string{
	// The British/American split. Both directions, because the catalog is US
	// and the athlete may be neither.
	"yoghurt":   {"yogurt"},
	"yogurt":    {"yoghurt"},
	"aubergine": {"eggplant"},
	"eggplant":  {"aubergine"},
	"courgette": {"zucchini"},
	"zucchini":  {"courgette"},
	"prawn":     {"shrimp"},
	"shrimp":    {"prawn"},
	"coriander": {"cilantro"},
	"cilantro":  {"coriander"},
	"rocket":    {"arugula"},
	"beetroot":  {"beet"},
	"maize":     {"corn"},
	"swede":     {"rutabaga"},
	// "Mince" is what most of the world calls ground meat, and the catalog
	// says "ground" every time.
	"mince": {"ground"},
	// A person types the dish; the catalog stores the grain.
	"porridge": {"oat"},
	"oatmeal":  {"oat"},
	// Legume naming is genuinely split down the middle.
	"chickpea": {"garbanzo"},
	"garbanzo": {"chickpea"},
	// Said far more often than the catalog's spelling.
	"scallion": {"onion"},
	"soda":     {"cola"},
	// Abbreviations that are near-universal in a food log.
	"pb":  {"peanut butter"},
	"oj":  {"orange juice"},
	"veg": {"vegetable"},
}

// maxSearchTokens bounds how much of a query is used. See searchTokens.
const maxSearchTokens = 10

// searchTokens splits a query into the words to match on.
//
// Punctuation separates rather than matching, so "ez-bar" and "ez bar" are one
// query — and here it matters more than it did for exercises, because USDA
// descriptions are commas all the way down. Trailing plurals go too: "oats"
// must find "Oat", "eggs" must find "Egg". That is one rule instead of a
// dictionary, and it is the single most common way a typed food query misses.
func searchTokens(q string) []string {
	fields := strings.FieldsFunc(strings.ToLower(q), func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9')
	})
	// Bounded, and this is a real limit rather than tidiness. Each token
	// expands to up to four alternatives, each binding a placeholder used by
	// two predicates in the WHERE and one `strpos` in the ORDER BY — so an
	// unbounded query builds SQL that grows with what somebody typed, and past
	// ~65k parameters pgx fails outright, turning a pasted wall of text into a
	// 500. Ten tokens is far beyond any real food query. Raised in review.
	if len(fields) > maxSearchTokens {
		fields = fields[:maxSearchTokens]
	}
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		// Only a trailing "s", and only when dropping it leaves something to
		// match: "s" and "as" are not plurals, and "grass" must not lose its
		// last letter.
		if len(f) > 3 && strings.HasSuffix(f, "s") && !strings.HasSuffix(f, "ss") {
			f = strings.TrimSuffix(f, "s")
		}
		out = append(out, f)
	}
	return out
}

// HasSearchableTerm reports whether a query contains anything to match on.
//
// Exported because the handler needs it BEFORE running a query: a query of
// pure punctuation must come back as OutcomeQueryUnusable, which is a
// materially different statement from "we do not have that food". Deciding it
// from an empty result set would be exactly the absence-as-answer bug this
// package exists to avoid.
func HasSearchableTerm(q string) bool { return len(searchTokens(q)) > 0 }

// SearchClause builds the WHERE fragment for a catalog search, with the
// arguments it binds.
//
// **Every token must match, and a token matches if IT or any of its synonyms
// appears in the name OR in one of the row's aliases.** AND across the words
// typed, OR within one word's meanings and across the fields it may land in.
//
// That AND is what keeps "chicken breast" from returning every chicken row,
// and the technique-library entry is explicit that ORing terms is the bug:
// `knee belly` must not return all 19 knee techniques.
//
// **Name and aliases are kept apart for MATCHING PURPOSES, rather than
// concatenated**, which is the other half of that lesson. Joining them into
// one string and matching against THAT would let a single token match across
// the boundary between two unrelated names -- the exact defect that made
// `arm bar` behave the way it did. `unnest` keeps each alias its own string
// for the clause that actually DECIDES a match, so a term must live inside
// one of them. See TestSearchClauseRejectsATermThatCrossesAnAliasBoundary
// below, and the Postgres-integration counterpart in postgres_test.go, for
// that guarantee checked directly against real rows.
//
// # N109 -- the alias OR used to defeat food_catalog_name_trgm_idx
//
// Each token's clause used to be one flat OR: `f.name ILIKE $n OR EXISTS
// (SELECT 1 FROM unnest(f.aliases) ...)`. An OR against a correlated
// subquery forces Postgres to Seq Scan -- a GIN bitmap scan cannot be built
// for one branch of an OR whose other branch is a subplan. Measured at
// 12,651 rows on `chicken breast`: Seq Scan, 12,588 rows filtered, 31.6ms
// (N88's original measurement) / 14.6ms (re-measured for this fix, same
// plan, different hardware). The SAME predicate with the alias half removed
// plans as a Bitmap Index Scan and runs in 0.97ms / 0.66ms.
//
// The fix ANDs in an indexable OVER-APPROXIMATION alongside the original,
// UNCHANGED exact clause, per token:
//
//	(f.name ILIKE $n OR f.aliases_text ILIKE $n)                        -- prefilter, indexable
//	AND
//	(f.name ILIKE $n OR EXISTS (SELECT 1 FROM unnest(f.aliases) ...))   -- exact, unchanged
//
// `aliases_text` (migration 000078) is `aliases` joined with a space and
// carries its own trigram GIN index. **It is provably a superset of the
// exact clause, never a substitute for it**: if some alias element contains
// the typed substring, the joined string still contains that same run of
// characters -- joining can only add text AROUND a match, never break one
// apart -- so `exact` implies `prefilter`, which makes `prefilter AND exact`
// logically identical to `exact` alone for every row, for every query this
// function can build. What changes is that Postgres now has an index to
// bitmap-scan for CANDIDATES (on `name` and on `aliases_text`, combined via
// BitmapOr/BitmapAnd), applying the untouched `EXISTS` clause only as a
// Recheck/Filter on that narrowed set instead of against all 12,651 rows.
//
// This is also why the alias-boundary guarantee above survives having
// `aliases_text` in the query at all: `aliases_text` can only ever produce a
// FALSE-POSITIVE CANDIDATE, never a false-positive RESULT, because the final
// answer is always gated by the unchanged `EXISTS` clause, which only ever
// looks inside one alias at a time. A prefilter that is a safe superset
// cannot narrow a correct result into a wrong one; it can only be redundant.
//
// That candidate can genuinely be a false positive, and it is worth being
// precise about when. A single-WORD token can never cross the seam: the join
// separator is a space, `searchTokens` never emits a token containing one, so
// a contiguous ILIKE match cannot straddle it either — `{'arm','bar'}` joins
// to `'arm bar'`, which does not contain `armbar`. The real case is
// `synonyms`, whose VALUES are used as-is rather than re-tokenized, and a few
// of them contain a literal space (`synonyms["pb"] = {"peanut butter"}`).
// Two aliases like `{'... peanut', 'butter ...'}`, neither containing
// "peanut butter" alone, DO produce it at the seam once joined — a query for
// "pb" is a real false-positive CANDIDATE there. The `EXISTS` recheck is what
// still correctly rejects it; see
// TestSearchRejectsATermThatCrossesAnAliasBoundary in postgres_test.go, which
// is built on exactly this shape (mutation-tested: dropping the `EXISTS`
// recheck and keeping only `aliases_text` makes that test fail on "pb").
//
// `startAt` is the first placeholder number this may use, because the caller
// has already bound others.
func SearchClause(query string, startAt int) (string, []any) {
	tokens := searchTokens(query)
	if len(tokens) == 0 {
		// A query that is ALL punctuation -- "%", "_", "!!!".
		//
		// Returns a FALSE clause, never an empty one. An empty string leaves
		// the caller to decide what no constraint means, and the obvious
		// reading -- "no clause, so no filter" -- hands back the whole catalog
		// for a single stray "%". The exercise catalog regressed exactly that
		// way and returned all 762 rows for a one-character query.
		return "false", nil
	}

	var (
		clauses []string
		args    []any
		n       = startAt
	)
	for _, tok := range tokens {
		// The literal token first, so the most direct reading is always in the
		// set even when a synonym is wrong for this particular query.
		alts := append([]string{tok}, synonyms[tok]...)
		// "smoothie" -> "smoothi" would match nothing; adding the e-stripped
		// form as an ALTERNATIVE can only widen. Substituting it would break
		// words where the "e" is real.
		if strings.HasSuffix(tok, "e") && len(tok) > 4 {
			alts = append(alts, strings.TrimSuffix(tok, "e"))
		}
		var (
			exact     = make([]string, 0, len(alts)*2)
			prefilter = make([]string, 0, len(alts)*2)
		)
		for _, alt := range alts {
			args = append(args, database.LikeTerm(alt))
			// One placeholder, bound ONCE, referenced by BOTH clauses below --
			// there is exactly one term per alt either way, so the arg count
			// callers (and the tests) rely on is unchanged from before N109.
			nameClause := database.LikeClause("f.name", n)
			exact = append(exact, nameClause,
				fmt.Sprintf(
					"EXISTS (SELECT 1 FROM unnest(f.aliases) AS alias WHERE %s)",
					database.LikeClause("alias", n)))
			prefilter = append(prefilter, nameClause,
				database.LikeClause("f.aliases_text", n))
			n++
		}
		// prefilter AND exact -- never prefilter OR exact, and never
		// prefilter alone. See the block comment above for why that AND is a
		// no-op on the RESULT rather than a weakening of it.
		clauses = append(clauses,
			"("+strings.Join(prefilter, " OR ")+")"+
				" AND "+
				"("+strings.Join(exact, " OR ")+")")
	}
	return strings.Join(clauses, " AND "), args
}

func SearchRank(query string, startAt int) (string, []any) {
	tokens := searchTokens(query)
	if len(tokens) == 0 {
		// Unreachable through Search (a tokenless query short-circuits to a
		// false clause), but a stable order is still the right answer to "sort
		// nothing" — and it keeps this function total.
		return "f.rank_tier ASC, f.id ASC", nil
	}

	var (
		args  []any
		leads []string
		n     = startAt
	)
	for _, tok := range tokens {
		for _, alt := range append([]string{tok}, synonyms[tok]...) {
			args = append(args, alt)
			// strpos returns 0 when absent; NULLIF turns that into NULL so
			// LEAST skips it rather than treating "not present" as the best
			// possible position. Getting that wrong would rank every
			// non-matching row first.
			leads = append(leads, fmt.Sprintf("NULLIF(strpos(lower(f.name), $%d), 0)", n))
			n++
		}
	}
	// COALESCE because LEAST returns NULL only when every argument is NULL —
	// a row matched through an alias rather than the name, where no typed word
	// appears in the name at all. Those sort last among matches, which is
	// right: an alias hit is a weaker signal than a name hit.
	lead := fmt.Sprintf("COALESCE(LEAST(%s), 9999) ASC", strings.Join(leads, ", "))

	args = append(args, expandedQuery(query))
	sim := fmt.Sprintf("similarity(f.name, $%d) DESC", n)

	// rank_tier FIRST — ahead of both signals above. See the block comment
	// above this function for why neither of them can do this job.
	return "f.rank_tier ASC, " + lead + ", " + sim + ", f.id ASC", args
}

// expandedQuery is the query with every token's synonyms appended.
//
// Ranking has to speak the SAME vocabulary as matching. A row a synonym made
// MATCH must be able to rank on it too, or "courgette" finds the zucchini row
// through the synonym and then sorts below anything that happens to share
// letters with the typed word. The exercise catalog shipped that bug and it
// took a measured example to see it.
//
// Additive rather than substitutive — the typed words stay in — because a
// synonym is a second reading, not a correction.
func expandedQuery(query string) string {
	tokens := searchTokens(query)
	out := make([]string, 0, len(tokens)*2)
	for _, tok := range tokens {
		out = append(out, tok)
		out = append(out, synonyms[tok]...)
	}
	return strings.Join(out, " ")
}
