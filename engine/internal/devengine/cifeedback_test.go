package devengine

import (
	"strings"
	"testing"
	"time"
)

var expected = []string{"Backend (Go)", "Web (Next.js)", "Mobile (Expo)"}

func at(min int) time.Time { return time.Date(2026, 8, 21, 14, min, 0, 0, time.UTC) }

func green(name string, min int) CheckRun {
	return CheckRun{ID: int64(min), Name: name, Status: "completed", Conclusion: "success", StartedAt: at(min)}
}
func red(name string, min int) CheckRun {
	return CheckRun{ID: int64(min), Name: name, Status: "completed", Conclusion: "failure", StartedAt: at(min)}
}

func prState(mergeable string, runs ...CheckRun) PRCheckState {
	return PRCheckState{
		HeadRefOid: "abc123", BranchHeadSHA: "abc123",
		Mergeable: mergeable, ExpectedChecks: expected, CheckRuns: runs,
	}
}

func TestAllGreenIsGreen(t *testing.T) {
	v := ReadChecks(prState("MERGEABLE", green("Backend (Go)", 1), green("Web (Next.js)", 1), green("Mobile (Expo)", 1)))
	if v.State != CIGreen {
		t.Fatalf("state = %s (%s)", v.State, v.Reason)
	}
}

func TestSupersededFailureOnTheSameSHAIsNotAFailure(t *testing.T) {
	// The #401 shape: the raw list accumulates one entry per workflow RUN,
	// so a superseded failing run sits beside its green re-run. Raw reads
	// report a failing check on a green PR; latest-per-name does not.
	v := ReadChecks(prState("MERGEABLE",
		green("Backend (Go)", 1), green("Web (Next.js)", 1),
		red("Mobile (Expo)", 1),   // first run failed
		green("Mobile (Expo)", 9), // re-run succeeded
	))
	if v.State != CIGreen {
		t.Fatalf("superseded failure read as %s (%s)", v.State, v.Reason)
	}
	// And the mirror: the FAILURE being newest is a real failure.
	v = ReadChecks(prState("MERGEABLE",
		green("Backend (Go)", 1), green("Web (Next.js)", 1),
		green("Mobile (Expo)", 1), red("Mobile (Expo)", 9),
	))
	if v.State != CIFailed || v.FailedChecks[0] != "Mobile (Expo)" {
		t.Fatalf("newest failure read as %s", v.State)
	}
}

func TestZeroChecksIsNeverPassing(t *testing.T) {
	v := ReadChecks(prState("MERGEABLE"))
	if v.State != CIZeroChecks {
		t.Fatalf("zero runs read as %s", v.State)
	}
	// The N65 cause: CONFLICTING means GitHub silently declined to run.
	v = ReadChecks(prState("CONFLICTING"))
	if v.State != CIZeroChecks || !strings.Contains(v.Reason, "rebase") {
		t.Fatalf("conflicting zero-checks verdict lacks the unblocking action: %s / %s", v.State, v.Reason)
	}
}

func TestGreenButConflictingIsStaleNotGreen(t *testing.T) {
	// #395: six green runs, then the base moved 19 seconds later — the green
	// describes a merge commit that no longer exists.
	v := ReadChecks(prState("CONFLICTING", green("Backend (Go)", 1), green("Web (Next.js)", 1), green("Mobile (Expo)", 1)))
	if v.State != CIStaleGreen {
		t.Fatalf("stale green read as %s", v.State)
	}
}

func TestSkippedAndMissingChecksAreNotChecked(t *testing.T) {
	skipped := CheckRun{Name: "Mobile (Expo)", Status: "completed", Conclusion: "skipped", StartedAt: at(1)}
	v := ReadChecks(prState("MERGEABLE", green("Backend (Go)", 1), green("Web (Next.js)", 1), skipped))
	if v.State != CIIncomplete {
		t.Fatalf("a skipped check read as %s — that is absence wearing a green tick", v.State)
	}
	v = ReadChecks(prState("MERGEABLE", green("Backend (Go)", 1), green("Web (Next.js)", 1)))
	if v.State != CIIncomplete || !strings.Contains(v.Reason, "Mobile (Expo)") {
		t.Fatalf("a missing declared check read as %s (%s)", v.State, v.Reason)
	}
}

