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

type stubCounter struct {
	n   int
	err error
}

func (s stubCounter) PendingCount(context.Context, string) (int, error) { return s.n, s.err }

func TestPendingAsksEverythingRegistered(t *testing.T) {
	c := NewCounts(Registry{
		"friend_requests": stubCounter{n: 2},
		"shares":          stubCounter{n: 1},
	})
	got, err := c.Pending(context.Background(), "u1")
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if got["friend_requests"] != 2 || got["shares"] != 1 {
		t.Fatalf("counts wrong: %+v", got)
	}
	if len(got) != 2 {
		t.Fatalf("want exactly the registered keys, got %+v", got)
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
