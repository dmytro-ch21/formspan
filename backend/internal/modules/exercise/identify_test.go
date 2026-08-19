package exercise

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/llm"
)

// The shortlist is the whole design, so these tests are mostly about what does
// NOT survive validation. An identification feature that cannot be wrong in a
// detectable way is one nobody can trust, and every guard below turns an
// undetectable failure into a detectable one.

func fixtureCatalog() []Exercise {
	return []Exercise{
		{ID: "seated-cable-row", Name: "Seated Cable Row", Equipment: []string{"cable-stack"}, Status: StatusPublished},
		{ID: "lat-pulldown", Name: "Lat Pulldown", Equipment: []string{"cable-stack"}, Status: StatusPublished},
		// Five more cable-stack rows so a cap test can supply MORE THAN
		// MaxCandidates candidates that all SURVIVE the coherence filter.
		// Without them the cap test is vacuous: filtering now runs before the
		// cap, so a mixed-equipment list is cut to two long before the cap
		// could fire. That is exactly what happened to the original cap test
		// when the filter was tightened — it kept passing and stopped meaning
		// anything.
		{ID: "cable-triceps-pushdown", Name: "Cable Triceps Pushdown", Equipment: []string{"cable-stack"}, Status: StatusPublished},
		{ID: "cable-face-pull", Name: "Cable Face Pull", Equipment: []string{"cable-stack"}, Status: StatusPublished},
		{ID: "cable-lateral-raise", Name: "Cable Lateral Raise", Equipment: []string{"cable-stack"}, Status: StatusPublished},
		{ID: "cable-woodchop", Name: "Cable Woodchop", Equipment: []string{"cable-stack"}, Status: StatusPublished},
		{ID: "cable-crossover", Name: "Cable Crossover", Equipment: []string{"cable-stack"}, Status: StatusPublished},
		{ID: "leg-press", Name: "Leg Press", Equipment: []string{"plate-loaded-machine"}, Status: StatusPublished},
		{ID: "chest-press-machine", Name: "Chest Press Machine", Equipment: []string{"selectorized"}, Status: StatusPublished},
		{ID: "treadmill-run", Name: "Treadmill Run", Equipment: []string{"treadmill"}, Status: StatusPublished},
		// Must NOT reach the shortlist: no machine to photograph.
		{ID: "push-up", Name: "Push-Up", Equipment: []string{"bodyweight"}, Status: StatusPublished},
		{ID: "dumbbell-curl", Name: "Dumbbell Curl", Equipment: []string{"dumbbells"}, Status: StatusPublished},
		// Must NOT reach the shortlist: a draft is content the console is still
		// writing, and a candidate an athlete cannot open is a tap that fails.
		{ID: "secret-machine", Name: "Secret Machine", Equipment: []string{"selectorized"}, Status: StatusDraft},
	}
}

func TestShortlistIsMachinesOnlyAndPublishedOnly(t *testing.T) {
	got := Shortlist(fixtureCatalog())

	ids := map[string]bool{}
	for _, e := range got {
		ids[e.ID] = true
	}
	for _, want := range []string{"seated-cable-row", "lat-pulldown", "leg-press", "chest-press-machine", "treadmill-run"} {
		if !ids[want] {
			t.Errorf("%s is machine equipment and published but is not on the shortlist", want)
		}
	}
	// Each exclusion asserted BY NAME rather than by count, so a future
	// equipment change says which row moved rather than that some number did.
	if ids["push-up"] {
		t.Error("bodyweight reached the shortlist — a photo of empty floor now gets a confident answer")
	}
	if ids["dumbbell-curl"] {
		t.Error("dumbbells reached the shortlist — an athlete holding a dumbbell already knows what it is")
	}
	if ids["secret-machine"] {
		t.Error("a DRAFT exercise reached the shortlist — tapping it opens content that is not published")
	}
}

