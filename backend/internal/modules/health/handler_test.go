package health

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/auth"
)

// The batch form, and the single form it must not break.
//
// Both shapes stay supported on purpose: a client that reports its own trouble
// is the client least able to be upgraded first, so the form that shipped has
// to keep working forever. Every case below was checked by breaking the branch
// it covers.
func TestDecodeReports(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name  string
		body  string
		want  int
		first string
		bad   bool
	}{
		{
			name:  "the single-object form this endpoint shipped with",
			body:  `{"kind":"client_error","message":"boom"}`,
			want:  1,
			first: "boom",
		},
		{
			name:  "the batch form",
			body:  `{"events":[{"kind":"client_error","message":"a"},{"kind":"sync_blocked","message":"b"}]}`,
			want:  2,
			first: "a",
		},
		{
			name:  "a bare array, which is what a client author will try first",
			body:  `[{"kind":"client_error","message":"a"}]`,
			want:  1,
			first: "a",
		},
		{
			name: "an empty batch is empty, not an error",
			body: `{"events":[]}`,
			want: 0,
		},
		{
			// The discriminator matters here: an object with no `events` key is
			// a single report, not an empty batch. Reading it as an empty batch
			// would accept a malformed body with 202 and record nothing —
			// silence reported as success.
			name:  "an object without an events key is one report",
			body:  `{"kind":"sync_blocked","message":"push rejected"}`,
			want:  1,
			first: "push rejected",
		},
		{
			name: "leading whitespace does not change the shape",
			body: "\n\t  [{\"kind\":\"client_error\",\"message\":\"a\"}]",
			want: 1,
		},
		{
			name: "garbage is an error, never an empty batch",
			body: `not json at all`,
			bad:  true,
		},
		{
			// The four the reviewer asked to see pinned rather than reasoned
			// about. Each is a shape that could plausibly decode to an empty
			// batch and be answered 202 while recording nothing.
			name: "a bare null is not an empty batch",
			body: `null`,
			bad:  true,
		},
		{
			name: "an empty object is one (invalid) report, not an empty batch",
			body: `{}`,
			want: 1,
		},
		{
			name: "an explicit null events key is one report, not an empty batch",
			body: `{"events":null}`,
			want: 1,
		},
		{
			// Go takes the LAST duplicate key. Pinned because the resolution is
			// a language rule rather than a decision anyone made here, and a
			// future switch of JSON library could change it silently.
			name:  "duplicate events keys resolve to the last",
			body:  `{"events":[{"kind":"client_error","message":"first"}],"events":[{"kind":"client_error","message":"second"}]}`,
			want:  1,
			first: "second",
		},
		{
			name: "a bare number is an error",
			body: `42`,
			bad:  true,
		},
		{
			name: "an empty body is empty",
			body: ``,
			want: 0,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := decodeReports([]byte(tc.body))
			if tc.bad {
				if err == nil {
					t.Fatalf("expected an error, got %d events", len(got))
				}
				return
			}
			if err != nil {
				t.Fatalf("decodeReports: %v", err)
			}
			if len(got) != tc.want {
				t.Fatalf("got %d events, want %d", len(got), tc.want)
			}
			if tc.first != "" && got[0].Message != tc.first {
				t.Fatalf("first message = %q, want %q", got[0].Message, tc.first)
			}
		})
	}
}

// fakeRepo records what reached the repository, and can be told to fail.
//
// A fake rather than a live database because what is under test here is the
// HANDLER'S ORDERING — that nothing is written before every event has
// validated, and that an oversized or over-long batch is refused before any
// work at all. A Postgres test would prove the insert; only this proves that
// the insert never happened.
type fakeRepo struct {
	batches [][]Event
	single  []Event
	fail    error
}

func (f *fakeRepo) Record(_ context.Context, e Event) error {
	if f.fail != nil {
		return f.fail
	}
	f.single = append(f.single, e)
	return nil
}

func (f *fakeRepo) RecordBatch(_ context.Context, events []Event) error {
	if f.fail != nil {
		return f.fail
	}
	f.batches = append(f.batches, events)
	return nil
}

func (f *fakeRepo) List(context.Context, Filter) ([]Event, error) { return nil, nil }

func (f *fakeRepo) Summarise(context.Context, time.Time) (Summary, error) { return Summary{}, nil }

/** recorded counts every event that reached the repository by any path. */
func (f *fakeRepo) recorded() int {
	n := len(f.single)
	for _, b := range f.batches {
		n += len(b)
	}
	return n
}

func postReport(t *testing.T, repo Repository, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/v1/client-errors", strings.NewReader(body))
	r = r.WithContext(auth.ContextWithClaims(r.Context(), &auth.Claims{UserID: "user_1"}))
	w := httptest.NewRecorder()
	NewHandler(repo).Report(w, r)
	return w
}

