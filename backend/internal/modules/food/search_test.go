package food

import (
	"strings"
	"testing"
)

// Every assertion here should fail if the guard it covers is deleted. The
// mobile suite's rule, applied to the backend: a test that passes either way
// documents nothing.

func TestSearchTokens(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		// Punctuation separates rather than matching. USDA descriptions are
		// commas all the way down, so this is the common case, not the exotic
		// one.
		{"commas and hyphens split", "Chicken, broiler-fryers", []string{"chicken", "broiler", "fryer"}},
		{"plural dropped", "oats", []string{"oat"}},
		{"plural dropped on each word", "grapes apples", []string{"grape", "apple"}},
		// Guarding the length rule from both ends.
		{"short word keeps its s", "as", []string{"as"}},
		{"double s survives", "grass", []string{"grass"}},
		{"four letters is long enough", "eggs", []string{"egg"}},
		{"pure punctuation yields nothing", "%%% !!!", nil},
		{"empty yields nothing", "", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := searchTokens(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("searchTokens(%q) = %v, want %v", tc.in, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("searchTokens(%q) = %v, want %v", tc.in, got, tc.want)
				}
			}
		})
	}
}

// The tokenless query is the one that regressed in the exercise catalog and
// returned all 762 rows. `false` rather than an empty clause is the guard.
func TestSearchClauseRefusesATokenlessQuery(t *testing.T) {
	clause, args := SearchClause("%", 1)
	if clause != "false" {
		t.Fatalf("clause for %%: got %q, want %q — an empty clause reads as no filter and returns the whole catalog", clause, "false")
	}
	if len(args) != 0 {
		t.Fatalf("tokenless query bound %d args, want 0", len(args))
	}
}

func TestHasSearchableTerm(t *testing.T) {
	// The handler decides query_unusable from this BEFORE running a query.
	// Getting it wrong turns "nothing was asked" into "we do not have it".
	for _, q := range []string{"%", "!!!", "", "   ", "-"} {
		if HasSearchableTerm(q) {
			t.Errorf("HasSearchableTerm(%q) = true, want false", q)
		}
	}
	for _, q := range []string{"skyr", "chicken breast", "a1"} {
		if !HasSearchableTerm(q) {
			t.Errorf("HasSearchableTerm(%q) = false, want true", q)
		}
	}
}

// Terms are ANDed. The technique library's entry is explicit that ORing them
// is the bug — `knee belly` must not return all 19 knee techniques.
func TestSearchClauseAndsItsTerms(t *testing.T) {
	clause, args := SearchClause("chicken breast", 1)
	if !strings.Contains(clause, " AND ") {
		t.Fatalf("two terms produced no AND: %q", clause)
	}
	if strings.Contains(clause, ") OR (") {
		t.Fatalf("terms were ORed, which returns half the catalog for a two-word query: %q", clause)
	}
	// Each term is tried against the name and against the aliases, so two
	// terms bind two args and produce four predicates.
	if len(args) != 2 {
		t.Fatalf("bound %d args for two terms, want 2", len(args))
	}
}

// Name and aliases are kept APART. Concatenating them would let one typed word
// match across the boundary between two unrelated aliases — the defect that
// made `arm bar` return nothing.
func TestSearchClauseMatchesAliasesSeparatelyFromName(t *testing.T) {
	clause, _ := SearchClause("aubergine", 1)
	if !strings.Contains(clause, "f.name ILIKE") {
		t.Fatalf("clause does not match the name: %q", clause)
	}
	if !strings.Contains(clause, "unnest(f.aliases)") {
		t.Fatalf("clause does not match aliases: %q", clause)
	}
	// unnest is what keeps each alias its own string. A join would defeat it.
	if strings.Contains(clause, "array_to_string") {
		t.Fatalf("aliases were joined into one string, which lets a term straddle two of them: %q", clause)
	}
}

