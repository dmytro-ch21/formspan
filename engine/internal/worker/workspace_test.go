package worker

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// makeSourceRepo builds a tiny local git repo: two commits, an UNTRACKED
// secrets file in the working tree (the backend/.env.staging.local shape),
// and returns (path, firstSHA, headSHA).
func makeSourceRepo(t *testing.T) (string, string, string) {
	t.Helper()
	dir := t.TempDir()
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
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "README.md")
	run("commit", "--quiet", "-m", "first")
	first := run("rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("commit", "--quiet", "-am", "second")
	head := run("rev-parse", "HEAD")
	// The gitignored-secret shape: present in the working tree, absent from
	// history — exactly backend/.env.staging.local.
	if err := os.MkdirAll(filepath.Join(dir, "backend"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "backend", ".env.staging.local"),
		[]byte("DATABASE_URL=postgres://real:staging@railway.internal/vola\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, first, head
}

func TestProvisionClonesTheRecordedSHANotHEAD(t *testing.T) {
	src, first, head := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir()}
	ws, err := r.Provision(context.Background(), 1, 559, "Shadow Reconciler!", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	got, err := os.ReadFile(filepath.Join(ws.Dir, "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "v1\n" {
		t.Fatalf("clone is at HEAD (%.12s), not the recorded base %.12s — content %q", head, first, got)
	}
	if ws.BaseSHA != first {
		t.Fatalf("base SHA not recorded: %q", ws.BaseSHA)
	}
	if ws.Branch != "agent/559-shadow-reconciler-" && ws.Branch != "agent/559-shadow-reconciler" {
		t.Fatalf("branch = %q", ws.Branch)
	}
}

func TestProvisionRefusesAnUnrecordedBase(t *testing.T) {
	src, _, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir()}
	if _, err := r.Provision(context.Background(), 1, 1, "x", "", nil, ""); err == nil {
		t.Fatal("empty baseSHA accepted — 'whatever HEAD is current' is the drift this refusal prevents")
	}
}

func TestGitignoredSecretsCannotReachAWorkspace(t *testing.T) {
	// The credential-surface test the ticket demands, run by ATTEMPTING:
	// the source working tree carries a staging-credential file; the fresh
	// clone must not.
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir()}
	ws, err := r.Provision(context.Background(), 2, 1, "x", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())
	if _, err := os.Stat(filepath.Join(ws.Dir, "backend", ".env.staging.local")); err == nil {
		t.Fatal("a gitignored credential file reached the workspace — the clone-from-git isolation is broken")
	}
}

func TestWorkspaceEnvIsAnExplicitAllowlist(t *testing.T) {
	// Attempt to read engine credentials from a worker's environment.
	t.Setenv("GITHUB_TOKEN", "engine-secret")
	t.Setenv("OPENAI_API_KEY", "engine-secret")
	t.Setenv("RAILWAY_TOKEN", "engine-secret")
	ws := &Workspace{DBURL: "postgres://run@localhost/engine_run_1_ab", runner: &Runner{}}
	env := ws.Env()
	joined := strings.Join(env, "\n")
	for _, banned := range []string{"GITHUB_TOKEN", "OPENAI_API_KEY", "RAILWAY_TOKEN", "engine-secret"} {
		if strings.Contains(joined, banned) {
			t.Fatalf("worker env leaks %s:\n%s", banned, joined)
		}
	}
	// And the run's OWN database is granted.
	if !strings.Contains(joined, "DATABASE_URL=postgres://run@localhost/engine_run_1_ab") {
		t.Fatalf("ephemeral DB not granted:\n%s", joined)
	}
	if !strings.Contains(joined, "CI=1") {
		t.Fatal("CI=1 missing")
	}
}

func TestBudgetNamesWhichLimitWasExceeded(t *testing.T) {
	b := Budget{MaxWall: time.Hour, MaxTokens: 1000}
	if err := b.Check(30*time.Minute, 500); err != nil {
		t.Fatalf("under both budgets refused: %v", err)
	}
	err := b.Check(2*time.Hour, 500)
	if err == nil || !strings.Contains(err.Error(), "wall-time") {
		t.Fatalf("wall overrun not named: %v", err)
	}
	err = b.Check(30*time.Minute, 2000)
	if err == nil || !strings.Contains(err.Error(), "token") {
		t.Fatalf("token overrun not named: %v", err)
	}
	// Zero limits mean unlimited, not instantly exceeded.
	if err := (Budget{}).Check(100*time.Hour, 1<<30); err != nil {
		t.Fatalf("zero budget treated as a limit: %v", err)
	}
}

func TestArtifactsSurviveTeardownAndResidueAuditPasses(t *testing.T) {
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir()}
	ws, err := r.Provision(context.Background(), 3, 1, "x", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	ref, err := ws.RetainArtifact("decision.jsonl", []byte(`{"issue":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.Teardown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := ws.AuditResidue(context.Background()); err != nil {
		t.Fatalf("audit found residue after a clean teardown: %v", err)
	}
	got, err := os.ReadFile(ref)
	if err != nil || string(got) != `{"issue":1}` {
		t.Fatalf("artifact did not survive teardown: %v %q", err, got)
	}
}

func TestTheResidueAuditCanFail(t *testing.T) {
	// The audit is only worth its name if residue makes it red — plant some.
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir()}
	ws, err := r.Provision(context.Background(), 4, 1, "x", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	// No teardown: the directory is the residue.
	err = ws.AuditResidue(context.Background())
	if err == nil || !strings.Contains(err.Error(), "workspace directory still exists") {
		t.Fatalf("audit passed with a live workspace on disk: %v", err)
	}
	if err := ws.Teardown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := ws.AuditResidue(context.Background()); err != nil {
		t.Fatalf("audit still red after teardown: %v", err)
	}
}

func TestStripCredentials(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"password stripped, username kept", "https://x-access-token:sekret@github.com/o/r.git", "https://x-access-token@github.com/o/r.git"},
		{"plain https unaffected", "https://github.com/o/r.git", "https://github.com/o/r.git"},
		{"ssh user with no password unaffected", "ssh://git@github.com/o/r.git", "ssh://git@github.com/o/r.git"},
		{"bare local path unaffected", "/tmp/some/repo", "/tmp/some/repo"},
		{"scp-style ssh remote unaffected", "git@github.com:o/r.git", "git@github.com:o/r.git"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := stripCredentials(c.in)
			if got != c.want {
				t.Fatalf("stripCredentials(%q) = %q, want %q", c.in, got, c.want)
			}
			if strings.Contains(got, "sekret") {
				t.Fatalf("password survived stripping: %q", got)
			}
		})
	}
}

// TestCredentialedCloneURLIsNotPersistedInWorkspace is the attempted-leak
// test the credential surface criterion demands: git DOES persist a
// file://-transport URL's embedded userinfo into remote.origin.url even
// though it never uses it for the (local) transport — verified directly
// against this host's git before writing this test. Provision must not let
// that credential end up sitting in the workspace's own .git/config.
func TestCredentialedCloneURLIsNotPersistedInWorkspace(t *testing.T) {
	src, first, _ := makeSourceRepo(t)
	credentialed := "file://fakeuser:fakesecret@" + src
	r := &Runner{RepoURL: credentialed, WorkRoot: t.TempDir()}
	ws, err := r.Provision(context.Background(), 5, 1, "x", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	cmd := exec.Command("git", "config", "--get", "remote.origin.url")
	cmd.Dir = ws.Dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git config --get remote.origin.url: %v: %s", err, out)
	}
	got := strings.TrimSpace(string(out))
	if strings.Contains(got, "fakesecret") {
		t.Fatalf("credentialed clone URL persisted into the workspace: %q", got)
	}
}

func TestRoleConnectionURL(t *testing.T) {
	got := roleConnectionURL("postgres://vola:vola_dev_only@localhost:5432/vola_test?sslmode=disable", "engine_role_1_ab", "sekret", "engine_run_1_ab")
	want := "postgres://engine_role_1_ab:sekret@localhost:5432/engine_run_1_ab?sslmode=disable"
	if got != want {
		t.Fatalf("roleConnectionURL = %q, want %q", got, want)
	}
	// The admin credentials must never survive into the run's own URL.
	if strings.Contains(got, "vola_dev_only") || strings.Contains(got, ":vola@") {
		t.Fatalf("admin credentials leaked into role URL: %q", got)
	}
}

func TestQuoteLiteral(t *testing.T) {
	if got := quoteLiteral("abc123"); got != "'abc123'" {
		t.Fatalf("quoteLiteral(abc123) = %q", got)
	}
	if got := quoteLiteral("o'brien"); got != "'o''brien'" {
		t.Fatalf("quoteLiteral did not double an embedded quote: %q", got)
	}
}

func TestRandomHexIsNonEmptyAndVaries(t *testing.T) {
	a, err := randomHex(16)
	if err != nil {
		t.Fatal(err)
	}
	b, err := randomHex(16)
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != 32 || len(b) != 32 {
		t.Fatalf("randomHex(16) lengths = %d, %d, want 32 hex chars each", len(a), len(b))
	}
	if a == b {
		t.Fatal("two calls to randomHex(16) produced the same value")
	}
}
