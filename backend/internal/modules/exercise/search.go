package exercise

import (
	"fmt"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// Finding an exercise by the words an athlete would actually use.
//
// The old search was one contiguous `ILIKE '%term%'`, which fails on both of
// the ways a person naturally misses. Measured against the three exercises a
// real athlete reported as "missing" from a 762-row catalog — every one of
// which was present:
//
//	typed                      catalog                            old search
//	"ez bar curls"             "EZ-Bar Curl"                      no results
//	"incline dumbbell bench"   "Incline Dumbbell Press"           no results
//	"dumbbell overhead press"  "Seated Dumbbell Shoulder Press"   no results
//
// Two different failures, and they need two different fixes.
//
// # Word order — trigrams
//
// "ez bar curls" is every word of "EZ-Bar Curl" in the right order and still
// matches nothing, because the stored name has a hyphen and a plural is not a
// substring. Matching each word independently fixes this class.
//
// # Vocabulary — synonyms, and trigrams DO NOT fix this
//
// The other two are not spellings. "Bench" and "press" are different words for
// one movement, as are "overhead" and "shoulder"; no amount of fuzzy string
// matching bridges them. Measured: with trigram similarity alone,
// `Incline Dumbbell Press` does not appear in the top three for "incline
// dumbbell bench" (the top hit is `Incline Bench Dumbbell Row` — a ROW, which
// is worse than nothing), and `Seated Dumbbell Shoulder Press` does not appear
// for "dumbbell overhead press".
//
// So `synonyms` exists, and it is deliberately SMALL. It is hand-maintained
// content, which this repository is rightly wary of — the per-side
// classification review is the standing reminder of what that costs. It earns
// its place by being a closed list of lifting vocabulary rather than a
// per-exercise mapping: it grows when a word is genuinely ambiguous in the
// gym, not when a row is added to the catalog.
var synonyms = map[string][]string{
	// A "bench" IS a bench press; the catalog often drops the word, so
	// `Incline Dumbbell Press` never matches somebody typing "bench".
	"bench": {"press"},
	// Overhead and shoulder pressing are the same movement under two names,
	// and the catalog uses "shoulder" while athletes usually say "overhead".
	"overhead": {"shoulder"},
	"shoulder": {"overhead"},
	// Both spellings of the bar are in circulation, and one of them is what a
	// person types.
	"ez":    {"ez-bar", "ez bar"},
	"ezbar": {"ez-bar", "ez bar"},
	// Said far more often than "biceps curl", and the catalog says neither.
	"bicep":   {"biceps"},
	"biceps":  {"bicep"},
	"tricep":  {"triceps"},
	"triceps": {"tricep"},
	// The catalog hyphenates these and people usually do not. "Pulldown" is
	// NOT here: the catalog spells it as one word, so the typed token already
	// matches and a synonym would be dead weight.
	"pullup": {"pull-up"},
	"chinup": {"chin-up"},
	"situp":  {"sit-up"},
	// A "db" is a dumbbell on every whiteboard in every gym.
	"db": {"dumbbell"},
	"kb": {"kettlebell"},
	"bb": {"barbell"},
	// Romanian deadlift, said as three letters far more often than as words.
	"rdl": {"romanian deadlift"},
}

// searchTokens splits a query into the words to match on.
//
// Punctuation is a separator, not a character to match: "ez-bar" and "ez bar"
// are the same query, and a hyphen in either the query or the stored name must
// not decide whether anything is found. Trailing plurals go too — "curls"
// finds "Curl" — because that is the single most common way a typed query
// misses, and it is one rule rather than a dictionary.
func searchTokens(q string) []string {
	fields := strings.FieldsFunc(strings.ToLower(q), func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9')
	})
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		// Only a trailing "s", and only on a word long enough that dropping it
		// leaves something to match: "s" and "as" are not plurals, and
		// "press" must not become "pres".
		if len(f) > 3 && strings.HasSuffix(f, "s") && !strings.HasSuffix(f, "ss") {
			f = strings.TrimSuffix(f, "s")
		}
		out = append(out, f)
	}
	return out
}

