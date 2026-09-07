package worker

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// makeCostTestRepo builds a real, standalone git repo carrying THIS
// project's own actual backend/migrations directory — copied in wholesale,
// not the couple of synthetic files the rest of this package's tests use —
// so the cost measured below is the real "get a usable schema" cost N150/
// #554 asks for, not a toy one roughly two orders of magnitude smaller than
// production (93 real .up.sql files as of writing, vs. the 2 files
// TestMigrateBackendAppliesTheClonesOwnMigrations uses to test ordering
// only). Skips (does not fail) if it can't find that directory — this test
// only makes sense run from inside a checkout of this monorepo.
func makeCostTestRepo(t *testing.T) (dir, sha string) {
	t.Helper()
	dir = t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init", "--quiet", "--initial-branch=main")

	// engine/internal/worker -> repo root is three levels up.
	realMigrations, err := filepath.Abs(filepath.Join("..", "..", "..", "backend", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(realMigrations)
	if err != nil {
		t.Skipf("real backend/migrations not found at %s (not running inside the monorepo checkout?): %v", realMigrations, err)
	}
	dst := filepath.Join(dir, "backend", "migrations")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	var n int
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".up.sql") {
			continue
		}
		content, err := os.ReadFile(filepath.Join(realMigrations, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), content, 0o644); err != nil {
			t.Fatal(err)
		}
		n++
	}
	if n == 0 {
		t.Skip("no .up.sql files found in the real backend/migrations directory")
	}
	t.Logf("cost test repo carries %d real .up.sql files from backend/migrations", n)

	run("add", "-A")
	run("commit", "--quiet", "-m", "real migrations")
	return dir, run("rev-parse", "HEAD")
}

// TestProvisionMigrateTeardownCostIsMeasuredLive is N150/#554's own
// "measured for cost/latency per run" acceptance criterion, run live
// against this actual host rather than estimated: several full
// Provision-then-MigrateBackend-then-Teardown cycles against the real
// number of migrations this repo currently ships, with median/p95/min/max
// logged via t.Logf (run with `go test -v` to see them — this test makes
// no pass/fail claim about the numbers themselves, since "how fast is this
// host's Postgres today" is not something a regression gate should enforce;
// its VALUE is the measurement, which docs/decisions/history.md's N150
// entry records verbatim from a real run).
func TestProvisionMigrateTeardownCostIsMeasuredLive(t *testing.T) {
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	src, sha := makeCostTestRepo(t)

	const cycles = 5
	provision := make([]time.Duration, 0, cycles)
	migrate := make([]time.Duration, 0, cycles)
	teardown := make([]time.Duration, 0, cycles)
	total := make([]time.Duration, 0, cycles)

	for i := 0; i < cycles; i++ {
		r := &Runner{RepoURL: src, WorkRoot: t.TempDir(), AdminDBURL: admin}
		cycleStart := time.Now()

		pStart := time.Now()
		ws, err := r.Provision(ctx, int64(9200+i), 1, "cost", sha, nil, "")
		if err != nil {
			t.Fatal(err)
		}
		provision = append(provision, time.Since(pStart))

		mStart := time.Now()
		if err := ws.MigrateBackend(ctx); err != nil {
			t.Fatal(err)
		}
		migrate = append(migrate, time.Since(mStart))

		tStart := time.Now()
		if err := ws.Teardown(ctx); err != nil {
			t.Fatal(err)
		}
		teardown = append(teardown, time.Since(tStart))

		total = append(total, time.Since(cycleStart))
	}

	report := func(name string, d []time.Duration) {
		sorted := append([]time.Duration(nil), d...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
		median := sorted[len(sorted)/2]
		p95 := sorted[int(float64(len(sorted)-1)*0.95)]
		t.Logf("%-32s median=%-10s p95=%-10s min=%-10s max=%-10s all=%v",
			name, median, p95, sorted[0], sorted[len(sorted)-1], d)
	}
	report("provision (clone+role+db+owner)", provision)
	report("migrate (real .up.sql files)", migrate)
	report("teardown (drop db+role)", teardown)
	report("full cycle", total)
}
