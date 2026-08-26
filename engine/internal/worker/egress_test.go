package worker

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

// startTCPEchoServer binds on ALL interfaces (":0", never "127.0.0.1:0") and
// echoes back whatever it reads — the "allowed" test target below needs to
// be reachable from the BROKER via host.docker.internal, which (like the
// project's own published Postgres port) requires binding wider than
// loopback; a server bound only to 127.0.0.1 would be invisible from inside
// any container regardless of what this file gets right. Returns the port
// alone (the host side is always "host.docker.internal" from the sandboxed
// container's point of view, and always "host.docker.internal" is what gets
// allowlisted below — never the literal loopback IP a container has no route
// to post-N196).
func startTCPEchoServer(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("start echo server: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return // listener closed — normal shutdown via t.Cleanup
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 4096)
				for {
					n, err := c.Read(buf)
					if n > 0 {
						if _, werr := c.Write(buf[:n]); werr != nil {
							return
						}
					}
					if err != nil {
						return
					}
				}
			}(conn)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// connectThroughProxyScript is a bash script (run via bash's /dev/tcp, the
// same pseudo-device already used elsewhere in this package's tests rather
// than assuming curl/wget are in the image) that speaks one HTTP CONNECT to
// egress-broker's proxy port, prints the status line, and — if it got a
// 200 — writes "PING" through the tunnel and prints whatever comes back.
// Used both for the allowed case (expects "PING" echoed) and the refused
// case (expects "403" and nothing further).
func connectThroughProxyScript(target string) string {
	return fmt.Sprintf(`
exec 3<>/dev/tcp/%s/%s
printf 'CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n' >&3
status=$(head -1 <&3)
echo "STATUS:$status"
if echo "$status" | grep -q "200"; then
  printf 'PING' >&3
  reply=$(timeout 2 head -c 4 <&3)
  echo "REPLY:$reply"
fi
`, egressBrokerHostname, proxyPort, target, target)
}

// TestSandboxCannotDialAnArbitraryExternalHostDirectly is N196's core
// acceptance criterion, proven by the attempt: a sandboxed process bypassing
// HTTP_PROXY entirely (a raw /dev/tcp dial, exactly what a hostile or simply
// proxy-unaware payload would do) must still be unable to reach a host that
// was never asked about — because the sandbox's only network has no route
// out at all, not because anything inspected and refused the attempt.
// 1.1.1.1 is a real, stable public address chosen only for its stability as
// a destination; nothing about this test depends on it actually being
// reachable in principle, only on the connection attempt failing FAST with
// "no route", which a fully `--internal` Docker network produces regardless
// of whether the wider internet is up at all.
func TestSandboxCannotDialAnArbitraryExternalHostDirectly(t *testing.T) {
	dockerAvailable(t)
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: sandboxWorkRoot(t)}
	ws, err := r.Provision(context.Background(), 50, 1, "egress-escape", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	script := `timeout 3 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>&1; echo "EXIT:$?"`
	result, err := ws.RunSandboxed(context.Background(), Sandbox{}, "", nil, []string{"bash", "-c", script})
	if err != nil {
		t.Fatalf("RunSandboxed itself failed (not the same thing as the dial failing): %v", err)
	}
	if strings.Contains(result.Output, "EXIT:0") {
		t.Fatalf("sandboxed process reached an arbitrary external host directly — egress restriction did not hold: %s", result.Output)
	}
	if !strings.Contains(result.Output, "unreachable") {
		t.Fatalf("expected a clear no-route failure (\"Network is unreachable\"), got something else — verify this is still the internal-network mechanism and not e.g. a DNS failure reading as success: %s", result.Output)
	}
}

