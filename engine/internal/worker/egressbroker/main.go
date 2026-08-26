// Command egressbroker is N196/#622: the ONLY path out of a sandboxed
// container's network. It is embedded as source (see broker.go's go:embed)
// and run inside a small sidecar container attached to two networks — the
// sandbox's fully `--internal` bridge (no route anywhere, verified: a
// container on it gets "Network is unreachable" dialing ANY address outside
// the bridge, including the Docker host itself) and Docker's ordinary
// default bridge (real internet + host.docker.internal). A sandboxed
// process therefore has exactly two ways to reach anything outside its own
// workspace directory, both mediated here:
//
//   - the workspace's own ephemeral database, relayed on dbRelayPort to a
//     FIXED target given at startup (DB_TARGET) — never attacker-influenced,
//     so no allowlist check is needed for it, matching this package's
//     existing (pre-N196) trust boundary: the database a run's own role
//     already owns was never the thing N196 restricts.
//   - HTTPS to an explicit allowlist (ALLOWED_HOSTS), via an HTTP CONNECT
//     proxy on proxyPort — the shape the Go toolchain, npm/pnpm and git all
//     already speak when HTTP_PROXY/HTTPS_PROXY are set, so no change to
//     the tools running inside the sandbox is needed, only to what they're
//     pointed at. A bare hostname entry in ALLOWED_HOSTS permits ONLY port
//     443 on it — CONNECT to any other port is refused even for an
//     allowlisted host, matching "HTTPS" literally rather than "any TCP to
//     this host" (found in review: the first version let an allowlisted
//     host tunnel ANY port). An entry already carrying its own ":port"
//     (e.g. a test's synthetic local target) permits only that exact pair.
//
// Plain (non-CONNECT) HTTP proxying is deliberately NOT implemented: every
// host on the default allowlist (proxy.golang.org, sum.golang.org,
// storage.googleapis.com, registry.npmjs.org, github.com, api.github.com,
// objects.githubusercontent.com) serves HTTPS only. Adding it later is
// straightforward if a future gate needs a plain-HTTP source; until then it
// would be an untested path carrying no real traffic.
package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"time"
)

// dbRelayPort and proxyPort default to the values the worker package's
// ensureEgressBroker also defaults to (see egress.go's matching constants) —
// but the orchestrator is the single source of truth: it always passes
// DB_RELAY_PORT/PROXY_PORT explicitly, so these defaults exist only for
// running this program by hand (`go run .`) outside that wiring, e.g. while
// developing it.
const (
	defaultDBRelayPort = "15432"
	defaultProxyPort   = "8888"
)

func main() {
	dbTarget := os.Getenv("DB_TARGET")
	allowed := parseAllowlist(os.Getenv("ALLOWED_HOSTS"))
	dbRelayPort := envOr("DB_RELAY_PORT", defaultDBRelayPort)
	proxyPort := envOr("PROXY_PORT", defaultProxyPort)
	log.Printf("egressbroker: db_target=%q allowed_hosts=%v db_relay_port=%s proxy_port=%s", dbTarget, allowed, dbRelayPort, proxyPort)

	errc := make(chan error, 2)
	go func() { errc <- serveDBRelay(dbTarget, dbRelayPort) }()
	go func() { errc <- serveHTTPSProxy(allowed, proxyPort) }()
	log.Fatal(<-errc)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// parseAllowlist splits a comma-separated ALLOWED_HOSTS into a lowercase set.
// Empty entries (from a trailing comma or an unset var) are dropped rather
// than matching everything or nothing surprising.
func parseAllowlist(raw string) map[string]bool {
	set := make(map[string]bool)
	for _, h := range strings.Split(raw, ",") {
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" {
			set[h] = true
		}
	}
	return set
}

// serveDBRelay accepts raw TCP on dbRelayPort and forwards every connection
// to dbTarget, unconditionally — dbTarget is this broker's own startup
// configuration, never something a connecting sandboxed process supplies, so
// there is nothing here for a hostile input to redirect. An empty dbTarget
// (no database provisioned for this workspace) means the listener still
// runs — a caller connecting to it gets an immediate close, a clear "nothing
// is there" rather than a hang.
func serveDBRelay(dbTarget, port string) error {
	ln, err := net.Listen("tcp", ":"+port)
	if err != nil {
		return fmt.Errorf("db relay: listen: %w", err)
	}
	for {
		conn, err := ln.Accept()
		if err != nil {
			return fmt.Errorf("db relay: accept: %w", err)
		}
		go relayDB(conn, dbTarget)
	}
}

