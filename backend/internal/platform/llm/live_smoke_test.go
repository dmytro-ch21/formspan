package llm

import (
	"context"
	"encoding/json"
	"os"
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
//
// **The key comes from the environment and nowhere else.** The version this was
// cherry-picked from fell back to reading `.env` files by walking up to six
// parent directories — a real convenience, because a git worktree has no
// `backend/.env` (it is gitignored, the same trap that costs mobile builds
// their Clerk key). It is dropped anyway: a test that goes hunting for
// credentials outside its own tree is a bad habit to encode, and above the repo
// root it is reading files that are none of its business. Export the variable.
//
// And it FAILS rather than skips when `LLM_LIVE=1` is set without a key,
// because at that point the operator has asked for a live run and a silent skip
// would report success for a test that never ran — the failure mode this whole
// package's history is made of.
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
			key := os.Getenv(tc.provider.APIKeyEnv())
			if key == "" {
				t.Fatalf("LLM_LIVE=1 but %s is not set — export it; this test does "+
					"not go looking for it", tc.provider.APIKeyEnv())
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
