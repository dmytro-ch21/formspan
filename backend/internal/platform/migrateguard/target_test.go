package migrateguard

import (
	"strings"
	"testing"
)

// The password used in every fixture DSN below. Every case asserts it never
// reaches Display, because Display is the only thing this package prints and
// these DSNs are real credentials in the case that matters.
const fixturePassword = "sup3r-s3cret"

func TestParseTarget_Locality(t *testing.T) {
	cases := []struct {
		name  string
		dsn   string
		local bool
	}{
		{"loopback name", "postgres://vola:" + fixturePassword + "@localhost:5432/vola?sslmode=disable", true},
		{"loopback v4", "postgres://vola:" + fixturePassword + "@127.0.0.1:5432/vola", true},
		{"loopback v4 elsewhere in /8", "postgres://vola:" + fixturePassword + "@127.0.0.5:5432/vola", true},
		{"loopback v6", "postgres://vola:" + fixturePassword + "@[::1]:5432/vola", true},
		{"dot-localhost", "postgres://vola:" + fixturePassword + "@db.localhost:5432/vola", true},
		{"docker host alias", "postgres://vola:" + fixturePassword + "@host.docker.internal:5432/vola", true},
		{"compose service name", "postgres://vola:" + fixturePassword + "@postgres:5432/vola", true},
		{"postgresql scheme", "postgresql://vola:" + fixturePassword + "@localhost/vola", true},
		{"no port", "postgres://vola:" + fixturePassword + "@localhost/vola", true},

		// A LAN address is NOT local. "It's on my own network" is exactly the
		// reasoning that would relax this guard, so it gets an explicit case.
		{"RFC1918 192.168/16", "postgres://vola:" + fixturePassword + "@192.168.86.30:5432/vola", false},
		{"RFC1918 10/8", "postgres://vola:" + fixturePassword + "@10.1.2.3:5432/vola", false},
		{"RFC1918 172.16/12", "postgres://vola:" + fixturePassword + "@172.16.0.9:5432/vola", false},
		{"unspecified address", "postgres://vola:" + fixturePassword + "@0.0.0.0:5432/vola", false},
		{"managed provider", "postgres://postgres:" + fixturePassword + "@monorail.proxy.rlwy.net:23456/railway", false},
		{"one remote host among several", "postgres://vola:" + fixturePassword + "@localhost:5432,elsewhere.example:5432/vola", false},
		{"remote via ?host=", "postgres://vola:" + fixturePassword + "@localhost:5432/vola?host=elsewhere.example", false},

		{"keyword form, local", "host=localhost port=5432 user=vola password=" + fixturePassword + " dbname=vola", true},
		{"keyword form, quoted value", "host=localhost user=vola password='" + fixturePassword + " with spaces' dbname=vola", true},
		{"keyword form, remote", "host=monorail.proxy.rlwy.net port=23456 user=postgres password=" + fixturePassword, false},
		{"keyword form, hostaddr", "hostaddr=192.168.86.30 user=vola password=" + fixturePassword, false},
		{"keyword form, no host is a unix socket", "user=vola dbname=vola password=" + fixturePassword, true},
		{"unix socket directory", "host=/var/run/postgresql user=vola password=" + fixturePassword, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseTarget(tc.dsn)
			if got.Local != tc.local {
				t.Fatalf("Local = %v, want %v (why: %s)", got.Local, tc.local, got.Why)
			}
			if got.Why == "" {
				t.Error("Why is empty; the operator is told nothing about the classification")
			}
			if strings.Contains(got.Display, fixturePassword) {
				t.Fatalf("Display leaked the password: %q", got.Display)
			}
		})
	}
}

// An unparseable DSN must FAIL CLOSED — be treated as remote — and must be
// redacted entirely, since we cannot tell which part of it is the password.
//
// This is the case nobody writes a test for and the one an unusual connection
// string will find.
func TestParseTarget_UnparseableFailsClosed(t *testing.T) {
	cases := []struct {
		name string
		dsn  string
	}{
		{"empty", ""},
		{"whitespace", "   "},
		{"not a dsn at all", "://::not a dsn"},
		{"bare word", "postgres"},
		{"no key=value pairs", "just some words"},
		{"leading equals", "=value host=localhost"},
		{"unterminated quote", "host='localhost user=vola"},
		{"trailing backslash in quoted value", `password='abc\`},
		{"control characters in url", "postgres://vola:pw@local\x7fhost:5432/vola"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseTarget(tc.dsn)
			if got.Local {
				t.Fatalf("an unparseable DSN was classified LOCAL, which fails open: %q", tc.dsn)
			}
			if got.Display != "(unparseable DSN — redacted)" {
				t.Fatalf("Display = %q, want the fully redacted form — an unparseable DSN may hide a password anywhere in it", got.Display)
			}
			if !strings.Contains(got.Why, "not local") {
				t.Errorf("Why = %q, want it to say the target is not local", got.Why)
			}
		})
	}
}

func TestParseTarget_DisplayKeepsUsefulDetail(t *testing.T) {
	got := ParseTarget("postgres://vola:" + fixturePassword + "@localhost:5432/vola_test_n465?sslmode=disable")
	for _, want := range []string{"vola", "localhost:5432", "vola_test_n465"} {
		if !strings.Contains(got.Display, want) {
			t.Errorf("Display = %q, missing %q — the operator cannot tell which database this is", got.Display, want)
		}
	}
}

func TestParseTarget_RedactsPasswordQueryParameter(t *testing.T) {
	got := ParseTarget("postgres://vola@localhost:5432/vola?password=" + fixturePassword)
	if strings.Contains(got.Display, fixturePassword) {
		t.Fatalf("Display leaked a password passed as a query parameter: %q", got.Display)
	}
}