func TestRunningIsNotPassing(t *testing.T) {
	inflight := CheckRun{Name: "Mobile (Expo)", Status: "in_progress", StartedAt: at(1)}
	v := ReadChecks(prState("MERGEABLE", green("Backend (Go)", 1), green("Web (Next.js)", 1), inflight))
	if v.State != CIRunning {
		t.Fatalf("in-progress read as %s", v.State)
	}
}

func TestARebasedAwaySHAIsNeverPolled(t *testing.T) {
	// #400: a watcher armed on a rebased-away commit found zero checks —
	// correctly, forever — and reported a confident false red.
	pr := prState("MERGEABLE", green("Backend (Go)", 1))
	pr.BranchHeadSHA = "def456"
	v := ReadChecks(pr)
	if v.State != CISHAGone || !strings.Contains(v.Reason, "re-arm") {
		t.Fatalf("rebased-away SHA read as %s (%s)", v.State, v.Reason)
	}
}

func TestUnknownMergeableIsAskAgainNotGreen(t *testing.T) {
	v := ReadChecks(prState("UNKNOWN", green("Backend (Go)", 1), green("Web (Next.js)", 1), green("Mobile (Expo)", 1)))
	if v.State != CIUnknown {
		t.Fatalf("UNKNOWN mergeable read as %s", v.State)
	}
}

func TestFailureClassification(t *testing.T) {
	infra := []string{
		"##[error]Failed to resolve action download info",
		"npm ERR! network ECONNRESET while fetching",
		"Process completed with exit code 143",
		"read tcp 10.0.0.5:443: i/o timeout",
		"toomanyrequests: You have reached your pull rate limit",
	}
	for _, log := range infra {
		if got := ClassifyFailure(log); got != FailureInfrastructure {
			t.Fatalf("%q classified %s", log, got)
		}
	}
	code := []string{
		"--- FAIL: TestPreflightRefusesDraftItems (0.00s)",
		"src/app/page.tsx(42,7): error TS2339: Property 'x' does not exist",
		"gofmt: internal/devengine/gates.go is not formatted",
	}
	for _, log := range code {
		if got := ClassifyFailure(log); got != FailureCode {
			t.Fatalf("%q classified %s — broken code retried forever is the thrash this exists to stop", log, got)
		}
	}
}

func TestAttemptBoundIsThePolicyValue(t *testing.T) {
	cfg := testConfig(t) // policy.json fixture: max_ci_fix_attempts = 3
	b := NewFixBudget(cfg)
	if b.Max != cfg.Policy.MaxCIFixAttempts || b.Max != 3 {
		t.Fatalf("budget max = %d, want the policy's 3", b.Max)
	}
	for i := 1; i <= 3; i++ {
		if !b.Consume(FailureCode) {
			t.Fatalf("attempt %d refused inside the budget", i)
		}
	}
	if b.Consume(FailureCode) {
		t.Fatal("the fourth code failure was allowed — the bound is not enforced")
	}
	d := b.Diagnosis(CIVerdict{State: CIFailed, Reason: "failed: Backend (Go)"})
	if !strings.Contains(d, "3 code fixes pushed") || !strings.Contains(d, "further failure") || !strings.Contains(d, "human") {
		t.Fatalf("diagnosis not concise/actionable: %q", d)
	}
}

func TestInfrastructureFailuresDoNotConsumeTheCodeBudget(t *testing.T) {
	b := &FixBudget{Max: 3, MaxInfra: 9}
	for i := 0; i < 5; i++ {
		if !b.Consume(FailureInfrastructure) {
			t.Fatal("an infra retry consumed the code budget")
		}
	}
	if b.CodeAttempts != 0 || b.InfraRetries != 5 {
		t.Fatalf("ledger wrong: %+v", b)
	}
	// Code attempts still bounded afterwards.
	for i := 1; i <= 3; i++ {
		if !b.Consume(FailureCode) {
			t.Fatalf("code attempt %d refused", i)
		}
	}
	if b.Consume(FailureCode) {
		t.Fatal("bound not enforced after infra retries")
	}
}