func TestReportWritesNothingUntilEverythingValidates(t *testing.T) {
	t.Parallel()

	valid := `{"kind":"client_error","message":"ok"}`

	t.Run("a good batch is written once, atomically", func(t *testing.T) {
		t.Parallel()
		repo := &fakeRepo{}
		w := postReport(t, repo, `{"events":[`+valid+`,`+valid+`]}`)
		if w.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want 202", w.Code)
		}
		// ONE call carrying both, not two calls. A loop of single inserts can
		// commit a prefix and then fail, which makes the client's own
		// `lost_events` count wrong about events that were in fact stored.
		if len(repo.batches) != 1 || len(repo.batches[0]) != 2 {
			t.Fatalf("got %d batches %v, want one batch of 2", len(repo.batches), repo.batches)
		}
	})

	t.Run("one invalid event refuses the whole batch and writes nothing", func(t *testing.T) {
		t.Parallel()
		repo := &fakeRepo{}
		w := postReport(t, repo, `{"events":[`+valid+`,{"kind":"nonsense","message":"x"}]}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
		// The load-bearing assertion. "202 with some of it dropped" is the
		// silent-loss shape this endpoint exists to end, and a version that
		// wrote the good half would still return 400 here.
		if repo.recorded() != 0 {
			t.Fatalf("recorded %d events, want 0", repo.recorded())
		}
	})

	t.Run("over MaxBatch is refused before anything is written", func(t *testing.T) {
		t.Parallel()
		repo := &fakeRepo{}
		events := make([]string, MaxBatch+1)
		for i := range events {
			events[i] = valid
		}
		w := postReport(t, repo, `{"events":[`+strings.Join(events, ",")+`]}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
		if repo.recorded() != 0 {
			t.Fatalf("recorded %d events, want 0", repo.recorded())
		}
	})

	t.Run("exactly MaxBatch is allowed", func(t *testing.T) {
		t.Parallel()
		repo := &fakeRepo{}
		events := make([]string, MaxBatch)
		for i := range events {
			events[i] = valid
		}
		w := postReport(t, repo, `{"events":[`+strings.Join(events, ",")+`]}`)
		// The boundary in the other direction, so an off-by-one in the cap
		// cannot pass by rejecting one event too many.
		if w.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want 202", w.Code)
		}
		if repo.recorded() != MaxBatch {
			t.Fatalf("recorded %d, want %d", repo.recorded(), MaxBatch)
		}
	})

	t.Run("an empty batch is refused", func(t *testing.T) {
		t.Parallel()
		repo := &fakeRepo{}
		if w := postReport(t, repo, `{"events":[]}`); w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
		if repo.recorded() != 0 {
			t.Fatalf("recorded %d events, want 0", repo.recorded())
		}
	})

	t.Run("an oversized body is 413, not a confusing 400", func(t *testing.T) {
		t.Parallel()
		repo := &fakeRepo{}
		w := postReport(t, repo, `{"events":[{"kind":"client_error","message":"`+
			strings.Repeat("x", maxReportBytes+1)+`"}]}`)
		// Told apart from malformed JSON: a client author sending a valid but
		// large batch otherwise gets "invalid JSON body" and nothing to act on.
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want 413", w.Code)
		}
		if repo.recorded() != 0 {
			t.Fatalf("recorded %d events, want 0", repo.recorded())
		}
	})

	t.Run("details larger than the cap are refused", func(t *testing.T) {
		t.Parallel()
		repo := &fakeRepo{}
		big := strings.Repeat("y", MaxDetailsBytes)
		w := postReport(t, repo, `{"kind":"client_error","message":"x","details":{"blob":"`+big+`"}}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
		if repo.recorded() != 0 {
			t.Fatalf("recorded %d events, want 0", repo.recorded())
		}
	})

	t.Run("the user is taken from the token, never the body", func(t *testing.T) {
		t.Parallel()
		repo := &fakeRepo{}
		postReport(t, repo, `{"kind":"client_error","message":"x","user_id":"someone_else"}`)
		if len(repo.batches) != 1 || len(repo.batches[0]) != 1 {
			t.Fatalf("want one event, got %v", repo.batches)
		}
		got := repo.batches[0][0]
		if got.UserID == nil || *got.UserID != "user_1" {
			t.Fatalf("user = %v, want the token's user_1", got.UserID)
		}
		if got.Source != SourceClient {
			t.Fatalf("source = %v, want %v", got.Source, SourceClient)
		}
	})

	t.Run("unauthenticated is refused", func(t *testing.T) {
		t.Parallel()
		repo := &fakeRepo{}
		r := httptest.NewRequest(http.MethodPost, "/v1/client-errors", strings.NewReader(valid))
		w := httptest.NewRecorder()
		NewHandler(repo).Report(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
		if repo.recorded() != 0 {
			t.Fatalf("recorded %d events, want 0", repo.recorded())
		}
	})
}