// TestEgressBrokerProxiesAllowedHostsAndRefusesOthers is the positive half
// N196 also requires: an allowlisted host must actually work end to end
// (not merely "not blocked" — bytes have to really cross the tunnel), and a
// host that was never allowlisted must be refused BY THE PROXY (403, before
// any dial is even attempted on its behalf) even though the sandboxed
// container's HTTP_PROXY is correctly pointed at a broker that COULD reach
// the wider internet on its second leg.
func TestEgressBrokerProxiesAllowedHostsAndRefusesOthers(t *testing.T) {
	dockerAvailable(t)
	echoPort := startTCPEchoServer(t)
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: sandboxWorkRoot(t)}
	ws, err := r.Provision(context.Background(), 51, 1, "egress-proxy", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	allowedTarget := "host.docker.internal:" + strconv.Itoa(echoPort)
	// An explicit "host:port" entry, not a bare hostname — the broker only
	// permits port 443 on a bare-hostname allowlist entry (see
	// egressbroker/main.go's own doc comment), and this test's synthetic
	// echo server deliberately isn't on 443.
	sb := Sandbox{AllowedHosts: []string{allowedTarget}}

	allowedResult, err := ws.RunSandboxed(context.Background(), sb, "", nil,
		[]string{"bash", "-c", connectThroughProxyScript(allowedTarget)})
	if err != nil {
		t.Fatalf("RunSandboxed failed: %v", err)
	}
	if !strings.Contains(allowedResult.Output, "200") {
		t.Fatalf("allowlisted host was refused by the proxy: %s", allowedResult.Output)
	}
	if !strings.Contains(allowedResult.Output, "REPLY:PING") {
		t.Fatalf("proxy accepted the CONNECT but bytes did not actually flow through the tunnel: %s", allowedResult.Output)
	}

	// A DIFFERENT host, never named in AllowedHosts — the broker itself
	// could reach it (it has a real second network leg), so a refusal here
	// proves the ALLOWLIST is what's deciding, not a network-level accident.
	disallowedResult, err := ws.RunSandboxed(context.Background(), sb, "", nil,
		[]string{"bash", "-c", connectThroughProxyScript("example.com:443")})
	if err != nil {
		t.Fatalf("RunSandboxed failed: %v", err)
	}
	if !strings.Contains(disallowedResult.Output, "403") {
		t.Fatalf("a host NOT on the allowlist was not refused with 403: %s", disallowedResult.Output)
	}
	if strings.Contains(disallowedResult.Output, "REPLY:") {
		t.Fatalf("a disallowed CONNECT still relayed bytes — the refusal did not actually stop the tunnel: %s", disallowedResult.Output)
	}
}