func TestInfraRetriesHaveTheirOwnBound(t *testing.T) {
	// Without a cap, a sticky runner failure — or a misclassified code
	// failure, which the substring classifier CAN produce — retries forever.
	// The cap converts thrash-forever into costs-a-few-runs.
	cfg := testConfig(t)
	b := NewFixBudget(cfg)
	if b.MaxInfra != 3*b.Max {
		t.Fatalf("MaxInfra = %d, want 3x the code budget", b.MaxInfra)
	}
	for i := 1; i <= b.MaxInfra; i++ {
		if !b.Consume(FailureInfrastructure) {
			t.Fatalf("infra retry %d refused inside the cap", i)
		}
	}
	if b.Consume(FailureInfrastructure) {
		t.Fatal("infra retries are unbounded — the thrash loop the cap exists to close")
	}
}

func TestSameSecondTieBreaksByRunIDNotOrder(t *testing.T) {
	// Review measured StartedAt-keyed dedup giving TWO verdicts for the same
	// facts depending on slice order when a retrigger lands within the same
	// second. IDs are monotonic; the newest ID wins in either order.
	oldGreen := CheckRun{ID: 100, Name: "Mobile (Expo)", Status: "completed", Conclusion: "success", StartedAt: at(5)}
	newRed := CheckRun{ID: 200, Name: "Mobile (Expo)", Status: "completed", Conclusion: "failure", StartedAt: at(5)}
	base := []CheckRun{green("Backend (Go)", 1), green("Web (Next.js)", 1)}
	for _, order := range [][]CheckRun{
		append(append([]CheckRun{}, base...), oldGreen, newRed),
		append(append([]CheckRun{}, base...), newRed, oldGreen),
	} {
		v := ReadChecks(prState("MERGEABLE", order...))
		if v.State != CIFailed {
			t.Fatalf("same-second tie read as %s — verdict depended on response order", v.State)
		}
	}
}

func TestAQueuedRerunIsNeverInvisibleBehindAnOldGreen(t *testing.T) {
	// A queued run has zero StartedAt — under time-keyed dedup it lost to
	// the old completed green and the verdict was green while a fresh run
	// was queued. Not finished is not passing.
	oldGreen := CheckRun{ID: 100, Name: "Mobile (Expo)", Status: "completed", Conclusion: "success", StartedAt: at(5)}
	queued := CheckRun{ID: 200, Name: "Mobile (Expo)", Status: "queued"}
	v := ReadChecks(prState("MERGEABLE", green("Backend (Go)", 1), green("Web (Next.js)", 1), oldGreen, queued))
	if v.State != CIRunning {
		t.Fatalf("queued re-run read as %s", v.State)
	}
}

func TestFailedAndConflictingIsStaleNotSpendable(t *testing.T) {
	// Runs are never withdrawn, so a conflicting PR shows stale FAILURES as
	// it shows stale greens — failures about a merge commit of a dead base.
	// Spending fix attempts there repairs a commit that no longer exists.
	v := ReadChecks(prState("CONFLICTING", green("Backend (Go)", 1), green("Web (Next.js)", 1), red("Mobile (Expo)", 2)))
	if v.State != CIStaleFailed || !strings.Contains(v.Reason, "rebase first") {
		t.Fatalf("stale failure read as %s (%s)", v.State, v.Reason)
	}
}

func TestAnUndeclaredFailingCheckIsNotInvisible(t *testing.T) {
	// A new CI job added to main before the engine's config catches up must
	// not fail unseen while the verdict reads green.
	rogue := CheckRun{ID: 300, Name: "Brand-New Job", Status: "completed", Conclusion: "failure", StartedAt: at(3)}
	v := ReadChecks(prState("MERGEABLE", green("Backend (Go)", 1), green("Web (Next.js)", 1), green("Mobile (Expo)", 1), rogue))
	if v.State != CIFailed || !strings.Contains(strings.Join(v.FailedChecks, ","), "Brand-New Job (undeclared)") {
		t.Fatalf("undeclared failing check read as %s (%v)", v.State, v.FailedChecks)
	}
}
