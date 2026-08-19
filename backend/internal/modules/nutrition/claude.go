package nutrition

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// Estimator turns a described or photographed meal into a draft.
//
// An interface because the handler must be testable without a live API key and
// without spending money per test run — every quota, validation and refusal
// path is exercised against a fake. The real implementation below is the only
// thing in this package that talks to Anthropic.
type Estimator interface {
	Estimate(ctx context.Context, in EstimateInput) (Estimate, error)
}

// ErrNoEstimator is the feature being unconfigured — no API key on this
// deploy. Separate from unavailable, because the fix is a deploy setting
// rather than a retry.
var ErrNoEstimator = errors.New("nutrition: estimation is not configured")

// EstimateModel is the model the endpoint runs on.
//
// **Sonnet 5, chosen as the cheapest model that can actually do this**, not as
// the most capable available. Two things rule out the tier below it:
//
//   - `effort` is not supported on Haiku 4.5, so using it would mean deleting
//     the one knob holding this endpoint's per-call cost down — a saving that
//     pays for itself in the wrong direction.
//   - Haiku 4.5 is not in the high-resolution vision tier. Portion judgement
//     from a photo is the whole feature, and it is the half the confidence
//     field already admits is unreliable; spending the saving on worse eyes is
//     the wrong trade.
//
// Sonnet 5 is the first Sonnet-tier model with high-resolution vision (2576px
// on the long edge, same tier as Opus 5), supports structured outputs and the
// full effort ladder, and lists at $3/$15 per MTok against Opus 5's $5/$25 —
// currently $2/$10 under introductory pricing.
const EstimateModel = "claude-sonnet-5"

// estimateMaxTokens bounds thinking AND response text together.
//
// Adaptive thinking is on by default on this model, and `max_tokens` caps the
// two as one budget — so a value sized to the JSON alone truncates mid-object
// and yields a parse failure that reads like a model fault. Sized with
// headroom for exactly that reason.
const estimateMaxTokens = 8192

// estimateSystemPrompt is deliberately short.
//
// Prompts written for older models tend to be over-prescriptive and reduce
// output quality on current ones, and the schema already carries the
// field-level instructions (see EstimateSchema's descriptions) — repeating
// them here would be two sources for one rule. What is left is the part a
// schema cannot express: who this is for, and what honesty means here.
const estimateSystemPrompt = `You estimate the nutrition of a meal an athlete has just eaten, so they can log it.

They will see your numbers as an editable draft and correct them. That makes a stated assumption far more useful than a confident guess: when you have to decide something you cannot see — portion size, cooking fat, whether the coffee had milk — put it in that item's assumption field so they know which number to fix.

Say what you actually see or are told. Do not add items to make a meal look complete, and do not round a portion toward a typical serving when the evidence points elsewhere. If a photo shows food you cannot identify, say so in the note rather than naming a guess as though you were sure.

List each component once, under the name someone would call it. If you genuinely cannot make anything out, return an empty items list and explain why in the note — an empty list is a fine answer. Never emit an item as a placeholder, with an empty name, or with zeroed numbers to fill the shape: a row the athlete cannot act on is worse than no row.`

// AnthropicEstimator is the real Estimator.
type AnthropicEstimator struct {
	client anthropic.Client
	model  string
}

// NewAnthropicEstimator builds an estimator against the given API key.
//
// Returns nil when the key is empty, and the caller treats a nil estimator as
// "not configured" — so a deploy without the key serves every other nutrition
// route normally and fails only this one, rather than refusing to start. The
// API key is the one piece of config this module needs that nothing else does.
//
// **It returns the INTERFACE rather than `*AnthropicEstimator`, and that is
// the whole point of the signature.** Go's usual advice is to return the
// concrete type, but a nil `*AnthropicEstimator` assigned into an `Estimator`
// produces a NON-nil interface holding a nil pointer — so the handler's
// `estimator == nil` check reads false, the 503 branch is skipped, and the
// first real request on an unconfigured deploy panics on a nil receiver.
// Returning the interface makes the nil a true nil at the source, so no call
// site has to remember. Review found this as a live panic; the test that was
// supposed to cover it passed an untyped `nil` literal, which is a different
// thing entirely.
func NewAnthropicEstimator(apiKey string) Estimator {
	if strings.TrimSpace(apiKey) == "" {
		return nil
	}
	return &AnthropicEstimator{
		client: anthropic.NewClient(option.WithAPIKey(apiKey)),
		model:  EstimateModel,
	}
}

