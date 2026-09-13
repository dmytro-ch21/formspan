package narration

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// The server-side fabricated-fact guard. **The same three rules as
// `apps/mobile/lib/narrationGuard.ts`**, held in step by the shared cases in
// `evals/day-narration/guard_vectors.json`, which both sides' tests read:
//
//  1. A sentence cites at least one fact.
//  2. Every citation is a key of a fact that was sent.
//  3. Every number in the sentence, once the cited facts' own names are removed,
//     is a number one of the cited facts states.
//
// A failing sentence is dropped whole, never repaired. Rewriting a number would
// be the guard inventing one.
//
// It runs here as well as on the phone because this is where model output
// first exists. Nothing the model wrote leaves the server unguarded, even for a
// client that forgot to run its own copy.

// Sentence is one narrated sentence and the fact keys it rests on.
type Sentence struct {
	Text  string   `json:"text"`
	Cites []string `json:"cites"`
}

// Dropped is a sentence the guard refused, and why.
type Dropped struct {
	Sentence Sentence `json:"sentence"`
	// Reason is `no-citation`, `unknown-key` or `unbacked-number`.
	Reason string `json:"reason"`
	// Detail names what failed: the unknown keys or the unbacked numbers.
	Detail string `json:"detail"`
}

// Verdict is what the guard kept and dropped, each in input order.
type Verdict struct {
	Kept    []Sentence
	Dropped []Dropped
}

// numberPattern is a number as it can appear in prose. It is the phone's
// `NUMBER` pattern. RE2's `\d` is ASCII-only, like JavaScript's without the `u`
// flag, so both sides see the same digits.
var numberPattern = regexp.MustCompile(`\d[\d,]*(?:\.\d+)?`)

// stripNames removes each name from the text, longest first, so "5x5 Day 2" is
// removed whole before "5x5 Day" could split it.
//
// Length is counted in code points on both sides (`[...name].length` on the
// phone), so two names that tie sort identically in JavaScript and Go.
func stripNames(text string, names []string) string {
	sorted := append([]string(nil), names...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return utf8.RuneCountInString(sorted[i]) > utf8.RuneCountInString(sorted[j])
	})
	for _, name := range sorted {
		if name != "" {
			text = strings.ReplaceAll(text, name, " ")
		}
	}
	return text
}

// Guard checks narrated sentences against the facts they may rest on.
func Guard(sentences []Sentence, facts []Fact) Verdict {
	byKey := make(map[string]Fact, len(facts))
	for _, f := range facts {
		byKey[f.Key] = f
	}
	v := Verdict{Kept: []Sentence{}, Dropped: []Dropped{}}
	for _, s := range sentences {
		if len(s.Cites) == 0 {
			v.Dropped = append(v.Dropped, Dropped{Sentence: s, Reason: "no-citation", Detail: "cites no fact"})
			continue
		}
		var unknown []string
		for _, key := range s.Cites {
			if _, ok := byKey[key]; !ok {
				unknown = append(unknown, key)
			}
		}
		if len(unknown) > 0 {
			v.Dropped = append(v.Dropped, Dropped{Sentence: s, Reason: "unknown-key", Detail: strings.Join(unknown, ", ")})
			continue
		}
		backed := map[string]bool{}
		var names []string
		for _, key := range s.Cites {
			f := byKey[key]
			for _, n := range f.Numbers {
				backed[normalise(n)] = true
			}
			names = append(names, f.Names...)
		}
		var unbacked []string
		for _, raw := range numberPattern.FindAllString(stripNames(s.Text, names), -1) {
			if n := normalise(raw); !backed[n] {
				unbacked = append(unbacked, n)
			}
		}
		if len(unbacked) > 0 {
			v.Dropped = append(v.Dropped, Dropped{Sentence: s, Reason: "unbacked-number", Detail: strings.Join(unbacked, ", ")})
			continue
		}
		v.Kept = append(v.Kept, s)
	}
	return v
}
