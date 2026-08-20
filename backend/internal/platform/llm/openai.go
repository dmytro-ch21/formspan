package llm

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/shared"
)

// The OpenAI backend.
//
// The output cap is `req.MaxTokens` rather than a field on this struct. It used
// to be a field so a test could set it low enough to actually PROVOKE
// truncation against the live API — otherwise the `length` branch below is
// reasoned about and never run, which is how it came to carry a comment
// describing a budget that did not exist. A per-request value keeps that
// ability and hands it to every caller.
//
// Moved here from `nutrition` with N36. It is given whatever prompt and schema
// the caller supplies, which is the property that made the original bake-off
// mean anything: a comparison where each side gets its own instructions
// measures the instructions rather than the models.
type openAICompleter struct {
	client openai.Client
	model  string
}

// newOpenAI builds the backend.
//
// `opts` is how a test reaches a REAL transport failure rather than a stubbed
// one — `option.WithBaseURL` pointed at a closed port or an unresolvable host
// makes the SDK's own error path run for real. Nothing in production passes
// any, and `New` does not expose it, so this cannot become deploy
// configuration by accident. The alternative is a fake `Completer`, which can
// only return the error its author already believes the SDK returns; that is
// the shape this repo has been burned by, and F16 turns on getting it right.
func newOpenAI(apiKey, model string, opts ...option.RequestOption) *openAICompleter {
	return &openAICompleter{
		client: openai.NewClient(append([]option.RequestOption{option.WithAPIKey(apiKey)}, opts...)...),
		model:  model,
	}
}

func (o *openAICompleter) Model() string { return o.model }

func (o *openAICompleter) Name() string { return string(ProviderOpenAI) }

func (o *openAICompleter) Complete(ctx context.Context, req Request) (Response, error) {
	if err := req.validate(); err != nil {
		return Response{}, err
	}
	parts := make([]openai.ChatCompletionContentPartUnionParam, 0, 2)
	if len(req.Image) > 0 {
		// A data URI rather than a URL: the bytes are in hand and are never
		// stored anywhere they could be fetched from, which is the point.
		parts = append(parts, openai.ImageContentPart(openai.ChatCompletionContentPartImageImageURLParam{
			URL: fmt.Sprintf("data:%s;base64,%s",
				req.ImageMediaType, base64.StdEncoding.EncodeToString(req.Image)),
		}))
	}
	parts = append(parts, openai.TextContentPart(req.Prompt))

	resp, err := o.client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{
		Model: openai.ChatModel(o.model),
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(req.System),
			openai.UserMessage(parts),
		},
		// The output ceiling, and it matters more here than on the other
		// backend: this is the default provider, and its model is billed for
		// reasoning tokens it never shows — measured at ~726 completion tokens
		// against ~1,337 input, so output is most of the bill. Without a cap a
		// pathological input is bounded only by the model's own maximum, on the
		// one endpoint in this API where a request turns directly into money.
		//
		// `MaxCompletionTokens`, NOT the deprecated `MaxTokens`: only the former
		// covers reasoning tokens, so the latter would cap the visible answer
		// and leave the expensive half unbounded — a cap that reads as present
		// and is not.
		MaxCompletionTokens: openai.Int(req.MaxTokens),
		ResponseFormat: openai.ChatCompletionNewParamsResponseFormatUnion{
			OfJSONSchema: &shared.ResponseFormatJSONSchemaParam{
				JSONSchema: shared.ResponseFormatJSONSchemaJSONSchemaParam{
					Name: req.SchemaName,
					// `strict` is what makes this structured output rather than
					// a suggestion. Our schema already satisfies its rules —
					// `additionalProperties: false` everywhere and every
					// property in `required` — because Anthropic's structured
					// outputs demand the same, which is the happy reason one
					// schema serves both.
					Strict: openai.Bool(true),
					Schema: req.Schema,
				},
			},
		},
	})
	if err != nil {
		// `*openai.Error` is returned if and ONLY IF the API answered with a
		// status — the SDK's own words are "Error represents an error that
		// originates from the API, i.e. when a request is made and the API
		// returns a response with a HTTP status code. Other errors are not
		// wrapped by this SDK." So `errors.As` failing here is itself the
		// evidence that no response arrived, and `callFailure` reads the two
		// cases apart. See ErrUnreachable.
		var apiErr *openai.Error
		if errors.As(err, &apiErr) {
			return Response{}, callFailure(err, apiErr.StatusCode)
		}
		return Response{}, callFailure(err, 0)
	}
	if len(resp.Choices) == 0 {
		// The provider ANSWERED and the answer was useless, which is a
		// different thing from never answering: this is an HTTP 200 that may
		// have been billed, so it stays ErrUnavailable and stays metered.
		return Response{}, fmt.Errorf("%w: no choices returned", ErrUnavailable)
	}

	// Built BEFORE the refusal and truncation checks below, because both of
	// those are billed 200s and a meter that skipped them would under-count
	// exactly the traffic a runaway client produces.
	usage := openAIUsage(resp)

	choice := resp.Choices[0]
	// The refusal check, and it is NOT the same shape as Anthropic's: OpenAI
	// puts a declined request in a `refusal` field on the message rather than
	// in a stop reason, so code ported across without reading the API would
	// silently treat a refusal as an empty response and report an outage.
	if choice.Message.Refusal != "" {
		return Response{Model: resp.Model, Usage: usage}, ErrRefused
	}
	// `length` means the response hit `MaxCompletionTokens` mid-object. Reported
	// as a refusal rather than as unavailable because a retry is deterministic —
	// same input, same truncation, same cost — so telling the client to try
	// again would bill them for a doomed request.
	//
	// This branch was unreachable-in-practice until the cap above existed: with
	// no budget set, `length` fires only at the model's own maximum, which this
	// prompt cannot approach. The comment claimed a budget that was not there.
	if choice.FinishReason == "length" {
		return Response{Model: resp.Model, Usage: usage}, fmt.Errorf("%w: response was cut off", ErrRefused)
	}
	return Response{Raw: choice.Message.Content, Model: resp.Model, Usage: usage}, nil
}

// openAIUsage maps OpenAI's accounting onto the normalised shape.
//
// `PromptTokens` already INCLUDES the cached portion here, so it maps straight
// across — the adjustment is on the Anthropic side. See the Usage doc comment
// for why that asymmetry cannot be ignored.
func openAIUsage(resp *openai.ChatCompletion) Usage {
	if resp == nil {
		return Usage{}
	}
	u := Usage{
		InputTokens:       resp.Usage.PromptTokens,
		OutputTokens:      resp.Usage.CompletionTokens,
		CachedInputTokens: resp.Usage.PromptTokensDetails.CachedTokens,
		ReasoningTokens:   resp.Usage.CompletionTokensDetails.ReasoningTokens,
	}
	// Presence, not value. The SDK zero-values an absent field, so `0` alone
	// cannot tell "this text call had no image" from "this model does not
	// report a breakdown" — and the shipped model is the second case on every
	// call. `Valid()` is the only thing that separates them.
	if resp.Usage.PromptTokensDetails.JSON.ImageTokens.Valid() {
		n := resp.Usage.PromptTokensDetails.ImageTokens
		u.ImageTokens = &n
	}
	return u
}
