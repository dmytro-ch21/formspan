// Sandbox is N188/#604: worker EXECUTION gets a real filesystem boundary,
// closing the gap the rest of this package's own doc comment already named
// honestly. Everything else in this package (the env allowlist, the git-
// clone provenance, the per-run database role) narrows what a worker
// process is HANDED. None of it stops a process from reading a path it was
// never handed at all — an unsandboxed process inherits its host user's
// full filesystem view regardless of its own environment. RunSandboxed
// closes that: the command runs inside a container whose ONLY visible host
// path is this workspace's own directory. A path outside it is not merely
// unreadable by convention — it does not exist in the container's mount
// namespace, so there is nothing to read by any means the sandboxed process
// has, not just the ones this package happens to have thought of.
package worker

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"path"
	"strings"
	"sync/atomic"
	"time"
)

// DefaultSandboxImage is used when Sandbox.Image is empty. It carries the
// same Go toolchain version this module itself builds with (see go.mod) and
// git, needed by gates like the clean-tree check. It does NOT carry
// pnpm/node/python — gates that need those need a richer image, which is a
// choice for whoever configures Sandbox.Image, not something this package
// hardcodes.
const DefaultSandboxImage = "golang:1.26-bookworm"

// Sandbox configures one sandboxed run. The zero value is valid — Image
// defaults to DefaultSandboxImage, AllowedHosts defaults to
// DefaultAllowedHosts (see egress.go).
type Sandbox struct {
	Image string
	// AllowedHosts is this sandbox's egress allowlist — see egress.go for
	// the enforcement mechanism. A nil/empty slice means DefaultAllowedHosts,
	// NOT "no restriction" — there is no Sandbox configuration that reaches
	// the unrestricted-egress behavior this package had before N196.
	AllowedHosts []string
}

// sandboxRunCounter gives each RunSandboxed invocation a distinct container
// name — needed so a cancelled run's cleanup (see RunSandboxed) can name the
// exact container to force-remove, rather than guessing.
var sandboxRunCounter atomic.Uint64

// SandboxResult is one sandboxed command's outcome.
type SandboxResult struct {
	Output   string // combined stdout+stderr
	ExitCode int
}

// containerGoCache/containerGoModCache are where RunSandboxed points Go's
// build and module caches — INSIDE the container's view of the workspace,
// never at the host's real GOCACHE/GOMODCACHE. Mounting those host paths
// would be a second, silent way for a sandboxed process to reach outside
// its own workspace, which is exactly what this file exists to prevent — so
// a fresh workspace's first sandboxed Go command pays a cold cache (network
// access to fetch modules) rather than share the host's. This is a
// deliberate choice against N141's review, which flagged the (bare-exec,
// pre-sandbox) worker sharing the host's GOCACHE/GOMODCACHE as an accepted
// but real cross-run trust link; sandboxed execution does not carry that
// link forward.
const (
	containerGoCache    = "/workspace/.sandbox-cache/go-build"
	containerGoModCache = "/workspace/.sandbox-cache/go-mod"
)

