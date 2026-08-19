package llm

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A live happy-path test, skipped unless LLM_LIVE=1.
//
// It exists because "behaviour-preserving by construction" is an argument, not
// a measurement: every other test in this package uses a fake or greps a
// request, so nothing here has ever proved that a request built by this code
// reaches a real provider and comes back parseable. A transport refactor whose
// transport was never exercised is exactly the change that looks green and is
// broken.
//
// Deliberately gated rather than skipped-on-missing-key: this spends money, and
// a test that runs whenever a key happens to be in the environment will run in
// somebody's CI eventually.
func TestLiveComplete(t *testing.T) {
	if os.Getenv("LLM_LIVE") != "1" {
		t.Skip("set LLM_LIVE=1 to make real API calls (spends money)")
	}

	schema := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"sport", "count"},
		"properties": map[string]any{
			"sport": map[string]any{"type": "string"},
			"count": map[string]any{"type": "integer"},
		},
	}

	for _, tc := range []struct {
		provider Provider
		model    string
	}{
		{ProviderOpenAI, "gpt-5.6-luna"},
		{ProviderAnthropic, "claude-haiku-4-5"},
	} {
		t.Run(string(tc.provider), func(t *testing.T) {
			key := envFromFile(t, tc.provider.APIKeyEnv())
			if key == "" {
				t.Skipf("%s not set", tc.provider.APIKeyEnv())
			}
			c, err := New(Config{Provider: tc.provider, Model: tc.model, APIKey: key})
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			if c == nil {
				t.Fatal("New returned a nil Completer with a key set")
			}
			if c.Name() != string(tc.provider) {
				t.Errorf("Name() = %q, want %q", c.Name(), tc.provider)
			}
			if c.Model() != tc.model {
				t.Errorf("Model() = %q, want %q", c.Model(), tc.model)
			}

			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			resp, err := c.Complete(ctx, Request{
				System:     "Answer only with the JSON the schema describes.",
				Prompt:     "Three rounds of brazilian jiu-jitsu. Give the sport and the round count.",
				Schema:     schema,
				SchemaName: "smoke",
				MaxTokens:  2048,
			})
			if err != nil {
				t.Fatalf("Complete: %v", err)
			}
			var got struct {
				Sport string `json:"sport"`
				Count int    `json:"count"`
			}
			if err := json.Unmarshal([]byte(resp.Raw), &got); err != nil {
				t.Fatalf("response is not the schema's JSON: %v\nraw: %q", err, resp.Raw)
			}
			if got.Count != 3 {
				t.Errorf("count = %d, want 3 (raw: %s)", got.Count, resp.Raw)
			}
			if resp.Model == "" {
				t.Error("Response.Model is empty; the provider reports what it used")
			}
			t.Logf("OK  configured=%s reported=%s  raw=%s", c.Model(), resp.Model, resp.Raw)
		})
	}
}

// envFromFile reads a key from the environment, falling back to backend/.env —
// which a git worktree never has, being gitignored, so walk to the primary
// checkout the same way the eval runner does.
func envFromFile(t *testing.T, name string) string {
	t.Helper()
	if v := os.Getenv(name); v != "" {
		return v
	}
	for _, dir := range []string{"../../..", "../../../../../.."} {
		b, err := os.ReadFile(filepath.Join(dir, ".env"))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			k, v, ok := strings.Cut(line, "=")
			if ok && strings.TrimSpace(k) == name {
				return strings.Trim(strings.TrimSpace(v), `"'`)
			}
		}
	}
	return ""
}
