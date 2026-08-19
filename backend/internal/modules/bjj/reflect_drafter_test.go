package bjj

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/llm"
)

// fakeCompleter stands in for the provider.
//
// Every path below — refusal, outage, garbled JSON, success — runs against this
// rather than a live model, so the suite costs nothing and needs no API key. It
// also records what it was ASKED, which is the only way to assert that the
// prompt, the schema and the token cap actually reached the transport rather
// than being computed and dropped.
type fakeCompleter struct {
	raw   string
	model string
	err   error

	calls int
	last  llm.Request
}

func (f *fakeCompleter) Complete(_ context.Context, req llm.Request) (llm.Response, error) {
	f.calls++
	f.last = req
	if f.err != nil {
		return llm.Response{}, f.err
	}
	return llm.Response{Raw: f.raw, Model: f.model}, nil
}

func (f *fakeCompleter) Name() string  { return "fake" }
func (f *fakeCompleter) Model() string { return "fake-model" }

func newTestDrafter(t *testing.T, c llm.Completer) Drafter {
	t.Helper()
	d, err := NewDrafterWithCompleter(c, fixtureCatalog())
	if err != nil {
		t.Fatalf("building the drafter: %v", err)
	}
	return d
}

// Everything this feature owns has to cross the seam, or it is configuration
// that exists only in a comment. Nutrition learned this the hard way: its own
// cap was asserted against nothing until the field moved onto the request.
func TestTheRequestCarriesThePromptSchemaAndCap(t *testing.T) {
	f := &fakeCompleter{raw: `{"tags":[],"unresolved":[],"note":null,"body_note":null,"kind":null,"gi":null,"rounds":null,"round_minutes":null,"session_rpe":null}`}
	d := newTestDrafter(t, f)

	if _, err := d.Draft(context.Background(), DictationInput{Dictation: "  rolled five rounds  "}); err != nil {
		t.Fatalf("Draft: %v", err)
	}

	if f.last.System != draftSystemPrompt(fixtureCatalog()) {
		t.Error("the system prompt that reached the transport is not the assembled one")
	}
	if f.last.Prompt != "<dictation>\nrolled five rounds\n</dictation>" {
		t.Errorf("user prompt = %q, want the trimmed dictation inside the fence", f.last.Prompt)
	}
	if f.last.MaxTokens != draftMaxTokens {
		t.Errorf("MaxTokens = %d, want %d", f.last.MaxTokens, draftMaxTokens)
	}
	if f.last.SchemaName != "session_draft" {
		t.Errorf("SchemaName = %q, want session_draft", f.last.SchemaName)
	}
	if f.last.Schema == nil {
		t.Fatal("no schema reached the transport — the response would be free text")
	}
	// Text only, forever. Transcription happens on the device's own keyboard,
	// so no audio and no image ever reaches this endpoint; a request that
	// carried one would mean somebody had added a second, unmeasured path.
	if len(f.last.Image) != 0 || f.last.ImageMediaType != "" {
		t.Error("an image reached the transport — this endpoint has no image path")
	}
}

// The gate before the gate: an input that cannot succeed must not reach the
// provider at all, because reaching it is what costs money.
func TestAnInvalidDictationNeverReachesTheProvider(t *testing.T) {
	f := &fakeCompleter{raw: "{}"}
	d := newTestDrafter(t, f)

	if _, err := d.Draft(context.Background(), DictationInput{Dictation: "   "}); err == nil {
		t.Fatal("an empty dictation was accepted")
	}
	if f.calls != 0 {
		t.Errorf("provider was called %d times for an input that could never succeed", f.calls)
	}
}

// A refusal and an outage are different answers and a client acts on them
// differently: one will be the same next time, the other will not.
func TestTheTransportSentinelsBecomeThisModulesVocabulary(t *testing.T) {
	for name, tc := range map[string]struct {
		from error
		want error
	}{
		"declined":    {llm.ErrRefused, ErrDraftRefused},
		"unavailable": {llm.ErrUnavailable, ErrDraftUnavailable},
		// Anything unmapped becomes unavailable rather than escaping as itself:
		// a raw SDK error carries request ids and prompt fragments, and this
		// module's errors reach a client.
		"something else": {errors.New("dial tcp: connection reset by peer"), ErrDraftUnavailable},
	} {
		d := newTestDrafter(t, &fakeCompleter{err: tc.from})
		_, err := d.Draft(context.Background(), DictationInput{Dictation: "rolled tonight"})
		if !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", name, err, tc.want)
		}
	}
}

// The wrapped detail survives translation, because the handler logs it and
// "the model declined" versus "the output cap is too low" is exactly the
// distinction an operator needs and a client never sees.
func TestARefusalKeepsItsDetailForTheLog(t *testing.T) {
	d := newTestDrafter(t, &fakeCompleter{err: llm.ErrRefused})
	_, err := d.Draft(context.Background(), DictationInput{Dictation: "rolled tonight"})
	if err == nil || !strings.Contains(err.Error(), "declined") {
		t.Errorf("err = %v, want the transport's own words carried through", err)
	}
}

