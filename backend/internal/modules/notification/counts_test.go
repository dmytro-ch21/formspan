package notification

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

// Pure-logic tests: this package owns no table, so what there is to get wrong
// is the aggregation contract, not SQL. The counting queries themselves are
// pinned in the modules that own the rows.

// The stub RECORDS the user id it was handed. Review mutated
// `counter.PendingCount(ctx, userID)` to `counter.PendingCount(ctx, "")` and
// the whole suite stayed green, because the old stub discarded its arguments —
// and that regression returns all-zero counts for every athlete, which is
// precisely the zero-that-lies this endpoint exists to never produce.
type stubCounter struct {
	n   int
	err error
	// sawUser is the last id this counter was asked about.
	sawUser *string
}

func (s stubCounter) PendingCount(_ context.Context, userID string) (int, error) {
	if s.sawUser != nil {
		*s.sawUser = userID
	}
	return s.n, s.err
}

func TestPendingAsksEverythingRegisteredAboutTheRightPerson(t *testing.T) {
	var askedFriends, askedShares string
	c := NewCounts(Registry{
		"friend_requests": stubCounter{n: 2, sawUser: &askedFriends},
		// ZERO on purpose. Every stub returning a nonzero count meant the
		// aggregator could have been dropping zero keys and this test would
		// not have noticed — review mutated `out[key] = n` to skip zeros and
		// the suite stayed green. A missing key and a zero are different
		// things to a client, so the zero has to be one of the fixtures.
		"shares": stubCounter{n: 0, sawUser: &askedShares},
	})
	got, err := c.Pending(context.Background(), "u1")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if got["friend_requests"] != 2 {
		t.Fatalf("counts wrong: %+v", got)
	}
	if _, present := got["shares"]; !present {
		t.Fatalf("a zero count was dropped from the map: %+v", got)
	}
	if got["shares"] != 0 {
		t.Fatalf("zero count wrong: %+v", got)
	}
	if len(got) != 2 {
		t.Fatalf("want exactly the registered keys, got %+v", got)
	}
	// Every counter is asked about the CALLER, not about nobody.
	if askedFriends != "u1" || askedShares != "u1" {
		t.Fatalf("counters asked about %q/%q, want u1", askedFriends, askedShares)
	}
}

// THE ONE ANSWER THIS ENDPOINT MUST NEVER GIVE. A counter that fails has to
// fail the request, because a zero does not say "I could not check" — it says
// "nothing is waiting for you", and a badge is believed.
func TestOneFailingCounterFailsTheWholeRequest(t *testing.T) {
	boom := errors.New("database is having a day")
	c := NewCounts(Registry{
		"friend_requests": stubCounter{n: 3},
		"shares":          stubCounter{err: boom},
	})
	got, err := c.Pending(context.Background(), "u1")
	if !errors.Is(err, boom) {
		t.Fatalf("want the counter's error, got %v", err)
	}
	if got != nil {
		t.Fatalf("a failed count must not return partial counts: %+v", got)
	}
}

// A zero must be PRESENT rather than absent: `counts.shares ?? unknown` reads
// a missing key and a zero as different things, and a badge that renders for
// one but not the other is the bug this prevents.
func TestZeroCountsAreSerialisedNotOmitted(t *testing.T) {
	out, err := json.Marshal(pendingPayload(map[string]int{"friend_requests": 0, "shares": 4}))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got struct {
		Pending map[string]json.RawMessage `json:"pending"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := got.Pending["friend_requests"]; !present {
		t.Fatalf("a zero count was omitted: %s", out)
	}
	if string(got.Pending["friend_requests"]) != "0" {
		t.Fatalf("zero did not serialise as 0: %s", out)
	}
}

// An empty registry is `{}`, never `null` — the contract says object, and a
// nil map marshals to null, which a client then has to special-case.
func TestEmptyRegistrySerialisesAsAnObject(t *testing.T) {
	c := NewCounts(Registry{})
	got, err := c.Pending(context.Background(), "u1")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	out, err := json.Marshal(pendingPayload(got))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(out) != `{"pending":{}}` {
		t.Fatalf(`want {"pending":{}}, got %s`, out)
	}
	// And explicitly from nil, since that is what a future code path could
	// hand it.
	if out, _ := json.Marshal(pendingPayload(nil)); string(out) != `{"pending":{}}` {
		t.Fatalf(`nil counts must serialise as {}, got %s`, out)
	}
}
