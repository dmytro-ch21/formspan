package llm

import (
	"fmt"
	"strings"
)

// Provider names a backend. The value is what an env var like
// `ESTIMATE_PROVIDER` takes.
type Provider string

const (
	ProviderAnthropic Provider = "anthropic"
	ProviderOpenAI    Provider = "openai"
)

// Valid reports whether p names a backend that exists.
func (p Provider) Valid() bool {
	switch p {
	case ProviderAnthropic, ProviderOpenAI:
		return true
	}
	return false
}

// APIKeyEnv names the environment variable holding this provider's key.
//
// Here rather than in main.go so the provider and the key it needs cannot drift
// apart — reading ANTHROPIC_API_KEY for an OpenAI deploy is a 503 that looks
// like an outage and is really a config error.
func (p Provider) APIKeyEnv() string {
	switch p {
	case ProviderAnthropic:
		return "ANTHROPIC_API_KEY"
	case ProviderOpenAI:
		return "OPENAI_API_KEY"
	}
	return ""
}

// Config is everything New needs.
//
// No DEFAULT provider and no default model: both are per-feature judgements
// that stay with the caller, and that is measured rather than asserted.
//
// Same provider, same prompt shape, same schema discipline, opposite verdicts —
// and measured from BOTH directions, which is what makes it an argument rather
// than a preference:
//
//   - On dictation (#302), `gpt-5.6-luna` scored a 0.0% invention rate against
//     `gpt-5.4-nano`'s 24.2%. That is the difference between usable and
//     unusable, and it disqualifies nano for N33 outright.
//   - On nutrition portions, the same nano was perfectly adequate. Its
//     characteristic failure there is compressing a stated quantity to
//     `medium` where luna and Haiku say `high` — a wrong portion size, which
//     the athlete is looking at and can correct, not an invented food.
//
// So the cheap tier is disqualified by one feature and fine for the other, on
// the same provider. A package-level default map would quietly become one
// feature's opinion imposed on the other, and it would be a saving for the
// feature that did not need it and a correctness bug for the one that did.
//
// This now has a third dependent: N7's machine-recognition call was chosen for
// OpenAI on COST against a comparable result (#309) — a third reasoning again,
// which only works while each feature owns its own tier.
type Config struct {
	// Provider selects the backend. Required — the caller owns its own default.
	Provider Provider
	// Model is the model id. Required, for the same reason.
	Model string
	// APIKey for the selected provider.
	APIKey string
}

// New builds the configured backend.
//
// Returns `nil, nil` when there is no API key, so a deploy without one runs
// every other route normally rather than refusing to start; the caller serves
// 503 for a nil Completer.
//
// **It returns the INTERFACE, not a concrete pointer, and that is
// load-bearing.** A nil `*openAICompleter` assigned into an interface produces
// a NON-nil interface value, so a caller's `if completer == nil` reads false
// and the first request panics on a nil receiver. That was a live bug in the
// nutrition version, found by review; returning the interface is what fixes it,
// and a future refactor that "simplifies" this to return the concrete type
// reintroduces it silently.
func New(cfg Config) (Completer, error) {
	// Validity is checked BEFORE the missing-key return, deliberately. The other
	// order lets a typo'd provider pass silently whenever its key is also absent
	// — which is exactly the deploy where that happens — and the symptom is a
	// 503 that reads as an outage. A misspelled provider is a boot failure
	// whether or not a key is set.
	if !cfg.Provider.Valid() {
		return nil, fmt.Errorf("llm: unknown provider %q", cfg.Provider)
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		return nil, nil
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return nil, fmt.Errorf("llm: provider %q needs a model id", cfg.Provider)
	}

	switch cfg.Provider {
	case ProviderAnthropic:
		return newAnthropic(cfg.APIKey, cfg.Model), nil
	case ProviderOpenAI:
		return newOpenAI(cfg.APIKey, cfg.Model), nil
	}
	// Unreachable — Valid() above is the gate. Kept so that adding a Provider
	// constant without adding its case here fails loudly at boot rather than
	// nil-panicking on the first request.
	return nil, fmt.Errorf("llm: provider %q has no implementation", cfg.Provider)
}
