// N196/#622: RunSandboxed's own doc comment (sandbox.go) used to say network
// egress is deliberately open — Docker's ordinary default, reachable to any
// host on the internet. This file closes that, and the mechanism is chosen
// and justified here rather than in the ticket, because the choice follows
// directly from two measurements against this project's own Colima host
// (both reproducible with plain `docker` commands, no engine code needed):
//
//   - `docker network create --internal` blocks EVERY route out of that
//     bridge, not just the internet — a container on it gets "Network is
//     unreachable" dialing host.docker.internal too. So `--internal` alone
//     cannot be the sandbox's ONLY network change: the workspace's own
//     ephemeral database (reached via host.docker.internal — see
//     rewriteHostForSandbox) would break along with everything else.
//   - Two containers on the SAME internal bridge reach each other fine
//     (that never leaves the bridge), and a container attached to BOTH the
//     internal bridge and Docker's ordinary default bridge has full
//     internet + host.docker.internal reachability on its second leg.
//
// Those two facts compose into the design: the sandboxed container's ONLY
// network is a fresh `--internal` bridge (RunSandboxed's existing
// `--add-host host.docker.internal:host-gateway` is dropped for it — that
// address is now unreachable by construction, which is the point), and a
// small sidecar — egressbroker, embedded below and run inside a container
// dual-homed onto that bridge and the default one — is the sandbox's ONLY
// path to anything outside its own workspace directory. It relays the
// workspace's own database to a FIXED target (never sandboxed-input-
// controlled) and proxies HTTPS to an explicit allowlist; everything else a
// sandboxed process might attempt has no route to take, the same class of
// guarantee RunSandboxed's filesystem sandboxing already gives (not merely
// "isn't handed a credential" but "the path does not exist to reach").
//
// This was the alternative to container-level firewall rules (iptables/
// nftables in or around the container), which the ticket named as the other
// option: rejected because it needs root/CAP_NET_ADMIN on whatever host runs
// dockerd, which differs by environment (this project's own Colima VM,
// locally, vs a CI runner, vs wherever the engine eventually deploys) and
// would be a bigger privilege grant to the engine process itself than
// anything this package has needed so far. The broker needs nothing beyond
// the `docker` CLI this package already shells out to everywhere else.
package worker

