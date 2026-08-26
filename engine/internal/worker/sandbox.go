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
)

// DefaultSandboxImage is used when Sandbox.Image is empty. It carries the
// same Go toolchain version this module itself builds with (see go.mod) and
// git, needed by gates like the clean-tree check. It does NOT carry
// pnpm/node/python — gates that need those need a richer image, which is a
// choice for whoever configures Sandbox.Image, not something this package
// hardcodes.
const DefaultSandboxImage = "golang:1.26-bookworm"

// Sandbox configures one sandboxed run. The zero value is valid — Image
// defaults to DefaultSandboxImage.
type Sandbox struct {
	Image string
}

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
// reaches the container implicitly. Two entries are rewritten rather than
// passed verbatim, both explained where they're defined: GOCACHE/
// GOMODCACHE are redirected to a path inside the workspace instead of the
// host's real cache (see containerGoCache above), and DATABASE_URL/
// TEST_DATABASE_URL have "localhost"/"127.0.0.1" rewritten to
// host.docker.internal — a sandboxed container has its OWN loopback,
// separate from the host's, so the run's own ephemeral database (which
// Provision created ON THE HOST) is otherwise unreachable from inside it.
//
// Networking is Docker's ordinary default (bridge) — reachable to the
// internet and, via host.docker.internal, to the host's own ports.
// Restricting that to a specific allowlist of legitimate hosts is
// deliberately NOT done here: see the package doc and this ticket's history
// entry for why, and N-tracking-ticket for the follow-up. Requires `docker`
// on PATH; this package's isolation guarantee depends on Docker's own
// container boundary, so if Docker is unavailable this returns an error
// rather than silently running unsandboxed — a fallback would be exactly
// the "isolation is optional" failure this file exists to close.
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
	// actionable error instead.
	if err := verifyMount(ctx, ws.Dir, image); err != nil {
		return SandboxResult{}, err
	}

	args := []string{
		"run", "--rm",
		"-v", ws.Dir + ":/workspace",
		"-w", workdir,
	}
	for _, e := range sandboxEnv(env) {
		args = append(args, "-e", e)
	}
	args = append(args, image)
	args = append(args, command...)

	cmd := exec.CommandContext(ctx, "docker", args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()

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
// to lack it.
func verifyMount(ctx context.Context, hostDir, image string) error {
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm",
		"-v", hostDir+":/workspace", image, "test", "-e", "/workspace/.git")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf(
			"sandbox: workspace mount appears empty inside the container — "+
				"on this host's Docker setup (e.g. Colima sharing only $HOME "+
				"into its VM by default), WorkRoot must be a path Docker "+
				"actually shares into its VM, not just any temp directory: %w", err)
	}
	return nil
}

// sandboxEnv rewrites the two env-var classes RunSandboxed's doc comment
// names, leaving everything else untouched.
func sandboxEnv(env []string) []string {
	out := make([]string, 0, len(env)+2)
	for _, e := range env {
		k, v, ok := strings.Cut(e, "=")
		if !ok {
			out = append(out, e)
			continue
		}
		switch k {
		case "GOCACHE", "GOMODCACHE":
			continue // replaced below with container-local paths
		case "DATABASE_URL", "TEST_DATABASE_URL":
			out = append(out, k+"="+rewriteHostForSandbox(v))
		default:
			out = append(out, e)
		}
	}
	return append(out,
		"GOCACHE="+containerGoCache,
		"GOMODCACHE="+containerGoModCache)
}

// rewriteHostForSandbox swaps a loopback host for host.docker.internal, the
// address a container uses to reach a port bound on the host machine. A
// non-loopback host (a real remote database, say) is returned unchanged —
// only "the workspace's own database, created on the host we're sandboxed
// away from" needs this rewrite.
func rewriteHostForSandbox(dbURL string) string {
	u, err := url.Parse(dbURL)
	if err != nil {
		return dbURL
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1":
		newHost := "host.docker.internal"
		if port := u.Port(); port != "" {
			newHost += ":" + port
		}
		u.Host = newHost
	}
	return u.String()
}
