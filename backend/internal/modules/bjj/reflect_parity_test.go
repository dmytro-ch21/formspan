package bjj

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// The shipped prompt is the prompt that was measured, or the measurement is
// about nothing.
//
// N37 ran `evals/bjj-dictation/prompt.py` against the corpus and published the
// numbers this feature's tier choice rests on — `gpt-5.6-luna` at 0.0%
// invention and 0.905 tag F1, `gpt-5.4-nano` at 24.2% and 0.708. A score
// describes the prompt, the schema and the post-processing it was run against.
// Change any of the three here and every one of those numbers silently becomes
// a claim about software that no longer exists, which is worse than having no
// numbers at all: nobody re-runs an eval whose result they still believe.
//
// So this fails when the two drift. It is a SYNTACTIC check, matching
// `scripts/check-grip-parity.py` and its neighbours — it pins the text and the
// vocabularies, not the behaviour around them — and that bound is the honest
// one to state. What it cannot see: whether `ResolveDraft` still does what
// `postprocess` in run.py does. Those are prose-to-prose, and the eval's own
// docstring is where that correspondence is written down.
//
// When the prompt genuinely needs to change, the order is: change prompt.py,
// re-run `run.py` against both tiers, record the numbers in the eval README,
// then copy the text across and update this test's expectations if the shape
// moved. Not the other way round.

func evalPrompt(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(repoFile(t, filepath.Join("evals", "bjj-dictation", "prompt.py")))
	if err != nil {
		t.Fatalf("reading the eval prompt: %v", err)
	}
	return string(raw)
}

// pythonList pulls the strings out of a top-level list literal.
func pythonList(t *testing.T, src, name string) []string {
	t.Helper()
	re := regexp.MustCompile(name + `\s*=\s*\[([^\]]*)\]`)
	m := re.FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("could not find %s in prompt.py — the parser has fallen behind the file; fix it, do not delete the check", name)
	}
	var out []string
	for _, s := range regexp.MustCompile(`"([^"]*)"`).FindAllStringSubmatch(m[1], -1) {
		out = append(out, s[1])
	}
	if len(out) == 0 {
		t.Fatalf("%s parsed as empty — this check would pass vacuously", name)
	}
	return out
}

