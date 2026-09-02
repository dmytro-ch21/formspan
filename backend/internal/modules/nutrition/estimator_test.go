package nutrition

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/llm"
)

// fakeCompleter stands in for a provider — the SMALL interface, which is the
// point of the split: a test can exercise every provider-neutral rule without
// knowing anything about a transport.
type fakeCompleter struct {
	raw   string
	model string
	err   error
	calls int
	// last is the REQUEST now, not the EstimateInput — and it is asserted
	// rather than merely captured. It used to be the input and nothing read it,
	// which meant nothing checked that this module hands the transport the
	// right prompt, schema and image. That is precisely the seam N36 moved, so
	// it is the seam that most needs a test.
	last llm.Request
}

func (f *fakeCompleter) Name() string  { return "fake" }
func (f *fakeCompleter) Model() string { return f.model }
func (f *fakeCompleter) Complete(_ context.Context, req llm.Request) (llm.Response, error) {
	f.calls++
	f.last = req
	if f.err != nil {
		return llm.Response{}, f.err
	}
	return llm.Response{Raw: f.raw, Model: f.model}, nil
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
			_, _, err := e.Estimate(context.Background(), EstimateInput{Description: "two eggs"})
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

func TestAGoodResponseIsStampedWithTheProviderModelAndSource(t *testing.T) {
	e := &estimator{c: &fakeCompleter{raw: goodRaw, model: "some-model-9"}}
	out, _, err := e.Estimate(context.Background(), EstimateInput{
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

// TestMealNameRoundTripsThroughTheResponse is N472's own guard: the whole
// point of adding the field is that a client can read it back and offer it as
// a suggested name for a compiled meal, so a JSON response that states one
// must actually reach the caller with it intact.
//
// Uses `twoItemRaw` (defined below), not `goodRaw` — a single-item response
// is forced empty by TestASingleItemMealNameIsForcedEmpty's own rule, so a
// round-trip test on ONE item would be asserting a name that the estimator
// is required to strip, for a reason that has nothing to do with round-
// tripping.
func TestMealNameRoundTripsThroughTheResponse(t *testing.T) {
	raw := strings.Replace(twoItemRaw, `"note":""`, `"note":"","meal_name":"Bacon and eggs"`, 1)
	e := &estimator{c: &fakeCompleter{raw: raw, model: "m"}}
	out, _, err := e.Estimate(context.Background(), EstimateInput{Description: "bacon and eggs"})
	if err != nil {
		t.Fatalf("estimate: %v", err)
	}
	if out.MealName != "Bacon and eggs" {
		t.Fatalf("meal_name = %q, want %q", out.MealName, "Bacon and eggs")
	}
}

// TestAnEmptyMealNameIsNotAnError pins the "nothing coherent" case the prompt
// names — a genuinely absent meal_name is not a defect the way an absent item
// name is.
func TestAnEmptyMealNameIsNotAnError(t *testing.T) {
	e := &estimator{c: &fakeCompleter{raw: goodRaw, model: "m"}}
	out, _, err := e.Estimate(context.Background(), EstimateInput{Description: "two eggs"})
	if err != nil {
		t.Fatalf("estimate: %v", err)
	}
	if out.MealName != "" {
		t.Fatalf("meal_name = %q, want empty", out.MealName)
	}
}

// TestASingleItemMealNameIsForcedEmpty is the structural half of the promise
// — NOT trusting the prompt's own request for an empty single-item name (it
// is a request, not a guarantee), by feeding a raw response that names one
// anyway and asserting the estimator strips it. Without this, a client
// discriminating on "meal_name non-empty ⇒ worth offering to compile" would
// be trusting model compliance for a one-item draft that has nothing to
// compile.
func TestASingleItemMealNameIsForcedEmpty(t *testing.T) {
	raw := strings.Replace(goodRaw, `"note":""`, `"note":"","meal_name":"Scrambled eggs"`, 1)
	e := &estimator{c: &fakeCompleter{raw: raw, model: "m"}}
	out, _, err := e.Estimate(context.Background(), EstimateInput{Description: "scrambled eggs"})
	if err != nil {
		t.Fatalf("estimate: %v", err)
	}
	if out.MealName != "" {
		t.Fatalf("meal_name = %q, want forced empty for a single-item draft even though the model supplied one", out.MealName)
	}
}

// twoItemRaw is goodRaw's single item, twice — used wherever a test needs to
// be past the single-item normalization (TestASingleItemMealNameIsForcedEmpty
// above) to observe something else about meal_name.
const twoItemRaw = `{"items":[` +
	`{"name":"Scrambled eggs","serving_label":"1 medium egg","servings":2,` +
	`"kcal":180,"protein_g":12,"carb_g":1,"fat_g":14,"fibre_g":null,` +
	`"portion_confidence":"high","assumption":"assumed a medium egg"},` +
	`{"name":"Bacon","serving_label":"1 slice","servings":2,` +
	`"kcal":90,"protein_g":6,"carb_g":0,"fat_g":7,"fibre_g":0,` +
	`"portion_confidence":"high","assumption":""}` +
	`],"note":""}`

// TestMealNameIsTrimmed guards the same defensive trim ValidateEstimate
// already applies to item names (whitespace-only reads as empty there too) —
// a model returning " " should not read to a client as a real name.
func TestMealNameIsTrimmed(t *testing.T) {
	raw := strings.Replace(twoItemRaw, `"note":""`, `"note":"","meal_name":"  Bacon and eggs  "`, 1)
	e := &estimator{c: &fakeCompleter{raw: raw, model: "m"}}
	out, _, err := e.Estimate(context.Background(), EstimateInput{Description: "bacon and eggs"})
	if err != nil {
		t.Fatalf("estimate: %v", err)
	}
	if out.MealName != "Bacon and eggs" {
		t.Fatalf("meal_name = %q, want trimmed %q", out.MealName, "Bacon and eggs")
	}
}

func TestAnInvalidInputNeverReachesAProvider(t *testing.T) {
	// The provider is where money is spent, so validation happens above it.
	f := &fakeCompleter{raw: goodRaw, model: "m"}
	e := &estimator{c: f}
	if _, _, err := e.Estimate(context.Background(), EstimateInput{}); !errors.Is(err, ErrNoInput) {
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
		// The default-model lookup is this module's, not the transport's — N33
		// wants a different default on the same provider — so a wrong entry
		// here is a nutrition bug and this is where it must fail.
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
			if got := Provider(inner.c.Name()); got != tc.wantProvider {
				t.Errorf("provider = %q, want %q", got, tc.wantProvider)
			}
			// Read off the transport rather than by type-switching on the
			// concrete completer, which this test used to do and no longer can:
			// those types moved to `internal/platform/llm` with N36 and are
			// unexported there. `Model()` is on the interface precisely so this
			// module can confirm the model IT resolved reached the transport —
			// re-deriving it here would assert `ResolveModel` against itself.
			gotModel := inner.c.Model()
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

func TestTheRequestCarriesEverythingTheProviderNeeds(t *testing.T) {
	// N36 moved the transport out, so what this module now owns is the REQUEST
	// it builds. Every field below was previously implicit — the provider
	// reached for `estimateSystemPrompt`, `EstimateSchema()` and
	// `estimateMaxTokens` itself — so nothing could assert them; now they cross
	// a boundary and each one is a way to ship a broken call silently.
	f := &fakeCompleter{raw: goodRaw, model: "m"}
	e := &estimator{c: f}
	img := []byte{0xff, 0xd8, 0xff}
	if _, _, err := e.Estimate(context.Background(), EstimateInput{
		Description:    "two eggs",
		Image:          img,
		ImageMediaType: "image/jpeg",
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The output cap. A zero is not a missing cap, it is a BROKEN one: the
	// field is sent either way, so `max_completion_tokens: 0` reaches the API
	// and every call fails. This used to assert a struct field on the OpenAI
	// completer; asserting the request is strictly stronger, because it proves
	// the value actually crosses to the transport rather than merely existing.
	if f.last.MaxTokens != estimateMaxTokens {
		t.Errorf("MaxTokens = %d, want %d", f.last.MaxTokens, estimateMaxTokens)
	}
	if f.last.MaxTokens == 0 {
		t.Error("no output cap: this endpoint turns a request directly into money")
	}

	if f.last.System != estimateSystemPrompt {
		t.Error("the system prompt did not reach the provider")
	}
	if !strings.Contains(f.last.Prompt, "two eggs") {
		t.Errorf("the user prompt does not carry the description: %q", f.last.Prompt)
	}
	// A schema is what makes this structured output rather than a suggestion,
	// and OpenAI additionally requires the name.
	if f.last.Schema == nil {
		t.Error("no schema sent — the response would be free text")
	}
	if f.last.SchemaName == "" {
		t.Error("no schema name sent — OpenAI rejects a strict schema without one")
	}
	if len(f.last.Image) != len(img) || f.last.ImageMediaType != "image/jpeg" {
		t.Error("the photo did not reach the provider")
	}
}

func TestResolveModelIsTheOnePlaceDefaultingHappens(t *testing.T) {
	// main.go logs the resolved model at boot and NewEstimator builds with it;
	// two copies of "empty means the default" drift, and the one that drifts is
	// the log — which is the line somebody reads to find out what is running.
	for _, tc := range []struct {
		provider Provider
		override string
		want     string
	}{
		{ProviderOpenAI, "", DefaultModels[ProviderOpenAI]},
		{ProviderAnthropic, "", DefaultModels[ProviderAnthropic]},
		{ProviderOpenAI, "  ", DefaultModels[ProviderOpenAI]},
		{ProviderOpenAI, "gpt-5.4-nano", "gpt-5.4-nano"},
		{ProviderOpenAI, "  gpt-5.4-nano  ", "gpt-5.4-nano"},
	} {
		if got := ResolveModel(tc.provider, tc.override); got != tc.want {
			t.Errorf("ResolveModel(%q, %q) = %q, want %q", tc.provider, tc.override, got, tc.want)
		}
	}
}

func TestTheTransportsVocabularyBecomesThisModulesVocabulary(t *testing.T) {
	// `llm` speaks two sentinels; this module speaks its own, and the handler
	// turns ITS sentinels into statuses. If the translation drops a case, a
	// refusal reaches the client as "temporarily unavailable" and the athlete
	// retries a deterministic failure — billed twice for the identical doomed
	// request.
	//
	// The truncation-is-a-refusal rule itself now lives with the providers, in
	// `internal/platform/llm` — the two backends disagreeing about it was the
	// divergence that seam exists to stop, and it is asserted there, against
	// the files that implement it.
	if got := translateLLMError(llm.ErrRefused); !errors.Is(got, ErrEstimateRefused) {
		t.Errorf("a refusal became %v, want ErrEstimateRefused", got)
	}
	if got := translateLLMError(llm.ErrRefused); errors.Is(got, ErrEstimateUnavailable) {
		t.Error("a refusal also reads as unavailable, so the client will retry it")
	}
	if got := translateLLMError(llm.ErrUnavailable); !errors.Is(got, ErrEstimateUnavailable) {
		t.Errorf("an outage became %v, want ErrEstimateUnavailable", got)
	}
	// Total by construction: anything unrecognised must still land inside this
	// module's vocabulary rather than escaping as itself, or it reaches the
	// handler as a 500 carrying whatever text the SDK put in it — which is how
	// request ids and prompt fragments leave the building.
	stray := errors.New("dial tcp: connection refused to api.internal:443")
	got := translateLLMError(stray)
	if !errors.Is(got, ErrEstimateUnavailable) {
		t.Errorf("an unmapped error became %v, want ErrEstimateUnavailable", got)
	}
}