// RunSandboxed runs command inside a fresh, disposable container: this
// workspace's own directory bind-mounted read-write at /workspace (dir
// joined under it when non-empty) and NO other host path visible at all —
// not read-only, not mounted anywhere else in the container's tree, simply
// absent from its filesystem namespace. env is passed through explicitly,
// like Workspace.Env() — nothing from this process's own environment
// reaches the container implicitly (not even via a bare `-e NAME` with no
// value, which Docker would resolve from the docker CLI's own environment;
// see sandboxEnv). Most entries are forwarded as given; sandboxEnv rewrites
// or drops a few specific ones — see its own doc comment for the full list
// and why (host-shaped PATH/HOME/TMPDIR/GOPATH would be actively wrong
// inside a Linux container; GOCACHE/GOMODCACHE and DATABASE_URL/
// TEST_DATABASE_URL need redirecting to reach the right place FROM INSIDE
// the sandbox rather than the host's).
//
// Networking is restricted to an explicit allowlist (N196/#622) — the
// sandboxed container's ONLY network is a fully `--internal` Docker bridge
// (no route anywhere at all, not even to the Docker host — measured; see
// egress.go's package doc), and a sidecar broker on that same bridge is its
// only path to anything outside its own workspace: the workspace's own
// ephemeral database (relayed to a fixed target the broker alone knows) and
// HTTPS to sb.AllowedHosts (or DefaultAllowedHosts). Requires `docker` on
// PATH; this package's isolation guarantee depends on Docker's own container
// boundary, so if Docker is unavailable this returns an error rather than
// silently running unsandboxed — a fallback would be exactly the "isolation
// is optional" failure this file exists to close.
func (ws *Workspace) RunSandboxed(ctx context.Context, sb Sandbox, dir string, env []string, command []string) (SandboxResult, error) {
	if len(command) == 0 {
		return SandboxResult{}, fmt.Errorf("sandbox: no command given")
	}
	if _, err := exec.LookPath("docker"); err != nil {
		return SandboxResult{}, fmt.Errorf("sandbox: docker not found on PATH: %w", err)
	}

	image := sb.Image
	if image == "" {
		image = DefaultSandboxImage
	}
	allowedHosts := sb.AllowedHosts
	if len(allowedHosts) == 0 {
		allowedHosts = DefaultAllowedHosts
	}
	workdir := "/workspace"
	if dir != "" {
		workdir = path.Join(workdir, dir)
	}

	// Some Docker hosts (this project's own Colima setup among them, whose
	// default config shares only $HOME into its VM) silently hand back an
	// EMPTY directory for a bind mount outside whatever they share, rather
	// than erroring — measured directly against this host before writing
	// this guard. Left unchecked, that turns into a confusing "no such
	// file" from the CALLER's command, which reads as a bug in the command
	// rather than in where WorkRoot was configured. Confirming the mount
	// worked before running anything else turns that into one clear,
	// actionable error instead. Cached on the workspace (mountVerified):
	// the property is fixed for ws.Dir's whole lifetime, so only the FIRST
	// call per workspace pays the extra container.
	if !ws.mountVerified.Load() {
		if err := verifyMount(ctx, ws.Dir, image); err != nil {
			return SandboxResult{}, err
		}
		ws.mountVerified.Store(true)
	}

	// The sandboxed container's ONLY path to anything beyond its own
	// workspace directory — its own database, and the egress allowlist —
	// goes through this broker, started (or reused, after the first call)
	// on this workspace's own fully `--internal` network. See egress.go.
	brokerIP, egressNetwork, err := ws.ensureEgressBroker(ctx, allowedHosts, dbTargetFor(ws))
	if err != nil {
		return SandboxResult{}, fmt.Errorf("sandbox: %w", err)
	}

	// Named so a cancelled run's cleanup (below) can force-remove the exact
	// container rather than guessing — CommandContext SIGKILLs the `docker`
	// CLI client on cancel, but the DAEMON keeps the container itself
	// running regardless (--rm only fires when the container's own process
	// exits on its own), so without this a wall-time budget cancel against
	// a hung command would leak a running container the residue audit
	// never sees. Found in review.
	name := fmt.Sprintf("engine-sandbox-%d-%d", ws.RunID, sandboxRunCounter.Add(1))
	args := []string{
		"run", "--rm", "--name", name,
		// This container's ONLY network — a fully `--internal` bridge with
		// no route anywhere at all. host.docker.internal is deliberately
		// NOT added here any more (it is unreachable by construction on
		// this network, which is the point); egress-broker is the one host
		// this container CAN reach, and everything legitimate goes through
		// it. See ensureEgressBroker.
		"--network", egressNetwork,
		"--add-host", egressBrokerHostname + ":" + brokerIP,
		"-v", ws.Dir + ":/workspace",
		"-w", workdir,
	}
	for _, e := range sandboxEnv(env) {
		args = append(args, "-e", e)
	}
	args = append(args, image)
	args = append(args, command...)

	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Cancel = func() error {
		// Best-effort: the client process is about to be killed regardless
		// (Go's default Cancel), but that alone leaves the container
		// running on the daemon — force-remove it by the name we gave it.
		// Errors here are deliberately swallowed: this already runs during
		// cancellation, and the caller's own error is the one that matters.
		exec.Command("docker", "rm", "-f", name).Run()
		return cmd.Process.Kill()
	}
	cmd.WaitDelay = 5 * time.Second
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err = cmd.Run()

	code := 0
	if exitErr, ok := err.(*exec.ExitError); ok {
		code = exitErr.ExitCode()
	} else if err != nil {
		return SandboxResult{Output: out.String()}, fmt.Errorf("sandbox: docker run: %w", err)
	}
	return SandboxResult{Output: out.String(), ExitCode: code}, nil
}

// verifyMount confirms the bind mount actually surfaced this workspace's own
// content, by checking for .git — present in every workspace Provision
// creates (a real git clone), so its absence inside the container means the
// mount came back empty rather than that this particular workspace happens
// to lack it. Exit code 1 from `test -e` means exactly that absence; any
// OTHER failure (Docker itself unavailable, an image pull failing) is a
// different problem and gets its own message rather than being misdiagnosed
// as an empty mount — found in review, since attributing every failure to
// "mount appears empty" would itself be the "confusing symptom, wrong
// diagnosis" class this guard exists to end.
func verifyMount(ctx context.Context, hostDir, image string) error {
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm",
		"-v", hostDir+":/workspace", image, "test", "-e", "/workspace/.git")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		return nil
	}
	if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
		return fmt.Errorf(
			"sandbox: workspace mount appears empty inside the container — " +
				"on this host's Docker setup (e.g. Colima sharing only $HOME " +
				"into its VM by default), WorkRoot must be a path Docker " +
				"actually shares into its VM, not just any temp directory")
	}
	return fmt.Errorf("sandbox: could not verify the workspace mount (is Docker running, and is %s pullable?): %w: %s",
		image, err, strings.TrimSpace(stderr.String()))
}

