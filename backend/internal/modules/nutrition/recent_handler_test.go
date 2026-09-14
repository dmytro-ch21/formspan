package nutrition

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/llm"
)

// N194 — the handler: what is charged, what is read, and what the model sees.

// memEntries hands back EVERYTHING it holds, whoever asks and for whatever
// dates. Deliberately: a fake that filtered by user and window would supply
// the very behaviour the resolver is supposed to guarantee, and a test built
// on it could not see that guarantee go missing.
type memEntries struct {
	entries []Entry
	asked   []string
	err     error
	events  *[]string
}

func (m *memEntries) ListEntries(_ context.Context, userID, from, to string, limit int) ([]Entry, error) {
	m.asked = append(m.asked, fmt.Sprintf("%s|%s|%s|%d", userID, from, to, limit))
	if m.events != nil {
		*m.events = append(*m.events, "read the log")
	}
	if m.err != nil {
		return nil, m.err
	}
	return m.entries, nil
}

// recentNow is a Monday afternoon in UTC, so "2026-09-14" is a plausible today.
var recentNow = time.Date(2026, 9, 14, 15, 0, 0, 0, time.UTC)

func recentHandler(est Estimator, usage *memUsage, entries RecentEntryReader) *EstimateHandler {
	h := NewEstimateHandler(est, usage, nil, entries)
	h.now = func() time.Time { return recentNow }
	return h
}

func decodeEstimate(t *testing.T, body []byte) estimateResponse {
	t.Helper()
	var got estimateResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v: %s", err, body)
	}
	return got
}

func breakfastYesterday() *memEntries {
	return &memEntries{entries: []Entry{logged("e1", "2026-09-13", MealBreakfast, "Oatmeal", 300)}}
}

