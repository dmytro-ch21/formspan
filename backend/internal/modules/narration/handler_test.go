package narration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// fakeNarrator stands in for the model and counts calls. The count is the
// assertion that matters: this endpoint spends money, so "the gate runs first"
// is only true if a refusal means the model was never reached.
type fakeNarrator struct {
	out    []Sentence
	meta   CallMeta
	err    error
	calls  int
	onCall func()
}

func (f *fakeNarrator) Narrate(_ context.Context, _ Input) ([]Sentence, CallMeta, error) {
	f.calls++
	if f.onCall != nil {
		f.onCall()
	}
	return f.out, f.meta, f.err
}

// memUsage is an in-memory meter that counts per user, so a cross-athlete leak
// shows as a wrong count rather than needing a database.
type memUsage struct {
	rows       []Record
	askedFor   []string
	exhausted  *time.Time // when set, the caller's quota is used up, oldest call at this time
	lastCtxErr error
}

func (m *memUsage) Quota(_ context.Context, userID string, _ time.Time) (Quota, error) {
	m.askedFor = append(m.askedFor, userID)
	if m.exhausted != nil {
		return NewQuota(DailyNarrations, m.exhausted), nil
	}
	n := 0
	for _, r := range m.rows {
		if r.UserID == userID {
			n++
		}
	}
	return NewQuota(n, nil), nil
}

func (m *memUsage) Record(ctx context.Context, rec Record) error {
	m.lastCtxErr = ctx.Err()
	m.rows = append(m.rows, rec)
	return nil
}

var fixedNow = time.Date(2026, 9, 12, 12, 0, 0, 0, time.UTC)

const goodBody = `{"facts":[` +
	`{"key":"food-eaten:2026-09-12","kind":"food-eaten","label":"Eaten today: 1,840 kcal across 3 entries","numbers":["1840","3"],"names":[]},` +
	`{"key":"logged:s9","kind":"logged","label":"5x5 Day logged","numbers":[],"names":["5x5 Day"]}]}`

func newTestHandler(n Narrator, u UsageRepository) *Handler {
	h := NewHandler(n, u)
	h.now = func() time.Time { return fixedNow }
	return h
}

func call(t *testing.T, h *Handler, body string, ctx context.Context) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/v1/day/narration", strings.NewReader(body)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Narrate(w, r)
	return w
}

func signedIn(user string) context.Context {
	return auth.ContextWithClaims(context.Background(), &auth.Claims{UserID: user})
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body: %v: %s", err, w.Body.String())
	}
	return body.Error.Code
}

func TestNarrateRequiresSignIn(t *testing.T) {
	n, u := &fakeNarrator{}, &memUsage{}
	w := call(t, newTestHandler(n, u), goodBody, context.Background())
	if w.Code != http.StatusUnauthorized || n.calls != 0 || len(u.rows) != 0 {
		t.Fatalf("code=%d calls=%d rows=%d", w.Code, n.calls, len(u.rows))
	}
}

func TestNarrateIs503WhenNoProviderIsConfigured(t *testing.T) {
	u := &memUsage{}
	w := call(t, newTestHandler(nil, u), goodBody, signedIn("grappler"))
	if w.Code != http.StatusServiceUnavailable || len(u.rows) != 0 {
		t.Fatalf("code=%d rows=%d", w.Code, len(u.rows))
	}
}

func TestNarrateRefusesBadInputBeforeTheQuotaOrTheModel(t *testing.T) {
	cases := map[string]string{
		"malformed JSON":                     `{"facts":`,
		"no facts":                           `{"facts":[]}`,
		"an unknown kind":                    `{"facts":[{"key":"k","kind":"horoscope","label":"l","numbers":[],"names":[]}]}`,
		"a label stating an unbacked number": `{"facts":[{"key":"k","kind":"food-eaten","label":"9 kcal","numbers":[],"names":[]}]}`,
		// Cross-athlete: the body cannot choose whose quota or meter it hits.
		"a user_id in the body": `{"user_id":"victim",` + goodBody[1:],
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			n, u := &fakeNarrator{}, &memUsage{}
			w := call(t, newTestHandler(n, u), body, signedIn("grappler"))
			if w.Code != http.StatusBadRequest || errorCode(t, w) != "invalid_input" {
				t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
			}
			if n.calls != 0 || len(u.askedFor) != 0 || len(u.rows) != 0 {
				t.Fatalf("a request that cannot succeed must cost nothing: calls=%d asked=%v rows=%d", n.calls, u.askedFor, len(u.rows))
			}
		})
	}
}

