package exercise

import (
	"reflect"
	"testing"
)

// The tokenizer and the synonym expansion, which are the two pieces that decide
// whether a typed query can reach a row at all. The database half is in
// search_postgres_test.go.

func TestTokensIgnorePunctuationAndPlurals(t *testing.T) {
	for _, c := range []struct {
		in   string
		want []string
	}{
		// The hyphen is the catalog's, not the athlete's: "EZ-Bar" is stored
		// hyphenated and nobody types it that way.
		{"ez-bar curls", []string{"ez", "bar", "curl"}},
		{"EZ Bar Curls", []string{"ez", "bar", "curl"}},
		{"  incline   dumbbell  bench ", []string{"incline", "dumbbell", "bench"}},
		// Plural stripping is one rule, not a dictionary, so it has to be
		// conservative at the edges.
		{"press", []string{"press"}}, // -ss is never a plural
		{"legs", []string{"leg"}},    // ...but 4 letters is
		{"abs", []string{"abs"}},     // too short to strip safely
		{"90/90 hip switch", []string{"90", "90", "hip", "switch"}},
		{"!!!", nil},
	} {
		got := searchTokens(c.in)
		if len(got) == 0 && len(c.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("searchTokens(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestASynonymIsAdditiveNeverASubstitution(t *testing.T) {
	// The typed word always survives, because a synonym is a second reading
	// rather than a correction: "bench" must still find rows that say bench.
	got := expandedQuery("incline dumbbell bench")
	for _, want := range []string{"incline", "dumbbell", "bench", "press"} {
		if !contains(got, want) {
			t.Errorf("expandedQuery(...) = %q, missing %q", got, want)
		}
	}
}

func TestAQueryOfPunctuationMatchesNothingRatherThanEverything(t *testing.T) {
	// A stray keystroke must not return the whole catalog, and this is the
	// exact regression this change shipped once: an EMPTY clause read as "no
	// constraint" and `%` returned all 762 exercises — the behaviour the old
	// escaping existed to prevent. `TestPostgresRepository_ListFilters` caught
	// it, and this pins the cause rather than the symptom.
	//
	// `false`, not "": a clause that always means something is one no caller
	// can misread.
	for _, q := range []string{"!!!", "%", "_", `\`} {
		clause, args := SearchClause(q, 1)
		if clause != "false" {
			t.Errorf("SearchClause(%q) = %q, want %q", q, clause, "false")
		}
		if len(args) != 0 {
			t.Errorf("SearchClause(%q) bound %d args, want 0", q, len(args))
		}
	}
}

func TestEveryTypedWordMustMatchAndItsSynonymsAreAlternatives(t *testing.T) {
	// The shape of the whole design in one assertion: AND across the words the
	// athlete typed, OR within each word's meanings. Reversed — OR across
	// words — a three-word query returns most of the catalog.
	clause, args := SearchClause("dumbbell bench", 1)
	if got := countOf(clause, " AND "); got != 1 {
		t.Errorf("clause %q has %d ANDs, want 1 (one per typed word boundary)", clause, got)
	}
	if got := countOf(clause, " OR "); got != 1 {
		t.Errorf("clause %q has %d ORs, want 1 (bench -> press)", clause, got)
	}
	// dumbbell(1) + bench(1) + press(1)
	if len(args) != 3 {
		t.Errorf("bound %d args, want 3", len(args))
	}
}

func TestPlaceholdersStartWhereTheCallerSaysTheyDo(t *testing.T) {
	// The caller has usually bound a sport filter already; numbering from 1
	// regardless would silently reuse its placeholder and search for the sport.
	clause, _ := SearchClause("curl", 4)
	if !contains(clause, "$4") {
		t.Errorf("clause %q does not start at $4", clause)
	}
	if contains(clause, "$1") {
		t.Errorf("clause %q reuses $1, which belongs to the caller", clause)
	}
}

func contains(s, sub string) bool { return len(s) >= len(sub) && indexOf(s, sub) >= 0 }

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func countOf(s, sub string) int {
	n, i := 0, 0
	for {
		j := indexOf(s[i:], sub)
		if j < 0 {
			return n
		}
		n++
		i += j + len(sub)
	}
}
