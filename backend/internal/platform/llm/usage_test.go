package llm

import (
	"encoding/json"
	"testing"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/openai/openai-go/v3"
)

// **The normalisation these tests exist for.** The two providers disagree about
// whether cached tokens sit inside the input count, and taking either at face
// value makes the other's numbers wrong. Every figure the quota re-tune will be
// derived from passes through here.

// Anthropic reports `input_tokens` EXCLUSIVE of anything read from or written
// to the cache. On this prompt 1,334 of 1,337 tokens come back cached, so
// reading the exclusive figure as if it were inclusive reports a 1,337-token
// prompt as a 3-token one — and every cost derived from it is off by 400x.
func TestAnthropicUsageAddsCacheTokensBackIn(t *testing.T) {
	resp := &anthropic.Message{Usage: anthropic.Usage{
		InputTokens:              3,
		CacheReadInputTokens:     1334,
		CacheCreationInputTokens: 0,
		OutputTokens:             726,
	}}
	got := anthropicUsage(resp)

	if got.InputTokens != 1337 {
		t.Fatalf("InputTokens = %d, want 1337 — Anthropic's input_tokens EXCLUDES cache reads, so they must be added back or a 1,337-token prompt reports as 3", got.InputTokens)
	}
	if got.CachedInputTokens != 1334 {
		t.Fatalf("CachedInputTokens = %d, want 1334", got.CachedInputTokens)
	}
	if got.OutputTokens != 726 {
		t.Fatalf("OutputTokens = %d, want 726", got.OutputTokens)
	}
	// Anthropic has no image breakdown at all, so nil — "not reported", never
	// "the image was free".
	if got.ImageTokens != nil {
		t.Fatalf("ImageTokens = %v, want nil — Anthropic does not break it out", *got.ImageTokens)
	}
}

// Cache CREATION is billed too, and is part of the input. Omitting it
// under-reports the one call that actually paid to populate the cache.
func TestAnthropicUsageCountsCacheCreation(t *testing.T) {
	got := anthropicUsage(&anthropic.Message{Usage: anthropic.Usage{
		InputTokens:              3,
		CacheCreationInputTokens: 1334,
		OutputTokens:             10,
	}})
	if got.InputTokens != 1337 {
		t.Fatalf("InputTokens = %d, want 1337 — the call that wrote the cache paid for those tokens", got.InputTokens)
	}
	// Nothing was READ from cache on that call, so the discounted portion is 0
	// even though 1,334 tokens were cache-related.
	if got.CachedInputTokens != 0 {
		t.Fatalf("CachedInputTokens = %d, want 0 — creation is not a discount", got.CachedInputTokens)
	}
}

// OpenAI's `prompt_tokens` ALREADY includes the cached portion, so it maps
// straight across. Adding the cache figure again here would inflate every
// OpenAI input count by the size of the cache hit — the mirror-image mistake.
func TestOpenAIUsageDoesNotDoubleCountCache(t *testing.T) {
	resp := &openai.ChatCompletion{}
	resp.Usage.PromptTokens = 1337
	resp.Usage.CompletionTokens = 726
	resp.Usage.PromptTokensDetails.CachedTokens = 1334
	resp.Usage.PromptTokensDetails.ImageTokens = 500
	resp.Usage.CompletionTokensDetails.ReasoningTokens = 448

	got := openAIUsage(resp)
	if got.InputTokens != 1337 {
		t.Fatalf("InputTokens = %d, want 1337 — OpenAI's prompt_tokens already includes cached tokens", got.InputTokens)
	}
	if got.CachedInputTokens != 1334 {
		t.Fatalf("CachedInputTokens = %d, want 1334", got.CachedInputTokens)
	}
	// ImageTokens is asserted in its own test below, because presence — not
	// value — is what decides it, and a hand-built struct cannot express that.
	// Reasoning is billed as output; reporting it separately must not remove it
	// from the output total.
	if got.OutputTokens != 726 {
		t.Fatalf("OutputTokens = %d, want 726 (reasoning included — it is billed as output)", got.OutputTokens)
	}
	if got.ReasoningTokens != 448 {
		t.Fatalf("ReasoningTokens = %d, want 448", got.ReasoningTokens)
	}
}

// A nil response is a transport failure. Zero usage is the honest answer —
// there is nothing to report rather than nothing to find.
func TestUsageMappersTolerateNilResponses(t *testing.T) {
	if got := (openAIUsage(nil)); got != (Usage{}) {
		t.Fatalf("openAIUsage(nil) = %+v, want zero", got)
	}
	if got := (anthropicUsage(nil)); got != (Usage{}) {
		t.Fatalf("anthropicUsage(nil) = %+v, want zero", got)
	}
}

// **Anthropic DOES report reasoning, and an earlier version of this package
// said it did not.** Leaving it unmapped writes a confident
// `reasoning_tokens = 0` for every Anthropic call — a measured-looking zero for
// something never measured, which is the precise failure the NULL rule on these
// columns exists to prevent. Raised in review.
func TestAnthropicUsageMapsThinkingTokens(t *testing.T) {
	got := anthropicUsage(&anthropic.Message{Usage: anthropic.Usage{
		InputTokens:         1337,
		OutputTokens:        726,
		OutputTokensDetails: anthropic.OutputTokensDetails{ThinkingTokens: 448},
	}})
	if got.ReasoningTokens != 448 {
		t.Fatalf("ReasoningTokens = %d, want 448 — thinking_tokens is reported and must not be recorded as a measured zero", got.ReasoningTokens)
	}
	// And it stays INSIDE the output total, because it is billed as output.
	if got.OutputTokens != 726 {
		t.Fatalf("OutputTokens = %d, want 726", got.OutputTokens)
	}
}

// A model that genuinely reports zero image tokens is not the same as one that
// reports nothing, and only PRESENCE separates them — on the shipped model
// every call is the second case.
//
// Decoded from real JSON rather than a hand-built struct, because the presence
// flag is set by the SDK's unmarshaller and cannot be assigned: a struct
// literal can only ever produce "absent", so a test built that way could not
// tell the two apart and would pass against the `> 0` guess this replaced.
func TestOpenAIUsageDistinguishesAnUnreportedImageBreakdownFromZero(t *testing.T) {
	decode := func(t *testing.T, body string) Usage {
		t.Helper()
		var resp openai.ChatCompletion
		if err := json.Unmarshal([]byte(body), &resp); err != nil {
			t.Fatal(err)
		}
		return openAIUsage(&resp)
	}

	absent := decode(t, `{"usage":{"prompt_tokens":1337,"completion_tokens":10,
		"prompt_tokens_details":{"cached_tokens":1300}}}`)
	if absent.ImageTokens != nil {
		t.Fatalf("ImageTokens = %v, want nil when the provider reported no breakdown", *absent.ImageTokens)
	}

	zero := decode(t, `{"usage":{"prompt_tokens":1337,"completion_tokens":10,
		"prompt_tokens_details":{"cached_tokens":1300,"image_tokens":0}}}`)
	if zero.ImageTokens == nil || *zero.ImageTokens != 0 {
		t.Fatalf("ImageTokens = %v, want a REPORTED zero — distinct from absent", zero.ImageTokens)
	}

	reported := decode(t, `{"usage":{"prompt_tokens":2620,"completion_tokens":900,
		"prompt_tokens_details":{"cached_tokens":1792,"image_tokens":1272}}}`)
	if reported.ImageTokens == nil || *reported.ImageTokens != 1272 {
		t.Fatalf("ImageTokens = %v, want 1272 — the figure the two-cap split was always missing", reported.ImageTokens)
	}
}
