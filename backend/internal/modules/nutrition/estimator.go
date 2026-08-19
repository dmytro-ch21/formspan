package nutrition

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/platform/llm"
)

// Estimator turns a described or photographed meal into a draft.
//
// The seam the handler depends on, so every quota, validation and refusal path
// is testable against a fake — no API key, no spend per test run.
type Estimator interface {
	// Estimate returns the draft, what the call cost, and any error.
	//
	// **Usage is a THIRD return rather than a field on Estimate**, and that is
	// the whole reason it is shaped this way: `Estimate` is the response body
	// this endpoint serialises to the athlete, so a usage field on it would put
	// our token spend on the wire for every client to read. Metering is the
	// server's business.
	//
	// Usage is meaningful even when err is non-nil — a refusal and a truncation
	// are billed 200s. It is the zero value only when no call completed.
	Estimate(ctx context.Context, in EstimateInput) (Estimate, Usage, error)
}

// Usage is `llm.Usage`, re-exported so this module's callers keep reading one
// name — the same treatment `Provider` gets below, and for the same reason.
type Usage = llm.Usage

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
// estimator is the provider-neutral half, and the only implementation of
// Estimator that ships.
type estimator struct {
	c llm.Completer
}

// Estimate validates the input, calls the provider, and turns raw JSON into a
// checked draft.
//
// Note what is NOT provider-specific: all of it. A provider that returns
// well-formed JSON gets the same validation, the same absurdity bounds and the
// same errors as every other, which is what stops two backends disagreeing
// about whether a draft is acceptable.
func (e *estimator) Estimate(ctx context.Context, in EstimateInput) (Estimate, Usage, error) {
	if err := in.Validate(); err != nil {
		// Rejected before the call, so nothing was spent and there is genuinely
		// nothing to meter.
		return Estimate{}, Usage{}, err
	}

	res, err := e.c.Complete(ctx, llm.Request{
		System:         estimateSystemPrompt,
		Prompt:         userPrompt(in),
		Schema:         EstimateSchema(),
		SchemaName:     "meal_estimate",
		Image:          in.Image,
		ImageMediaType: in.ImageMediaType,
		MaxTokens:      estimateMaxTokens,
	})
	if err != nil {
		// The transport speaks its own two sentinels; this module speaks its
		// own. Translating here rather than letting `llm.ErrRefused` escape is
		// what keeps the wire vocabulary a nutrition decision — the handler
		// maps ErrEstimateRefused to its own status, and it should not have to
		// know which transport produced it.
		//
		// `res.Usage` is returned ALONGSIDE the error rather than dropped: a
		// refusal was billed in full, and the meter that exists to bound spend
		// would otherwise miss exactly the traffic that runs it up. It is the
		// zero value on a transport failure, where no call completed.
		return Estimate{}, res.Usage, translateLLMError(err)
	}
	raw, model, usage := res.Raw, res.Model, res.Usage
	if strings.TrimSpace(raw) == "" {
		return Estimate{}, usage, fmt.Errorf("%w: empty response", ErrEstimateUnavailable)
	}

	var out Estimate
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		// Structured outputs make this close to impossible on either provider;
		// the usual cause is truncation, which means the token budget is too
		// small rather than that the model misbehaved.
		return Estimate{}, usage, fmt.Errorf("%w: could not read the response", ErrEstimateUnavailable)
	}
	out.Model = model
	out.Source = in.Source()

	if err := ValidateEstimate(out); err != nil {
		return Estimate{}, usage, err
	}
	return out, usage, nil
}

// Provider is `llm.Provider`, re-exported so callers and config keep reading
// one name for the thing `ESTIMATE_PROVIDER` selects.
//
// An alias rather than a wrapper type: `main.go` passes the value straight to
// `llm.Config`, and a distinct type would need converting at every boundary for
// no gain. The transport owns which providers EXIST; this module owns which one
// it defaults to and what model it asks for.
type Provider = llm.Provider

const (
	ProviderAnthropic = llm.ProviderAnthropic
	ProviderOpenAI    = llm.ProviderOpenAI
)

// DefaultProvider is the backend when ESTIMATE_PROVIDER is unset.
//
// OpenAI, on a measurement rather than a preference. Both providers named every
// item correctly across the bake-off; the split was calibration and price, and
// gpt-5.6-luna marks a stated quantity `high` where the cheaper tier says
// `medium` while costing a fraction of Haiku. Switching is one env var, and
// `DefaultModels` records what each provider's default is FOR.
const DefaultProvider = ProviderOpenAI

// `Valid` and `APIKeyEnv` moved to `internal/platform/llm` with the transport
// (N36). They are provider-shaped rather than nutrition-shaped — which key an
// OpenAI deploy reads is not a fact about food — and they come along so a second
// consumer does not restate them. `DefaultProvider` above and `DefaultModels`
// below deliberately stay: those are per-feature judgements, and N33 wants a
// different default on the same provider.

// EstimatorConfig is everything the factory needs.
type EstimatorConfig struct {
	// Provider selects the backend. Empty means DefaultProvider.
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
	ProviderOpenAI:    "gpt-5.6-luna",
}

// ResolveModel is the model id a given configuration actually uses.
//
// Exported so main.go can log what it built rather than re-deriving it, which
// is the kind of duplicated defaulting that drifts and then misreports the
// thing somebody is reading the log to find out.
func ResolveModel(provider Provider, override string) string {
	if m := strings.TrimSpace(override); m != "" {
		return m
	}
	return DefaultModels[provider]
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
	provider := cfg.Provider
	if provider == "" {
		provider = DefaultProvider
	}
	c, err := llm.New(llm.Config{
		Provider: provider,
		Model:    ResolveModel(provider, cfg.Model),
		APIKey:   cfg.APIKey,
	})
	if err != nil {
		return nil, fmt.Errorf("nutrition: %w", err)
	}
	// Nil Completer means no API key. Returning a nil INTERFACE rather than a
	// non-nil one wrapping a nil pointer is the load-bearing half — see
	// `llm.New`, where the same mistake was a live bug.
	if c == nil {
		return nil, nil
	}
	return &estimator{c: c}, nil
}

// translateLLMError maps the transport's vocabulary onto this module's.
//
// Two sentinels either side, and the mapping is deliberately total: anything
// that is neither a refusal nor a recognised transport failure becomes
// unavailable rather than escaping as itself, because an unmapped error reaches
// the handler as a 500 carrying whatever text the SDK put in it.
func translateLLMError(err error) error {
	switch {
	case errors.Is(err, llm.ErrRefused):
		// The detail is KEPT, not dropped to the bare sentinel. The client sees
		// a hard-coded 422 message either way, but the handler logs this error,
		// and truncation-versus-genuine-refusal is precisely the half the client
		// never sees and the operator needs — it is what says the output cap is
		// too low. The first version returned the bare sentinel and quietly made
		// those two indistinguishable in the log. Safe to embed because the
		// refusal paths in both providers carry either nothing or the fixed
		// "response was cut off" string, never SDK text. Raised in review.
		return fmt.Errorf("%w: %v", ErrEstimateRefused, err)
	case errors.Is(err, llm.ErrUnavailable):
		return fmt.Errorf("%w: %v", ErrEstimateUnavailable, err)
	default:
		return fmt.Errorf("%w: %v", ErrEstimateUnavailable, err)
	}
}
