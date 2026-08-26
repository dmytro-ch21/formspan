package health

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/httplog"
)

// recordingRepo captures what the writer goroutine actually inserts. Only
// Record is exercised; the rest satisfy the interface.
type recordingRepo struct{ got chan Event }

func (r *recordingRepo) Record(_ context.Context, e Event) error { r.got <- e; return nil }
func (r *recordingRepo) RecordBatch(context.Context, []Event) error {
	return nil
}
func (r *recordingRepo) List(context.Context, Filter) ([]Event, error) { return nil, nil }
func (r *recordingRepo) Summarise(context.Context, time.Time) (Summary, error) {
	return Summary{}, nil
}

// observed runs one observation and returns the event that reached the
// repository, or nil if nothing was recorded within a short grace period.
//
// The grace period is what makes a negative answer mean something: the write
// is handed to a goroutine, so reading the channel immediately would report
// "nothing recorded" for every event, and every assertion that something is
// SKIPPED would pass for the wrong reason.
func observed(t *testing.T, slowerThan time.Duration, o httplog.Observation) *Event {
	t.Helper()
	repo := &recordingRepo{got: make(chan Event, 4)}
	rec := NewRecorder(repo, slowerThan, slog.New(slog.NewTextHandler(io.Discard, nil)))
	rec.Observe(context.Background(), o)
	select {
	case e := <-repo.got:
		return &e
	case <-time.After(2 * time.Second):
		return nil
	}
}

// The gap that made #433 undiagnosable three times.
//
// A refused estimate is the one 4xx an operator has to be able to find later:
// it costs the athlete the answer they asked for, and — until
// `apihttp.DrainRequestBody` — an upload over 256 KiB never even received the
// status, so the phone could not report it either. With Railway's request log
// retaining minutes, `health_events` is the only place it can survive.
func TestARefusedAIRequestIsRecorded(t *testing.T) {
	for _, status := range []int{400, 401, 413, 429} {
		got := observed(t, 2*time.Second, httplog.Observation{
			Method: "POST", Path: "/v1/nutrition/estimate",
			Status: status, Duration: 40 * time.Millisecond,
			UserID: "user_abc",
		})
		if got == nil {
			t.Fatalf("a %d on the estimate route was not recorded; this is the "+
				"trace whose absence was twice read as 'the request never arrived'", status)
		}
		if got.Kind != KindClientError {
			t.Fatalf("status %d recorded as kind %q, want %q", status, got.Kind, KindClientError)
		}
		if got.Status == nil || *got.Status != status {
			t.Fatalf("status %d not carried onto the row; the status IS the diagnosis", status)
		}
		if got.Source != SourceAPI {
			t.Fatalf("source = %q, want %q — this is a server-side observation, "+
				"not something an app reported", got.Source, SourceAPI)
		}
	}
}

// The general rule is unchanged, and this is what stops the exception eating
// it: a 404 on an ordinary route stays out of the operator's screen.
func TestAnOrdinary4xxIsStillNotRecorded(t *testing.T) {
	got := observed(t, 2*time.Second, httplog.Observation{
		Method: "GET", Path: "/v1/sessions/does-not-exist",
		Status: 404, Duration: 5 * time.Millisecond,
	})
	if got != nil {
		t.Fatalf("a routine 404 was recorded as %q; filling the health page with "+
			"these is how it becomes something nobody opens", got.Kind)
	}
}

// A rejection that is ALSO slow files as a rejection.
//
// Mutating the case order in Observe puts this row under `slow_request`, which
// is the kind an operator filters OUT when hunting latency — so the one
// interesting row would hide in the pile it least belongs to.
func TestASlowRejectionIsARejectionFirst(t *testing.T) {
	got := observed(t, 10*time.Millisecond, httplog.Observation{
		Method: "POST", Path: "/v1/nutrition/estimate",
		Status: 429, Duration: 5 * time.Second,
	})
	if got == nil {
		t.Fatal("nothing recorded at all")
	}
	if got.Kind != KindClientError {
		t.Fatalf("kind = %q, want %q: a refused request that happened to be slow "+
			"is a rejection, not a latency symptom", got.Kind, KindClientError)
	}
}

// The two behaviours that were already there, pinned so the new branch cannot
// have quietly displaced either.
func TestServerErrorsAndSlowRequestsStillRecord(t *testing.T) {
	if got := observed(t, time.Hour, httplog.Observation{
		Method: "GET", Path: "/v1/anything", Status: 500, Duration: time.Millisecond,
	}); got == nil || got.Kind != KindServerError {
		t.Fatalf("a 500 must always record as %q, got %v", KindServerError, got)
	}
	if got := observed(t, 10*time.Millisecond, httplog.Observation{
		Method: "GET", Path: "/v1/anything", Status: 200, Duration: time.Second,
	}); got == nil || got.Kind != KindSlowRequest {
		t.Fatalf("a slow 200 must record as %q, got %v", KindSlowRequest, got)
	}
}

// Every route in the list is one somebody chose. A typo'd path is a silent
// no-op — it compiles, it reads correctly, and it records nothing forever —
// so the paths are asserted against the routes `cmd/api` actually serves.
func TestTheRecordedRoutesAreSpelledAsTheyAreServed(t *testing.T) {
	for _, p := range []string{
		"/v1/nutrition/estimate",
		"/v1/exercises/identify",
		"/v1/bjj/reflect/draft",
	} {
		if !recordRejectionsOn[p] {
			t.Fatalf("%s is not in recordRejectionsOn", p)
		}
	}
	if len(recordRejectionsOn) != 3 {
		t.Fatalf("recordRejectionsOn has %d entries; if a route was added, add it "+
			"here too so a typo cannot pass as coverage", len(recordRejectionsOn))
	}
}
