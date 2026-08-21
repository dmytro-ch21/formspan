package devengine

// Detector finds Todo → In Progress transitions between successive board
// snapshots. It is deliberately stateful-in-memory only: shadow mode restarts
// re-baseline rather than replaying, so a restart can never double-log a
// transition it already saw, and can never "catch up" on transitions that
// happened while it was down (the durable version of that is N139's job).
type Detector struct {
	prev map[int]string // issue number -> last seen status
	// primed is false until the first snapshot. The first snapshot is a
	// BASELINE: items already In Progress at startup are not transitions —
	// dispatching them would re-claim every ticket humans are mid-way
	// through, which is the exact failure the claiming rules exist to stop.
	primed bool
}

func NewDetector() *Detector {
	return &Detector{prev: map[int]string{}}
}

// Observe ingests a snapshot and returns the items that moved Todo → In
// Progress since the last COMMITTED one, plus a commit func the caller
// invokes only after it has durably recorded every returned transition.
// Splitting detect from commit is what stops a failed decision-log append
// losing a transition forever: an uncommitted observation is re-detected on
// the next poll. The cost is that a partial failure can log a transition
// twice — for an evidence log, a duplicate is strictly better than a loss.
//
// Commit MERGES into the previous state rather than replacing it, so an item
// that flickers out of one snapshot (API eventual consistency) and back does
// not re-enter through the brand-new-item branch and get re-reported.
func (d *Detector) Observe(items []Item) (moved []Item, commit func()) {
	current := make(map[int]string, len(items))
	for _, it := range items {
		if it.IsDraft {
			continue
		}
		current[it.IssueNumber] = it.Status
		if !d.primed {
			continue
		}
		prev, seen := d.prev[it.IssueNumber]
		// A brand-new item appearing already In Progress is a transition the
		// poller missed the Todo half of — count it, because the human gesture
		// (created, then immediately started) is a dispatch request.
		if it.Status == "In Progress" && (!seen || prev == "Todo") {
			moved = append(moved, it)
		}
	}
	commit = func() {
		for k, v := range current {
			d.prev[k] = v
		}
		d.primed = true
	}
	return moved, commit
}