// SearchClause builds the WHERE fragment for a name search, and returns it
// alongside the arguments it binds.
//
// **Every token must match, and a token matches if IT or any of its synonyms
// appears** — an AND across the words the athlete typed, an OR within each
// word's meanings. That ordering is the whole design: AND keeps a three-word
// query from returning half the catalog, and OR is what lets "bench" find a
// row that says "press".
//
// `startAt` is the number of the first placeholder this may use, because the
// caller has already bound others.
//
// The returned clause is ALWAYS non-empty, so no caller has to decide what an
// unmatchable query means — see the tokenless case below for why that mattered.
func SearchClause(query string, startAt int) (string, []any) {
	tokens := searchTokens(query)
	if len(tokens) == 0 {
		// A query that is ALL punctuation — `%`, `_`, `\`, `!!!`.
		//
		// Matches NOTHING, and returning a false clause rather than an empty
		// one is the whole point: an empty string leaves the caller to decide,
		// and the obvious reading — "no clause, so no constraint" — hands back
		// the entire catalog for a single stray `%`. That is exactly what the
		// escaping in the old `LikeTerm` existed to prevent, and it regressed
		// here until `TestPostgresRepository_ListFilters` caught it: 762 rows
		// for a one-character query.
		//
		// The old behaviour is the right one and this reproduces it: `%` was
		// escaped to a literal percent sign, which no exercise name contains.
		return "false", nil
	}

	var (
		clauses []string
		args    []any
		n       = startAt
	)
	for _, tok := range tokens {
		// The token itself first, so the most literal reading is always in the
		// set even when a synonym is wrong for this particular query.
		alts := append([]string{tok}, synonyms[tok]...)
		// "crunches" loses its "s" above and becomes "crunche", which matches
		// none of the catalog's 8 `... Crunch` rows. Added as an ALTERNATIVE
		// rather than by replacing the token, so this can only ever widen: the
		// same rule would turn "hors" into "hor" if it were substitutive.
		if strings.HasSuffix(tok, "e") && len(tok) > 4 {
			alts = append(alts, strings.TrimSuffix(tok, "e"))
		}
		ors := make([]string, 0, len(alts))
		for _, alt := range alts {
			args = append(args, database.LikeTerm(alt))
			ors = append(ors, database.LikeClause("name", n))
			n++
		}
		clauses = append(clauses, "("+strings.Join(ors, " OR ")+")")
	}
	return strings.Join(clauses, " AND "), args
}

// SearchRank orders results by how close the whole name is to the whole query.
//
// The WHERE decides what is a match; this decides what is FIRST, and the two
// answer different questions. "incline dumbbell bench" matches both
// `Incline Dumbbell Press` and `Incline Bench Dumbbell Row` — the row contains
// every typed word literally — and similarity is what puts the press on top,
// which is the one the athlete meant.
//
// Uses `pg_trgm`'s `similarity`, installed since migration 000017 for the
// technique library. Note the trigram index added alongside this does NOT serve
// this ordering — GIN has no ordered scans, so similarity is computed per row
// and sorted. It serves the ILIKE predicates in the WHERE.
func SearchRank(query string, n int) (string, any) {
	return fmt.Sprintf("similarity(name, $%d) DESC", n), expandedQuery(query)
}

// expandedQuery is the query with every token's synonyms appended.
//
// Ranking has to speak the SAME vocabulary as matching, and getting this wrong
// is subtle enough to have shipped: ranked against the raw text, "incline
// dumbbell bench" puts `Incline Bench Dumbbell Row` first — it contains all
// three typed words literally — and buries `Incline Dumbbell Press`, which is
// the one the athlete meant. Against "incline dumbbell bench press" the press
// wins (0.79 to 0.70).
//
// So the synonym that made a row MATCH must also be able to make it rank. The
// expansion is additive rather than substitutive — the typed words stay in —
// because a synonym is a second reading, not a correction.
func expandedQuery(query string) string {
	tokens := searchTokens(query)
	out := make([]string, 0, len(tokens)*2)
	for _, tok := range tokens {
		out = append(out, tok)
		out = append(out, synonyms[tok]...)
	}
	return strings.Join(out, " ")
}
