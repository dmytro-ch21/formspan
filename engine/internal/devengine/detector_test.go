package devengine

import "testing"

// observe runs one snapshot and commits it — the happy path every test that
// is not about commit semantics wants.
func observe(d *Detector, items []Item) []Item {
	moved, commit := d.Observe(items)
	commit()
	return moved
}

func TestFirstSnapshotIsABaselineNotADispatch(t *testing.T) {
	// Items already In Progress at startup are humans mid-work. Dispatching
	// them would contest every live claim on the board, so the first snapshot
	// primes state and reports nothing.
	d := NewDetector()
	moved := observe(d, []Item{
		{IssueNumber: 1, Status: "In Progress"},
		{IssueNumber: 2, Status: "Todo"},
	})
	if len(moved) != 0 {
		t.Fatalf("baseline snapshot dispatched %d items", len(moved))
	}
}

func TestTodoToInProgressIsDetected(t *testing.T) {
	d := NewDetector()
	observe(d, []Item{{IssueNumber: 2, Status: "Todo"}})
	moved := observe(d, []Item{{IssueNumber: 2, Status: "In Progress"}})
	if len(moved) != 1 || moved[0].IssueNumber != 2 {
		t.Fatalf("moved = %v, want issue 2", moved)
	}
}

func TestOtherTransitionsAreNot(t *testing.T) {
	d := NewDetector()
	observe(d, []Item{
		{IssueNumber: 1, Status: "In Progress"},
		{IssueNumber: 2, Status: "In Review"},
		{IssueNumber: 3, Status: "Todo"},
	})
	moved := observe(d, []Item{
		{IssueNumber: 1, Status: "Todo"},        // un-claimed: not a dispatch
		{IssueNumber: 2, Status: "In Progress"}, // Review -> Progress: rework, not a fresh claim
		{IssueNumber: 3, Status: "Done"},        // closed without the engine
	})
	if len(moved) != 0 {
		t.Fatalf("moved = %v, want none", moved)
	}
}

func TestNewItemAppearingInProgressCountsAfterBaseline(t *testing.T) {
	// Created-then-immediately-started is a dispatch gesture whose Todo half
	// fell between polls; missing it would make fast humans invisible.
	d := NewDetector()
	observe(d, []Item{{IssueNumber: 1, Status: "Todo"}})
	moved := observe(d, []Item{
		{IssueNumber: 1, Status: "Todo"},
		{IssueNumber: 99, Status: "In Progress"},
	})
	if len(moved) != 1 || moved[0].IssueNumber != 99 {
		t.Fatalf("moved = %v, want issue 99", moved)
	}
}

func TestSameTransitionIsNotReportedTwice(t *testing.T) {
	d := NewDetector()
	observe(d, []Item{{IssueNumber: 2, Status: "Todo"}})
	first := observe(d, []Item{{IssueNumber: 2, Status: "In Progress"}})
	second := observe(d, []Item{{IssueNumber: 2, Status: "In Progress"}})
	if len(first) != 1 || len(second) != 0 {
		t.Fatalf("first=%v second=%v, want exactly one report", first, second)
	}
}

func TestUncommittedTransitionIsRedetected(t *testing.T) {
	// The decision log is the evidence base: if the append fails, the caller
	// skips commit, and the transition must come back on the next poll rather
	// than being silently lost. A duplicate beats a loss.
	d := NewDetector()
	observe(d, []Item{{IssueNumber: 2, Status: "Todo"}})
	first, _ := d.Observe([]Item{{IssueNumber: 2, Status: "In Progress"}}) // commit never called
	again := observe(d, []Item{{IssueNumber: 2, Status: "In Progress"}})
	if len(first) != 1 || len(again) != 1 {
		t.Fatalf("first=%v again=%v — an uncommitted transition was lost", first, again)
	}
}

func TestItemFlickeringOutOfASnapshotIsNotRedispatched(t *testing.T) {
	// Commit merges rather than replaces, so an item missing from one poll
	// (API eventual consistency) does not re-enter as brand-new.
	d := NewDetector()
	observe(d, []Item{{IssueNumber: 5, Status: "In Progress"}}) // baseline
	observe(d, []Item{})                                        // 5 flickers out
	moved := observe(d, []Item{{IssueNumber: 5, Status: "In Progress"}})
	if len(moved) != 0 {
		t.Fatalf("flickering item re-dispatched: %v", moved)
	}
}

func TestDraftItemsNeverTransition(t *testing.T) {
	d := NewDetector()
	observe(d, []Item{{IsDraft: true, Status: "Todo", Title: "card"}})
	moved := observe(d, []Item{{IsDraft: true, Status: "In Progress", Title: "card"}})
	if len(moved) != 0 {
		t.Fatalf("draft item reported as a transition: %v", moved)
	}
}