// Sorted, because the shortlist is most of every prompt and a set whose order
// wanders is a different prompt each call, caching nothing.
func TestShortlistIsSorted(t *testing.T) {
	got := Shortlist(fixtureCatalog())
	for i := 1; i < len(got); i++ {
		if got[i-1].ID > got[i].ID {
			t.Fatalf("shortlist is not sorted by id: %q before %q", got[i-1].ID, got[i].ID)
		}
	}
}

// An empty status must read as published, or every seeded row that predates the
// column silently vanishes from the shortlist.
func TestShortlistTreatsAnEmptyStatusAsPublished(t *testing.T) {
	got := Shortlist([]Exercise{
		{ID: "leg-press", Name: "Leg Press", Equipment: []string{"plate-loaded-machine"}},
	})
	if len(got) != 1 {
		t.Fatalf("a row with no status was dropped from the shortlist; got %d rows", len(got))
	}
}

func TestValidateIdentificationDropsIdsThatWereNotOffered(t *testing.T) {
	short := Shortlist(fixtureCatalog())

	got, err := ValidateIdentification(Identification{
		Equipment: "cable-stack",
		Candidates: []Candidate{
			// Real gym equipment, real-sounding id, NOT on the list. This is the
			// model answering from its own knowledge instead of from the
			// shortlist, and it is the failure the closed set exists to catch.
			{ExerciseID: "pec-deck-fly", Confidence: 0.9},
			{ExerciseID: "seated-cable-row", Confidence: 0.7},
		},
	}, short)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Candidates) != 1 || got.Candidates[0].ExerciseID != "seated-cable-row" {
		t.Fatalf("expected the invented id dropped and the real one kept, got %+v", got.Candidates)
	}
}

// Everything invented is the same answer as "I cannot tell", and neither is
// worth retrying.
func TestValidateIdentificationRefusesWhenNothingSurvives(t *testing.T) {
	_, err := ValidateIdentification(Identification{
		Equipment:  "cable-stack",
		Candidates: []Candidate{{ExerciseID: "pec-deck-fly", Confidence: 0.99}},
	}, Shortlist(fixtureCatalog()))
	if !errors.Is(err, ErrIdentifyRefused) {
		t.Fatalf("want ErrIdentifyRefused, got %v", err)
	}
}

func TestValidateIdentificationRefusesAnEmptyAnswer(t *testing.T) {
	_, err := ValidateIdentification(Identification{Equipment: "", Candidates: nil},
		Shortlist(fixtureCatalog()))
	if !errors.Is(err, ErrIdentifyRefused) {
		t.Fatalf("want ErrIdentifyRefused for an empty candidate list, got %v", err)
	}
}

// THE COHERENCE GUARD — the one worth having beyond "is this id real".
//
// N40's lesson was that the dangerous failure is the one nothing flags: its
// invented item was caught three ways while a doubled quantity was caught not at
// all, because nothing downstream could see it. A model reporting "treadmill"
// and returning cable rows is that shape — each half well-formed, the pair
// incoherent, and an id-existence check blind to it.
func TestValidateIdentificationRejectsEquipmentThatContradictsItsOwnCandidates(t *testing.T) {
	_, err := ValidateIdentification(Identification{
		Equipment:  "treadmill",
		Candidates: []Candidate{{ExerciseID: "seated-cable-row", Confidence: 0.95}},
	}, Shortlist(fixtureCatalog()))
	if !errors.Is(err, ErrIdentifyRefused) {
		t.Fatalf("a treadmill that returns a cable row should refuse, got %v", err)
	}
}

func TestValidateIdentificationAcceptsAgreeingEquipment(t *testing.T) {
	got, err := ValidateIdentification(Identification{
		Equipment:  "cable-stack",
		Candidates: []Candidate{{ExerciseID: "lat-pulldown", Confidence: 0.8}},
	}, Shortlist(fixtureCatalog()))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Candidates) != 1 {
		t.Fatalf("want the candidate kept, got %+v", got.Candidates)
	}
}