// sandboxEnv rewrites or drops the env-var classes RunSandboxed's doc
// comment names, leaving everything else untouched. Two classes are
// dropped rather than forwarded, both found in review:
//
//   - A bare NAME with no "=" is never forwarded. Passed straight through to
//     `docker run -e NAME` (no value), Docker copies NAME's value from the
//     docker CLI's OWN environment — i.e. from the engine host process —
//     which is exactly the implicit host-env channel this package's doc
//     comment claims is closed. Workspace.Env() never produces one, but the
//     guarantee should hold by construction, not by every caller happening
//     to agree.
//   - PATH, HOME, TMPDIR and GOPATH are HOST-shaped (this engine typically
//     runs on macOS) and WRONG inside a Linux container: the image's own
//     PATH already has Go on it and gets clobbered by the host's; TMPDIR
//     would point at a macOS temp directory that doesn't exist in the
//     container at all; HOME/GOPATH the same. Every test here runs
//     cat/sh/bash (found via any reasonable PATH, which is why this went
//     unnoticed) — the first real Go gate wired through this would fail
//     confusingly on "go: command not found" or a temp-dir error that reads
//     as a bug in the gate rather than in the sandbox. Dropping them lets
//     the image supply its own sane defaults; GOMODCACHE is pinned
//     independently below regardless of GOPATH's value.
//
// N196/#622 changed WHAT DATABASE_URL/TEST_DATABASE_URL are rewritten TO —
// egress-broker's relay, not host.docker.internal directly (unreachable from
// this container by construction; see egress.go) — and adds
// HTTP_PROXY/HTTPS_PROXY (both cases: the Go toolchain and most POSIX tools
// read the uppercase form, but plenty of software only checks lowercase)
// pointed at the broker's CONNECT proxy, so GOPROXY/npm/pnpm reach their
// allowlisted hosts without the sandboxed process needing to know anything
// changed. NO_PROXY exempts the broker's own hostname — defensive, since
// nothing legitimate proxies to itself, but a future gate hard-coding
// "http://egress-broker:8888" as a target for some other reason should not
// silently loop through the CONNECT proxy to reach it.
func sandboxEnv(env []string) []string {
	out := make([]string, 0, len(env)+6)
	for _, e := range env {
		k, v, ok := strings.Cut(e, "=")
		if !ok {
			continue // never forward a bare name — see doc comment above
		}
		switch k {
		case "GOCACHE", "GOMODCACHE":
			continue // replaced below with container-local paths
		case "PATH", "HOME", "TMPDIR", "GOPATH":
			continue // host-shaped; let the image's own defaults stand
		case "DATABASE_URL", "TEST_DATABASE_URL":
			out = append(out, k+"="+rewriteHostForEgressBrokerRelay(v))
		default:
			out = append(out, e)
		}
	}
	proxyURL := "http://" + egressBrokerHostname + ":" + proxyPort
	return append(out,
		"GOCACHE="+containerGoCache,
		"GOMODCACHE="+containerGoModCache,
		"HTTP_PROXY="+proxyURL, "http_proxy="+proxyURL,
		"HTTPS_PROXY="+proxyURL, "https_proxy="+proxyURL,
		"NO_PROXY="+egressBrokerHostname, "no_proxy="+egressBrokerHostname)
}

// rewriteHostForSandbox swaps a loopback host for host.docker.internal, the
// address a container uses to reach a port bound on the host machine. Used
// today by dbTargetFor (egress.go) to compute what the BROKER itself should
// dial — the broker sits on Docker's ordinary default bridge, where this
// still holds exactly as it always did. It is NOT what the sandboxed
// container's own env is rewritten to any more; see
// rewriteHostForEgressBrokerRelay for that. A non-loopback host (a real
// remote database, say) is returned EXACTLY UNCHANGED, not re-serialized —
// so a URL shape this function doesn't recognize is passed through
// byte-for-byte rather than risking a lossy round-trip through net/url for a
// rewrite that was never needed.
func rewriteHostForSandbox(dbURL string) string {
	u, err := url.Parse(dbURL)
	if err != nil {
		return dbURL
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		newHost := "host.docker.internal"
		if port := u.Port(); port != "" {
			newHost += ":" + port
		}
		u.Host = newHost
		return u.String()
	default:
		return dbURL
	}
}