func relayDB(client net.Conn, dbTarget string) {
	defer client.Close()
	if dbTarget == "" {
		return // no database for this workspace — refuse by closing immediately
	}
	upstream, err := net.DialTimeout("tcp", dbTarget, 5*time.Second)
	if err != nil {
		log.Printf("db relay: dial %s: %v", dbTarget, err)
		return
	}
	defer upstream.Close()
	splice(client, upstream)
}

// serveHTTPSProxy accepts HTTP CONNECT requests on proxyPort and, for a
// target host present in allowed, dials it and splices the two connections
// together byte for byte — a standard blind TLS tunnel, so the broker never
// terminates or inspects the TLS session itself, only the CONNECT target
// named before any TLS handshake begins. Every other method (plain HTTP
// proxying) gets 501, and a disallowed CONNECT target gets 403 — both
// WITHOUT dialing anywhere, so a disallowed host never even gets a DNS
// lookup or a TCP SYN from this process.
func serveHTTPSProxy(allowed map[string]bool, port string) error {
	ln, err := net.Listen("tcp", ":"+port)
	if err != nil {
		return fmt.Errorf("https proxy: listen: %w", err)
	}
	for {
		conn, err := ln.Accept()
		if err != nil {
			return fmt.Errorf("https proxy: accept: %w", err)
		}
		go handleProxyConn(conn, allowed)
	}
}

func handleProxyConn(client net.Conn, allowed map[string]bool) {
	defer client.Close()
	client.SetReadDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReader(client)
	requestLine, err := reader.ReadString('\n')
	if err != nil {
		return
	}
	// Drain the rest of the request headers (CONNECT carries none that
	// matter here, but a well-behaved client still sends a blank line —
	// read until it, or until the client gives up).
	for {
		line, err := reader.ReadString('\n')
		if err != nil || strings.TrimSpace(line) == "" {
			break
		}
	}
	client.SetReadDeadline(time.Time{})

	fields := strings.Fields(requestLine)
	if len(fields) != 3 || fields[0] != "CONNECT" {
		fmt.Fprintf(client, "HTTP/1.1 501 Not Implemented\r\n\r\nonly CONNECT is supported\r\n")
		return
	}
	target := fields[1] // host:port
	host, port, err := net.SplitHostPort(target)
	if err != nil {
		fmt.Fprintf(client, "HTTP/1.1 400 Bad Request\r\n\r\nmalformed CONNECT target\r\n")
		return
	}
	// Port-checked, not just host-checked — found in review: an allowlisted
	// HOST used to tunnel to ANY port on it (CONNECT github.com:22 got you
	// SSH), broader than this file's own doc comment ("HTTPS to an explicit
	// allowlist"). A bare hostname entry in ALLOWED_HOSTS (every default
	// entry's shape — every one of them serves HTTPS only) permits ONLY
	// port 443; an entry that already carries its own ":port" permits only
	// that exact pair — needed for tests, which proxy to a synthetic local
	// target on an arbitrary port rather than a real HTTPS server.
	host = strings.ToLower(host)
	if !allowed[host+":"+port] && !(allowed[host] && port == "443") {
		log.Printf("https proxy: refused %s:%s — not on the allowlist", host, port)
		fmt.Fprintf(client, "HTTP/1.1 403 Forbidden\r\n\r\n%s:%s is not on this sandbox's egress allowlist\r\n", host, port)
		return
	}

	upstream, err := net.DialTimeout("tcp", target, 5*time.Second)
	if err != nil {
		fmt.Fprintf(client, "HTTP/1.1 502 Bad Gateway\r\n\r\n%v\r\n", err)
		return
	}
	defer upstream.Close()
	fmt.Fprintf(client, "HTTP/1.1 200 Connection Established\r\n\r\n")
	splice(client, upstream)
}

// splice moves bytes both directions until either side closes, then closes
// both — the shared plumbing behind both relays above.
func splice(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(a, b); done <- struct{}{} }()
	go func() { io.Copy(b, a); done <- struct{}{} }()
	<-done
}
