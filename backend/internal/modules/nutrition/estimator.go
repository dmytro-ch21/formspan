package nutrition

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Estimator turns a described or photographed meal into a draft.
//
// The seam the handler depends on, so every quota, validation and refusal path
// is testable against a fake — no API key, no spend per test run.
type Estimator interface {
	Estimate(ctx context.Context, in EstimateInput) (Estimate, error)
}

// completer is what a PROVIDER implements, and it is deliberately the smaller
// interface.
//
// Everything a provider does NOT need to know lives above it: the prompt, the
// schema, the parse, the range checks, the error vocabulary. A provider is
// handed an input and returns raw JSON text plus the model id that produced
// it. That is the whole contract.
//
// The split exists because `Estimator` alone was not enough to make this
// swappable in practice — implementing it a second time meant reimplementing
// the parse, the validation and the error mapping alongside the actual call,
// which is three chances to have two providers disagree about what a draft is.
// Adding a provider now means one file with one method.
type completer interface {
	// complete sends the shared prompt and schema, and returns the model's raw
	// JSON response.
	//
	// It must map its own transport failures onto this package's sentinels:
	// ErrEstimateRefused when the provider declined, ErrEstimateUnavailable for
	// anything else. Never a raw upstream error — those carry request ids and
	// prompt fragments.
	complete(ctx context.Context, in EstimateInput) (raw string, model string, err error)
	// providerName is for logging and for the usage row.
	providerName() string
}

// estimator is the provider-neutral half, and the only implementation of
// Estimator that ships.
type estimator struct {
	c completer
}

// Estimate validates the input, calls the provider, and turns raw JSON into a
// checked draft.
//
// Note what is NOT provider-specific: all of it. A provider that returns
// well-formed JSON gets the same validation, the same absurdity bounds and the
// same errors as every other, which is what stops two backends disagreeing
// about whether a draft is acceptable.
func (e *estimator) Estimate(ctx context.Context, in EstimateInput) (Estimate, error) {
	if err := in.Validate(); err != nil {
		return Estimate{}, err
	}

	raw, model, err := e.c.complete(ctx, in)
	if err != nil {
		return Estimate{}, err
	}
	if strings.TrimSpace(raw) == "" {
		return Estimate{}, fmt.Errorf("%w: empty response", ErrEstimateUnavailable)
	}

	var out Estimate
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		// Structured outputs make this close to impossible on either provider;
		// the usual cause is truncation, which means the token budget is too
		// small rather than that the model misbehaved.
		return Estimate{}, fmt.Errorf("%w: could not read the response", ErrEstimateUnavailable)
	}
	out.Model = model
	out.Source = in.Source()

	if err := ValidateEstimate(out); err != nil {
		return Estimate{}, err
	}
	return out, nil
}

// Provider names a backend. The value is what `ESTIMATE_PROVIDER` takes.
type Provider string

const (
	ProviderAnthropic Provider = "anthropic"
	ProviderOpenAI    Provider = "openai"
)

// EstimatorConfig is everything the factory needs.
type EstimatorConfig struct {
	// Provider selects the backend. Empty means Anthropic — the default rather
	// than an error, so an existing deploy that only sets an API key keeps
	// working across this change.
	Provider Provider
	// Model overrides the provider's default. Empty takes the default, which is
	// the cheapest model measured to do this job well on that provider.
	Model string
	// APIKey for the selected provider.
	APIKey string
}

// DefaultModels are the per-provider defaults.
//
// Each is the cheapest model MEASURED to do this job well on that provider, not
// the most capable available and not the cheapest listed. See the anthropic
// implementation's comment for how that was arrived at — it took three attempts
// and two overturned assumptions.
var DefaultModels = map[Provider]string{
	ProviderAnthropic: "claude-haiku-4-5",
	ProviderOpenAI:    "gpt-5.4-nano",
}

// NewEstimator builds the configured backend.
//
// Returns nil — not an error — when there is no API key, and the handler serves
// 503 for a nil estimator. A deploy without a key runs every other nutrition
// route normally rather than refusing to start.
//
// **Returns the INTERFACE, and that is load-bearing.** A nil concrete pointer
// assigned into an interface produces a NON-nil interface, so the handler's nil
// check would read false and the first request would panic on a nil receiver.
// That was a live bug here, found by review.
func NewEstimator(cfg EstimatorConfig) (Estimator, error) {
	if strings.TrimSpace(cfg.APIKey) == "" {
		return nil, nil
	}

	provider := cfg.Provider
	if provider == "" {
		provider = ProviderAnthropic
	}
	model := strings.TrimSpace(cfg.Model)
	if model == "" {
		model = DefaultModels[provider]
	}

	var c completer
	switch provider {
	case ProviderAnthropic:
		c = newAnthropicCompleter(cfg.APIKey, model)
	case ProviderOpenAI:
		c = newOpenAICompleter(cfg.APIKey, model)
	default:
		// A typo in ESTIMATE_PROVIDER is a startup error rather than a silent
		// fallback: falling back would bill the wrong account and read as the
		// config having been applied.
		return nil, fmt.Errorf("nutrition: unknown estimate provider %q", provider)
	}
	return &estimator{c: c}, nil
}
