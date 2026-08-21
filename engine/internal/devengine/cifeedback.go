package devengine

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// This file is the engine's CI-reading discipline, encoding what this repo
// learned the hard way (CLAUDE.md, N65, #395, #400, #401):
//
//   - COUNT the check runs; never read the absence of failures.
//   - The raw check-runs API ACCUMULATES one entry per workflow run, so a
//     superseded failure sits beside its green re-run on the same SHA —
//     read latest-per-name, like `gh pr checks`, never the raw list.
//   - Zero checks + CONFLICTING is an unmergeable PR GitHub declined
//     silently; green + CONFLICTING is green about a merge commit that no
//     longer exists. Neither is passing.
//   - A watcher pinned to a SHA must check the SHA still exists — a rebase
//     leaves it on no branch, and polling it yields a confident false red.

// CheckRun is one raw entry from commits/{sha}/check-runs.
type CheckRun struct {
	// ID is GitHub's check-run id — MONOTONIC, and therefore the dedup key.
	// StartedAt is second-granularity in several API representations, so a
	// retrigger landing within the same second made "newest by time"
	// order-dependent: the same facts produced green in one response order
	// and failed in the other, and a queued re-run (zero StartedAt) was
	// invisible behind an old completed green. Both measured in review.
	ID         int64
	Name       string
	Status     string    // queued | in_progress | completed
	Conclusion string    // success | failure | skipped | cancelled | ...
	StartedAt  time.Time // informational only — never a dedup key
}

// PRCheckState is everything the verdict needs, gathered by the caller so
// this logic stays pure and fixture-testable.
type PRCheckState struct {
	HeadRefOid string
	// BranchHeadSHA is what the branch points at NOW. If it differs from
	// HeadRefOid, the SHA under observation has been rebased away and any
	// verdict about it describes a commit on no branch. An EMPTY value means
	// the caller checked and vouches (deliberately skipped) — a caller that
	// TRIED to resolve the branch and failed must surface that as its own
	// branch-gone state, never as "", because post-force-push the branch
	// being unresolvable is MORE sha-gone than a mismatch is (N141 contract).
	BranchHeadSHA  string
	Mergeable      string // MERGEABLE | CONFLICTING | UNKNOWN
	ExpectedChecks []string
	CheckRuns      []CheckRun
}

// CI verdict states. Only Green means "CI passed"; every other state names
// why it does not, so no caller can collapse them into "not failed".
const (
	CIGreen       = "green"
	CIFailed      = "failed"
	CIRunning     = "running"
	CIZeroChecks  = "zero_checks"
	CIIncomplete  = "incomplete" // a declared check is missing or skipped
	CIStaleGreen  = "stale_green"
	CIStaleFailed = "stale_failed"
	CISHAGone     = "sha_gone"
	CIUnknown     = "mergeable_unknown"
)

type CIVerdict struct {
	State        string
	FailedChecks []string
	Reason       string // the human action or fact, ready for a run comment
}

// ReadChecks turns raw check-run state into a verdict.
func ReadChecks(pr PRCheckState) CIVerdict {
	if pr.BranchHeadSHA != "" && pr.BranchHeadSHA != pr.HeadRefOid {
		return CIVerdict{State: CISHAGone, Reason: fmt.Sprintf(
			"observed SHA %.12s is no longer the branch head (%.12s) — re-arm on the new head; a verdict about a rebased-away commit is a confident answer about nothing",
			pr.HeadRefOid, pr.BranchHeadSHA)}
	}

	latest := latestPerName(pr.CheckRuns)

	if len(latest) == 0 {
		reason := "zero check runs — which is indistinguishable from passing on every default surface and is not passing"
		if pr.Mergeable == "CONFLICTING" {
			reason += "; the PR CONFLICTS with its base, so GitHub cannot build refs/pull/N/merge and silently declines to run anything — rebase onto the base and push"
		}
		return CIVerdict{State: CIZeroChecks, Reason: reason}
	}

	var failed, missing []string
	running := false
	expected := map[string]bool{}
	for _, name := range pr.ExpectedChecks {
		expected[name] = true
		run, ok := latest[name]
		switch {
		case !ok:
			missing = append(missing, name)
		case run.Status != "completed":
			running = true
		case run.Conclusion == "skipped":
			// A skipped check is NOT-CHECKED wearing a green tick.
			missing = append(missing, name+" (skipped)")
		case run.Conclusion != "success":
			failed = append(failed, name)
		}
	}
	// A failing check OUTSIDE the declared list must not be invisible — a
	// new CI job added to main before the engine's config catches up would
	// otherwise fail unseen while the verdict read green. Found in review;
	// the repo's own ci:checks fails loudly on set disagreement for the
	// same reason.
	for name, run := range latest {
		if expected[name] {
			continue
		}
		if run.Status == "completed" && run.Conclusion != "success" && run.Conclusion != "skipped" {
			failed = append(failed, name+" (undeclared)")
		}
	}

	switch {
	case len(failed) > 0 && pr.Mergeable == "CONFLICTING":
		// The N65 mechanism is symmetric: runs are never withdrawn, so a
		// conflicting PR shows stale FAILURES exactly as it shows stale
		// greens — failures about refs/pull/N/merge of a dead base. Spending
		// fix attempts on them repairs a commit that no longer exists; the
		// correct, free action is rebase.
		sort.Strings(failed)
		return CIVerdict{State: CIStaleFailed, FailedChecks: failed,
			Reason: "checks failed AND the PR conflicts with its base — the failures describe a merge commit that no longer exists; rebase first, spend no fix attempts on this state"}
	case len(failed) > 0:
		sort.Strings(failed)
		return CIVerdict{State: CIFailed, FailedChecks: failed,
			Reason: "failed: " + strings.Join(failed, ", ")}
	case running:
		return CIVerdict{State: CIRunning, Reason: "not finished is not passing"}
	case len(missing) > 0:
		sort.Strings(missing)
		return CIVerdict{State: CIIncomplete,
			Reason: "declared checks did not run: " + strings.Join(missing, ", ")}
	case pr.Mergeable == "CONFLICTING":
		return CIVerdict{State: CIStaleGreen, Reason: "every check is green AND the PR conflicts with its base — the green describes a merge commit that no longer exists; rebase and let CI re-run"}
	case pr.Mergeable == "UNKNOWN":
		// GitHub computes mergeability lazily after every push; ask again
		// rather than declaring green against an unanswered question.
		return CIVerdict{State: CIUnknown, Reason: "mergeable is UNKNOWN — re-read in a few seconds; the second call is when GitHub has an answer"}
	}
	return CIVerdict{State: CIGreen}
}

