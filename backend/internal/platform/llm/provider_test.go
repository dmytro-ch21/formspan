package llm

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// This package's own contract, pinned here rather than through a consumer.
//
// It was pinned only through `nutrition`'s factory tests, which was fine while
// nutrition was the only caller — and stops being fine the moment N33 calls
// `llm.New` directly, because then a guard N33 depends on lives in a package it
// does not own, and a future nutrition refactor that stops exercising a branch
// silently unpins it for everybody. Raised in review.

func TestNewReturnsNilForNoKeyAndErrorsForNonsense(t *testing.T) {
	for _, tc := range []struct {
		name    string
		cfg     Config
		wantNil bool
		wantErr string
	}{
		{
			// The load-bearing one. A nil CONCRETE pointer boxed into an
			// interface is a NON-nil interface, so a caller's nil check reads
			// false and the first request panics on a nil receiver — a live bug
			// in the version this was extracted from.
			name:    "no key yields a genuinely nil interface",
			cfg:     Config{Provider: ProviderOpenAI, Model: "m", APIKey: "   "},
			wantNil: true,
		},
		{
			// Checked BEFORE the missing-key return: the other order lets a
			// typo pass silently on exactly the deploy where the key is also
			// absent, and the symptom is a 503 that reads as an outage.
			name:    "an unknown provider fails even with no key",
			cfg:     Config{Provider: "gemini"},
			wantErr: "unknown provider",
		},
		{
			name:    "an unknown provider fails with a key",
			cfg:     Config{Provider: "gemini", Model: "m", APIKey: "k"},
			wantErr: "unknown provider",
		},
		{
			// The caller owns its defaults, so an empty model here is a caller
			// bug. Failing at construction beats failing per-request against a
			// billed endpoint.
			name:    "a missing model fails at construction",
			cfg:     Config{Provider: ProviderAnthropic, Model: " ", APIKey: "k"},
			wantErr: "needs a model id",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := New(tc.cfg)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("wanted an error containing %q, got none", tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error %v does not mention %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantNil && c != nil {
				t.Fatal("Completer is not nil without a key — the caller's 503 branch will be skipped")
			}
		})
	}
}

// Every provider must be reachable AND report itself correctly.
//
// Enumerated from the constants rather than listed by hand: adding a Provider
// without a case in `New` should fail here, not nil-panic on somebody's first
// request.
func TestEveryProviderBuildsAndReportsItself(t *testing.T) {
	for _, p := range []Provider{ProviderAnthropic, ProviderOpenAI} {
		t.Run(string(p), func(t *testing.T) {
			c, err := New(Config{Provider: p, Model: "some-model", APIKey: "k"})
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			if c == nil {
				t.Fatal("nil Completer with a key set")
			}
			if c.Name() != string(p) {
				t.Errorf("Name() = %q, want %q", c.Name(), p)
			}
			// The CONFIGURED model, which is what a caller resolved from its own
			// defaults — distinct from `Response.Model`, what the provider says
			// it used. Without this a caller can only confirm the resolution
			// reached the transport by re-deriving it, which asserts its own
			// defaulting against itself.
			if c.Model() != "some-model" {
				t.Errorf("Model() = %q, want %q", c.Model(), "some-model")
			}
			if !p.Valid() {
				t.Errorf("%q builds but reports itself invalid", p)
			}
			if p.APIKeyEnv() == "" {
				t.Errorf("%q names no API key env var, so a deploy cannot configure it", p)
			}
		})
	}
}

// EVERY provider must reject a request that cannot succeed, and the enumeration
// is the point rather than the assertion.
//
// A zero cap is not "no cap", it is a cap of zero: the field is sent either way,
// so it fails every call and surfaces as an outage rather than as the config
// error it is. Two implementations means one of them can be forgotten — which is
// exactly how a sibling change shipped an admin endpoint serving `null` — so
// this drives off the constants and fails by provider name.
func TestEveryProviderRefusesAnImpossibleRequest(t *testing.T) {
	for _, p := range []Provider{ProviderAnthropic, ProviderOpenAI} {
		t.Run(string(p), func(t *testing.T) {
			c, err := New(Config{Provider: p, Model: "m", APIKey: "k"})
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			// No network: validation happens before the SDK is touched, which
			// is the property being asserted as much as the rejection itself.
			_, err = c.Complete(context.Background(), Request{
				System: "s", Prompt: "p", MaxTokens: 0,
			})
			if err == nil {
				t.Fatalf("%s accepted MaxTokens=0 — that reaches the API and fails "+
					"every call, reading as an outage rather than as config", p)
			}
			if !strings.Contains(err.Error(), "MaxTokens") {
				t.Errorf("%s rejected it with %v, which does not say why", p, err)
			}
			// Deliberately NOT a sentinel: a caller maps unknown errors to its
			// own "unavailable", which is the right status, while the text
			// carries the real reason into the log.
			if errors.Is(err, ErrRefused) || errors.Is(err, ErrUnavailable) {
				t.Errorf("%s reported a config error as a transport sentinel", p)
			}
		})
	}
}
