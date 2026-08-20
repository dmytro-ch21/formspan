// Package migrateguard decides whether a migration set is allowed to be
// applied to a given database, and explains itself when it says no.
//
// It exists because of a real incident (issue #465, incident #461): three
// migrations from an unmerged branch were applied to the staging Postgres by
// hand. Staging's schema_migrations went to 71 while the highest number on
// main was 70, so every subsequent deploy died in the pre-deploy migrate
// phase and the API served a six-commit-stale build for forty minutes.
//
// Nothing in the repo made that hard to do, and nothing could catch it: CI
// migrates a throwaway database that starts at zero, so a numbering collision
// against a real environment is invisible there and stays green forever.
package migrateguard

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// Target is a database connection, classified and safe to print.
type Target struct {
	// Display is the DSN with the password removed. It is the only form of
	// the DSN this package will ever put on stdout.
	Display string
	// Hosts are the hostnames the DSN names, in the order given.
	Hosts []string
	// Local reports whether every host is a database on THIS machine.
	Local bool
	// Why explains the classification, for the operator, in one clause.
	Why string
}

// localHostnames are the names that mean "a database on this machine".
//
// Deliberately a short static list with no environment variable extending it:
// the property that cannot be satisfied by accident is that a managed
// provider's hostname is not in it. "postgres" is here because it is the
// docker-compose service name, reachable only from inside that network.
var localHostnames = map[string]bool{
	"localhost":            true,
	"host.docker.internal": true,
	"postgres":             true,
}

// ParseTarget classifies a DSN. It NEVER returns an error: an unparseable DSN
// is classified as not-local with its display fully redacted, because failing
// closed is the only safe reading of a connection string we do not understand.
func ParseTarget(dsn string) Target {
	hosts, display, err := dissect(dsn)
	if err != nil {
		return Target{
			Display: "(unparseable DSN — redacted)",
			Local:   false,
			Why:     fmt.Sprintf("not local: the DSN could not be parsed (%v), so it is treated as remote", err),
		}
	}

	if len(hosts) == 0 {
		// libpq with no host= connects over a Unix socket, which cannot leave
		// the machine.
		return Target{Display: display, Local: true, Why: "local: no host, so a Unix socket on this machine"}
	}

	var remote []string
	for _, h := range hosts {
		if !hostIsLocal(h) {
			remote = append(remote, h)
		}
	}
	if len(remote) > 0 {
		return Target{
			Display: display,
			Hosts:   hosts,
			Local:   false,
			Why:     fmt.Sprintf("not local: %s is not this machine", strings.Join(remote, ", ")),
		}
	}
	return Target{Display: display, Hosts: hosts, Local: true, Why: "local: loopback on this machine"}
}

// hostIsLocal reports whether a single host names this machine.
//
// A private/LAN address (10/8, 172.16/12, 192.168/16) is deliberately NOT
// local. The claim being made is "a database on this machine", not "a database
// I can reach" — "it's on my own network" is exactly the reasoning that would
// relax this guard into uselessness.
func hostIsLocal(h string) bool {
	h = strings.Trim(h, "[]")
	if h == "" {
		return true
	}
	if strings.HasPrefix(h, "/") || strings.HasPrefix(h, "@") {
		return true // a Unix socket directory
	}
	lower := strings.ToLower(h)
	if localHostnames[lower] || strings.HasSuffix(lower, ".localhost") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// dissect pulls the hosts out of a DSN and renders it without its password.
func dissect(dsn string) (hosts []string, display string, err error) {
	trimmed := strings.TrimSpace(dsn)
	if trimmed == "" {
		return nil, "", fmt.Errorf("empty")
	}
	if strings.HasPrefix(trimmed, "postgres://") || strings.HasPrefix(trimmed, "postgresql://") {
		return dissectURL(trimmed)
	}
	return dissectKeywords(trimmed)
}

func dissectURL(dsn string) ([]string, string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, "", err
	}
	// url.Host holds every host when the DSN names several
	// ("host1:5432,host2:5432"); split on the comma, then drop the port.
	var hosts []string
	for _, hp := range strings.Split(u.Host, ",") {
		if hp == "" {
			continue
		}
		host, _, splitErr := net.SplitHostPort(hp)
		if splitErr != nil {
			host = hp // no port
		}
		hosts = append(hosts, host)
	}
	// pgx also accepts ?host=, including a Unix socket directory.
	if q := u.Query()["host"]; len(q) > 0 {
		for _, h := range q {
			hosts = append(hosts, strings.Split(h, ",")...)
		}
	}

	redacted := *u
	if u.User != nil {
		redacted.User = url.User(u.User.Username())
	}
	q := redacted.Query()
	// A password can also arrive as a query parameter.
	if q.Has("password") {
		q.Set("password", "REDACTED")
		redacted.RawQuery = q.Encode()
	}
	return hosts, redacted.String(), nil
}

// dissectKeywords parses libpq keyword/value form ("host=... password=...").
// Supported so that a legitimate local connection in this form is classified
// local rather than falling into the fail-closed branch and being refused.
func dissectKeywords(dsn string) ([]string, string, error) {
	kv, order, err := scanKeywords(dsn)
	if err != nil {
		return nil, "", err
	}
	if len(kv) == 0 {
		return nil, "", fmt.Errorf("no key=value pairs")
	}

	var hosts []string
	for _, key := range []string{"host", "hostaddr"} {
		if v, ok := kv[key]; ok && v != "" {
			hosts = append(hosts, strings.Split(v, ",")...)
		}
	}

	var parts []string
	for _, key := range order {
		v := kv[key]
		if key == "password" {
			v = "REDACTED"
		}
		parts = append(parts, key+"="+v)
	}
	return hosts, strings.Join(parts, " "), nil
}

func scanKeywords(dsn string) (map[string]string, []string, error) {
	kv := map[string]string{}
	var order []string
	rest := dsn
	for {
		rest = strings.TrimLeft(rest, " \t\n\r")
		if rest == "" {
			return kv, order, nil
		}
		eq := strings.IndexByte(rest, '=')
		if eq <= 0 {
			return nil, nil, fmt.Errorf("expected key=value near %q", truncate(rest))
		}
		key := strings.TrimSpace(rest[:eq])
		if key == "" || strings.ContainsAny(key, " \t") {
			return nil, nil, fmt.Errorf("invalid key %q", truncate(key))
		}
		rest = strings.TrimLeft(rest[eq+1:], " \t")

		var value strings.Builder
		if strings.HasPrefix(rest, "'") {
			rest = rest[1:]
			closed := false
			for i := 0; i < len(rest); i++ {
				switch rest[i] {
				case '\\':
					if i+1 >= len(rest) {
						return nil, nil, fmt.Errorf("trailing backslash in value for %q", key)
					}
					i++
					value.WriteByte(rest[i])
				case '\'':
					rest = rest[i+1:]
					closed = true
				default:
					value.WriteByte(rest[i])
				}
				if closed {
					break
				}
			}
			if !closed {
				return nil, nil, fmt.Errorf("unterminated quote in value for %q", key)
			}
		} else {
			end := strings.IndexAny(rest, " \t\n\r")
			if end < 0 {
				end = len(rest)
			}
			value.WriteString(rest[:end])
			rest = rest[end:]
		}
		if _, seen := kv[key]; !seen {
			order = append(order, key)
		}
		kv[key] = value.String()
	}
}

func truncate(s string) string {
	if len(s) > 20 {
		return s[:20] + "…"
	}
	return s
}