func TestAnUnusableResponseIsUnavailableRatherThanARefusal(t *testing.T) {
	for name, raw := range map[string]string{
		"empty body": "   ",
		"not JSON":   "sorry, I can't help with that",
		"truncated":  `{"tags":[{"category":"sweep"`,
	} {
		d := newTestDrafter(t, &fakeCompleter{raw: raw})
		_, err := d.Draft(context.Background(), DictationInput{Dictation: "rolled tonight"})
		if !errors.Is(err, ErrDraftUnavailable) {
			t.Errorf("%s: err = %v, want ErrDraftUnavailable — a garbled response is not a decision about the input", name, err)
		}
	}
}

// The model id comes off the RESPONSE, not off the request: an alias resolves
// to a dated snapshot, and the point of recording it is to answer "what
// actually produced this draft" later.
func TestTheDraftRecordsWhichModelAnswered(t *testing.T) {
	f := &fakeCompleter{
		raw:   `{"tags":[],"unresolved":[],"note":"good session","body_note":null,"kind":"rolling","gi":true,"rounds":null,"round_minutes":null,"session_rpe":null}`,
		model: "gpt-5.6-luna-2026-08-01",
	}
	d := newTestDrafter(t, f)

	got, err := d.Draft(context.Background(), DictationInput{Dictation: "rolling in the gi, good session"})
	if err != nil {
		t.Fatalf("Draft: %v", err)
	}
	if got.Model != "gpt-5.6-luna-2026-08-01" {
		t.Errorf("model = %q, want the id the provider reported", got.Model)
	}
	if got.Kind != KindRolling || got.Gi == nil || !*got.Gi {
		t.Errorf("draft lost stated scalars: %+v", got)
	}
}

// The validation runs on the way out, not only in `ResolveDraft`'s own tests:
// an invented id has to be gone by the time a Draft leaves this package.
func TestAnInventedIDIsAlreadyGoneByTheTimeTheDraftLeaves(t *testing.T) {
	f := &fakeCompleter{raw: `{
		"tags":[{"category":"submission","event":"scored","position":"Mount","technique_id":"gogoplata-from-space","count":1}],
		"unresolved":[],"note":null,"body_note":null,"kind":null,"gi":null,
		"rounds":null,"round_minutes":null,"session_rpe":null}`}
	d := newTestDrafter(t, f)

	got, err := d.Draft(context.Background(), DictationInput{Dictation: "hit a gogoplata"})
	if err != nil {
		t.Fatalf("Draft: %v", err)
	}
	if got.Tags[0].TechniqueID != nil {
		t.Fatalf("an id that is not in the catalog reached the caller: %q", *got.Tags[0].TechniqueID)
	}
	if len(got.Unresolved) != 1 {
		t.Fatalf("unresolved = %+v, want the phrase handed back for the athlete to pick", got.Unresolved)
	}
}

// **Returns the INTERFACE.** A nil concrete pointer assigned into an interface
// produces a NON-nil interface, so the handler's nil check would read false and
// the first request would panic on a nil receiver. That was a live bug in
// `llm.New` once, and it is the kind that only shows up in production.
func TestNoAPIKeyProducesATrulyNilDrafter(t *testing.T) {
	d, err := NewDrafter(DrafterConfig{Provider: DefaultDraftProvider, APIKey: "", Catalog: fixtureCatalog()})
	if err != nil {
		t.Fatalf("NewDrafter: %v", err)
	}
	if d != nil {
		t.Fatal("a keyless deploy got a non-nil Drafter — the handler's nil check will read false and panic")
	}
}

// A catalog with no position families would make `familyOf` return "" for every
// position, so every tag would come back placeless and the funnel would never
// join. That is a config error, and it fails at boot where the cause is visible
// rather than by serving drafts that are quietly missing half their value.
func TestADrafterWithNoPositionFamiliesRefusesToStart(t *testing.T) {
	_, err := NewDrafterWithCompleter(&fakeCompleter{}, NewCatalog([]CatalogEntry{
		{ID: "x", Name: "X", Category: "Sweep", Position: "Guard - Bottom"},
	}, nil))
	if err == nil {
		t.Fatal("a drafter with no families started — every tag it produces would have no position")
	}
}

// The tier is the decision this feature rests on, and it is measured: N37 put
// `gpt-5.6-luna` at 0.0% invention and `gpt-5.4-nano` at 24.2% on the same
// corpus and the same prompt. Pinned so a cost-saving default cannot be changed
// without somebody meeting this sentence.
func TestTheDefaultTierIsTheMeasuredOne(t *testing.T) {
	if got := ResolveDraftModel(DefaultDraftProvider, ""); got != "gpt-5.6-luna" {
		t.Errorf("default model = %q, want gpt-5.6-luna — the cheap tier invents a technique in a quarter of cases", got)
	}
	if got := ResolveDraftModel(DefaultDraftProvider, "gpt-5.4-nano"); got != "gpt-5.4-nano" {
		t.Errorf("an explicit override was ignored: %q", got)
	}
}
