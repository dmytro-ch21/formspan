package worker

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func dockerAvailable(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not available on PATH")
	}
}

// sandboxWorkRoot returns a WorkRoot Docker can actually bind-mount from.
// t.TempDir() resolves under the OS temp directory (/var/folders/... on
// macOS), which this project's own Colima config does NOT share into its
// VM — Colima's default shares only $HOME, so a bind mount there silently
// comes back empty rather than erroring (measured directly against this
// host: an alpine container listing a /var/folders bind mount saw an empty
// directory where the host side plainly had a file). Sandboxed tests need a
// WorkRoot Docker genuinely shares, so this uses $HOME instead — with the
// same cleanup guarantee t.TempDir() gives.
func sandboxWorkRoot(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no $HOME to build a Docker-shareable WorkRoot from")
	}
	base := filepath.Join(home, ".engine-sandbox-tmp")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	d, err := os.MkdirTemp(base, "test-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func TestRewriteHostForSandbox(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"localhost rewritten", "postgres://u:p@localhost:5432/db?sslmode=disable", "postgres://u:p@host.docker.internal:5432/db?sslmode=disable"},
		{"127.0.0.1 rewritten", "postgres://u:p@127.0.0.1:5432/db", "postgres://u:p@host.docker.internal:5432/db"},
		{"remote host unaffected", "postgres://u:p@db.example.com:5432/db", "postgres://u:p@db.example.com:5432/db"},
		{"no port carries no colon", "postgres://u:p@localhost/db", "postgres://u:p@host.docker.internal/db"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := rewriteHostForSandbox(c.in); got != c.want {
				t.Fatalf("rewriteHostForSandbox(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestSandboxEnvRewritesGoCachesAndDBHostAndLeavesEverythingElse(t *testing.T) {
	in := []string{
		"CI=1",
		"PATH=/usr/bin",
		"GOCACHE=/Users/host/Library/Caches/go-build",
		"GOMODCACHE=/Users/host/go/pkg/mod",
		"DATABASE_URL=postgres://engine_role_1_ab:pw@localhost:5432/engine_run_1_ab",
		"TEST_DATABASE_URL=postgres://engine_role_1_ab:pw@localhost:5432/engine_run_1_ab",
	}
	out := sandboxEnv(in)
	joined := strings.Join(out, "\n")

	// The host's real caches must never reach the container.
	if strings.Contains(joined, "/Users/host/") {
		t.Fatalf("host cache path leaked into sandbox env:\n%s", joined)
	}
	if !strings.Contains(joined, "GOCACHE="+containerGoCache) || !strings.Contains(joined, "GOMODCACHE="+containerGoModCache) {
		t.Fatalf("go caches not redirected inside the workspace:\n%s", joined)
	}
	// localhost must never reach the container either — its own loopback is
	// not the host's.
	if strings.Contains(joined, "@localhost:") {
		t.Fatalf("localhost DB host survived rewriting:\n%s", joined)
	}
	if !strings.Contains(joined, "host.docker.internal:5432") {
		t.Fatalf("DB host not rewritten to host.docker.internal:\n%s", joined)
	}
	// Untouched entries must survive verbatim.
	if !strings.Contains(joined, "CI=1") || !strings.Contains(joined, "PATH=/usr/bin") {
		t.Fatalf("unrelated env entries were not preserved:\n%s", joined)
	}
}

// TestSandboxRefusesToRunWithoutDocker proves RunSandboxed fails loudly
// rather than silently falling back to an unsandboxed run when Docker is
// unavailable — simulated by hiding it from PATH rather than by actually
// uninstalling Docker.
func TestSandboxRefusesToRunWithoutDocker(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // an empty directory: docker cannot be found
	ws := &Workspace{Dir: t.TempDir()}
	_, err := ws.RunSandboxed(context.Background(), Sandbox{}, "", nil, []string{"echo", "hi"})
	if err == nil {
		t.Fatal("RunSandboxed succeeded with no docker on PATH")
	}
}

// TestSandboxCannotReadFilesOutsideTheWorkspace is the acceptance criterion
// itself, proven by attempting the escape — mirroring
// TestGitignoredSecretsCannotReachAWorkspace's pattern. A secret file sits
// at a path shaped exactly like the primary checkout's own
// backend/.env.staging.local, OUTSIDE the workspace directory Provision
// created; a sandboxed command trying to read it must fail, not because of
// file permissions (the file is perfectly readable to this host process)
// but because the sandboxed process's filesystem namespace never contains
// that path at all.
func TestSandboxCannotReadFilesOutsideTheWorkspace(t *testing.T) {
	dockerAvailable(t)
	src, first, _ := makeSourceRepo(t)
	root := sandboxWorkRoot(t)
	r := &Runner{RepoURL: src, WorkRoot: root}
	ws, err := r.Provision(context.Background(), 40, 1, "sandbox-escape", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	outsideDir := filepath.Join(root, "primary-checkout-simulation", "backend")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	secretPath := filepath.Join(outsideDir, ".env.staging.local")
	if err := os.WriteFile(secretPath,
		[]byte("DATABASE_URL=postgres://real:staging@railway.internal/vola\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Confirm the file really is readable to an ordinary (unsandboxed)
	// process on this host — otherwise a failure to read it from inside the
	// sandbox would prove nothing about isolation.
	if _, err := os.ReadFile(secretPath); err != nil {
		t.Fatalf("test setup broken: the planted secret isn't even host-readable: %v", err)
	}

	result, err := ws.RunSandboxed(context.Background(), Sandbox{}, "", nil, []string{"cat", secretPath})
	if err == nil && result.ExitCode == 0 {
		t.Fatalf("sandboxed process read a file OUTSIDE its workspace: %s", result.Output)
	}
	if strings.Contains(result.Output, "railway.internal") {
		t.Fatalf("secret content leaked into sandbox output: %s", result.Output)
	}
}

// TestSandboxCanReadAndWriteInsideTheWorkspace is the positive control for
// the test above — without it, a sandbox that can reach NOTHING would pass
// the escape test vacuously.
func TestSandboxCanReadAndWriteInsideTheWorkspace(t *testing.T) {
	dockerAvailable(t)
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: sandboxWorkRoot(t)}
	ws, err := r.Provision(context.Background(), 41, 1, "sandbox-rw", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	result, err := ws.RunSandboxed(context.Background(), Sandbox{}, "", nil, []string{"cat", "README.md"})
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("sandbox could not read its own workspace file: %v (exit %d): %s", err, result.ExitCode, result.Output)
	}
	if !strings.Contains(result.Output, "v1") {
		t.Fatalf("unexpected content reading the workspace's own file: %q", result.Output)
	}

	writeResult, err := ws.RunSandboxed(context.Background(), Sandbox{}, "",
		nil, []string{"sh", "-c", "echo written > new-file.txt && cat new-file.txt"})
	if err != nil || writeResult.ExitCode != 0 {
		t.Fatalf("sandbox could not write inside its own workspace: %v (exit %d): %s", err, writeResult.ExitCode, writeResult.Output)
	}
	got, err := os.ReadFile(filepath.Join(ws.Dir, "new-file.txt"))
	if err != nil || strings.TrimSpace(string(got)) != "written" {
		t.Fatalf("write from inside the sandbox did not land on the host workspace: %v %q", err, got)
	}
}

// TestSandboxCanReachTheHostsEphemeralDatabase proves the network-egress
// half: a DB-backed gate running inside the sandbox needs to reach the
// workspace's OWN ephemeral database, which Provision created on the HOST —
// unreachable at "localhost" from inside a container with its own loopback,
// which is exactly why sandboxEnv rewrites it to host.docker.internal.
func TestSandboxCanReachTheHostsEphemeralDatabase(t *testing.T) {
	dockerAvailable(t)
	admin := os.Getenv("TEST_DATABASE_URL")
	if admin == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: sandboxWorkRoot(t), AdminDBURL: admin}
	ws, err := r.Provision(context.Background(), 42, 1, "sandbox-db", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	// bash's /dev/tcp is a pseudo-device, not a real network tool install —
	// verified working in this project's own golang:1.26-bookworm image
	// before writing this test, so a failure here means the sandbox itself
	// can't reach the database, not that some tool was missing.
	script := `host_port=$(echo "$DATABASE_URL" | sed -E 's#.*@([^/]+)/.*#\1#'); ` +
		`exec 3<>"/dev/tcp/${host_port%%:*}/${host_port##*:}" && echo REACHABLE`
	result, err := ws.RunSandboxed(context.Background(), Sandbox{}, "", ws.Env(),
		[]string{"bash", "-c", script})
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("sandbox could not reach the host's ephemeral database: %v (exit %d): %s", err, result.ExitCode, result.Output)
	}
	if !strings.Contains(result.Output, "REACHABLE") {
		t.Fatalf("unexpected output: %s", result.Output)
	}
}

// TestVerifyMountCatchesAWorkRootDockerCannotShare is the pre-flight guard's
// own test: a WorkRoot under the OS temp directory (t.TempDir(), deliberately
// used here instead of sandboxWorkRoot) is exactly the shape that silently
// bind-mounts empty on this project's own Colima setup — measured directly
// against this host before writing verifyMount. Without the guard, this
// surfaces as a confusing "no such file" from whatever command the caller
// happened to run; with it, RunSandboxed refuses clearly before running
// anything.
func TestVerifyMountCatchesAWorkRootDockerCannotShare(t *testing.T) {
	dockerAvailable(t)
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: t.TempDir()}
	ws, err := r.Provision(context.Background(), 43, 1, "bad-workroot", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	_, err = ws.RunSandboxed(context.Background(), Sandbox{}, "", nil, []string{"cat", "README.md"})
	if err == nil {
		t.Fatal("RunSandboxed succeeded against a WorkRoot this host's Docker cannot share")
	}
	if !strings.Contains(err.Error(), "mount appears empty") {
		t.Fatalf("wrong error, or the guard's message changed without this test updating: %v", err)
	}
}
