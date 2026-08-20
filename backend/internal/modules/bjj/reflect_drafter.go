package bjj

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
	"github.com/dmytro-ch21/vola/backend/internal/platform/llm"
)

// Drafter turns a dictated reflection into a draft.
//
// The seam the handler depends on, so every quota, validation and refusal path
// is testable against a fake — no API key, no spend per test run. Same shape as
// `nutrition.Estimator` and `exercise.Identifier`, and for the same reason.
type Drafter interface {
	Draft(ctx context.Context, in DictationInput) (Draft, error)
}

// drafter is the only implementation that ships.
//
// **There is no provider file here, and that is the whole point of N36.**
// `internal/platform/llm` already carries both backends behind one `Completer`,
// and its own package comment names this feature as the second consumer it was
// extracted for. A feature is a prompt, a schema, a validator and a model id;
// writing an `openai.go` in this package would be exactly the duplication the
// extraction was done to prevent.
type drafter struct {
	c llm.Completer
	// catalog is built once at construction rather than per request.
	//
	// It comes from the embedded seed content rather than the database on
	// purpose. Two reasons, and the second is the load-bearing one: a 542-row
	// query would sit on the latency budget of a call that already has a model
	// round-trip in it, and — more importantly — the block has to be BYTE
	// STABLE to be cached, and a table read is a thing that changes underneath
	// you. The consequence is honest and worth stating: a console-authored
	// technique is not offered to the model until the next deploy carries it
	// into the seed file, same as every other consumer of `SeedData()`. An
	// athlete who names one gets it back as an unresolved phrase and picks it
	// from the library, which is the ordinary path rather than a failure.
	catalog Catalog
	// system is the assembled prompt, also built once. It is ~10,600 tokens and
	// identical on every call, which is what makes it cacheable.
	system string
	schema map[string]any
}

// Provider is `llm.Provider`, re-exported so this module and config read one
// name for the thing `REFLECT_PROVIDER` selects.
type Provider = llm.Provider

// DefaultDraftProvider is the backend when REFLECT_PROVIDER is unset.
const DefaultDraftProvider = llm.ProviderOpenAI

// DefaultDraftModels is this feature's own tier choice, per provider.
//
// It lives here rather than in `llm` because a model default is a per-feature
// judgement — `nutrition`, `exercise` and this each want something different
// from the same provider, and the transport deliberately does not know what a
// good model is.
//
// # This is the one tier choice in this repo that is measured
//
// N37 ran the whole dictation corpus through both OpenAI tiers and published
// the numbers:
//
//	gpt-5.6-luna   invention rate 0.0%    tag F1 0.905
//	gpt-5.4-nano   invention rate 24.2%   tag F1 0.708
//
// Nano's eight inventions are all the same mistake — resolving a phrase the
// athlete did not narrow, "butterfly" onto one of twenty-six butterfly entries
// — which is precisely the failure this feature exists to avoid and precisely
// the one a validator cannot catch: the id is real, it is in the catalog, and
// nothing downstream can tell it from the right one. The cheap tier is not a
// saving here, it is the feature not working, and it is written down rather
// than left as a preference.
//
// The Anthropic entry is NOT measured on this task. It is there so a key swap
// works, not as a claim that Haiku scores like luna; running the corpus against
// it is a day's work nobody has done.
//
//nolint:gochecknoglobals // vocabulary, not state
var DefaultDraftModels = map[Provider]string{
	llm.ProviderOpenAI:    "gpt-5.6-luna",
	llm.ProviderAnthropic: "claude-haiku-4-5",
}

// ResolveDraftModel picks the model id: an explicit override wins, otherwise
// this feature's default for that provider.
//
// Exported so main.go can log what it built rather than re-deriving it, which
// is the kind of duplicated defaulting that drifts and then misreports the very
// thing somebody is reading the log to find out.
func ResolveDraftModel(provider Provider, override string) string {
	if o := strings.TrimSpace(override); o != "" {
		return o
	}
	return DefaultDraftModels[provider]
}

// DrafterConfig is everything the factory needs.
type DrafterConfig struct {
	// Provider selects the backend. Empty means DefaultDraftProvider.
	Provider Provider
	// Model overrides this feature's default for that provider.
	Model string
	// APIKey for the selected provider. Empty disables the feature.
	APIKey string
	// Catalog is the technique set to resolve against. Zero value means the
	// embedded seed content, which is what production uses; tests pass their
	// own so an assertion does not depend on 542 rows of real prose.
	Catalog Catalog
}

// TechniqueCatalog is the production catalog: every published technique in the
// seeded library, plus the position families the tag vocabulary uses.
//
// Only PUBLISHED rows. Today that is all 542 of them — the seed file carries no
// drafts — so this filter changes nothing and is here because a draft is content
// the console is still writing, and offering one to the model would resolve an
// athlete's words onto a technique they are not meant to see yet.
func TechniqueCatalog() (Catalog, error) {
	techniques, err := technique.SeedData()
	if err != nil {
		return Catalog{}, fmt.Errorf("bjj: reflection catalog: %w", err)
	}
	positions, err := technique.PositionSeedData()
	if err != nil {
		return Catalog{}, fmt.Errorf("bjj: reflection families: %w", err)
	}

	entries := make([]CatalogEntry, 0, len(techniques))
	for _, t := range techniques {
		if technique.NormalizeStatus(t.Status) != technique.StatusPublished {
			continue
		}
		entries = append(entries, CatalogEntry{
			ID: t.ID, Name: t.Name, Category: t.Category, Position: t.Position,
		})
	}
	return NewCatalog(entries, positionFamilies(positions)), nil
}