// Estimate calls Claude and returns a validated draft.
func (e *AnthropicEstimator) Estimate(ctx context.Context, in EstimateInput) (Estimate, error) {
	if err := in.Validate(); err != nil {
		return Estimate{}, err
	}

	blocks := make([]anthropic.ContentBlockParamUnion, 0, 2)
	// IMAGE FIRST, then the text: a leading image reads better than a trailing
	// one, and the text here is a caption for the picture rather than the
	// other way round.
	if len(in.Image) > 0 {
		blocks = append(blocks, anthropic.NewImageBlockBase64(
			in.ImageMediaType, base64.StdEncoding.EncodeToString(in.Image)))
	}
	blocks = append(blocks, anthropic.NewTextBlock(userPrompt(in)))

	resp, err := e.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     anthropic.Model(e.model),
		MaxTokens: estimateMaxTokens,
		System:    []anthropic.TextBlockParam{{Text: estimateSystemPrompt}},
		Thinking: anthropic.ThinkingConfigParamUnion{
			// Adaptive rather than disabled: portion judgement is exactly what
			// benefits, and on this model disabling thinking has two documented
			// failure modes — a tool call written as plain text, and
			// `<thinking>` tags leaking into the visible response.
			OfAdaptive: &anthropic.ThinkingConfigAdaptiveParam{},
		},
		OutputConfig: anthropic.OutputConfigParam{
			// Structured outputs guarantee the SHAPE. The range checks in
			// ValidateEstimate are what guarantee the VALUES — JSON-schema
			// numeric bounds are not supported here, so the two are not
			// redundant.
			Format: anthropic.JSONOutputFormatParam{Schema: EstimateSchema()},
			// Extraction is not reasoning-heavy, and this is the one endpoint
			// in the app where depth costs money per call.
			Effort: anthropic.OutputConfigEffortMedium,
		},
		Messages: []anthropic.MessageParam{anthropic.NewUserMessage(blocks...)},
	})
	if err != nil {
		// Never surface upstream error text: it can carry request ids and
		// prompt fragments, and the house rule is that a raw internal error
		// never reaches a client.
		return Estimate{}, fmt.Errorf("%w: %v", ErrEstimateUnavailable, err)
	}

	// CHECK stop_reason BEFORE READING CONTENT. A refusal is a successful HTTP
	// 200 with an empty or partial content array, so code that indexes
	// content[0] unconditionally breaks on exactly the response it most needs
	// to handle gracefully.
	if resp.StopReason == anthropic.StopReasonRefusal {
		return Estimate{}, ErrEstimateRefused
	}

	raw := firstText(resp)
	if strings.TrimSpace(raw) == "" {
		return Estimate{}, fmt.Errorf("%w: empty response", ErrEstimateUnavailable)
	}

	var out Estimate
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		// Structured outputs make this close to impossible; the usual cause is
		// truncation, which means max_tokens is too small for thinking plus
		// output rather than that the model misbehaved.
		return Estimate{}, fmt.Errorf("%w: could not read the response", ErrEstimateUnavailable)
	}
	out.Model = string(resp.Model)
	out.Source = in.Source()

	if err := ValidateEstimate(out); err != nil {
		return Estimate{}, err
	}
	return out, nil
}

// firstText returns the first text block, skipping thinking blocks.
//
// Thinking blocks come FIRST in the content array when adaptive thinking is
// on, so `Content[0]` is the wrong block to read even on a perfectly ordinary
// response — a mistake that would parse as "empty response" and read as an
// upstream fault rather than as a bug here.
func firstText(resp *anthropic.Message) string {
	for _, block := range resp.Content {
		if variant, ok := block.AsAny().(anthropic.TextBlock); ok {
			return variant.Text
		}
	}
	return ""
}

// userPrompt is the athlete's own words, plus the slot as portion context.
func userPrompt(in EstimateInput) string {
	var b strings.Builder
	desc := strings.TrimSpace(in.Description)
	switch {
	case desc != "" && len(in.Image) > 0:
		b.WriteString("This is what I ate. My own description: ")
		b.WriteString(desc)
	case desc != "":
		b.WriteString("This is what I ate: ")
		b.WriteString(desc)
	default:
		b.WriteString("This is what I ate.")
	}
	if in.Meal != "" {
		// Context for portion sizing only — a breakfast portion of oats and a
		// dinner one differ. Never a constraint on what may be returned.
		b.WriteString("\n\nLogged as: ")
		b.WriteString(string(in.Meal))
	}
	return b.String()
}
