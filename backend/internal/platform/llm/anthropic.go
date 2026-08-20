package llm

import (
	"context"
	"encoding/base64"
	"errors"
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

// newAnthropic builds the backend.
//
// `opts` exists for the same reason the OpenAI constructor's does — see the
// comment there. It is how a test drives a genuine transport failure through
// the real SDK instead of asserting against a fake that returns whatever its
// author assumed.
func newAnthropic(apiKey, model string, opts ...option.RequestOption) *anthropicCompleter {
	return &anthropicCompleter{
		client: anthropic.NewClient(append([]option.RequestOption{option.WithAPIKey(apiKey)}, opts...)...),
		model:  model,
	}
}

func (a *anthropicCompleter) Model() string { return a.model }

func (a *anthropicCompleter) Name() string { return string(ProviderAnthropic) }

func (a *anthropicCompleter) Complete(ctx context.Context, req Request) (Response, error) {
	if err := req.validate(); err != nil {
		return Response{}, err
	}
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
		// The upstream text is never forwarded to a CLIENT: it carries request
		// ids and prompt fragments. It reaches the caller's log only.
		//
		// `*anthropic.Error` is returned if and only if the API answered with a
		// status — this SDK carries the same guarantee as the other, in the
		// same words ("Other errors are not wrapped by this SDK"), so the
		// classification below is the same on both backends rather than two
		// hand-written opinions. See ErrUnreachable.
		var apiErr *anthropic.Error
		if errors.As(err, &apiErr) {
			return Response{}, callFailure(err, apiErr.StatusCode)
		}
		return Response{}, callFailure(err, 0)
	}

	// CHECK stop_reason BEFORE READING CONTENT. A refusal is a successful HTTP
	// 200 with an empty or partial content array, so code that indexes
	// content[0] breaks on exactly the response it most needs to handle.
	// Built before the two billed-200 branches below, same reasoning as the
	// OpenAI backend: a refusal costs tokens and must still be metered.
	usage := anthropicUsage(resp)

	if resp.StopReason == anthropic.StopReasonRefusal {
		return Response{Model: string(resp.Model), Usage: usage}, ErrRefused
	}
	// Truncation, reported the SAME WAY as on the other backend. Without this
	// a response cut off at MaxTokens fell through to the JSON parse, failed
	// there, and surfaced as ErrEstimateUnavailable — "try again later" for
	// something deterministic, which bills the athlete twice for one doomed
	// request. The two backends disagreeing about the same event is precisely
	// what the shared completer exists to prevent, and they did.
	if resp.StopReason == anthropic.StopReasonMaxTokens {
		return Response{Model: string(resp.Model), Usage: usage}, fmt.Errorf("%w: response was cut off", ErrRefused)
	}
	return Response{Raw: anthropicText(resp), Model: string(resp.Model), Usage: usage}, nil
}

// anthropicUsage maps Anthropic's accounting onto the normalised shape.
//
// **`InputTokens` here EXCLUDES anything served from or written to the cache**,
// which is the opposite of OpenAI's `prompt_tokens`. Adding the two cache
// figures back in is what makes the same field name mean the same thing on both
// backends — without it, this prompt's 1,337-token input reports as 3 tokens
// once the cache is warm, and every cost derived from it is nonsense.
//
// Reasoning maps from `output_tokens_details.thinking_tokens`, which this SDK
// does expose — an earlier version of this file claimed it did not and left the
// field at zero, which would have recorded "reasoning was free" for every
// Anthropic call as though it were measured. Raised in review.
//
// No image breakdown: Anthropic has no equivalent field, so ImageTokens stays
// nil — "not reported", never "the image was free".
func anthropicUsage(resp *anthropic.Message) Usage {
	if resp == nil {
		return Usage{}
	}
	return Usage{
		InputTokens: resp.Usage.InputTokens +
			resp.Usage.CacheReadInputTokens + resp.Usage.CacheCreationInputTokens,
		OutputTokens:      resp.Usage.OutputTokens,
		CachedInputTokens: resp.Usage.CacheReadInputTokens,
		ReasoningTokens:   resp.Usage.OutputTokensDetails.ThinkingTokens,
	}
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
