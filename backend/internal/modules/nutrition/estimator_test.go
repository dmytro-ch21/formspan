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
	for _, tc := range []struct {
		name string
		cfg  EstimatorConfig
	}{
		{"anthropic by default", EstimatorConfig{APIKey: "k"}},
		{"anthropic explicitly", EstimatorConfig{Provider: ProviderAnthropic, APIKey: "k"}},
		{"openai", EstimatorConfig{Provider: ProviderOpenAI, APIKey: "k"}},
		{"a named model", EstimatorConfig{Provider: ProviderOpenAI, Model: "gpt-5.6-luna", APIKey: "k"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			est, err := NewEstimator(tc.cfg)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if est == nil {
				t.Fatal("nil estimator with a key present")
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

func TestEveryProviderHasADefaultModel(t *testing.T) {
	// A provider added without one would send an empty model id, which reads as
	// an upstream error rather than as a missing map entry.
	for _, p := range []Provider{ProviderAnthropic, ProviderOpenAI} {
		if DefaultModels[p] == "" {
			t.Errorf("provider %q has no default model", p)
		}
	}
}