import (
	"context"
	"embed"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed egressbroker/*.go
var egressBrokerSrc embed.FS

// syntheticBrokerGoMod is written alongside the embedded broker source at
// materialize time (see materializeEmbeddedDir) rather than embedded from a
// go.mod ON DISK in egressbroker/ — `go run .` needs SOME go.mod to run in
// module mode at all (found the hard way: golang:1.26-bookworm's `go run .`
// against a bind mount with only main.go fails outright with "go.mod file
// not found", before the broker ever listens on anything), but `go:embed`
// refuses to embed a directory that is ITSELF a separate Go module ("cannot
// embed directory egressbroker: in different module") — so egressbroker/
// cannot hold a real go.mod on disk without breaking the embed directive
// above. Synthesizing it as a plain string sidesteps both problems at once.
// The broker imports nothing beyond the standard library, so there is
// nothing else for this to declare.
const syntheticBrokerGoMod = "module egressbroker\n\ngo 1.26\n"

// egressBrokerHostname/dbRelayPort/proxyPort are the single source of truth
// for how a sandboxed container reaches its broker: --add-host names the
// broker exactly egressBrokerHostname (see RunSandboxed), and these two
// ports are passed to the broker via DB_RELAY_PORT/PROXY_PORT rather than
// hardcoded on both sides — see egressbroker/main.go's own doc comment on
// its defaults, which exist only for running that program by hand.
const (
	egressBrokerHostname = "egress-broker"
	dbRelayPort          = "15432"
	proxyPort            = "8888"
)

// DefaultAllowedHosts is the egress allowlist a Sandbox gets when it does
// not set its own — the "at minimum" list N196's acceptance criteria name,
// plus storage.googleapis.com: the Go module proxy is GCS-backed and known
// to redirect large-module fetches there, so a client that follows the
// redirect through the SAME proxy configuration would otherwise hit an
// allowlist it was never told about.
var DefaultAllowedHosts = []string{
	"proxy.golang.org",
	"sum.golang.org",
	"storage.googleapis.com",
	"registry.npmjs.org",
	"github.com",
	"api.github.com",
	"objects.githubusercontent.com",
}

// egressBroker is one workspace's running sidecar — created lazily on the
// first RunSandboxed call that needs it, and reused for every later call on
// the same *Workspace, the same caching shape mountVerified already uses for
// the mount pre-flight check. network and container are named for exactly
// this run (see ensureEgressBroker) so Teardown can remove precisely what it
// started, never "whatever matches a loose filter".
type egressBroker struct {
	mu        sync.Mutex
	network   string // "" until started
	container string
	brokerIP  string // this broker's address on `network`, from the sandboxed container's side
	srcDir    string // embedded broker source, materialized once under ws.Dir's parent

	// startedWithAllowlist/startedWithDBTarget record what the RUNNING
	// broker was actually configured with, so a later RunSandboxed call
	// with a DIFFERENT Sandbox.AllowedHosts can be caught rather than
	// silently ignored — found in review: the cache-hit path used to return
	// the existing broker's IP regardless of what THIS call asked for,
	// so a caller reading Sandbox.AllowedHosts as "this call's allowlist"
	// (which its own doc comment claims) would be wrong the moment a
	// second call on the same workspace asked for something different. A
	// canonicalized (sorted, comma-joined) form, so two equal sets built in
	// a different order don't spuriously mismatch.
	startedWithAllowlist string
	startedWithDBTarget  string
}

// ensureEgressBroker starts this workspace's broker (network + sidecar
// container) on first use and returns its internal-network IP AND the
// internal network's own name on every call, including the first — later
// calls are a cache hit guarded by mu, not a second container, PROVIDED
// allowedHosts and dbTarget match what the running broker was actually
// started with (see egressBroker's own doc comment on why this is checked
// rather than silently ignored on a cache hit). Returning the network name
// too (rather than making a caller read ws.egress.network separately,
// outside this lock) keeps every read of that field inside its own mutex —
// found in review, since a caller reading it unguarded right after this
// returns would be exactly the kind of benign-looking data race
// `go test -race` exists to catch. allowedHosts is passed through verbatim
// to the broker's ALLOWED_HOSTS env var; dbTarget is the FIXED host:port the
// broker will relay database connections to (empty when this workspace has
// no database).
func (ws *Workspace) ensureEgressBroker(ctx context.Context, allowedHosts []string, dbTarget string) (brokerIP, networkName string, err error) {
	ws.egress.mu.Lock()
	defer ws.egress.mu.Unlock()
	requestedAllowlist := canonicalAllowlist(allowedHosts)
	if ws.egress.brokerIP != "" {
		if ws.egress.startedWithAllowlist != requestedAllowlist || ws.egress.startedWithDBTarget != dbTarget {
			return "", "", fmt.Errorf(
				"egress: this workspace's broker is already running with a different configuration "+
					"(allowlist %q, db target %q) than this call requested (allowlist %q, db target %q) — "+
					"one workspace's broker cannot serve two different Sandbox.AllowedHosts values; use separate workspaces or a consistent allowlist",
				ws.egress.startedWithAllowlist, ws.egress.startedWithDBTarget, requestedAllowlist, dbTarget)
		}
		return ws.egress.brokerIP, ws.egress.network, nil
	}

	// Suffixed with random hex, not just RunID — found in review (confirmed
	// LIVE, twice independently, by two different review agents running this
	// same suite concurrently on this shared multi-agent host):
	// `network with name engine-egress-<runID> already exists`. This
	// package's own tests use fixed RunIDs (Provision(..., 50, ...) etc.),
	// and Docker network names are global to the daemon, so two concurrent
	// invocations of this test suite collide on the same name. Provision
	// already solved exactly this for Dir/DBName with a random suffix (see
	// its own doc comment); this mirrors that rather than inventing a
	// second convention.
	suffix, err := randomHex(4)
	if err != nil {
		return "", "", fmt.Errorf("egress: generate name suffix: %w", err)
	}
	networkName = fmt.Sprintf("engine-egress-%d-%s", ws.RunID, suffix)
	if out, err := exec.CommandContext(ctx, "docker", "network", "create", "--internal", networkName).CombinedOutput(); err != nil {
		return "", "", fmt.Errorf("egress: create internal network: %w: %s", err, strings.TrimSpace(string(out)))
	}
	ws.egress.network = networkName

	// The broker's source is embedded IN THIS BINARY (see egressBrokerSrc)
	// rather than read from a source tree on disk — the running process may
	// be a deployed binary with no engine/ checkout anywhere near it, and
	// this is the only way `go run` (below) has something to point at
	// regardless. Materialized once per workspace, alongside it rather than
	// inside it, so it is never mistaken for part of the sandboxed clone.
	srcDir := ws.Dir + "-egressbroker-src"
	if err := materializeEmbeddedDir(egressBrokerSrc, "egressbroker", srcDir); err != nil {
		ws.teardownEgressLocked(ctx) // ctx here is unused by the cleanup itself — see that function's doc comment
		return "", "", fmt.Errorf("egress: materialize broker source: %w", err)
	}
	ws.egress.srcDir = srcDir
	// syntheticBrokerGoMod's own doc comment explains why this is written
	// here rather than embedded alongside main.go.
	if err := os.WriteFile(filepath.Join(srcDir, "go.mod"), []byte(syntheticBrokerGoMod), 0o600); err != nil {
		ws.teardownEgressLocked(ctx)
		return "", "", fmt.Errorf("egress: write broker go.mod: %w", err)
	}

	// Same suffix as the network above — easier to correlate the pair in
	// `docker ps`/`docker network ls` while debugging, and no reason to
	// generate a second one.
	containerName := fmt.Sprintf("engine-egress-broker-%d-%s", ws.RunID, suffix)
	runArgs := []string{
		"run", "-d", "--rm", "--name", containerName,
		"--network", networkName,
		// host.docker.internal resolves out of the box on Docker Desktop and
		// this project's own Colima setup, but NOT on native Linux Docker
		// (CI's ubuntu-latest runners) unless told to — the exact class of
		// bug RunSandboxed's own comment already names for the SANDBOXED
		// container, reproduced here for the BROKER: found by a real CI
		// failure (both TestEgressBrokerProxiesAllowedHostsAndRefusesOthers
		// and TestSandboxCanReachTheHostsEphemeralDatabase failed on
		// ubuntu-latest — "502 Bad Gateway" and "connection reset by peer"
		// respectively — while passing locally on Colima, which resolves it
		// regardless of this flag, so the gap was invisible until CI ran
		// it). `--add-host` is a `docker run`-time flag and this survives
		// the LATER `docker network connect bridge` below unaffected — it
		// writes an /etc/hosts entry, independent of which networks get
		// attached afterward.
		"--add-host", "host.docker.internal:host-gateway",
		"-v", srcDir + ":/broker:ro",
		"-w", "/broker",
		"-e", "DB_TARGET=" + dbTarget,
		"-e", "ALLOWED_HOSTS=" + strings.Join(allowedHosts, ","),
		"-e", "DB_RELAY_PORT=" + dbRelayPort,
		"-e", "PROXY_PORT=" + proxyPort,
		DefaultSandboxImage, // has the Go toolchain the broker is `go run` under; no separate image to build/pull
		"go", "run", ".",
	}
	if out, err := exec.CommandContext(ctx, "docker", runArgs...).CombinedOutput(); err != nil {
		ws.teardownEgressLocked(ctx)
		return "", "", fmt.Errorf("egress: start broker container: %w: %s", err, strings.TrimSpace(string(out)))
	}
	ws.egress.container = containerName

	// The second leg: real internet + host.docker.internal, via Docker's
	// ordinary default bridge — this is what makes the broker able to relay
	// anything at all, and is the one network connection this whole file
	// exists to make sure the SANDBOXED container never gets a copy of.
	if out, err := exec.CommandContext(ctx, "docker", "network", "connect", "bridge", containerName).CombinedOutput(); err != nil {
		ws.teardownEgressLocked(ctx)
		return "", "", fmt.Errorf("egress: connect broker to default bridge: %w: %s", err, strings.TrimSpace(string(out)))
	}

	ip, err := brokerInternalIP(ctx, containerName, networkName)
	if err != nil {
		ws.teardownEgressLocked(ctx)
		return "", "", fmt.Errorf("egress: read broker's internal-network address: %w", err)
	}

	// `docker run -d` returns as soon as the container's process STARTS, not
	// once it is actually listening — `go run .` has to compile the broker
	// first, which measurably takes longer than the gap between this call
	// returning and a sandboxed container's first connection attempt.
	// Without this wait, that race is real: measured directly, "Connection
	// refused" on a fresh broker rather than any behavior the code above is
	// wrong about. Waiting on the broker's OWN loopback (from inside its
	// container, via docker exec) rather than on brokerIP from out here — no
	// process outside the internal network can dial that address at all,
	// which is the entire point of it being internal-only.
	if err := waitForBrokerReady(ctx, containerName); err != nil {
		ws.teardownEgressLocked(ctx)
		return "", "", fmt.Errorf("egress: broker did not become ready: %w", err)
	}

	ws.egress.brokerIP = ip
	ws.egress.startedWithAllowlist = requestedAllowlist
	ws.egress.startedWithDBTarget = dbTarget
	return ip, networkName, nil
}

// canonicalAllowlist renders an allowlist as a stable, order-independent
// string for equality comparison — two calls building the same set of hosts
// in a different order (or with different backing slices) must compare
// equal, or ensureEgressBroker's mismatch check would fire on a distinction
// that was never real.
func canonicalAllowlist(hosts []string) string {
	sorted := append([]string(nil), hosts...)
	sort.Strings(sorted)
	return strings.Join(sorted, ",")
}

// waitForBrokerReady polls the broker's own two listeners from INSIDE its
// container (its loopback, not brokerIP — see the call site's comment) until
// both accept a connection or the deadline passes. bash's /dev/tcp is the
// same pseudo-device sandbox_test.go already relies on for connectivity
// checks against this same image, so this needs nothing the broker's image
// doesn't already carry.
func waitForBrokerReady(ctx context.Context, containerName string) error {
	deadline := time.Now().Add(15 * time.Second)
	script := fmt.Sprintf(
		`exec 3<>/dev/tcp/localhost/%s && exec 4<>/dev/tcp/localhost/%s`,
		dbRelayPort, proxyPort)
	for {
		// Fail fast on a cancelled/expired ctx rather than burning the full
		// 15s wall-clock deadline finding out the hard way — every retry
		// below would fail near-instantly anyway once ctx is done, so
		// without this a caller whose OWN context was already cancelled
		// (a run's wall-time budget, say) waits out the full deadline for
		// no reason, which can itself blow a caller's own shorter timeout.
		// Found while fixing the leak this same cancellation shape caused
		// in ensureEgressBroker's cleanup path — see teardownEgressLocked.
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("broker readiness wait: %w", err)
		}
		cmd := exec.CommandContext(ctx, "docker", "exec", containerName, "bash", "-c", script)
		if err := cmd.Run(); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			out, _ := exec.CommandContext(ctx, "docker", "logs", containerName).CombinedOutput()
			return fmt.Errorf("broker did not start listening within 15s; container logs: %s", strings.TrimSpace(string(out)))
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// brokerInternalIP reads the broker's OWN address on networkName — never
// assumed or computed from the subnet, since Docker's IPAM assigns it and
// nothing here should have to agree with IPAM's allocation order to be
// correct.
func brokerInternalIP(ctx context.Context, containerName, networkName string) (string, error) {
	format := fmt.Sprintf(`{{(index .NetworkSettings.Networks %q).IPAddress}}`, networkName)
	out, err := exec.CommandContext(ctx, "docker", "inspect", containerName, "--format", format).Output()
	if err != nil {
		return "", err
	}
	ip := strings.TrimSpace(string(out))
	if ip == "" || net.ParseIP(ip) == nil {
		return "", fmt.Errorf("docker inspect returned no usable address: %q", ip)
	}
	return ip, nil
}

// teardownEgress removes this workspace's broker container and network, if
// any were started — best-effort, mirroring Workspace.Teardown's own style
// (collect what it can, never panic on a partial failure). Safe to call on a
// workspace that never started a broker at all (every command is a no-op
// against nothing).
func (ws *Workspace) teardownEgress(ctx context.Context) error {
	ws.egress.mu.Lock()
	defer ws.egress.mu.Unlock()
	return ws.teardownEgressLocked(ctx)
}

// teardownEgressLocked is teardownEgress's actual body, split out because
// ensureEgressBroker's own failure paths need to clean up a partial start
// WHILE STILL HOLDING ws.egress.mu — sync.Mutex is not reentrant, so calling
// the locking teardownEgress from inside ensureEgressBroker would deadlock
// the run permanently rather than fail it. Callers must already hold the
// lock; teardownEgress (above) is the only entry point that does not.
//
// The ctx parameter is deliberately IGNORED for the docker commands below —
// found the hard way, by reproducing it: ensureEgressBroker's own failure
// paths call this with the SAME ctx that just caused the failure (e.g. a
// cancelled run's context, mid-`waitForBrokerReady`), and exec.CommandContext
// against an already-done context never even starts the process — Go returns
// immediately with ctx.Err(), so a cleanup call "using" a dead context is
// indistinguishable from not calling it at all. Measured: a cancelled sandbox
// run left `engine-egress-broker-44` and `engine-egress-44` running
// (confirmed live, not crash-looping — its own log line printed and it kept
// serving) because this function's cleanup commands inherited the same
// cancellation that triggered them. This mirrors RunSandboxed's own
// cmd.Cancel, which uses plain exec.Command (no context at all) for exactly
// this reason: a resource that needs removing BECAUSE something was
// cancelled must not have its removal blocked by that same cancellation.
// cleanupCtx is bounded (not context.Background() unbounded) so a wedged
// Docker daemon cannot hang a caller forever either.
func (ws *Workspace) teardownEgressLocked(ctx context.Context) error {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var firstErr error
	if ws.egress.container != "" {
		if out, err := exec.CommandContext(cleanupCtx, "docker", "rm", "-f", ws.egress.container).CombinedOutput(); err != nil {
			firstErr = fmt.Errorf("remove broker container: %w: %s", err, strings.TrimSpace(string(out)))
		}
		ws.egress.container = ""
	}
	if ws.egress.network != "" {
		if out, err := exec.CommandContext(cleanupCtx, "docker", "network", "rm", ws.egress.network).CombinedOutput(); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("remove egress network: %w: %s", err, strings.TrimSpace(string(out)))
			}
		}
		ws.egress.network = ""
	}
	if ws.egress.srcDir != "" {
		os.RemoveAll(ws.egress.srcDir)
		ws.egress.srcDir = ""
	}
	ws.egress.brokerIP = ""
	return firstErr
}

// materializeEmbeddedDir writes every file under fsys's subdir into dest on
// the real filesystem — needed because `go run` (and the bind mount it
// requires) needs actual files, and embed.FS is read-only in memory. dest is
// created fresh (0o700 — this is our own trusted broker source, not
// sandboxed content, but there is no reason to make it world-readable
// either) and this refuses to overwrite an existing directory, since two
// workspaces racing to materialize the SAME path would otherwise be able to
// step on each other's broker source mid-write.
func materializeEmbeddedDir(fsys embed.FS, subdir, dest string) error {
	if _, err := os.Stat(dest); err == nil {
		return fmt.Errorf("materialize: %s already exists", dest)
	}
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return err
	}
	entries, err := fsys.ReadDir(subdir)
	if err != nil {
		os.RemoveAll(dest)
		return err
	}
	for _, e := range entries {
		content, err := fsys.ReadFile(filepath.Join(subdir, e.Name()))
		if err != nil {
			os.RemoveAll(dest)
			return err
		}
		if err := os.WriteFile(filepath.Join(dest, e.Name()), content, 0o600); err != nil {
			os.RemoveAll(dest)
			return err
		}
	}
	return nil
}

// dbTargetFor returns the FIXED host:port the BROKER should dial for
// database connections — the broker sits on Docker's ordinary default
// bridge (see ensureEgressBroker), so it reaches the workspace's own
// ephemeral database exactly the way a pre-N196 sandboxed container used
// to: host.docker.internal, since Postgres runs on the Docker host's side,
// never inside any sandbox. This is deliberately NOT what the SANDBOXED
// container's own DATABASE_URL points at any more — see
// rewriteHostForEgressBrokerRelay for that, which points at the broker's
// relay instead, because host.docker.internal is unreachable from a fully
// `--internal`-networked container by construction (measured; see this
// file's package doc). Empty when ws has no database at all (a workspace
// built without AdminDBURL), matching Env()'s own "no DATABASE_URL
// entries" behavior in that case.
func dbTargetFor(ws *Workspace) string {
	if ws.DBURL == "" {
		return ""
	}
	return hostPortFromURL(rewriteHostForSandbox(ws.DBURL))
}

// rewriteHostForEgressBrokerRelay is rewriteHostForSandbox's counterpart for
// the SANDBOXED container's own env (as opposed to dbTargetFor, which is the
// BROKER's dial target). A loopback host is rewritten to the broker's
// relay — egress-broker:<dbRelayPort>, always that fixed port regardless of
// the original one, since the relay's listening port is independent of
// whatever port the real database happens to run on (the broker already
// knows the real target from its own DB_TARGET at startup; the sandboxed
// client never needs to). A non-loopback host (a real remote database) is
// left completely unchanged, matching rewriteHostForSandbox's own rule —
// only a LOCAL database exists behind the broker's relay at all.
func rewriteHostForEgressBrokerRelay(dbURL string) string {
	u, err := url.Parse(dbURL)
	if err != nil {
		return dbURL
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		u.Host = egressBrokerHostname + ":" + dbRelayPort
		return u.String()
	default:
		return dbURL
	}
}

func hostPortFromURL(rawURL string) string {
	// rewriteHostForSandbox already guarantees this parses (it round-trips
	// through net/url itself); a second parse here keeps this function
	// self-contained rather than threading a *url.URL through two files.
	i := strings.Index(rawURL, "@")
	if i < 0 {
		return ""
	}
	rest := rawURL[i+1:]
	if j := strings.IndexAny(rest, "/?"); j >= 0 {
		rest = rest[:j]
	}
	return rest
}

// egressResidue asks the Docker daemon directly whether THIS workspace's
// egress broker container or network still exist, appending a message to
// *residue for each found — the real-world check AuditResidue needs instead
// of trusting ws.egress's in-memory fields (see the call site's comment for
// why those fields alone are not enough). Matching is done by exact PREFIX
// in Go, not by Docker's own `--filter name=` alone: that filter is a plain
// substring match, and this run's names are suffixed with random hex (see
// ensureEgressBroker) — a bare `--filter name=engine-egress-4-` would also
// match a DIFFERENT run's `engine-egress-44-<suffix>` (the substring "4-"
// occurs inside "44-<suffix>"), which would misattribute one run's residue
// to another's audit. The Docker-side filter here is only a coarse
// narrowing (cuts the list Docker returns before this function iterates
// it); the actual decision uses strings.HasPrefix against a fully-anchored
// prefix.
func (ws *Workspace) egressResidue(ctx context.Context, residue *[]string) error {
	networkPrefix := fmt.Sprintf("engine-egress-%d-", ws.RunID)
	containerPrefix := fmt.Sprintf("engine-egress-broker-%d-", ws.RunID)

	netOut, err := exec.CommandContext(ctx, "docker", "network", "ls",
		"--filter", "name=engine-egress-", "--format", "{{.Name}}").Output()
	if err != nil {
		return fmt.Errorf("list networks: %w", err)
	}
	for _, name := range strings.Split(strings.TrimSpace(string(netOut)), "\n") {
		if name != "" && strings.HasPrefix(name, networkPrefix) {
			*residue = append(*residue, "egress network still exists: "+name)
		}
	}

	psOut, err := exec.CommandContext(ctx, "docker", "ps", "-a",
		"--filter", "name=engine-egress-broker-", "--format", "{{.Names}}").Output()
	if err != nil {
		return fmt.Errorf("list containers: %w", err)
	}
	for _, name := range strings.Split(strings.TrimSpace(string(psOut)), "\n") {
		if name != "" && strings.HasPrefix(name, containerPrefix) {
			*residue = append(*residue, "egress broker container still exists: "+name)
		}
	}
	return nil
}