// The NAME comes from the catalog, never from the response — otherwise a model
// returning a valid id with a wrong label puts text on screen that no other
// part of the app agrees with.
func TestValidateIdentificationTakesTheNameFromTheCatalog(t *testing.T) {
	got, err := ValidateIdentification(Identification{
		Equipment:  "cable-stack",
		Candidates: []Candidate{{ExerciseID: "lat-pulldown", Name: "Pec Deck", Confidence: 0.8}},
	}, Shortlist(fixtureCatalog()))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Candidates[0].Name != "Lat Pulldown" {
		t.Errorf("name came from the model (%q) rather than the catalog", got.Candidates[0].Name)
	}
}

// Structured outputs do not enforce uniqueness across array items, so the same
// id can arrive twice and would render as two taps that do the same thing.
func TestValidateIdentificationDropsDuplicates(t *testing.T) {
	got, err := ValidateIdentification(Identification{
		Equipment: "cable-stack",
		Candidates: []Candidate{
			{ExerciseID: "lat-pulldown", Confidence: 0.8},
			{ExerciseID: "lat-pulldown", Confidence: 0.6},
		},
	}, Shortlist(fixtureCatalog()))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Candidates) != 1 {
		t.Fatalf("want one candidate after dedup, got %d", len(got.Candidates))
	}
}

func TestValidateIdentificationCapsCandidates(t *testing.T) {
	short := Shortlist(fixtureCatalog())
	in := Identification{Equipment: "cable-stack"}
	// SEVEN, all cable-stack, so every one survives the coherence filter and
	// the cap is the only thing that can reduce them. The earlier version of
	// this test listed five exercises of mixed equipment, which the filter now
	// cuts to two on its own — so it passed while exercising nothing.
	for _, id := range []string{
		"lat-pulldown", "seated-cable-row", "cable-triceps-pushdown", "cable-face-pull",
		"cable-lateral-raise", "cable-woodchop", "cable-crossover",
	} {
		in.Candidates = append(in.Candidates, Candidate{ExerciseID: id, Confidence: 0.5})
	}
	got, err := ValidateIdentification(in, short)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Candidates) > MaxCandidates {
		t.Fatalf("returned %d candidates, cap is %d", len(got.Candidates), MaxCandidates)
	}
}

// Advisory, so an out-of-range score is clamped rather than throwing away an
// otherwise good answer over its decorative field.
func TestConfidenceIsClampedNotRejected(t *testing.T) {
	got, err := ValidateIdentification(Identification{
		Equipment: "cable-stack",
		Candidates: []Candidate{
			{ExerciseID: "lat-pulldown", Confidence: 4.2},
			{ExerciseID: "seated-cable-row", Confidence: -1},
		},
	}, Shortlist(fixtureCatalog()))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Candidates[0].Confidence != 1 || got.Candidates[1].Confidence != 0 {
		t.Fatalf("confidence not clamped to 0..1: %+v", got.Candidates)
	}
}

func TestIdentifyInputValidation(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   IdentifyInput
		want string
	}{
		{"no image", IdentifyInput{}, "a photo is required"},
		{"wrong type", IdentifyInput{Image: []byte("x"), ImageMediaType: "application/pdf"}, "not an image type"},
		{"too big", IdentifyInput{Image: make([]byte, MaxIdentifyImageBytes+1), ImageMediaType: "image/jpeg"}, "larger than"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.in.Validate()
			if err == nil {
				t.Fatalf("wanted an error containing %q", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %v does not mention %q", err, tc.want)
			}
			if !errors.Is(err, ErrInvalidInput) {
				t.Errorf("want ErrInvalidInput, got %v", err)
			}
		})
	}
	ok := IdentifyInput{Image: []byte{0xFF, 0xD8}, ImageMediaType: "image/jpeg"}
	if err := ok.Validate(); err != nil {
		t.Fatalf("a valid jpeg was rejected: %v", err)
	}
}

// fakeCompleter records what it was handed and returns canned JSON.
type fakeCompleter struct {
	last llm.Request
	raw  string
	err  error
}

func (f *fakeCompleter) Complete(_ context.Context, req llm.Request) (llm.Response, error) {
	f.last = req
	if f.err != nil {
		return llm.Response{}, f.err
	}
	return llm.Response{Raw: f.raw, Model: "fake-model-1"}, nil
}
func (f *fakeCompleter) Name() string  { return "fake" }
func (f *fakeCompleter) Model() string { return "fake-model" }

