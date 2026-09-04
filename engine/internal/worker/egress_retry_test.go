package worker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
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

// TestRemoveDockerResourceWithRetry_CommandFailsButResourceIsAlreadyGone is
// the specific bug found in `/pre-merge` review, pinned directly: unlike
// `docker rm -f` (exits 0 against an already-gone container), `docker
// network rm` exits 1 against an already-gone NETWORK — measured directly
// on this host, Docker 29.x. The first version of this function only
// consulted `exists` inside the err-is-nil branch, so a command that
// reports an error is checked FIRST, and `exists` reporting "gone" must
// still win — otherwise a network recorded-but-never-actually-created (the
// case the reorder fix in ensureEgressBroker exists to make survivable)
// burns this function's entire retry budget on a resource that was never
// there in the first place, the opposite of the fast-pass this exists for.
func TestRemoveDockerResourceWithRetry_CommandFailsButResourceIsAlreadyGone(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// "false" always exits non-zero (stands in for `docker network rm`
	// against a target that plain never existed); `exists` says gone from
	// the very first check.
	exists := func(context.Context) bool { return false }

	start := time.Now()
	err := removeDockerResourceWithRetry(ctx, "test remove", exists, "false")
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("removeDockerResourceWithRetry = %v, want nil — exists already says the resource "+
			"is gone, so the command's own non-zero exit must not override that", err)
	}
	// Must return on the FIRST attempt, not after a 500ms retry interval —
	// this is the "fast-pass", not merely "eventually succeeds".
	if elapsed > 250*time.Millisecond {
		t.Fatalf("returned after %v, want near-instant — this looks like it retried at least once "+
			"instead of trusting exists on the very first check", elapsed)
	}
}

// TestRemoveDockerResourceWithRetry_CommandFailsAndResourceStillThere is
// that test's sibling: a command that keeps failing AND a resource that
// genuinely never goes away (a real removal failure, not the fast-pass
// case above) must still be retried until ctx says otherwise — a
// transient `docker` CLI hiccup deserves the same second chance a lagging
// daemon does, and the fast-pass added for the sibling test above must not
// have quietly turned every command failure into an immediate return.
func TestRemoveDockerResourceWithRetry_CommandFailsAndResourceStillThere(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()

	exists := func(context.Context) bool { return true }

	start := time.Now()
	err := removeDockerResourceWithRetry(ctx, "test remove", exists, "false")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("removeDockerResourceWithRetry returned nil, want an error — the resource never actually went away")
	}
	if elapsed < 400*time.Millisecond {
		t.Fatalf("returned after %v, want at least one retry interval (500ms) to have elapsed — "+
			"a command failure must not be treated as immediately fatal when the resource is still there", elapsed)
	}
}

// writeFakeDocker installs a fake `docker` executable at the front of PATH
// for the duration of the test, dispatching only the three subcommands
// TestEnsureEgressBroker_CancelledNetworkCreateStillGetsCleanedUp needs:
//   - `network create --internal <name>`: writes a marker file for <name> —
//     simulating the daemon having genuinely created it — THEN exits
//     non-zero, simulating a client that was killed (ctx cancelled) after
//     the daemon already acted but before the client observed success. This
//     is the exact race N470/#799's reorder fix exists to survive.
//   - `network inspect <name>`: exit 0 iff the marker exists — this is what
//     `removeDockerResourceWithRetry`'s `exists` closure (egress.go) calls.
//   - `network rm <name>`: remove the marker if present, exit 0 either way
//     (matches real `docker network rm`'s own idempotent-on-missing shape).
//
// Any other invocation exits 2 with a message naming what was unhandled —
// loud on purpose: real `ensureEgressBroker`/`teardownEgressLocked` code
// only need these three shapes for the path this test drives (a network
// create that fails, with no container ever created), so anything else
// reaching this script means the test's own understanding of the code
// under test has drifted, not that the script needs a new case.
//
// Deliberately a shell script rather than a Go helper binary: `os/exec`
// resolves "docker" via PATH lookup at the moment `exec.CommandContext` is
// called, so anything executable named `docker` earlier on PATH is
// indistinguishable to the code under test from the real thing, and a
// shell script needs no compilation step.
func writeFakeDocker(t *testing.T) (binDir, stateDir string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake docker script is a POSIX shell script; not attempted on Windows")
	}
	binDir = t.TempDir()
	stateDir = t.TempDir()
	script := fmt.Sprintf(`#!/bin/sh
set -e
STATE=%q
case "$1 $2" in
  "network create")
    name="$4"
    touch "$STATE/net.$name"
    echo "fake docker: simulated client-killed-after-daemon-created" >&2
    exit 1
    ;;
  "network inspect")
    name="$3"
    test -e "$STATE/net.$name"
    exit $?
    ;;
  "network rm")
    name="$3"
    rm -f "$STATE/net.$name"
    exit 0
    ;;
  *)
    echo "fake docker: unhandled invocation: $*" >&2
    exit 2
    ;;
esac
`, stateDir)
	dockerPath := filepath.Join(binDir, "docker")
	if err := os.WriteFile(dockerPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake docker script: %v", err)
	}
	return binDir, stateDir
}

// TestEnsureEgressBroker_CancelledNetworkCreateStillGetsCleanedUp is the
// deterministic, Docker-free reproduction of N470/#799's actual bug —
// suggested in `/pre-merge` review as the one thing that could close the
// "not mechanically mutation-verified" gap the history entry names for the
// reorder fix, and built here.
//
// Unlike the integration test (sandbox_test.go), this does not depend on
// winning a real race against a real Docker daemon's timing — the fake
// `docker` above deterministically produces the exact disagreement the bug
// hinges on (daemon-side effect happened; client observed an error) on
// every single run, so this can and does catch a regression in the reorder
// fix itself, which nothing else in this package can.
func TestEnsureEgressBroker_CancelledNetworkCreateStillGetsCleanedUp(t *testing.T) {
	binDir, stateDir := writeFakeDocker(t)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	ws := &Workspace{RunID: 999999}
	_, _, err := ws.ensureEgressBroker(context.Background(), nil, "")

	if err == nil {
		t.Fatal("ensureEgressBroker returned nil error, want the simulated network-create failure to surface")
	}

	entries, readErr := os.ReadDir(stateDir)
	if readErr != nil {
		t.Fatalf("read state dir: %v", readErr)
	}
	if len(entries) != 0 {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Fatalf("marker file(s) %v still present — the network the fake daemon \"created\" was never "+
			"cleaned up. This is N470/#799's actual bug: if ws.egress.network is only recorded AFTER "+
			"the docker command succeeds (rather than before), teardownEgressLocked is called with no "+
			"idea a network exists at all, and this leaks exactly like it did before that fix", names)
	}
}
