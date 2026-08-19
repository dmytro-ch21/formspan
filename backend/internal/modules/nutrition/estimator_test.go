package nutrition

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeCompleter stands in for a provider — the SMALL interface, which is the
// point of the split: a test can exercise every provider-neutral rule without
// knowing anything about a transport.
type fakeCompleter struct {
	raw   string
	model string
	err   error
	calls int
	last  EstimateInput
}

func (f *fakeCompleter) providerName() string { return "fake" }
func (f *fakeCompleter) complete(_ context.Context, in EstimateInput) (string, string, error) {
	f.calls++
	f.last = in
	return f.raw, f.model, f.err
}

const goodRaw = `{"items":[{"name":"Scrambled eggs","serving_label":"1 medium egg","servings":2,` +
	`"kcal":180,"protein_g":12,"carb_g":1,"fat_g":14,"fibre_g":null,` +
	`"portion_confidence":"high","assumption":"assumed a medium egg"}],"note":""}`

func TestTheProviderNeutralHalfDoesAllTheChecking(t *testing.T) {
	// Everything below is applied to EVERY provider, which is what stops two
	// backends disagreeing about what a draft is. A provider that returns
	// well-formed JSON gets the same validation either way.
	cases := map[string]struct {
		raw  string
		want error
	}{
		"empty response":     {"", ErrEstimateUnavailable},
		"not JSON":           {"sorry, I cannot help with that", ErrEstimateUnavailable},
		"no items":           {`{"items":[],"note":"too dark"}`, ErrEstimateRefused},
		"negative kcal":      {strings.Replace(goodRaw, `"kcal":180`, `"kcal":-5`, 1), ErrInvalidInput},
		"unknown confidence": {strings.Replace(goodRaw, `"high"`, `"probably"`, 1), ErrInvalidInput},
		"absurd magnitude":   {strings.Replace(goodRaw, `"kcal":180`, `"kcal":900000`, 1), ErrInvalidInput},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			e := &estimator{c: &fakeCompleter{raw: tc.raw, model: "m"}}
			_, err := e.Estimate(context.Background(), EstimateInput{Description: "two eggs"})
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

func TestAGoodResponseIsStampedWithTheProviderModelAndSource(t *testing.T) {
	e := &estimator{c: &fakeCompleter{raw: goodRaw, model: "some-model-9"}}
	out, err := e.Estimate(context.Background(), EstimateInput{
		Image: []byte{1}, ImageMediaType: "image/png",
	})
	if err != nil {
		t.Fatalf("estimate: %v", err)
	}
	// The model comes from the PROVIDER's response, not from config: config
	// says what was asked for, the response says what actually answered.
	if out.Model != "some-model-9" {
		t.Fatalf("model = %q", out.Model)
	}
	if out.Source != SourcePhoto {
		t.Fatalf("source = %q, want photo", out.Source)
	}
}

func TestAnInvalidInputNeverReachesAProvider(t *testing.T) {
	// The provider is where money is spent, so validation happens above it.
	f := &fakeCompleter{raw: goodRaw, model: "m"}
	e := &estimator{c: f}
	if _, err := e.Estimate(context.Background(), EstimateInput{}); !errors.Is(err, ErrNoInput) {
		t.Fatalf("want ErrNoInput, got %v", err)
	}
	if f.calls != 0 {
		t.Fatalf("an empty request reached the provider %d times", f.calls)
	}
}

func TestTheFactoryPicksABackendFromConfig(t *testing.T) {
	// The whole point of the config seam: swapping models is an env change.
	//
	// This asserts WHICH backend and WHICH model, which it did not always do.
	// It used to check only that the estimator was non-nil, under subtest names
	// that claimed a particular provider — so it passed identically whatever
	// the default was, and went on passing unchanged when the default moved
	// from Anthropic to OpenAI. A test whose name is the only place its claim
	// appears is not testing that claim.
	for _, tc := range []struct {
		name         string
		cfg          EstimatorConfig
		wantProvider Provider
		wantModel    string
	}{
		{"the default provider", EstimatorConfig{APIKey: "k"}, DefaultProvider, DefaultModels[DefaultProvider]},
		{"anthropic explicitly", EstimatorConfig{Provider: ProviderAnthropic, APIKey: "k"}, ProviderAnthropic, DefaultModels[ProviderAnthropic]},
		{"openai explicitly", EstimatorConfig{Provider: ProviderOpenAI, APIKey: "k"}, ProviderOpenAI, DefaultModels[ProviderOpenAI]},
		{"a named model overrides the default", EstimatorConfig{Provider: ProviderOpenAI, Model: "gpt-5.4-nano", APIKey: "k"}, ProviderOpenAI, "gpt-5.4-nano"},
		{"a named model on anthropic", EstimatorConfig{Provider: ProviderAnthropic, Model: "claude-opus-5", APIKey: "k"}, ProviderAnthropic, "claude-opus-5"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			est, err := NewEstimator(tc.cfg)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if est == nil {
				t.Fatal("nil estimator with a key present")
			}
			inner, ok := est.(*estimator)
			if !ok {
				t.Fatalf("factory returned %T, not *estimator", est)
			}
			if got := Provider(inner.c.providerName()); got != tc.wantProvider {
				t.Errorf("provider = %q, want %q", got, tc.wantProvider)
			}
			var gotModel string
			switch c := inner.c.(type) {
			case *anthropicCompleter:
				gotModel = c.model
			case *openAICompleter:
				gotModel = c.model
			default:
				t.Fatalf("unknown completer %T — add its model accessor here", c)
			}
			if gotModel != tc.wantModel {
				t.Errorf("model = %q, want %q", gotModel, tc.wantModel)
			}
		})
	}
}

func TestAnUnknownProviderFailsTheBootRatherThanFallingBack(t *testing.T) {
	// A typo in ESTIMATE_PROVIDER must not silently serve Anthropic: that would
	// bill the wrong account and read as the config having been applied.
	if _, err := NewEstimator(EstimatorConfig{Provider: "gemini", APIKey: "k"}); err == nil {
		t.Fatal("an unknown provider was accepted")
	}
}

func TestNoKeyYieldsAGENUINELYNilInterface(t *testing.T) {
	// A nil CONCRETE pointer in an interface is a NON-nil interface, so the
	// handler's nil check would read false and the first request would panic on
	// a nil receiver. That was a live bug here; this is the test that pins it.
	est, err := NewEstimator(EstimatorConfig{APIKey: "   "})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if est != nil {
		t.Fatal("estimator is not nil without a key — the 503 branch will be skipped")
	}
}

func TestAnUnknownProviderFailsTheBootEVENWITHNoKey(t *testing.T) {
	// The order inside NewEstimator matters and this is what pins it. With the
	// missing-key return placed first, a typo'd provider passes silently
	// whenever its key is also absent — which is precisely the deploy where a
	// typo happens — and the symptom is a 503 that reads as an outage rather
	// than as the config error it is.
	if _, err := NewEstimator(EstimatorConfig{Provider: "gemini"}); err == nil {
		t.Fatal("an unknown provider with no key was accepted")
	}
}

func TestEveryProviderIsCompletelyConfigured(t *testing.T) {
	// Three things have to be added together for a provider to work, and each
	// omission fails somewhere unhelpful: no default model sends an empty model
	// id (reads as an upstream error), no key variable reads an empty key
	// (reads as an outage), and no Valid() case fails the boot. One test so
	// that adding a fourth provider cannot half-land.
	for _, p := range []Provider{ProviderAnthropic, ProviderOpenAI} {
		if !p.Valid() {
			t.Errorf("provider %q is not Valid()", p)
		}
		if DefaultModels[p] == "" {
			t.Errorf("provider %q has no default model", p)
		}
		if p.APIKeyEnv() == "" {
			t.Errorf("provider %q names no API key variable", p)
		}
		est, err := NewEstimator(EstimatorConfig{Provider: p, APIKey: "k"})
		if err != nil || est == nil {
			t.Errorf("provider %q did not build: est=%v err=%v", p, est, err)
		}
	}
}

func TestTheDefaultProviderResolvesToARealBackend(t *testing.T) {
	// An empty ESTIMATE_PROVIDER is the normal deploy, so the default has to be
	// a provider that is fully configured rather than merely a named constant.
	if !DefaultProvider.Valid() {
		t.Fatalf("DefaultProvider %q is not a real backend", DefaultProvider)
	}
	if DefaultProvider.APIKeyEnv() == "" {
		t.Fatalf("DefaultProvider %q names no API key variable", DefaultProvider)
	}
	est, err := NewEstimator(EstimatorConfig{APIKey: "k"})
	if err != nil || est == nil {
		t.Fatalf("the default configuration did not build: est=%v err=%v", est, err)
	}
}

func TestAnUnknownProviderNamesNoKeyVariable(t *testing.T) {
	// main.go reads os.Getenv(provider.APIKeyEnv()), and os.Getenv("") is "" —
	// so this returning something plausible for a typo would hand the wrong
	// account's key to the wrong API.
	if got := Provider("gemini").APIKeyEnv(); got != "" {
		t.Fatalf("an unknown provider named the key variable %q", got)
	}
}

func TestTheShippedDefaultIsPinnedBecauseTheAppNamesIt(t *testing.T) {
	// A deliberate change-detector, and the only one in this package.
	//
	// The rest of the factory tests derive their expectations from these
	// constants, so they pass whatever the constants say — which is right for
	// them and useless for pinning the decision itself. This one asserts the
	// literals, because changing them has a consequence Go cannot see:
	//
	//   apps/mobile/app/food/describe.tsx tells the athlete, BEFORE the camera
	//   opens, which company their photograph is sent to. A provider swap that
	//   leaves that string alone turns a privacy disclosure into a specific
	//   false statement about where a picture of somebody's kitchen went.
	//
	// So this failing is not a nuisance — it is the reminder that the swap has
	// a second half. Change both, in the same PR, then update this line.
	if DefaultProvider != ProviderOpenAI {
		t.Errorf("DefaultProvider = %q, want %q — and if this is intended, update the disclosure in apps/mobile/app/food/describe.tsx",
			DefaultProvider, ProviderOpenAI)
	}
	if got := DefaultModels[ProviderOpenAI]; got != "gpt-5.6-luna" {
		t.Errorf("default OpenAI model = %q, want %q — chosen on measured calibration, see the N26 history entry", got, "gpt-5.6-luna")
	}
}