func newTestIdentifier(t *testing.T, f *fakeCompleter) Identifier {
	t.Helper()
	i, err := NewIdentifierWithCompleter(f, fixtureCatalog())
	if err != nil {
		t.Fatalf("NewIdentifierWithCompleter: %v", err)
	}
	return i
}

// Everything the feature owns must actually CROSS to the transport. Asserted
// rather than assumed because the equivalent fake in nutrition captured a
// request nothing ever read — so nothing checked that the module handed the
// provider the right anything.
func TestTheRequestCarriesEverythingTheProviderNeeds(t *testing.T) {
	f := &fakeCompleter{raw: `{"equipment":"cable-stack","candidates":[{"exercise_id":"lat-pulldown","confidence":0.9}]}`}
	i := newTestIdentifier(t, f)

	img := []byte{0xFF, 0xD8, 0xFF}
	if _, err := i.Identify(context.Background(), IdentifyInput{Image: img, ImageMediaType: "image/jpeg"}); err != nil {
		t.Fatalf("Identify: %v", err)
	}

	if f.last.System != identifySystemPrompt {
		t.Error("the system prompt did not reach the transport")
	}
	if string(f.last.Image) != string(img) || f.last.ImageMediaType != "image/jpeg" {
		t.Error("the image did not reach the transport — this is a VISION call, so that is the entire input")
	}
	if f.last.SchemaName != "machine_identification" || f.last.Schema == nil {
		t.Error("the schema did not reach the transport, so nothing constrains the response shape")
	}
	if f.last.MaxTokens != identifyMaxTokens {
		t.Errorf("MaxTokens = %d, want %d — this endpoint turns a request directly into money",
			f.last.MaxTokens, identifyMaxTokens)
	}
	// The shortlist IS the prompt. Its absence would silently turn a closed-set
	// question into an open-vocabulary one, which still returns plausible
	// answers — the worst possible way for this to break.
	if !strings.Contains(f.last.Prompt, "lat-pulldown") {
		t.Error("the shortlist did not reach the prompt — the model is answering from an open vocabulary")
	}
	if strings.Contains(f.last.Prompt, "push-up") {
		t.Error("a non-machine exercise reached the prompt")
	}
}

