package narration

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The server guard against the SAME cases the phone's guard answers
// (apps/mobile/lib/__tests__/narrationGuardVectors.test.ts). A change to either
// implementation that the other does not make turns one of the two red.
func TestGuardAnswersTheSharedCases(t *testing.T) {
	raw, err := os.ReadFile(repoFile(t, filepath.Join("evals", "day-narration", "guard_vectors.json")))
	if err != nil {
		t.Fatalf("reading guard_vectors.json: %v", err)
	}
	var vectors struct {
		Facts []Fact `json:"facts"`
		Cases []struct {
			Name     string   `json:"name"`
			Sentence Sentence `json:"sentence"`
			Kept     bool     `json:"kept"`
			Reason   string   `json:"reason"`
			Detail   string   `json:"detail"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("parsing guard_vectors.json: %v", err)
	}
	if len(vectors.Cases) < 10 {
		t.Fatalf("expected the shared cases, found %d: the file may have lost them", len(vectors.Cases))
	}
	for _, c := range vectors.Cases {
		t.Run(c.Name, func(t *testing.T) {
			v := Guard([]Sentence{c.Sentence}, vectors.Facts)
			if c.Kept {
				if len(v.Kept) != 1 || len(v.Dropped) != 0 {
					t.Fatalf("expected kept, got kept=%v dropped=%v", v.Kept, v.Dropped)
				}
				return
			}
			want := []Dropped{{Sentence: c.Sentence, Reason: c.Reason, Detail: c.Detail}}
			if len(v.Kept) != 0 || !reflect.DeepEqual(v.Dropped, want) {
				t.Fatalf("expected %+v, got kept=%v dropped=%+v", want, v.Kept, v.Dropped)
			}
		})
	}
}

func TestGuardKeepsInputOrderAndCountsEverySentence(t *testing.T) {
	facts := []Fact{{Key: "a", Numbers: []string{"1"}}, {Key: "b", Numbers: []string{"2"}}}
	in := []Sentence{
		{Text: "one 1", Cites: []string{"a"}},
		{Text: "invented 9", Cites: []string{"a"}},
		{Text: "two 2", Cites: []string{"b"}},
	}
	v := Guard(in, facts)
	if len(v.Kept) != 2 || v.Kept[0].Text != "one 1" || v.Kept[1].Text != "two 2" || len(v.Dropped) != 1 {
		t.Fatalf("got kept=%v dropped=%v", v.Kept, v.Dropped)
	}
}

// repoFile resolves a path from the repository root. It FAILS rather than skips
// when the root cannot be found: a skip would print `ok` for a package whose
// parity check did not run. Same helper as bjj's.
func repoFile(t *testing.T, rel string) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if isDir(filepath.Join(dir, "backend")) && isDir(filepath.Join(dir, "evals")) {
			return filepath.Join(dir, rel)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("could not find the repository root above %s", dir)
		}
		dir = parent
	}
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
