package main

import (
	"reflect"
	"testing"
)

func TestParseAllowlist(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want map[string]bool
	}{
		{"empty string yields empty set", "", map[string]bool{}},
		{"single host", "github.com", map[string]bool{"github.com": true}},
		{"several hosts", "github.com,api.github.com", map[string]bool{"github.com": true, "api.github.com": true}},
		{"lowercased", "GitHub.com", map[string]bool{"github.com": true}},
		{"whitespace trimmed", " github.com , api.github.com ", map[string]bool{"github.com": true, "api.github.com": true}},
		{"trailing comma drops no real host but adds none either", "github.com,", map[string]bool{"github.com": true}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := parseAllowlist(c.in)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("parseAllowlist(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

func TestEnvOr(t *testing.T) {
	if got := envOr("EGRESSBROKER_TEST_UNSET_VAR", "fallback"); got != "fallback" {
		t.Fatalf("envOr with an unset var = %q, want the fallback", got)
	}
	t.Setenv("EGRESSBROKER_TEST_SET_VAR", "real")
	if got := envOr("EGRESSBROKER_TEST_SET_VAR", "fallback"); got != "real" {
		t.Fatalf("envOr with a set var = %q, want the real value", got)
	}
}