func TestIdentifyTranslatesTransportSentinels(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   error
		want error
	}{
		{"refusal stays a refusal", llm.ErrRefused, ErrIdentifyRefused},
		{"outage is unavailable", llm.ErrUnavailable, ErrIdentifyUnavailable},
		// Total by construction: an unmapped error must not escape as itself,
		// because a raw SDK error carries request ids and prompt fragments and
		// this module's errors reach a client.
		{"anything else is unavailable", errors.New("openai: 500 whatever"), ErrIdentifyUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			i := newTestIdentifier(t, &fakeCompleter{err: tc.in})
			_, err := i.Identify(context.Background(), IdentifyInput{Image: []byte{0xFF, 0xD8}, ImageMediaType: "image/jpeg"})
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

// The detail is kept on the way through, so an operator reading the log can
// tell a genuine refusal from a truncated response. The client sees a fixed
// message either way; only the log carries this.
func TestIdentifyKeepsTheTransportDetailForTheLog(t *testing.T) {
	i := newTestIdentifier(t, &fakeCompleter{err: llm.ErrRefused})
	_, err := i.Identify(context.Background(), IdentifyInput{Image: []byte{0xFF, 0xD8}, ImageMediaType: "image/jpeg"})
	if !strings.Contains(err.Error(), llm.ErrRefused.Error()) {
		t.Errorf("the transport detail was dropped: %v", err)
	}
}

func TestIdentifyRejectsAnEmptyOrUnreadableResponse(t *testing.T) {
	for _, raw := range []string{"", "   ", "{not json"} {
		i := newTestIdentifier(t, &fakeCompleter{raw: raw})
		_, err := i.Identify(context.Background(), IdentifyInput{Image: []byte{0xFF, 0xD8}, ImageMediaType: "image/jpeg"})
		if !errors.Is(err, ErrIdentifyUnavailable) {
			t.Errorf("raw %q: want ErrIdentifyUnavailable, got %v", raw, err)
		}
	}
}

func TestIdentifyReportsTheModelTheProviderUsed(t *testing.T) {
	f := &fakeCompleter{raw: `{"equipment":"cable-stack","candidates":[{"exercise_id":"lat-pulldown","confidence":0.9}]}`}
	i := newTestIdentifier(t, f)
	got, err := i.Identify(context.Background(), IdentifyInput{Image: []byte{0xFF, 0xD8}, ImageMediaType: "image/jpeg"})
	if err != nil {
		t.Fatalf("Identify: %v", err)
	}
	// What the provider REPORTS, not what was configured — an alias resolves to
	// a dated snapshot, so the two differ routinely.
	if got.Model != "fake-model-1" {
		t.Errorf("Model = %q, want the reported one", got.Model)
	}
}

// The schema must be one both providers accept: every object closed, every
// property required. A schema that satisfies only one backend fails at the
// other rather than here, on a call that costs money.
func TestIdentifySchemaIsStrictEverywhere(t *testing.T) {
	var walk func(m map[string]any, path string)
	walk = func(m map[string]any, path string) {
		if m["type"] == "object" {
			if m["additionalProperties"] != false {
				t.Errorf("%s: additionalProperties is not false", path)
			}
			props, _ := m["properties"].(map[string]any)
			req, _ := m["required"].([]string)
			if len(props) != len(req) {
				t.Errorf("%s: %d properties but %d required — both providers demand every property listed",
					path, len(props), len(req))
			}
			for k, v := range props {
				if sub, ok := v.(map[string]any); ok {
					walk(sub, path+"."+k)
				}
			}
		}
		if items, ok := m["items"].(map[string]any); ok {
			walk(items, path+"[]")
		}
	}
	walk(IdentifySchema(), "root")

	// Serialisable, since it goes over the wire as JSON.
	if _, err := json.Marshal(IdentifySchema()); err != nil {
		t.Fatalf("schema does not marshal: %v", err)
	}
}

// The real catalog must produce a usable shortlist. A fixture proves the filter
// works; only this proves the filter matches the content that ships.
func TestTheRealCatalogYieldsAShortlist(t *testing.T) {
	all, err := SeedData()
	if err != nil {
		t.Fatalf("seed data: %v", err)
	}
	got := Shortlist(all)
	if len(got) < 50 {
		t.Fatalf("only %d machine exercises in the real catalog — the equipment filter has drifted "+
			"from the vocabulary, and every photo will come back 'could not tell'", len(got))
	}
	for _, e := range got {
		machine := false
		for _, q := range e.Equipment {
			if IsMachineEquipment(q) {
				machine = true
				break
			}
		}
		if !machine {
			t.Errorf("%s reached the shortlist with equipment %v", e.ID, e.Equipment)
		}
	}
}

// Every name in MachineEquipment must exist in the real catalog.
//
// A typo here is invisible and expensive: it silently narrows the shortlist,
// every photo of that machine comes back "could not tell", and nothing fails.
func TestEveryMachineEquipmentNameIsRealVocabulary(t *testing.T) {
	all, err := SeedData()
	if err != nil {
		t.Fatalf("seed data: %v", err)
	}
	known := map[string]bool{}
	for _, e := range all {
		for _, q := range e.Equipment {
			known[q] = true
		}
	}
	for _, m := range MachineEquipment {
		if !known[m] {
			t.Errorf("%q is in MachineEquipment but no catalog row uses it — a typo here "+
				"silently removes a whole machine family from the shortlist", m)
		}
	}
}

// The three below cover what review found in #321, and none of the original
// tests reached any of them. Each was a path the first version had, not a new
// feature — which is the more useful kind of gap to record.

// **Candidates with no equipment named is incoherent**, and the first version
// let it straight through: the guard only ran when `equipment != ""`.
//
// That made a PUBLISHED sentence false — the contract said `equipment` is
// "guaranteed to be used by at least one candidate" — on a path the schema
// actively invites, since the field's own description offers "" for none.
func TestValidateIdentificationRefusesCandidatesWithNoEquipmentNamed(t *testing.T) {
	_, err := ValidateIdentification(Identification{
		Equipment:  "",
		Candidates: []Candidate{{ExerciseID: "lat-pulldown", Confidence: 0.9}},
	}, Shortlist(fixtureCatalog()))
	if !errors.Is(err, ErrIdentifyRefused) {
		t.Fatalf("candidates with no equipment named is a contradiction; want a refusal, got %v", err)
	}
	// The MESSAGE is asserted, not just the refusal, and that is deliberate.
	// Mutation-testing showed the outcome alone does not pin this branch:
	// delete the empty check and the coherence filter refuses anyway, because
	// no real equipment string equals "". So the branch is only observable
	// through what it says — and it exists to say the accurate thing, since
	// "every candidate is other equipment" would be a misleading description
	// of a response that named no equipment at all.
	if !strings.Contains(err.Error(), "no equipment named") {
		t.Errorf("refused for the wrong stated reason: %v", err)
	}
}

// EVERY candidate must use the reported equipment, not merely one.
//
// The first version asked whether ANY agreed, so a treadmill answer could carry
// cable-machine candidates through on the strength of one that matched. A guard
// looser than the prompt it enforces cannot detect that prompt being ignored,
// which is the only thing it is for.
func TestValidateIdentificationDropsCandidatesThatUseOtherEquipment(t *testing.T) {
	got, err := ValidateIdentification(Identification{
		Equipment: "cable-stack",
		Candidates: []Candidate{
			{ExerciseID: "lat-pulldown", Confidence: 0.9},  // cable-stack
			{ExerciseID: "leg-press", Confidence: 0.8},     // plate-loaded-machine
			{ExerciseID: "treadmill-run", Confidence: 0.7}, // treadmill
		},
	}, Shortlist(fixtureCatalog()))
	if err != nil {
		t.Fatalf("a mostly-coherent answer should survive with the good candidates: %v", err)
	}
	if len(got.Candidates) != 1 || got.Candidates[0].ExerciseID != "lat-pulldown" {
		t.Fatalf("want only the cable-stack candidate, got %+v", got.Candidates)
	}
	// Every survivor uses the reported equipment — the property the contract
	// now states, asserted rather than assumed.
	for _, c := range got.Candidates {
		uses := false
		for _, e := range Shortlist(fixtureCatalog()) {
			if e.ID != c.ExerciseID {
				continue
			}
			for _, q := range e.Equipment {
				if q == got.Equipment {
					uses = true
				}
			}
		}
		if !uses {
			t.Errorf("%s survived but does not use %q", c.ExerciseID, got.Equipment)
		}
	}
}

// The cap is applied AFTER the coherence filter.
//
// Capping first discards by RANK what the filter then removes by CORRECTNESS,
// so a good fifth candidate is lost while four incoherent ones ahead of it are
// dropped anyway — leaving the athlete fewer answers than the model got right.
func TestValidateIdentificationCapsAfterFilteringNotBefore(t *testing.T) {
	got, err := ValidateIdentification(Identification{
		Equipment: "cable-stack",
		Candidates: []Candidate{
			{ExerciseID: "leg-press", Confidence: 0.9},           // wrong equipment
			{ExerciseID: "chest-press-machine", Confidence: 0.8}, // wrong equipment
			{ExerciseID: "treadmill-run", Confidence: 0.7},       // wrong equipment
			{ExerciseID: "seated-cable-row", Confidence: 0.6},    // right, 4th
			{ExerciseID: "lat-pulldown", Confidence: 0.5},        // right, 5th — past the cap
		},
	}, Shortlist(fixtureCatalog()))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Candidates) != 2 {
		t.Fatalf("both coherent candidates should survive, including the one ranked past the cap; got %+v",
			got.Candidates)
	}
}