// positionFamilies is the distinct family list, in the library's own display
// order.
//
// The SET is what matters — `familyOf` matches on membership, and no family is
// a " - " prefix of another, so the order cannot change which family a position
// resolves to. It is ordered anyway because the list also becomes an enum in
// the schema, and an enum whose order wandered between builds would be a
// gratuitous diff in the one artefact this feature keeps byte-stable.
//
// This list agreeing with `POSITIONS` in apps/mobile/lib/bjjSession.ts is not
// checked here: `scripts/check-dictation-evals.py` already fails `verify` when
// the two disagree, and a second copy of that check would be a third place for
// the vocabulary to drift.
func positionFamilies(positions []technique.Position) []string {
	sorted := make([]technique.Position, len(positions))
	copy(sorted, positions)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].OrderIndex < sorted[j].OrderIndex })

	seen := map[string]bool{}
	out := make([]string, 0, len(sorted))
	for _, p := range sorted {
		if p.Family == "" || seen[p.Family] {
			continue
		}
		seen[p.Family] = true
		out = append(out, p.Family)
	}
	return out
}

// NewDrafter builds the configured backend, or returns nil when there is no API
// key.
//
// **Returns the INTERFACE, and that is load-bearing.** A nil concrete pointer
// assigned into an interface produces a NON-nil interface, so the handler's nil
// check would read false and the first request would panic on a nil receiver.
// That was a live bug in `llm.New` once; this preserves the fix rather than
// re-introducing it one layer up.
func NewDrafter(cfg DrafterConfig) (Drafter, error) {
	provider := cfg.Provider
	if provider == "" {
		provider = DefaultDraftProvider
	}
	c, err := llm.New(llm.Config{
		Provider: provider,
		Model:    ResolveDraftModel(provider, cfg.Model),
		APIKey:   cfg.APIKey,
	})
	if err != nil {
		return nil, fmt.Errorf("bjj: %w", err)
	}
	if c == nil {
		// No key. The handler serves 503 for a nil Drafter and every other bjj
		// route runs normally, so a deploy without a key is not a deploy
		// without jiu-jitsu.
		return nil, nil
	}
	catalog := cfg.Catalog
	if catalog.Len() == 0 {
		catalog, err = TechniqueCatalog()
		if err != nil {
			return nil, err
		}
	}
	return newDrafter(c, catalog)
}

// NewDrafterWithCompleter builds one around a supplied Completer.
//
// For tests and for any future caller that already has a transport. Kept
// separate from `NewDrafter` so the production path keeps its "nil key means nil
// interface" contract without a test needing to fake an API key.
func NewDrafterWithCompleter(c llm.Completer, catalog Catalog) (Drafter, error) {
	if c == nil {
		return nil, errors.New("bjj: drafter needs a completer")
	}
	if catalog.Len() == 0 {
		var err error
		catalog, err = TechniqueCatalog()
		if err != nil {
			return nil, err
		}
	}
	return newDrafter(c, catalog)
}

func newDrafter(c llm.Completer, catalog Catalog) (Drafter, error) {
	if len(catalog.families) == 0 {
		// A family list of nothing would make `familyOf` return "" for every
		// position, so every tag would come back with no position and the
		// funnel would never join. Fail at boot, where the cause is visible,
		// rather than serving drafts that are quietly missing half their value.
		return nil, errors.New("bjj: reflection catalog has no position families")
	}
	return &drafter{
		c:       c,
		catalog: catalog,
		system:  draftSystemPrompt(catalog),
		schema:  DraftSchema(catalog.Families()),
	}, nil
}

// Draft validates the dictation, calls the provider, and checks what comes back
// against the catalog that was sent.
func (d *drafter) Draft(ctx context.Context, in DictationInput) (Draft, error) {
	if err := in.Validate(); err != nil {
		return Draft{}, err
	}
	dictation := strings.TrimSpace(in.Dictation)

	res, err := d.c.Complete(ctx, llm.Request{
		System:     d.system,
		Prompt:     dictationUserPrompt(dictation),
		Schema:     d.schema,
		SchemaName: "session_draft",
		MaxTokens:  draftMaxTokens,
	})
	if err != nil {
		return Draft{}, translateDraftError(err)
	}
	if strings.TrimSpace(res.Raw) == "" {
		return Draft{}, fmt.Errorf("%w: empty response", ErrDraftUnavailable)
	}

	var raw Draft
	if err := json.Unmarshal([]byte(res.Raw), &raw); err != nil {
		// Structured outputs make this close to impossible on either provider;
		// the usual cause is truncation, which is a token-budget problem rather
		// than a misbehaving model.
		return Draft{}, fmt.Errorf("%w: could not read the response", ErrDraftUnavailable)
	}

	// The dictation is passed in because the words are the only evidence a
	// number is real — see `spokenNumber`.
	out := ResolveDraft(raw, d.catalog, dictation)
	out.Model = res.Model
	return out, nil
}

// translateDraftError maps the transport's two sentinels onto this module's.
//
// Total by construction: an unmapped error becomes ErrDraftUnavailable rather
// than escaping as itself, because a raw SDK error carries request ids and
// prompt fragments and this module's errors reach a client.
//
// The detail is KEPT rather than collapsed to the bare sentinel. The client sees
// a fixed message either way, but the handler logs this error, and "the model
// declined" versus "the output cap is too low" is exactly the distinction an
// operator needs and the client never sees.
func translateDraftError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, llm.ErrRefused):
		return fmt.Errorf("%w: %v", ErrDraftRefused, err)
	default:
		return fmt.Errorf("%w: %v", ErrDraftUnavailable, err)
	}
}