// TestTheResidueAuditCatchesALeakedEgressBroker proves AuditResidue's new
// N196 checks actually fire — not merely that the code compiles and reads
// two fields, but that a genuinely-still-running broker container and
// network are reported. The workspace directory is removed FIRST and
// checked to be gone, deliberately isolating this from
// TestTheResidueAuditCanFail's own "workspace directory still exists"
// signal — a pass here has to come from the egress-specific message, not a
// coincidental match on the directory check.
func TestTheResidueAuditCatchesALeakedEgressBroker(t *testing.T) {
	dockerAvailable(t)
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: sandboxWorkRoot(t)}
	ws, err := r.Provision(context.Background(), 52, 1, "egress-residue", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := ws.RunSandboxed(context.Background(), Sandbox{}, "", nil, []string{"true"}); err != nil {
		t.Fatal(err)
	}
	// Registered via t.Cleanup rather than left as a plain call at the end of
	// this function — an assertion failing partway through (t.Fatalf stops
	// the goroutine immediately) must not skip this and leak a container and
	// network, the same class of leak this whole file exists to catch.
	t.Cleanup(func() { ws.teardownEgress(context.Background()) })

	// Simulate a teardown that cleaned up everything EXCEPT the egress
	// broker: remove just the workspace directory, leaving the broker
	// container and network deliberately still running.
	if err := os.RemoveAll(ws.Dir); err != nil {
		t.Fatal(err)
	}
	err = ws.AuditResidue(context.Background())
	if err == nil || !strings.Contains(err.Error(), "egress") {
		t.Fatalf("audit passed (or failed for an unrelated reason) with a live egress broker/network still running: %v", err)
	}

	// Real cleanup, so the audit below observes it too — the t.Cleanup above
	// is the safety net if THIS call itself never runs, not a substitute for
	// checking the audit reflects a real teardown.
	if err := ws.teardownEgress(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := ws.AuditResidue(context.Background()); err != nil {
		t.Fatalf("audit still red after the real egress teardown: %v", err)
	}
}

// TestSandboxCannotResolveArbitraryDNSEither closes a channel that isn't a
// TCP connection at all — found in review, and measured rather than
// assumed: Docker's embedded resolver (127.0.0.11 inside every user-defined
// network) is a SEPARATE path from routing, so "no route out" does not by
// itself prove DNS lookups are blocked too. On an older Docker Engine that
// still forwards external lookups for an `--internal` network, a sandboxed
// process could exfiltrate data via hostnames
// (`<stolen-data>.attacker.example`) without ever opening a connection this
// package's own escape test would catch. Measured directly on this host
// (Docker Engine 29.5.2, 2026-08-26): `getent hosts example.com` from inside
// a bare `--internal` network fails outright — this engine does not forward
// external lookups there. This test pins that as a regression check rather
// than a comment nobody re-verifies; if a future Docker version (or a
// different host) changes this default, this test is the thing that goes
// red, not a silent reintroduction of the channel.
func TestSandboxCannotResolveArbitraryDNSEither(t *testing.T) {
	dockerAvailable(t)
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: sandboxWorkRoot(t)}
	ws, err := r.Provision(context.Background(), 53, 1, "egress-dns", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	result, err := ws.RunSandboxed(context.Background(), Sandbox{}, "", nil,
		[]string{"bash", "-c", "getent hosts example.com; echo EXIT:$?"})
	if err != nil {
		t.Fatalf("RunSandboxed itself failed: %v", err)
	}
	if strings.Contains(result.Output, "EXIT:0") {
		t.Fatalf("an arbitrary external hostname resolved from inside the sandbox — DNS is a live exfiltration channel this test exists to catch: %s", result.Output)
	}
}

// TestASecondCallWithADifferentAllowlistIsRejectedNotSilentlyIgnored is a
// blocking finding from review: ensureEgressBroker's cache-hit path used to
// return the FIRST call's broker regardless of what a later call asked
// for, so a second RunSandboxed call on the same workspace with a
// DIFFERENT Sandbox.AllowedHosts silently ran against the first call's
// allowlist instead — Sandbox.AllowedHosts's own doc comment calls it
// "this sandbox's egress allowlist" (singular, per-call), which was false
// the moment two calls on one workspace disagreed. This proves the fix:
// a mismatched second call errors instead of silently proceeding.
func TestASecondCallWithADifferentAllowlistIsRejectedNotSilentlyIgnored(t *testing.T) {
	dockerAvailable(t)
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: sandboxWorkRoot(t)}
	ws, err := r.Provision(context.Background(), 54, 1, "egress-mismatch", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	first1 := Sandbox{AllowedHosts: []string{"github.com"}}
	if _, err := ws.RunSandboxed(context.Background(), first1, "", nil, []string{"true"}); err != nil {
		t.Fatalf("first call (starting the broker) failed: %v", err)
	}

	second := Sandbox{AllowedHosts: []string{"api.github.com"}} // deliberately DIFFERENT
	_, err = ws.RunSandboxed(context.Background(), second, "", nil, []string{"true"})
	if err == nil {
		t.Fatal("a second call with a different allowlist silently succeeded against the first call's broker — the mismatch went uncaught")
	}
	if !strings.Contains(err.Error(), "different configuration") {
		t.Fatalf("wrong error, or the guard's message changed without this test updating: %v", err)
	}

	// The SAME allowlist as the first call must still be a cache hit, not
	// an error — this guard is about disagreement, not about ever calling
	// RunSandboxed more than once.
	if _, err := ws.RunSandboxed(context.Background(), first1, "", nil, []string{"true"}); err != nil {
		t.Fatalf("a repeated call with the SAME allowlist was rejected — the guard is too strict: %v", err)
	}
}

// TestTheResidueAuditCatchesALeakEvenWhenInMemoryStateSaysClean is the exact
// scenario the review finding was about: teardownEgressLocked clears
// ws.egress.network/.container REGARDLESS of whether the underlying
// `docker rm`/`network rm` actually succeeded (so a caller can retry a
// genuinely-failed removal rather than losing track of what needs
// removing) — which means those fields can read "" while the real
// container and network are still running. AuditResidue must not be fooled
// by that: it has to ask Docker, not trust memory. Simulated directly here
// by clearing the fields BY HAND without actually removing anything —
// exactly what a failed-but-field-cleared teardown leaves behind — rather
// than trying to force a real `docker rm` failure, which isn't reliably
// reproducible from a test.
func TestTheResidueAuditCatchesALeakEvenWhenInMemoryStateSaysClean(t *testing.T) {
	dockerAvailable(t)
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: sandboxWorkRoot(t)}
	ws, err := r.Provision(context.Background(), 55, 1, "egress-stale-memory", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ws.RunSandboxed(context.Background(), Sandbox{}, "", nil, []string{"true"}); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(ws.Dir); err != nil {
		t.Fatal(err)
	}

	// Capture the real names BEFORE clearing the in-memory fields — the
	// cleanup below has to remove the ACTUAL container/network by name,
	// since teardownEgress itself reads these same fields to know what to
	// remove: registering `t.Cleanup(func() { ws.teardownEgress(...) })`
	// AFTER zeroing them would clean up nothing at all (found the hard
	// way — the first version of this test did exactly that and leaked a
	// container and network every run, mutation or not, because
	// teardownEgressLocked's own "is there anything to remove?" checks read
	// the very fields this test had already blanked).
	ws.egress.mu.Lock()
	realNetwork, realContainer := ws.egress.network, ws.egress.container
	ws.egress.mu.Unlock()
	t.Cleanup(func() {
		exec.Command("docker", "rm", "-f", realContainer).Run()
		exec.Command("docker", "network", "rm", realNetwork).Run()
	})

	// Simulate teardownEgressLocked having cleared its bookkeeping despite
	// the real docker commands failing — the container and network are
	// still genuinely running on the daemon; only the in-memory record is
	// wrong.
	ws.egress.mu.Lock()
	ws.egress.network = ""
	ws.egress.container = ""
	ws.egress.brokerIP = ""
	ws.egress.mu.Unlock()

	err = ws.AuditResidue(context.Background())
	if err == nil || !strings.Contains(err.Error(), "egress") {
		t.Fatalf("audit trusted stale in-memory state and missed a genuinely still-running broker/network: %v", err)
	}
}

// TestEgressBrokerRefusesAnAllowlistedHostOnTheWrongPort proves the port
// restriction (found in review: CONNECT used to be host-checked only, so an
// allowlisted host could tunnel ANY port — CONNECT github.com:22 got you
// SSH). A bare hostname allowlist entry permits ONLY port 443 on it.
func TestEgressBrokerRefusesAnAllowlistedHostOnTheWrongPort(t *testing.T) {
	dockerAvailable(t)
	src, first, _ := makeSourceRepo(t)
	r := &Runner{RepoURL: src, WorkRoot: sandboxWorkRoot(t)}
	ws, err := r.Provision(context.Background(), 56, 1, "egress-wrong-port", first, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Teardown(context.Background())

	// "github.com" (bare, no port) is on the DEFAULT allowlist and permits
	// only :443 — port 22 must be refused even though the HOST is allowed.
	sb := Sandbox{AllowedHosts: []string{"github.com"}}
	result, err := ws.RunSandboxed(context.Background(), sb, "", nil,
		[]string{"bash", "-c", connectThroughProxyScript("github.com:22")})
	if err != nil {
		t.Fatalf("RunSandboxed failed: %v", err)
	}
	if !strings.Contains(result.Output, "403") {
		t.Fatalf("an allowlisted host on a NON-443 port was not refused: %s", result.Output)
	}
	if strings.Contains(result.Output, "REPLY:") {
		t.Fatalf("a wrong-port CONNECT still relayed bytes: %s", result.Output)
	}
}