func TestNarrateChecksTheQuotaBeforeTheModel(t *testing.T) {
	oldest := fixedNow.Add(-time.Hour)
	n, u := &fakeNarrator{}, &memUsage{exhausted: &oldest}
	w := call(t, newTestHandler(n, u), goodBody, signedIn("grappler"))
	if w.Code != http.StatusTooManyRequests || errorCode(t, w) != "rate_limited" {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Retry-After"); got != "82800" {
		t.Fatalf("Retry-After=%q, want 82800 (23h)", got)
	}
	if n.calls != 0 || len(u.rows) != 0 {
		t.Fatalf("calls=%d rows=%d", n.calls, len(u.rows))
	}
}

// The exact-hour case above cannot tell rounding up from rounding down: both give
// 82800. The contract promises the wait is rounded UP, so waiting exactly that
// long succeeds. Half a second short of 23 hours must still say 82800. Raised in review.
// The field caps count RUNES, so the largest legitimate request is non-ASCII: 60
// facts, each at every cap, in 4-byte characters. It must reach validation and the
// narrator, not a 413 from the body limit. Raised in review; 64KB failed it.
func TestNarrateAcceptsTheLargestLegitimateRequest(t *testing.T) {
	drop := "\U0001F4A7" // 4 bytes in UTF-8
	name := strings.Repeat(drop, MaxNameRunes)
	in := Input{}
	for i := 0; i < MaxFacts; i++ {
		key := fmt.Sprintf("tracker:%03d", i)
		key += strings.Repeat(drop, MaxKeyRunes-len(key))
		in.Facts = append(in.Facts, Fact{
			Key: key, Kind: "tracker",
			Label: strings.Repeat(drop, MaxLabelRunes),
			Names: []string{name, name, name, name},
		})
	}
	if err := in.Validate(); err != nil {
		t.Fatalf("the fixture must be a legitimate request: %v", err)
	}
	body, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) <= 64<<10 {
		t.Fatalf("fixture is %d bytes; it must exceed the old 64KB limit to test anything", len(body))
	}
	n := &fakeNarrator{out: []Sentence{}}
	w := call(t, newTestHandler(n, &memUsage{}), string(body), signedIn("grappler"))
	if w.Code != http.StatusOK || n.calls != 1 {
		t.Fatalf("a %d-byte legitimate request got code=%d calls=%d", len(body), w.Code, n.calls)
	}
}

func TestNarrateRoundsRetryAfterUp(t *testing.T) {
	oldest := fixedNow.Add(-time.Hour - 500*time.Millisecond)
	w := call(t, newTestHandler(&fakeNarrator{}, &memUsage{exhausted: &oldest}), goodBody, signedIn("grappler"))
	if got := w.Header().Get("Retry-After"); got != "82800" {
		t.Fatalf("Retry-After=%q, want 82800 (82799.5s rounded up)", got)
	}
}

