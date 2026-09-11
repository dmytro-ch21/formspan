package devengine

import (
	"fmt"
	"strings"
	"testing"
)

// N174 (#551): the board the engine polls comes from policy.json's board
// block, with the flags as overrides — never from a literal default.

func TestBoardResolveUsesPolicyWhenNoFlags(t *testing.T) {
	owner, n, err := Board{Owner: "someone", ProjectNumber: 7}.Resolve("", 0)
	if err != nil || owner != "someone" || n != 7 {
		t.Fatalf(`Resolve("", 0) = %q, %d, %v; want "someone", 7, nil`, owner, n, err)
	}
}

func TestBoardResolveFlagsOverrideEachFieldIndependently(t *testing.T) {
	b := Board{Owner: "someone", ProjectNumber: 7}
	if owner, n, err := b.Resolve("other", 0); err != nil || owner != "other" || n != 7 {
		t.Errorf(`owner flag: got %q, %d, %v; want "other", 7, nil`, owner, n, err)
	}
	if owner, n, err := b.Resolve("", 9); err != nil || owner != "someone" || n != 9 {
		t.Errorf(`project flag: got %q, %d, %v; want "someone", 9, nil`, owner, n, err)
	}
}

func TestBoardResolveRefusesMissingIdentity(t *testing.T) {
	cases := []struct {
		name        string
		board       Board
		projectFlag int
		wantInErr   string
	}{
		{"no owner anywhere", Board{ProjectNumber: 7}, 0, "board.owner"},
		{"a blank owner is no owner", Board{Owner: "   ", ProjectNumber: 7}, 0, "board.owner"},
		{"no project number anywhere", Board{Owner: "someone"}, 0, "board.project_number"},
		{"a nonsense --project is refused, not replaced by the policy's", Board{Owner: "someone", ProjectNumber: 7}, -1, ">= 1, got -1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			owner, n, err := tc.board.Resolve("", tc.projectFlag)
			if err == nil {
				t.Fatalf("Resolve = %q, %d, nil; want an error naming %q", owner, n, tc.wantInErr)
			}
			if !strings.Contains(err.Error(), tc.wantInErr) {
				t.Fatalf("error %q does not name %q", err, tc.wantInErr)
			}
		})
	}
}

func TestRealPolicyNamesItsBoard(t *testing.T) {
	// Fatal, not Skip: .vola-agent is checked in at the repo root.
	cfg, err := LoadConfig("../../../.vola-agent")
	if err != nil {
		t.Fatalf(".vola-agent not readable from the repo root: %v", err)
	}
	owner, n, err := cfg.Policy.Board.Resolve("", 0)
	if err != nil {
		t.Fatalf("the checked-in policy names no board the engine can poll: %v", err)
	}
	if want := fmt.Sprintf("/%s/projects/%d", owner, n); !strings.HasSuffix(cfg.Policy.Board.URL, want) {
		t.Errorf("board.url %q is not the board owner and project_number name (%s)", cfg.Policy.Board.URL, want)
	}
}
