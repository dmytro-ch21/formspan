package devengine

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestShadowLogAppendsParseableJSONL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "decisions.jsonl")
	log := NewShadowLog(path)
	ctx := context.Background()

	d1 := Decision{Time: time.Now().UTC(), Issue: 1, Event: "todo_to_in_progress",
		WouldDispatch: true, Risk: "low", Engine: "test"}
	d2 := Decision{Time: time.Now().UTC(), Issue: 2, Event: "todo_to_in_progress",
		WouldDispatch: false, Reasons: []string{"no acceptance criteria"}, Risk: "high", Engine: "test"}
	if err := log.Dispatch(ctx, d1); err != nil {
		t.Fatal(err)
	}
	if err := log.Dispatch(ctx, d2); err != nil {
		t.Fatal(err)
	}

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var got []Decision
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var d Decision
		if err := json.Unmarshal(sc.Bytes(), &d); err != nil {
			t.Fatalf("line not parseable JSON: %q: %v", sc.Text(), err)
		}
		got = append(got, d)
	}
	if len(got) != 2 || got[0].Issue != 1 || got[1].Issue != 2 {
		t.Fatalf("got %d decisions %v, want issues [1 2]", len(got), got)
	}
	if got[1].Reasons[0] != "no acceptance criteria" {
		t.Fatalf("reasons did not round-trip: %v", got[1].Reasons)
	}
}

func TestShadowLogIsAppendOnly(t *testing.T) {
	// A pre-existing log must be extended, never truncated — the decision log
	// is the whole evidence base for the shadow-mode comparison (the ticket's
	// NEEDS HUMAN EVIDENCE criterion), so losing history on restart would
	// silently invalidate the week of observation.
	path := filepath.Join(t.TempDir(), "decisions.jsonl")
	if err := os.WriteFile(path, []byte("{\"issue\":100}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := NewShadowLog(path).Dispatch(context.Background(), Decision{Issue: 101}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if want := "{\"issue\":100}\n"; len(b) <= len(want) || string(b[:len(want)]) != want {
		t.Fatalf("prior content not preserved: %q", b)
	}
}