func TestNarrateReturnsOnlyWhatTheServerGuardKeeps(t *testing.T) {
	n := &fakeNarrator{
		out: []Sentence{
			{Text: "1,840 kcal eaten today.", Cites: []string{"food-eaten:2026-09-12"}},
			{Text: "5x5 Day logged.", Cites: []string{"logged:s9"}},
			{Text: "That leaves 860 kcal for dinner.", Cites: []string{"food-eaten:2026-09-12"}},
		},
		meta: CallMeta{Model: "gpt-x", Usage: Usage{InputTokens: 400, OutputTokens: 30}},
	}
	u := &memUsage{}
	w := call(t, newTestHandler(n, u), goodBody, signedIn("grappler"))
	if w.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
	var resp narrationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Narration.Sentences) != 2 || resp.Narration.Dropped != 1 {
		t.Fatalf("narration=%+v", resp.Narration)
	}
	if strings.Contains(w.Body.String(), "860") {
		t.Fatal("the invented sentence reached the response")
	}
	if len(u.rows) != 1 || !u.rows[0].Succeeded || u.rows[0].SentencesKept != 2 || u.rows[0].Usage.InputTokens != 400 || u.rows[0].Model != "gpt-x" {
		t.Fatalf("record=%+v", u.rows)
	}
	if resp.Quota.Used != 1 || resp.Quota.Remaining != DailyNarrations-1 {
		t.Fatalf("quota=%+v", resp.Quota)
	}
}

func TestNarrateReturnsAtMostMaxSentences(t *testing.T) {
	honest := Sentence{Text: "1,840 kcal eaten today.", Cites: []string{"food-eaten:2026-09-12"}}
	n := &fakeNarrator{out: []Sentence{honest, honest, honest, honest, honest}}
	w := call(t, newTestHandler(n, &memUsage{}), goodBody, signedIn("grappler"))
	var resp narrationResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Narration.Sentences) != MaxSentences {
		t.Fatalf("got %d sentences", len(resp.Narration.Sentences))
	}
}

func TestNarrateDoesNotMeterAnOutage(t *testing.T) {
	n := &fakeNarrator{err: ErrNarrationUnreachable}
	u := &memUsage{}
	w := call(t, newTestHandler(n, u), goodBody, signedIn("grappler"))
	if w.Code != http.StatusServiceUnavailable || errorCode(t, w) != "unavailable" || len(u.rows) != 0 {
		t.Fatalf("code=%d rows=%d body=%s", w.Code, len(u.rows), w.Body.String())
	}
}

func TestNarrateMetersARefusalWithItsTokens(t *testing.T) {
	n := &fakeNarrator{err: errors.Join(ErrNarrationRefused), meta: CallMeta{Model: "gpt-x", Usage: Usage{InputTokens: 900, OutputTokens: 40}}}
	u := &memUsage{}
	w := call(t, newTestHandler(n, u), goodBody, signedIn("grappler"))
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code=%d", w.Code)
	}
	if len(u.rows) != 1 || u.rows[0].Succeeded || u.rows[0].Usage.InputTokens != 900 {
		t.Fatalf("a refusal is billed and must be metered with its tokens: %+v", u.rows)
	}
}

func TestNarrateMetersEvenWhenTheClientDisconnects(t *testing.T) {
	ctx, cancel := context.WithCancel(signedIn("grappler"))
	n := &fakeNarrator{onCall: cancel, out: []Sentence{}}
	u := &memUsage{}
	call(t, newTestHandler(n, u), goodBody, ctx)
	if len(u.rows) != 1 || u.lastCtxErr != nil {
		t.Fatalf("rows=%d ctxErr=%v: a disconnect must not escape the meter", len(u.rows), u.lastCtxErr)
	}
}

// Cross-athlete: another athlete's spending does not count against this one,
// and this one's call is metered and quota-checked under the token's user only.
func TestNarrateMetersAndChecksOnlyTheCaller(t *testing.T) {
	u := &memUsage{}
	for i := 0; i < DailyNarrations; i++ {
		u.rows = append(u.rows, Record{UserID: "victim", Succeeded: true})
	}
	n := &fakeNarrator{out: []Sentence{}}
	w := call(t, newTestHandler(n, u), goodBody, signedIn("grappler"))
	if w.Code != http.StatusOK {
		t.Fatalf("the victim's used-up quota must not block the grappler: code=%d", w.Code)
	}
	for _, who := range u.askedFor {
		if who != "grappler" {
			t.Fatalf("quota read for %q", who)
		}
	}
	if last := u.rows[len(u.rows)-1]; last.UserID != "grappler" {
		t.Fatalf("metered under %q", last.UserID)
	}
}
