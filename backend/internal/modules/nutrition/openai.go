package nutrition

import (
	"context"
	"encoding/base64"
	"fmt"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/shared"
)

// The OpenAI backend.
//
// Added to answer a pricing question with a measurement rather than a table:
// on our shape the budget tier lists at roughly a quarter of Haiku's cost, and
// whether it holds up on portion confidence — the thing this feature actually
// sells — is not something a price list can say.
//
// It is given the SAME prompt and the SAME schema as every other provider (see
// prompt.go), because a comparison where each side gets its own instructions
// measures the instructions rather than the models.
type openAICompleter struct {
	client openai.Client
	model  string
}

func newOpenAICompleter(apiKey, model string) *openAICompleter {
	return &openAICompleter{
		client: openai.NewClient(option.WithAPIKey(apiKey)),
		model:  model,
	}
}

func (o *openAICompleter) providerName() string { return string(ProviderOpenAI) }

func (o *openAICompleter) complete(ctx context.Context, in EstimateInput) (string, string, error) {
	parts := make([]openai.ChatCompletionContentPartUnionParam, 0, 2)
	if len(in.Image) > 0 {
		// A data URI rather than a URL: the bytes are in hand and are never
		// stored anywhere they could be fetched from, which is the point.
		parts = append(parts, openai.ImageContentPart(openai.ChatCompletionContentPartImageImageURLParam{
			URL: fmt.Sprintf("data:%s;base64,%s",
				in.ImageMediaType, base64.StdEncoding.EncodeToString(in.Image)),
		}))
	}
	parts = append(parts, openai.TextContentPart(userPrompt(in)))

	resp, err := o.client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{
		Model: openai.ChatModel(o.model),
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(estimateSystemPrompt),
			openai.UserMessage(parts),
		},
		ResponseFormat: openai.ChatCompletionNewParamsResponseFormatUnion{
			OfJSONSchema: &shared.ResponseFormatJSONSchemaParam{
				JSONSchema: shared.ResponseFormatJSONSchemaJSONSchemaParam{
					Name: "meal_estimate",
					// `strict` is what makes this structured output rather than
					// a suggestion. Our schema already satisfies its rules —
					// `additionalProperties: false` everywhere and every
					// property in `required` — because Anthropic's structured
					// outputs demand the same, which is the happy reason one
					// schema serves both.
					Strict: openai.Bool(true),
					Schema: EstimateSchema(),
				},
			},
		},
	})
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrEstimateUnavailable, err)
	}
	if len(resp.Choices) == 0 {
		return "", "", fmt.Errorf("%w: no choices returned", ErrEstimateUnavailable)
	}

	choice := resp.Choices[0]
	// The refusal check, and it is NOT the same shape as Anthropic's: OpenAI
	// puts a declined request in a `refusal` field on the message rather than
	// in a stop reason, so code ported across without reading the API would
	// silently treat a refusal as an empty response and report an outage.
	if choice.Message.Refusal != "" {
		return "", "", ErrEstimateRefused
	}
	// `length` means the token budget ran out mid-object. Reported as a refusal
	// rather than as unavailable because a retry is deterministic — same input,
	// same truncation, same cost — so telling the client to try again would
	// bill them for a doomed request.
	if choice.FinishReason == "length" {
		return "", "", fmt.Errorf("%w: response was cut off", ErrEstimateRefused)
	}
	return choice.Message.Content, resp.Model, nil
}