// Decision 6, first half: resolved without a model call, NOT charged — the same
// before-the-gate ordering N114's reuse has.
func TestAPlainPointerIsResolvedWithoutTheModelAndCostsNothing(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	usage := &memUsage{}
	h := recentHandler(est, usage, breakfastYesterday())

	w := call(t, h, `{"description":"yesterday's breakfast again","meal":"breakfast","today":"2026-09-14"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	got := decodeEstimate(t, w.Body.Bytes())

	if est.calls != 0 {
		t.Fatalf("the model was called %d times for a pointer the words made plain", est.calls)
	}
	if len(usage.rows) != 0 {
		t.Fatalf("%d usage rows written for a lookup that spent nothing", len(usage.rows))
	}
	if got.Quota.Remaining != DailyEstimates {
		t.Fatalf("remaining = %d, want %d — the allowance moved", got.Quota.Remaining, DailyEstimates)
	}
	r := got.Estimate.Recent
	if r == nil || r.RecognizedBy != RecognizedByPhrase {
		t.Fatalf("no phrase resolution in the response: %s", w.Body.String())
	}
	if len(r.Candidates) != 1 || r.Candidates[0].Items[0].Name != "Oatmeal" {
		t.Fatalf("candidates %s, want yesterday's oatmeal", asJSON(r.Candidates))
	}
	if len(got.Estimate.Items) != 0 || got.Estimate.Model != "" {
		t.Fatalf("a resolved pointer carries items %d / model %q — the drafts live in the candidates", len(got.Estimate.Items), got.Estimate.Model)
	}
}

func TestAPlainPointerIsAnsweredEvenAtTheCap(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	usage := &memUsage{quotaFn: func() Quota { return NewQuota(DailyEstimates, nil) }}
	h := recentHandler(est, usage, breakfastYesterday())

	w := call(t, h, `{"description":"the same as yesterday","today":"2026-09-14"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d at the cap — a lookup spends nothing and must not be refused: %s", w.Code, w.Body.String())
	}
	if est.calls != 0 {
		t.Fatal("the model was called at the cap")
	}
}

// Decision 6, second half: a pointer the MODEL had to read is charged exactly
// as any estimate is.
func TestAPointerTheModelHadToReadIsChargedLikeAnyEstimate(t *testing.T) {
	est := &fakeEstimator{
		out: Estimate{Items: []EstimatedItem{}, Model: "gpt-5.6-luna", reference: &RecentReference{
			Day: DayUnstated, FoodWords: []string{"oatmeal"},
		}},
		meta: CallMeta{Model: "gpt-5.6-luna", Usage: Usage{InputTokens: 1400, OutputTokens: 90}},
	}
	usage := &memUsage{}
	h := recentHandler(est, usage, breakfastYesterday())

	// No marker word, so the grammar declines and the model has to read it.
	w := call(t, h, `{"description":"that oatmeal thing from the other morning","today":"2026-09-14"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if est.calls != 1 {
		t.Fatalf("model calls = %d, want 1", est.calls)
	}
	if !est.lastIn.ReferencesAllowed() {
		t.Fatal("the model was not allowed to recognise a reference")
	}
	if len(usage.rows) != 1 || !usage.rows[0].Succeeded || usage.rows[0].Usage.InputTokens != 1400 {
		t.Fatalf("usage rows %+v, want one metered success", usage.rows)
	}
	got := decodeEstimate(t, w.Body.Bytes())
	if got.Quota.Remaining != DailyEstimates-1 {
		t.Fatalf("remaining = %d, want %d", got.Quota.Remaining, DailyEstimates-1)
	}
	if r := got.Estimate.Recent; r == nil || r.RecognizedBy != RecognizedByModel || len(r.Candidates) != 1 {
		t.Fatalf("recent = %s, want one model-recognised candidate", asJSON(got.Estimate.Recent))
	}
	if got.Estimate.Model != "gpt-5.6-luna" {
		t.Fatalf("model = %q — a model WAS called, and the response must say which", got.Estimate.Model)
	}
}

// recordingCompleter notes WHEN the provider is called, relative to the log
// being read.
type recordingCompleter struct {
	*fakeCompleter
	events *[]string
}

func (c *recordingCompleter) Complete(ctx context.Context, req llm.Request) (llm.Response, error) {
	*c.events = append(*c.events, "call the model")
	return c.fakeCompleter.Complete(ctx, req)
}

// Decision 2, asserted on the request ACTUALLY BUILT: nothing from the log —
// no name, amount, label, note or id — is in what the provider receives.
func TestTheModelRequestCarriesNothingFromTheLog(t *testing.T) {
	var events []string
	sodium := 921.0
	food := "99999999-9999-4999-8999-999999999999"
	secret := Entry{
		ID: "77777777-7777-4777-8777-777777777777", UserID: "eater",
		EatenOn: "2026-09-12", Meal: MealBreakfast, Name: "Zanzibar Toasted Granola",
		Servings: 1.75, ServingLabel: "1 heaped bowl", SourceFoodID: &food,
		Notes:  "ate it at my desk before sparring",
		Macros: Macros{Kcal: 437.5, ProteinG: 13.25, CarbG: 61.5, FatG: 15.75, SodiumMG: &sodium},
	}
	entries := &memEntries{entries: []Entry{secret}, events: &events}

	f := &fakeCompleter{model: "m", raw: `{"items":[],"note":"","meal_name":"","reference":{` +
		`"refers_to_logged_food":true,"day":"unstated","days_ago":0,"weekday":"none",` +
		`"month_day":"","meal":"unstated","food_words":["granola"]}}`}
	h := recentHandler(&estimator{c: &recordingCompleter{fakeCompleter: f, events: &events}}, &memUsage{}, entries)

	w := call(t, h, `{"description":"that granola I keep having before training","meal":"breakfast","today":"2026-09-14"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}

	// Positive controls first: the log WAS available to the server, and the
	// request is one this test can see content in. Without both, the absence
	// assertions below would pass against a handler that never read anything.
	got := decodeEstimate(t, w.Body.Bytes())
	if r := got.Estimate.Recent; r == nil || len(r.Candidates) != 1 || r.Candidates[0].Items[0].Name != secret.Name {
		t.Fatalf("the log did not resolve, so this test cannot say anything: %s", w.Body.String())
	}
	sent, err := json.Marshal(struct {
		System, Prompt, SchemaName string
		Schema                     map[string]any
		Image                      []byte
	}{f.last.System, f.last.Prompt, f.last.SchemaName, f.last.Schema, f.last.Image})
	if err != nil {
		t.Fatalf("marshal the request: %v", err)
	}
	if !strings.Contains(string(sent), "granola I keep having") {
		t.Fatalf("the athlete's own words are not in the request, so an absence below proves nothing: %s", sent)
	}
	if _, asked := f.last.Schema["properties"].(map[string]any)["reference"]; !asked {
		t.Fatal("the reference question was not asked")
	}

	for _, leak := range []string{
		"Zanzibar", "Toasted", "heaped bowl", "437", "13.25", "61.5", "15.75", "921", "1.75",
		"at my desk", "sparring", "99999999", "77777777", "2026-09-12", "2026-09-14",
	} {
		if strings.Contains(string(sent), leak) {
			t.Errorf("the model request carries %q from the log or the date: %s", leak, sent)
		}
	}
	// And structurally: the model was answered before the log was opened.
	if !reflect.DeepEqual(events, []string{"call the model", "read the log"}) {
		t.Fatalf("order was %v — the log must be read only after the model has answered", events)
	}
}

func TestWithoutADateNothingIsReadAsAPointer(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	entries := breakfastYesterday()
	h := recentHandler(est, &memUsage{}, entries)

	call(t, h, `{"description":"the same as yesterday"}`)
	if len(entries.asked) != 0 {
		t.Fatalf("the log was read with no date to bound it: %v", entries.asked)
	}
	if est.calls != 1 || est.lastIn.ReferencesAllowed() {
		t.Fatalf("calls=%d allowed=%v — a client that sends no date gets exactly the old behaviour", est.calls, est.lastIn.ReferencesAllowed())
	}
}

func TestRecentFalseIsTheEscapeHatch(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	entries := breakfastYesterday()
	h := recentHandler(est, &memUsage{}, entries)

	w := call(t, h, `{"description":"the same as yesterday","today":"2026-09-14","recent":false}`)
	if w.Code != http.StatusOK || len(entries.asked) != 0 || est.calls != 1 || est.lastIn.ReferencesAllowed() {
		t.Fatalf("status=%d asked=%v calls=%d — `recent:false` must estimate the words as a new meal", w.Code, entries.asked, est.calls)
	}
}

func TestAnImplausibleTodayTurnsTheFeatureOffNotTheEndpoint(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	entries := breakfastYesterday()
	h := recentHandler(est, &memUsage{}, entries)

	w := call(t, h, `{"description":"the same as yesterday","today":"2025-09-14"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d — a wrong clock must not cost the athlete the endpoint", w.Code)
	}
	if len(entries.asked) != 0 || est.lastIn.ReferencesAllowed() {
		t.Fatalf("a date a year back was honoured: asked=%v", entries.asked)
	}
}

func TestAMalformedTodayIsRefusedBeforeAnythingIsSpent(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	h := recentHandler(est, &memUsage{}, breakfastYesterday())
	w := call(t, h, `{"description":"two eggs","today":"yesterday"}`)
	if w.Code != http.StatusBadRequest || est.calls != 0 {
		t.Fatalf("status %d, calls %d — want 400 and no model call", w.Code, est.calls)
	}
	if code := decodeError(t, w.Body.Bytes()).Error.Code; code != "invalid_input" {
		t.Fatalf("code %q", code)
	}
}

// The authorization property at the handler: the log is read for the TOKEN'S
// athlete, over exactly the window — and a stranger's row that a broken reader
// hands back anyway still does not resolve.
func TestTheLogIsReadForTheCallerOnlyAndOnlyOverTheWindow(t *testing.T) {
	stranger := logged("s1", "2026-09-13", MealBreakfast, "Oatmeal", 300)
	stranger.UserID = "stranger"
	entries := &memEntries{entries: []Entry{stranger}}
	h := recentHandler(&fakeEstimator{out: goodEstimate()}, &memUsage{}, entries)

	w := callAs(t, h, "eater", `{"description":"yesterday's breakfast again","today":"2026-09-14"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if want := []string{"eater|2026-09-01|2026-09-14|500"}; !reflect.DeepEqual(entries.asked, want) {
		t.Fatalf("asked %v, want %v", entries.asked, want)
	}
	if r := decodeEstimate(t, w.Body.Bytes()).Estimate.Recent; r == nil || len(r.Candidates) != 0 {
		t.Fatalf("another athlete's breakfast resolved: %s", w.Body.String())
	}
}

// "Nothing matched" is a claim. A lookup that failed cannot make it.
func TestAFailedLogReadIsAnErrorNotNothingMatched(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	usage := &memUsage{}
	entries := &memEntries{err: errors.New("pool exhausted: FATAL too many connections for role vola")}
	h := recentHandler(est, usage, entries)

	w := call(t, h, `{"description":"the same as yesterday","today":"2026-09-14"}`)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500: %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "pool") || strings.Contains(w.Body.String(), "vola") {
		t.Fatalf("the database error reached the client: %s", w.Body.String())
	}
	if est.calls != 0 || len(usage.rows) != 0 {
		t.Fatalf("calls=%d rows=%d — a failed free lookup must not fall through to a paid one", est.calls, len(usage.rows))
	}
}

func TestWithNoReaderWiredTheModelIsNotAskedAboutPointers(t *testing.T) {
	est := &fakeEstimator{out: goodEstimate()}
	h := NewEstimateHandler(est, &memUsage{}, nil, nil)
	h.now = func() time.Time { return recentNow }

	w := call(t, h, `{"description":"the same as yesterday","today":"2026-09-14"}`)
	if w.Code != http.StatusOK || est.calls != 1 || est.lastIn.ReferencesAllowed() {
		t.Fatalf("status=%d calls=%d allowed=%v — nothing could resolve the answer, so the question must not be asked",
			w.Code, est.calls, est.lastIn.ReferencesAllowed())
	}
}

// ------------------------------------------------------------ the estimator

func TestOnlyAReferenceRequestAsksTheQuestion(t *testing.T) {
	f := &fakeCompleter{raw: goodRaw, model: "m"}
	e := &estimator{c: f}

	if _, _, err := e.Estimate(context.Background(), EstimateInput{Description: "two eggs"}); err != nil {
		t.Fatalf("estimate: %v", err)
	}
	if !reflect.DeepEqual(f.last.Schema, EstimateSchema()) || f.last.System != estimateSystemPrompt {
		t.Fatal("a request that cannot be a reference was not sent exactly the pre-N194 schema and prompt")
	}

	if _, _, err := e.Estimate(context.Background(), EstimateInput{
		Description: "two eggs", Today: "2026-09-14", ResolveRecent: true,
	}); err != nil {
		t.Fatalf("estimate: %v", err)
	}
	if _, ok := f.last.Schema["properties"].(map[string]any)["reference"]; !ok {
		t.Fatal("a reference request's schema has no `reference`")
	}
	if !strings.HasSuffix(f.last.System, referenceSystemPrompt) {
		t.Fatal("a reference request's system prompt lacks the reference section")
	}
	// Minimal data: the date is the server's to use, not the provider's.
	if strings.Contains(f.last.Prompt, "2026") {
		t.Fatalf("the athlete's date reached the provider: %q", f.last.Prompt)
	}
}

func TestAReferenceIsReturnedWithoutItemsAndIsNotARefusal(t *testing.T) {
	raw := `{"items":[],"note":"","meal_name":"","reference":{"refers_to_logged_food":true,"day":"yesterday",` +
		`"days_ago":0,"weekday":"none","month_day":"","meal":"lunch","food_words":[]}}`
	in := EstimateInput{Description: "same lunch as yesterday", Today: "2026-09-14", ResolveRecent: true}

	out, _, err := (&estimator{c: &fakeCompleter{raw: raw, model: "m"}}).Estimate(context.Background(), in)
	if err != nil {
		t.Fatalf("a reference was treated as a failure: %v", err)
	}
	if out.reference == nil || out.reference.Day != DayYesterday || *out.reference.Meal != MealLunch || len(out.Items) != 0 {
		t.Fatalf("got items=%d reference=%s", len(out.Items), asJSON(out.reference))
	}

	// The same answer to a request that did NOT ask is not honoured: its empty
	// items are refused exactly as they always were.
	in.Today = ""
	if _, _, err := (&estimator{c: &fakeCompleter{raw: raw, model: "m"}}).Estimate(context.Background(), in); !errors.Is(err, ErrEstimateRefused) {
		t.Fatalf("an unasked-for reference was honoured: %v", err)
	}
}

func TestADescriptionTheModelSaysIsNotAPointerIsAnOrdinaryEstimate(t *testing.T) {
	raw := strings.Replace(goodRaw, `"note":""}`, `"note":"","meal_name":"","reference":{"refers_to_logged_food":false,`+
		`"day":"unstated","days_ago":0,"weekday":"none","month_day":"","meal":"unstated","food_words":[]}}`, 1)
	out, _, err := (&estimator{c: &fakeCompleter{raw: raw, model: "m"}}).Estimate(context.Background(),
		EstimateInput{Description: "two eggs", Today: "2026-09-14", ResolveRecent: true})
	if err != nil {
		t.Fatalf("estimate: %v", err)
	}
	if out.reference != nil || len(out.Items) != 1 {
		t.Fatalf("reference=%v items=%d", out.reference, len(out.Items))
	}
}