// latestPerName reduces the accumulated raw list to the newest run per check
// name — the #401 shape: one SHA ended with 8 entries and 6 names, and the
// superseded middle run was still in the list as a failure. Newest is by
// check-run ID, which GitHub allocates monotonically; keying on StartedAt
// was order-dependent under same-second ties and blind to queued runs.
func latestPerName(runs []CheckRun) map[string]CheckRun {
	latest := map[string]CheckRun{}
	for _, r := range runs {
		if prev, ok := latest[r.Name]; !ok || r.ID > prev.ID {
			latest[r.Name] = r
		}
	}
	return latest
}

// Failure classes. Default is CODE on purpose: mislabeling an infra flake as
// code costs one bounded attempt; mislabeling broken code as infra retries
// it forever, which is the thrash this whole file exists to prevent.
const (
	FailureInfrastructure = "infrastructure"
	FailureCode           = "code"
)

// infraSignatures are runner/tooling failures no code fix can address — each
// measured in this repo's or GitHub's documented behavior, not guessed.
var infraSignatures = []string{
	"Failed to resolve action download info", // took out three jobs on 2026-08-06
	"The runner has received a shutdown signal",
	"The operation was canceled",
	"The hosted runner encountered an error",
	"No space left on device",
	"Process completed with exit code 143", // SIGTERM: runner reclaimed
	"i/o timeout",
	"TLS handshake timeout",
	"ECONNRESET",
	"ETIMEDOUT",
	"ERR_PNPM_META_FETCH_FAIL",
	"toomanyrequests:", // registry rate limits (Docker Hub)
	"503 Service Unavailable",
}

// ClassifyFailure reads a failed check's log tail and decides whether a code
// fix could help.
func ClassifyFailure(logTail string) string {
	for _, sig := range infraSignatures {
		if strings.Contains(logTail, sig) {
			return FailureInfrastructure
		}
	}
	return FailureCode
}

// FixBudget bounds code-fix attempts at the policy value. Infrastructure
// failures never consume the CODE budget — a runner flake is not the
// change's fault — but they have their OWN bound: without one, a sticky
// runner failure ("No space left on device" is persistent, not transient)
// or a misclassified code failure would retry forever, and the classifier
// is a substring heuristic that CAN misfire (an ordinary test failure's log
// legitimately contains "i/o timeout" in this repo — the llm package tests
// exactly those strings). The cap converts every such miss from
// thrashes-forever into costs-a-few-runs, which is what makes the
// default-CODE asymmetry actually hold. Found in review.
type FixBudget struct {
	Max          int
	MaxInfra     int
	CodeAttempts int
	InfraRetries int
}

func NewFixBudget(cfg Config) *FixBudget {
	return &FixBudget{
		Max:      cfg.Policy.MaxCIFixAttempts,
		MaxInfra: 3 * cfg.Policy.MaxCIFixAttempts,
	}
}

// Consume records one failure of the given class and reports whether another
// attempt is allowed. The Nth code failure with Max=N exhausts the budget:
// 3 attempts means three fixes get pushed, and the fourth failure moves the
// run to Blocked. Infra retries block at MaxInfra consecutive-run failures.
func (b *FixBudget) Consume(class string) bool {
	if class == FailureInfrastructure {
		b.InfraRetries++
		return b.InfraRetries <= b.MaxInfra
	}
	b.CodeAttempts++
	return b.CodeAttempts <= b.Max
}

// Diagnosis renders the concise Blocked/Failed comment: what failed, what
// was tried, and the unblocking human action.
func (b *FixBudget) Diagnosis(v CIVerdict) string {
	pushed := b.CodeAttempts
	if pushed > b.Max {
		pushed = b.Max
	}
	return fmt.Sprintf(
		"CI repair budget exhausted: %d code fixes pushed (policy max %d) and a further failure occurred; %d infrastructure retries did not count against the code budget. Last state %s — %s. A human needs to look at the failing checks; the engine will not thrash CI further.",
		pushed, b.Max, b.InfraRetries, v.State, v.Reason)
}
