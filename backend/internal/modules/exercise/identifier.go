package exercise

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/platform/llm"
)

// Identifier turns a photograph into a draft shortlist.
//
// The seam the handler depends on, so every validation, refusal and coherence
// path is testable against a fake — no API key, no spend per test run. Same
// shape as `nutrition.Estimator` and for the same reason.
type Identifier interface {
	Identify(ctx context.Context, in IdentifyInput) (Identification, error)
}

// identifier is the only implementation that ships.
//
// **There is no provider file here, and that is the point of N36.**
// `internal/platform/llm` already carries both backends behind one `Completer`,
// and its `Request` already has `Image`/`ImageMediaType` because N26 needed
// them for a plate photo. This feature is a prompt, a schema, a validator and a
// model id — writing an `openai.go` here is the exact duplication the
// extraction was done to prevent, and it was done before this code existed
// precisely so the cheap version was still available.
type identifier struct {
	c llm.Completer
	// shortlist is computed once at construction, not per request.
	//
	// It comes from the embedded seed catalog rather than the database on
	// purpose: this is reference content that changes on deploy, and a
	// per-request query would put a table read on the latency budget of a call
	// that already has a vision round-trip in it. The consequence is honest and
	// worth stating — a console-authored exercise is NOT offered until the next
	// deploy carries it into the seed file, same as every other consumer of
	// `SeedData()`.
	shortlist []Exercise
}

// Provider is `llm.Provider`, re-exported so this module and config read one
// name for the thing `IDENTIFY_PROVIDER` selects.
type Provider = llm.Provider

// DefaultIdentifyProvider is OpenAI, decided 2026-08-19 and recorded on the N7
// task line: judged comparable to Anthropic on this task and cheaper.
//
// **"Comparable" was a judgement and has not been measured on equipment
// photos.** Recorded here rather than buried in a commit because the number
// most likely to be quoted back is the cost one, and the cost one is the half
// that was not in doubt.
const DefaultIdentifyProvider = llm.ProviderOpenAI

// DefaultIdentifyModels is this feature's own tier choice, per provider.
//
// It lives here rather than in `llm` because model defaults are a per-feature
// judgement — N26, N33 and this each want something different from the same
// provider, and that is measured from two directions already (see the `Config`
// comment in the transport). This is the third.
//
// **The tier is NOT yet chosen against evidence, and the risk is tier rather
// than vendor.** N37 put two tiers of the SAME provider at 0.0% and 24.2%
// invention on dictation — the difference between usable and unusable, at one
// vendor. The failure mode here is naming the wrong machine confidently, which
// the shortlist bounds but does not eliminate: an invented id is dropped, a
// plausible wrong one from the list is not detectable at all.
//
// So this starts on the CAPABLE tier and the cheap one is a measurement away,
// not a default. Banking a cost saving before running real machine photos is
// how the saving turns into a wrong exercise logged against real history.
//
//nolint:gochecknoglobals // vocabulary, not state
var DefaultIdentifyModels = map[Provider]string{
	llm.ProviderOpenAI:    "gpt-5.6-luna",
	llm.ProviderAnthropic: "claude-haiku-4-5",
}

// ResolveIdentifyModel picks the model id: an explicit override wins, otherwise
// this feature's default for that provider.
func ResolveIdentifyModel(provider Provider, override string) string {
	if o := strings.TrimSpace(override); o != "" {
		return o
	}
	return DefaultIdentifyModels[provider]
}

// identifyMaxTokens caps the output.
//
// The response is a handful of ids and numbers, so this is generous by design
// — large enough that truncation means something is wrong rather than that the
// budget was tight. Truncation maps to REFUSED in the transport because the
// retry is deterministic, so a cap set too low would present as "could not tell
// what machine that is" forever, on every photo, which is the most misleading
// possible symptom for a config error.
const identifyMaxTokens = 600

// IdentifierConfig is what NewIdentifier needs.
type IdentifierConfig struct {
	Provider Provider
	// Model overrides this feature's default for that provider. Empty means use
	// the default.
	Model string
	// APIKey for the provider. Empty disables the feature.
	APIKey string
	// Catalog is the exercise set to build the shortlist from. Nil means the
	// embedded seed catalog, which is what production uses; tests pass their own
	// so a shortlist assertion does not depend on 762 rows of real content.
	Catalog []Exercise
}

