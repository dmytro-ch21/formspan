package worker

import (
	"context"
	"testing"
	"time"
)

// removeDockerResourceWithRetry's own unit tests — deliberately NOT in
// egress_test.go, which is gated on Docker being available. This function
// takes an injectable `exists` and only cares about the exit code of
// whatever command it's given, so it needs no Docker at all: `true`/`false`
// stand in for a real `docker rm`/`docker network rm` invocation for free.
//
// N470/#799: the full-Docker integration test
// (TestCancelledRunDoesNotLeaveAnOrphanedContainer, sandbox_test.go) cannot
// reliably land in the narrow daemon-timing window that originally exposed
// this bug — `docker rm`/`docker network rm` reporting success while the
// resource is still mid-removal on the daemon side — because that requires
// the real Docker daemon to be caught mid-transition, which is exactly the
// kind of race a deterministic local run cannot force on demand. Verified
// directly: reverting the fix that made removeDockerResourceWithRetry exist
// at all (going back to trusting the command's own exit code with no
// `exists` check) still passes that integration test 3/3 runs in a row —
// so these unit tests are the only thing that can actually catch a
// regression in this function's own retry behaviour.

// TestRemoveDockerResourceWithRetry_RetriesUntilExistsConfirmsRemoval pins
// the fix's whole point: a command reporting success is not enough on its
// own — the loop must keep going until `exists` independently confirms the
// resource is actually gone.
func TestRemoveDockerResourceWithRetry_RetriesUntilExistsConfirmsRemoval(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	calls := 0
	exists := func(context.Context) bool {
		calls++
		// The first two checks still see the resource (a daemon still
		// settling); the third confirms it is actually gone.
		return calls < 3
	}

	if err := removeDockerResourceWithRetry(ctx, "test remove", exists, "true"); err != nil {
		t.Fatalf("removeDockerResourceWithRetry = %v, want nil once exists reports gone", err)
	}
	if calls != 3 {
		t.Fatalf("exists called %d times, want exactly 3 — the retry must keep going until it "+
			"says gone, not stop early (a surviving mutation that skips the exists check entirely "+
			"would return nil after exactly 1 call, since \"true\" always exits 0)", calls)
	}
}

// TestRemoveDockerResourceWithRetry_GivesUpWhenContextExpires proves the
// other half: a resource that never actually goes away must not hang
// forever — the caller's ctx budget (teardownEgressLocked's cleanupCtx) is
// what bounds it, and running out must return an error, never nil.
func TestRemoveDockerResourceWithRetry_GivesUpWhenContextExpires(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()

	// Never reports gone — a stuck resource, or a daemon that genuinely
	// never settles within the caller's budget.
	exists := func(context.Context) bool { return true }

	start := time.Now()
	err := removeDockerResourceWithRetry(ctx, "test remove", exists, "true")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("removeDockerResourceWithRetry returned nil, want an error — the resource never actually went away")
	}
	// Proves it actually retried (the 500ms sleep between attempts fired at
	// least once) rather than giving up on the very first still-there
	// answer — a mutation that returned immediately on the first `exists ==
	// true` would finish in well under the 500ms retry interval.
	if elapsed < 400*time.Millisecond {
		t.Fatalf("returned after %v, want at least one retry interval (500ms) to have elapsed — "+
			"this looks like it gave up after the first check instead of retrying", elapsed)
	}
}

// TestRemoveDockerResourceWithRetry_RetriesPastACommandThatKeepsFailing
// covers the other branch of the switch: the command itself reporting an
// error (not "succeeded but still there") must also be retried, not treated
// as immediately fatal — a transient `docker` CLI hiccup must get the same
// second chance a lagging daemon does.
func TestRemoveDockerResourceWithRetry_RetriesPastACommandThatKeepsFailing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()

	// "false" always exits non-zero — exists is never consulted on this
	// path (see the function's own switch), so this call never succeeds;
	// the point is only that it doesn't give up before ctx says so.
	exists := func(context.Context) bool { return false }

	start := time.Now()
	err := removeDockerResourceWithRetry(ctx, "test remove", exists, "false")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("removeDockerResourceWithRetry returned nil, want an error — the command never once succeeded")
	}
	if elapsed < 400*time.Millisecond {
		t.Fatalf("returned after %v, want at least one retry interval (500ms) to have elapsed — "+
			"a command failure must not be treated as immediately fatal", elapsed)
	}
}
