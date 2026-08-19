package llm

import (
	"context"
	"encoding/base64"
	"fmt"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// The Anthropic backend.
//
// Moved here from `nutrition` with N36. What came with it is the transport and
// the response-shape traps below; what did NOT is the model CHOICE, which is a
// per-feature judgement and stays with the caller that has to pay for it.
//
// **A model change means revisiting this request.** Haiku 4.5 rejects adaptive
// thinking AND `effort` with real 400s, so neither is sent — moving back up a
// tier should restore `Thinking: adaptive` and `Effort: medium`. Medium
// measured better than high on Sonnet 5, which is counterintuitive enough to be
// worth keeping: high produced duplicate and empty-named items at two to three
// times the tokens. That measurement lives in the nutrition module's own notes,
// beside the model ids it chose.
type anthropicCompleter struct {
	client anthropic.Client
	model  string
}

func newAnthropic(apiKey, model string) *anthropicCompleter {
	return &anthropicCompleter{
		client: anthropic.NewClient(option.WithAPIKey(apiKey)),
		model:  model,
	}
}

func (a *anthropicCompleter) Model() string { return a.model }

func (a *anthropicCompleter) Name() string { return string(ProviderAnthropic) }

func (a *anthropicCompleter) Complete(ctx context.Context, req Request) (Response, error) {
	blocks := make([]anthropic.ContentBlockParamUnion, 0, 2)
	// Image first: a leading image reads better than a trailing one, and the
	// text is a caption for the picture rather than the other way round.
	if len(req.Image) > 0 {
		blocks = append(blocks, anthropic.NewImageBlockBase64(
			req.ImageMediaType, base64.StdEncoding.EncodeToString(req.Image)))
	}
	blocks = append(blocks, anthropic.NewTextBlock(req.Prompt))

	resp, err := a.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     anthropic.Model(a.model),
		MaxTokens: req.MaxTokens,
		System:    []anthropic.TextBlockParam{{Text: req.System}},
		// NO `Thinking` and NO `Effort` — Haiku 4.5 rejects both outright, and
		// sending either fails every request in a way that reads as an outage.
		// See the type comment before changing the model.
		OutputConfig: anthropic.OutputConfigParam{
			Format: anthropic.JSONOutputFormatParam{Schema: req.Schema},
		},
		Messages: []anthropic.MessageParam{anthropic.NewUserMessage(blocks...)},
	})
	if err != nil {
		// The upstream text is never forwarded: it carries request ids and
		// prompt fragments.
		return Response{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}

	// CHECK stop_reason BEFORE READING CONTENT. A refusal is a successful HTTP
	// 200 with an empty or partial content array, so code that indexes
	// content[0] breaks on exactly the response it most needs to handle.
	if resp.StopReason == anthropic.StopReasonRefusal {
		return Response{}, ErrRefused
	}
	// Truncation, reported the SAME WAY as on the other backend. Without this
	// a response cut off at MaxTokens fell through to the JSON parse, failed
	// there, and surfaced as ErrEstimateUnavailable — "try again later" for
	// something deterministic, which bills the athlete twice for one doomed
	// request. The two backends disagreeing about the same event is precisely
	// what the shared completer exists to prevent, and they did.
	if resp.StopReason == anthropic.StopReasonMaxTokens {
		return Response{}, fmt.Errorf("%w: response was cut off", ErrRefused)
	}
	return Response{Raw: anthropicText(resp), Model: string(resp.Model)}, nil
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
