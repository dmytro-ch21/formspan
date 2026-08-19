package nutrition

import (
	"context"
	"encoding/base64"
	"fmt"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// The Anthropic backend.
//
// # Choosing the model took three attempts and two overturned assumptions
//
// Opus 5 first, on the reasoning that portion judgement is hard. Then Sonnet 5,
// when asked for the cheapest capable model, on two objections to going lower.
// Both objections fell to measurement:
//
//   - "Haiku lacks the high-resolution vision tier" — irrelevant. The client
//     downscales to 1080px before upload for unrelated cost reasons, which is
//     below Haiku's 1568px ceiling, so the tier never binds.
//   - "Haiku does not support `effort`, so the cost control would have to go" —
//     true (it rejects adaptive thinking AND effort with real 400s), but the
//     wrong conclusion. Reading food off a sentence is extraction, not
//     reasoning, and needs neither.
//
// Twelve runs across two real meals, a gibberish input and a photo: correct
// every time, refusing the nonsense and marking "two scrambled eggs" HIGH
// confidence (the athlete stated the quantity) while marking a curry LOW. That
// is a finer distinction than Sonnet 5 drew on the same input, at 0.24c a text
// call against 0.73c.
//
// **A model change here means revisiting the request.** Moving back up a tier
// should restore `Thinking: adaptive` and `Effort: medium` — medium measured
// better than high on Sonnet 5, which is counterintuitive enough to be worth
// writing down: high produced duplicate and empty-named items at two to three
// times the tokens.
type anthropicCompleter struct {
	client anthropic.Client
	model  string
}

func newAnthropicCompleter(apiKey, model string) *anthropicCompleter {
	return &anthropicCompleter{
		client: anthropic.NewClient(option.WithAPIKey(apiKey)),
		model:  model,
	}
}

func (a *anthropicCompleter) providerName() string { return string(ProviderAnthropic) }

func (a *anthropicCompleter) complete(ctx context.Context, in EstimateInput) (string, string, error) {
	blocks := make([]anthropic.ContentBlockParamUnion, 0, 2)
	// Image first: a leading image reads better than a trailing one, and the
	// text is a caption for the picture rather than the other way round.
	if len(in.Image) > 0 {
		blocks = append(blocks, anthropic.NewImageBlockBase64(
			in.ImageMediaType, base64.StdEncoding.EncodeToString(in.Image)))
	}
	blocks = append(blocks, anthropic.NewTextBlock(userPrompt(in)))

	resp, err := a.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     anthropic.Model(a.model),
		MaxTokens: estimateMaxTokens,
		System:    []anthropic.TextBlockParam{{Text: estimateSystemPrompt}},
		// NO `Thinking` and NO `Effort` — Haiku 4.5 rejects both outright, and
		// sending either fails every request in a way that reads as an outage.
		// See the type comment before changing the model.
		OutputConfig: anthropic.OutputConfigParam{
			Format: anthropic.JSONOutputFormatParam{Schema: EstimateSchema()},
		},
		Messages: []anthropic.MessageParam{anthropic.NewUserMessage(blocks...)},
	})
	if err != nil {
		// The upstream text is never forwarded: it carries request ids and
		// prompt fragments.
		return "", "", fmt.Errorf("%w: %v", ErrEstimateUnavailable, err)
	}

	// CHECK stop_reason BEFORE READING CONTENT. A refusal is a successful HTTP
	// 200 with an empty or partial content array, so code that indexes
	// content[0] breaks on exactly the response it most needs to handle.
	if resp.StopReason == anthropic.StopReasonRefusal {
		return "", "", ErrEstimateRefused
	}
	// Truncation, reported the SAME WAY as on the other backend. Without this
	// a response cut off at MaxTokens fell through to the JSON parse, failed
	// there, and surfaced as ErrEstimateUnavailable — "try again later" for
	// something deterministic, which bills the athlete twice for one doomed
	// request. The two backends disagreeing about the same event is precisely
	// what the shared completer exists to prevent, and they did.
	if resp.StopReason == anthropic.StopReasonMaxTokens {
		return "", "", fmt.Errorf("%w: response was cut off", ErrEstimateRefused)
	}
	return anthropicText(resp), string(resp.Model), nil
}

// anthropicText returns the first text block, skipping thinking blocks.
//
// Thinking blocks come FIRST when thinking is on, so `Content[0]` is the wrong
// block to read even on an ordinary response — a mistake that parses as "empty
// response" and reads as an upstream fault rather than a bug here. Kept even
// though this model cannot think, because the model is a constant somebody will
// change.
func anthropicText(resp *anthropic.Message) string {
	for _, block := range resp.Content {
		if variant, ok := block.AsAny().(anthropic.TextBlock); ok {
			return variant.Text
		}
	}
	return ""
}