// NewIdentifier builds the feature, or returns nil when there is no API key.
//
// **Returns the INTERFACE, and that is load-bearing** — the same trap N36
// documents. A nil `*identifier` assigned into an interface is a NON-nil
// interface value, so the caller's `if identifier == nil` reads false and the
// first request panics on a nil receiver. `llm.New` has the same property for
// the same reason; this preserves it rather than re-introducing the bug one
// layer up by wrapping a nil in a concrete pointer.
func NewIdentifier(cfg IdentifierConfig) (Identifier, error) {
	c, err := llm.New(llm.Config{
		Provider: cfg.Provider,
		Model:    ResolveIdentifyModel(cfg.Provider, cfg.Model),
		APIKey:   cfg.APIKey,
	})
	if err != nil {
		return nil, err
	}
	if c == nil {
		// No key. The caller serves 503 for a nil Identifier and every other
		// exercise route runs normally.
		return nil, nil
	}

	catalog := cfg.Catalog
	if catalog == nil {
		catalog, err = SeedData()
		if err != nil {
			return nil, fmt.Errorf("exercise: identify shortlist: %w", err)
		}
	}
	shortlist := Shortlist(catalog)
	if len(shortlist) == 0 {
		// A shortlist of nothing would make every call return "could not tell",
		// which reads as a model problem and is a catalog problem. Fail at boot
		// instead, where the cause is visible.
		return nil, errors.New("exercise: identify shortlist is empty — no published machine exercises in the catalog")
	}
	return &identifier{c: c, shortlist: shortlist}, nil
}

// NewIdentifierWithCompleter builds one around a supplied Completer.
//
// For tests and for any future caller that already has a transport. Kept
// separate from `NewIdentifier` so the production path keeps its "nil key means
// nil interface" contract without a test needing to fake an API key.
func NewIdentifierWithCompleter(c llm.Completer, catalog []Exercise) (Identifier, error) {
	if c == nil {
		return nil, errors.New("exercise: identifier needs a completer")
	}
	if catalog == nil {
		var err error
		catalog, err = SeedData()
		if err != nil {
			return nil, fmt.Errorf("exercise: identify shortlist: %w", err)
		}
	}
	shortlist := Shortlist(catalog)
	if len(shortlist) == 0 {
		return nil, errors.New("exercise: identify shortlist is empty")
	}
	return &identifier{c: c, shortlist: shortlist}, nil
}

// Identify validates the photo, calls the provider, and checks what comes back
// against the shortlist that was sent.
func (i *identifier) Identify(ctx context.Context, in IdentifyInput) (Identification, error) {
	if err := in.Validate(); err != nil {
		return Identification{}, err
	}

	res, err := i.c.Complete(ctx, llm.Request{
		System:         identifySystemPrompt,
		Prompt:         identifyUserPrompt(i.shortlist),
		Schema:         IdentifySchema(),
		SchemaName:     "machine_identification",
		Image:          in.Image,
		ImageMediaType: in.ImageMediaType,
		MaxTokens:      identifyMaxTokens,
	})
	if err != nil {
		return Identification{}, translateIdentifyError(err)
	}

	if strings.TrimSpace(res.Raw) == "" {
		return Identification{}, fmt.Errorf("%w: empty response", ErrIdentifyUnavailable)
	}

	var out Identification
	if err := json.Unmarshal([]byte(res.Raw), &out); err != nil {
		// Structured outputs make this close to impossible on either provider;
		// the usual cause is truncation, which is a token-budget problem rather
		// than a misbehaving model.
		return Identification{}, fmt.Errorf("%w: could not read the response", ErrIdentifyUnavailable)
	}

	// The shortlist that was SENT is the one validated against — see
	// ValidateIdentification for why that is a different and stronger check
	// than validating against the whole catalog.
	checked, err := ValidateIdentification(out, i.shortlist)
	if err != nil {
		return Identification{}, err
	}
	checked.Model = res.Model
	return checked, nil
}

// translateIdentifyError maps the transport's two sentinels onto this module's.
//
// Total by construction: an unmapped error becomes ErrIdentifyUnavailable
// rather than escaping as itself, because a raw SDK error carries request ids
// and prompt fragments and this module's errors reach a client.
//
// The detail is KEPT on both branches rather than collapsing to the bare
// sentinel — the client sees a fixed message either way, but the handler logs
// this error, and "the model declined" versus "the output cap is too low" is
// exactly the distinction an operator needs and the client never sees. That
// lesson came from review of N36's own consumer.
func translateIdentifyError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, llm.ErrUnreachable):
		// Before every other arm, because ErrIdentifyUnreachable wraps
		// ErrIdentifyUnavailable — the other order folds an outage back into
		// the metered branch with nothing failing to say so.
		return fmt.Errorf("%w: %v", ErrIdentifyUnreachable, err)
	case errors.Is(err, llm.ErrRefused):
		return fmt.Errorf("%w: %v", ErrIdentifyRefused, err)
	default:
		return fmt.Errorf("%w: %v", ErrIdentifyUnavailable, err)
	}
}