// A synonym has to make a row MATCH and be able to make it RANK. The exercise
// catalog shipped the bug where it did only the first.
func TestSynonymsReachBothMatchingAndRanking(t *testing.T) {
	clause, args := SearchClause("courgette", 1)
	if len(args) < 2 {
		t.Fatalf("courgette bound %d args — the zucchini synonym did not reach the WHERE", len(args))
	}
	if !strings.Contains(clause, " OR ") {
		t.Fatalf("synonym alternatives were not ORed within the term: %q", clause)
	}
	found := false
	for _, a := range args {
		if s, ok := a.(string); ok && strings.Contains(s, "zucchini") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no zucchini term bound for query 'courgette': %v", args)
	}

	if got := expandedQuery("courgette"); !strings.Contains(got, "zucchini") {
		t.Fatalf("expandedQuery(courgette) = %q — ranking cannot see the synonym that made the row match", got)
	}
	// Additive, not substitutive: a synonym is a second reading, not a
	// correction, so the typed word must survive.
	if got := expandedQuery("courgette"); !strings.Contains(got, "courgette") {
		t.Fatalf("expandedQuery dropped the typed word: %q", got)
	}
}

// Paging is only correct if the sort is total. similarity() ties constantly
// across a catalog of similar names, and a tie broken differently per query
// repeats rows on one page and skips them on the next.
func TestSearchRankIsDeterministic(t *testing.T) {
	order, args := SearchRank("chicken", 3)
	if !strings.Contains(order, "f.id ASC") {
		t.Fatalf("rank has no total tie-break: %q — LIMIT/OFFSET over a non-deterministic sort silently repeats and skips rows", order)
	}
	if !strings.Contains(order, "similarity(f.name") {
		t.Fatalf("rank dropped the similarity tiebreak: %q", order)
	}
	// rank_tier is the PRIMARY signal since N88, and it must come first in the
	// ORDER BY or it is not doing the job: 803 catalog rows contain "chicken",
	// and both signals below tie between the curated "Chicken breast" and
	// FNDDS's "Chicken breast, fried, coated, ...".
	if !strings.HasPrefix(order, "f.rank_tier ASC, ") {
		t.Fatalf("rank_tier is not the primary sort key: %q", order)
	}
	// Lead position stays the primary signal AMONG rows of equal tier — it is
	// what decides the order across the 12,474 bulk rows, where no curated row
	// matches at all. See the lunchmeat case.
	if !strings.Contains(order, "f.rank_tier ASC, COALESCE(LEAST(") {
		t.Fatalf("lead position does not follow rank_tier: %q", order)
	}
	if len(args) == 0 || args[len(args)-1] != "chicken" {
		t.Fatalf("rank args = %v, want the expanded query last", args)
	}
	if !strings.Contains(order, "$3") {
		t.Fatalf("rank ignored startAt: %q", order)
	}
}

// strpos returns 0 for "not present". Treating that as a position would rank
// every row that does NOT contain the word ahead of every row that does —
// exactly inverted — so the NULLIF is load-bearing.
func TestSearchRankTreatsAnAbsentWordAsWorstNotBest(t *testing.T) {
	order, _ := SearchRank("chicken", 1)
	if !strings.Contains(order, "NULLIF(strpos(") {
		t.Fatalf("absent words are not excluded from LEAST: %q — strpos returns 0 when absent, which would sort non-matches first", order)
	}
	if !strings.Contains(order, "9999") {
		t.Fatalf("no fallback for a row matched only through an alias: %q", order)
	}
}

// The placeholder numbering must continue from where the caller left off, or
// the query binds the wrong values to the wrong predicates.
func TestSearchClauseStartsAtTheGivenPlaceholder(t *testing.T) {
	clause, _ := SearchClause("oats", 7)
	if !strings.Contains(clause, "$7") {
		t.Fatalf("clause ignored startAt: %q", clause)
	}
	if strings.Contains(clause, "$1") {
		t.Fatalf("clause reused $1 despite startAt=7, which would rebind a caller's argument: %q", clause)
	}
}