func TestTheShippedRulesAreTheRulesTheEvalMeasured(t *testing.T) {
	src := evalPrompt(t)

	const marker = `SYSTEM_RULES = """\` + "\n"
	i := strings.Index(src, marker)
	if i < 0 {
		t.Fatal("could not find SYSTEM_RULES in prompt.py — fix this parser rather than deleting the check")
	}
	rest := src[i+len(marker):]
	j := strings.Index(rest, `"""`)
	if j < 0 {
		t.Fatal("SYSTEM_RULES is not terminated in prompt.py")
	}
	want := rest[:j]

	if draftSystemRules != want {
		t.Errorf("reflect_rules.txt has drifted from prompt.py's SYSTEM_RULES.\n"+
			"Every published eval number describes THAT text, so they no longer describe what ships.\n"+
			"len(shipped) = %d, len(eval) = %d", len(draftSystemRules), len(want))
	}
}

func TestTheShippedVocabulariesAreTheOnesTheEvalMeasured(t *testing.T) {
	src := evalPrompt(t)

	for _, tc := range []struct {
		name    string
		shipped []string
	}{
		{"CATEGORIES", categoryStrings()},
		{"EVENTS", eventStrings()},
		{"KINDS", kindStrings()},
	} {
		want := pythonList(t, src, tc.name)
		if strings.Join(tc.shipped, ",") != strings.Join(want, ",") {
			t.Errorf("%s drifted: shipped %v, eval %v", tc.name, tc.shipped, want)
		}
	}
}

// The prompt is assembled the same way on both sides, catalog and all. The
// rules alone are not the prompt: `system_prompt` in prompt.py appends a header
// line and the catalog block, and a header that said something else would be a
// different prompt with the same rules in it.
func TestTheCatalogIsAssembledTheWayTheEvalAssembledIt(t *testing.T) {
	cat := fixtureCatalog()
	got := draftSystemPrompt(cat)

	if !strings.HasPrefix(got, draftSystemRules) {
		t.Fatal("the system prompt does not start with the measured rules")
	}
	// `f"{SYSTEM_RULES}\nCATALOG ({len(techniques)} techniques)\n{catalog_block}\n"`
	wantHeader := fmt.Sprintf("\nCATALOG (%d techniques)\n", cat.Len())
	if !strings.Contains(got, wantHeader) {
		t.Errorf("catalog header missing or reworded; want %q", wantHeader)
	}
	// `f"{t['id']} · {t['name']} · {t.get('position', '')}"`
	if !strings.Contains(got, "armbar-closed-guard · Armbar from Closed Guard · Guard - Bottom") {
		t.Errorf("catalog line format drifted from `id · name · position`:\n%s", got)
	}
	if !strings.HasSuffix(got, "\n") {
		t.Error("the assembled prompt does not end in a newline, as prompt.py's does")
	}
}

// Sorted by id, which is what makes the ~10,600-token block cacheable: prompt
// caching is a prefix match, so an order that wandered between calls would
// re-bill the whole catalog every time. N37 measured 350,687 of 350,786 input
// tokens coming back cached; losing the sort loses that.
func TestTheCatalogBlockIsSortedByID(t *testing.T) {
	cat := NewCatalog([]CatalogEntry{
		{ID: "zzz", Name: "Z", Category: "Sweep", Position: "Guard - Bottom"},
		{ID: "aaa", Name: "A", Category: "Sweep", Position: "Guard - Bottom"},
		{ID: "mmm", Name: "M", Category: "Sweep", Position: "Guard - Bottom"},
	}, []string{"Guard"})

	lines := strings.Split(cat.CatalogBlock(), "\n")
	if len(lines) != 3 {
		t.Fatalf("catalog block has %d lines, want 3", len(lines))
	}
	for i, want := range []string{"aaa", "mmm", "zzz"} {
		if !strings.HasPrefix(lines[i], want+" ") {
			t.Errorf("line %d = %q, want it to start with %q", i, lines[i], want)
		}
	}
}

// The whole live catalog loads, and it is the one the eval scored against.
//
// 542 is the number in the eval README and in `run.py`'s own prompt build, so a
// seeded library that quietly grew or shrank would change what the model is
// offered without anything noticing. Asserted as a floor rather than an
// equality — the console can author new techniques into the seed file, and that
// is a feature — but a catalog that has LOST entries is a broken deploy.
func TestTheProductionCatalogLoadsWithTheLibraryAndItsFamilies(t *testing.T) {
	cat, err := TechniqueCatalog()
	if err != nil {
		t.Fatalf("loading the production catalog: %v", err)
	}
	if cat.Len() < 542 {
		t.Errorf("catalog has %d techniques, want at least the 542 the eval measured", cat.Len())
	}
	if got := len(cat.Families()); got != 9 {
		t.Errorf("families = %d, want the 9 the tag vocabulary uses: %v", got, cat.Families())
	}
	// Every family is a real prefix of some technique's position, or `familyOf`
	// returns "" for it forever and a whole slice of the funnel never joins.
	for _, f := range cat.Families() {
		found := false
		for _, e := range cat.entries {
			if familyOf(e.Position, cat.Families()) == f {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("family %q matches no technique's position", f)
		}
	}
}

// F29 (#785): the eval floors an unspoken count the way ResolveDraft does,
// through a Python port of numberWords, wordSplit and spokenNumber in
// scripts/check-dictation-evals.py. A port is a second copy, so it is held in
// step two ways. The vocabulary and the split are compared here, entry for entry
// and in order, because the compound rule reads each list's FIRST form. And both
// languages answer the same vectors in evals/bjj-dictation/spoken_numbers.json:
// this test runs them through spokenNumber, and check-dictation-evals.py runs
// them through the port.
func TestTheEvalCountsSpokenNumbersTheWayGoDoes(t *testing.T) {
	raw, err := os.ReadFile(repoFile(t, filepath.Join("scripts", "check-dictation-evals.py")))
	if err != nil {
		t.Fatalf("reading the eval validator: %v", err)
	}
	src := string(raw)

	const open = "NUMBER_WORDS = {\n"
	i := strings.Index(src, open)
	if i < 0 {
		t.Fatal("could not find NUMBER_WORDS in check-dictation-evals.py — fix this parser rather than deleting the check")
	}
	body := src[i+len(open):]
	j := strings.Index(body, "\n}")
	if j < 0 {
		t.Fatal("NUMBER_WORDS is not terminated in check-dictation-evals.py")
	}
	entry := regexp.MustCompile(`^\s*(\d+):\s*\[(.*)\],?\s*$`)
	port := map[int][]string{}
	for _, line := range strings.Split(body[:j], "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		m := entry.FindStringSubmatch(line)
		if m == nil {
			t.Fatalf("unparseable NUMBER_WORDS line %q — keep one entry per line", line)
		}
		n, _ := strconv.Atoi(m[1])
		var forms []string
		for _, f := range regexp.MustCompile(`"([^"]*)"`).FindAllStringSubmatch(m[2], -1) {
			forms = append(forms, f[1])
		}
		port[n] = forms
	}
	if len(port) == 0 {
		t.Fatal("NUMBER_WORDS parsed as empty — this check would pass vacuously")
	}
	for n, forms := range numberWords {
		if !slices.Equal(port[n], forms) {
			t.Errorf("numberWords[%d]: Go says %q, the eval's port says %q", n, forms, port[n])
		}
	}
	for n := range port {
		if _, ok := numberWords[n]; !ok {
			t.Errorf("the eval's port has NUMBER_WORDS[%d] = %q, which Go does not", n, port[n])
		}
	}
	// %q is Go quoting, not a Python raw string. The two spell a pattern the same
	// only while it has no backslash or double quote, which holds for today's
	// `[^a-z0-9]+`. Change wordSplit to something with `\s` in it and this line
	// will demand the wrong Python literal: rewrite the comparison then.
	if want := fmt.Sprintf("WORD_SPLIT = re.compile(r%q)", wordSplit.String()); !strings.Contains(src, want) {
		t.Errorf("the eval's WORD_SPLIT is not %s — the two tokenise the dictation differently", want)
	}
	// The third arm of ResolveDraft's count switch floors a count above
	// maxTagCount even when it was spoken; the port's floor_count reads this.
	if want := fmt.Sprintf("MAX_TAG_COUNT = %d\n", maxTagCount); !strings.Contains(src, want) {
		t.Errorf("the eval's MAX_TAG_COUNT is not %d — a spoken count above the ceiling would be floored by the app and kept by the eval", maxTagCount)
	}

	rawVectors, err := os.ReadFile(repoFile(t, filepath.Join("evals", "bjj-dictation", "spoken_numbers.json")))
	if err != nil {
		t.Fatalf("reading the shared vectors: %v", err)
	}
	var file struct {
		Vectors []struct {
			Dictation string `json:"dictation"`
			N         int    `json:"n"`
			Want      bool   `json:"want"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(rawVectors, &file); err != nil {
		t.Fatalf("parsing spoken_numbers.json: %v", err)
	}
	if len(file.Vectors) == 0 {
		t.Fatal("spoken_numbers.json has no vectors — this check would pass vacuously")
	}
	for _, v := range file.Vectors {
		if got := spokenNumber(v.Dictation, v.N); got != v.Want {
			t.Errorf("spokenNumber(%q, %d) = %v, but the shared vector says %v", v.Dictation, v.N, got, v.Want)
		}
	}
}
