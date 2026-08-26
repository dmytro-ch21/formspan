package worker

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
		{"IPv6 loopback rewritten", "postgres://u:p@[::1]:5432/db", "postgres://u:p@host.docker.internal:5432/db"},
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
		"PATH=/usr/bin:/opt/homebrew/bin", // host-shaped (macOS) — must be dropped, not forwarded
		"HOME=/Users/host",                // same
		"TMPDIR=/var/folders/xy/abc",      // same — doesn't exist inside the container at all
		"GOPATH=/Users/host/go",           // same
		"GOCACHE=/Users/host/Library/Caches/go-build",
		"GOMODCACHE=/Users/host/go/pkg/mod",
		"DATABASE_URL=postgres://engine_role_1_ab:pw@localhost:5432/engine_run_1_ab",
		"TEST_DATABASE_URL=postgres://engine_role_1_ab:pw@localhost:5432/engine_run_1_ab",
		"SOME_TOKEN", // a bare name with no "=" — must never be forwarded at all
	}
	out := sandboxEnv(in)
	joined := strings.Join(out, "\n")

	// The host's real caches must never reach the container.
	if strings.Contains(joined, "/Users/host") || strings.Contains(joined, "/var/folders") {
		t.Fatalf("a host-shaped path leaked into sandbox env:\n%s", joined)
	}
	if !strings.Contains(joined, "GOCACHE="+containerGoCache) || !strings.Contains(joined, "GOMODCACHE="+containerGoModCache) {
		t.Fatalf("go caches not redirected inside the workspace:\n%s", joined)
	}
	// PATH/HOME/TMPDIR/GOPATH are host-shaped and wrong inside a Linux
	// container — dropped entirely, not forwarded, so the image's own
	// defaults stand.
	for _, k := range []string{"PATH=", "HOME=", "TMPDIR=", "GOPATH="} {
		if strings.Contains(joined, "\n"+k) || strings.HasPrefix(joined, k) {
			t.Fatalf("%s was forwarded from the host instead of being dropped:\n%s", strings.TrimSuffix(k, "="), joined)
		}
	}
	// A bare NAME (no "=") must never be forwarded — that shape tells
	// `docker run -e NAME` to copy the value from docker CLI's OWN
	// environment, exactly the implicit host-env channel this file exists
	// to close.
	if strings.Contains(joined, "SOME_TOKEN") {
		t.Fatalf("a bare env name was forwarded, letting docker resolve it from the host's own environment:\n%s", joined)
	}
	// localhost must never reach the container either — its own loopback is
	// not the host's, and (post-N196) host.docker.internal isn't reachable
	// from it at all any more, so the rewrite target is the egress broker's
	// relay, not the host directly. See rewriteHostForEgressBrokerRelay.
	if strings.Contains(joined, "@localhost:") {
		t.Fatalf("localhost DB host survived rewriting:\n%s", joined)
	}
	if strings.Contains(joined, "host.docker.internal") {
		t.Fatalf("DB host rewritten to host.docker.internal, which is UNREACHABLE from the sandboxed container post-N196:\n%s", joined)
	}
	if !strings.Contains(joined, "@"+egressBrokerHostname+":"+dbRelayPort+"/") {
		t.Fatalf("DB host not rewritten to the egress broker's relay:\n%s", joined)
	}
	// N196: HTTP(S) traffic must be pointed at the broker's CONNECT proxy —
	// GOPROXY/npm/pnpm have no other legitimate way out of this container.
	wantProxy := "http://" + egressBrokerHostname + ":" + proxyPort
	for _, k := range []string{"HTTP_PROXY=", "http_proxy=", "HTTPS_PROXY=", "https_proxy="} {
		if !strings.Contains(joined, k+wantProxy) {
			t.Fatalf("%s not set to the egress broker's proxy address:\n%s", strings.TrimSuffix(k, "="), joined)
		}
	}
	// An ordinary, non-special entry must still survive verbatim.
	if !strings.Contains(joined, "CI=1") {
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
// unreachable at "localhost" from inside a container with its own loopback
// (and, post-N196, unreachable at host.docker.internal too — the sandboxed
// container's env now points DATABASE_URL at the egress broker's relay
// instead; see rewriteHostForEgressBrokerRelay).
//
// A bare TCP connect is NOT enough to prove this any more, and used to be —
// found in review, and confirmed by reproducing it: the broker's relay
// ACCEPTS a client connection before it dials the real database (see
// relayDB), so a plain "did /dev/tcp connect succeed" check would report
// REACHABLE even with an empty or wrong DB_TARGET, since the client's own
// TCP handshake completes against the relay's listener regardless of what
// happens next. This sends Postgres's real SSLRequest packet (the 8-byte
// wire-protocol message every client sends first, RFC-fixed: length=8,
// request code 80877103) and requires an 'S' or 'N' byte back — a response
// only a genuine PostgreSQL server produces, so getting one PROVES the
// relay actually reached a live database, not merely that something
// accepted a socket.
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
		`exec 3<>"/dev/tcp/${host_port%%:*}/${host_port##*:}" && ` +
		`printf '\x00\x00\x00\x08\x04\xd2\x16\x2f' >&3 && ` +
		`response=$(timeout 3 head -c 1 <&3 | od -An -tx1 | tr -d ' \n') && ` +
		`echo "SSL_RESPONSE:$response"`
	result, err := ws.RunSandboxed(context.Background(), Sandbox{}, "", ws.Env(),
		[]string{"bash", "-c", script})
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("sandbox could not reach the host's ephemeral database: %v (exit %d): %s", err, result.ExitCode, result.Output)
	}
	// 0x53 = 'S' (server supports SSL), 0x4e = 'N' (plaintext only) — either
	// is a genuine PostgreSQL wire-protocol response. Anything else (empty,
	// a timeout, garbage) means we reached a socket but not a real database.
	if !strings.Contains(result.Output, "SSL_RESPONSE:53") && !strings.Contains(result.Output, "SSL_RESPONSE:4e") {
		t.Fatalf("connected to something, but it did not answer PostgreSQL's wire protocol — the relay may have accepted the socket without actually reaching a live database: %s", result.Output)
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
// This is deliberately NOT a test of the Colima-specific empty-mount trap
// itself (t.TempDir() vs $HOME) — that behavior is host-config-dependent:
// native Linux Docker (what CI's ubuntu-latest runners use) and Docker
// Desktop for Mac both share more of the filesystem by default than this
// project's own Colima setup does, so asserting "a t.TempDir()-based
// WorkRoot fails" would itself be host-specific and could flip to a false
// failure on a different Docker host. What IS portable everywhere Docker
// runs is verifyMount's actual logic: a directory with no .git in it looks
// exactly like an empty mount regardless of WHY it's empty, so pointing at
// a genuinely empty (but Docker-shareable) directory exercises the same
// guard without depending on any one host's mount-sharing configuration.
func TestVerifyMountCatchesAGenuinelyEmptyWorkspace(t *testing.T) {
	dockerAvailable(t)
	empty := filepath.Join(sandboxWorkRoot(t), "no-git-here")
	if err := os.MkdirAll(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	ws := &Workspace{Dir: empty}

	_, err := ws.RunSandboxed(context.Background(), Sandbox{}, "", nil, []string{"cat", "anything"})
	if err == nil {
		t.Fatal("RunSandboxed succeeded against a workspace with no .git — the mount-verification guard did not fire")
	}
	if !strings.Contains(err.Error(), "mount appears empty") {
		t.Fatalf("wrong error, or the guard's message changed without this test updating: %v", err)
	}
}

// TestCancelledRunDoesNotLeaveAnOrphanedContainer is the fix for the
// blocking finding review raised: exec.CommandContext SIGKILLs the `docker`
// CLI client on cancel, but the DAEMON keeps a container running regardless
// of its client dying — --rm only fires when the container's own process
// exits on its own. Without cmd.Cancel force-removing it by name, a
// cancelled sandboxed run (this engine's normal way for a hung gate to die,
// via Budget.MaxWall) would leak a running container the residue audit
// never sees.
func TestCancelledRunDoesNotLeaveAnOrphanedContainer(t *testing.T) {
	dockerAvailable(t)
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: sandboxWorkRoot(t)}
	ws, err := r.Provision(context.Background(), 44, 1, "cancel-orphan", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		ws.RunSandboxed(ctx, Sandbox{}, "", nil, []string{"sleep", "30"})
	}()

	// Give the container time to actually start before cancelling — a
	// cancel before it exists would prove nothing about cleanup.
	time.Sleep(1 * time.Second)
	cancel()

	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("RunSandboxed did not return after its context was cancelled")
	}

	// Give Docker a moment to actually process the removal, then check the
	// daemon directly — this is the real proof, not just that our own call
	// returned. Checks the SANDBOX container (the original finding) and the
	// egress broker container/network together (N196's own leak, found by
	// reproducing it: cancelling mid-`waitForBrokerReady` used to leave
	// `engine-egress-44`/`engine-egress-broker-44` running because the
	// cleanup path inherited the same cancelled context that caused the
	// failure — see teardownEgressLocked's doc comment). Checking only the
	// sandbox container name (as this test originally did) would pass
	// vacuously here: a cancellation during broker startup means RunSandboxed
	// never got as far as creating a sandbox container AT ALL, so that half
	// alone proves nothing about the broker leak this extends the test to
	// catch.
	deadline := time.Now().Add(10 * time.Second)
	sandboxFilter := fmt.Sprintf("name=engine-sandbox-%d-", ws.RunID)
	egressFilter := fmt.Sprintf("name=engine-egress-%d", ws.RunID) // matches both engine-egress-N and engine-egress-broker-N
	for {
		sandboxOut, err := exec.Command("docker", "ps", "-a", "--filter", sandboxFilter, "--format", "{{.Names}}").CombinedOutput()
		if err != nil {
			t.Fatal(err)
		}
		egressOut, err := exec.Command("docker", "ps", "-a", "--filter", egressFilter, "--format", "{{.Names}}").CombinedOutput()
		if err != nil {
			t.Fatal(err)
		}
		egressNetOut, err := exec.Command("docker", "network", "ls", "--filter", egressFilter, "--format", "{{.Name}}").CombinedOutput()
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(string(sandboxOut)) == "" &&
			strings.TrimSpace(string(egressOut)) == "" &&
			strings.TrimSpace(string(egressNetOut)) == "" {
			return // clean — the fix worked
		}
		if time.Now().After(deadline) {
			t.Fatalf("a cancelled sandboxed run left something behind — sandbox containers: %q, egress containers: %q, egress networks: %q",
				sandboxOut, egressOut, egressNetOut)
		}
		time.Sleep(200 * time.Millisecond)
	}
}
