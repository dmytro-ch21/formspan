package share

import (
	"encoding/json"
	"testing"
)

// Wire-shape tests, for two properties that live entirely in serialisation and
// that no repository test can see. Review mutated both and the whole 14-test
// integration suite stayed green.
//
// WHY NOT THROUGH THE HANDLER: `auth`'s context key is unexported, so a test
// cannot inject claims, and both list handlers dereference them on their first
// line — a handler test would panic before reaching anything worth asserting.
// The workout module's handler test documents the same limitation and declines
// to widen `auth` for it. So the shaping is a plain function the handlers call,
// and the JSON tags are asserted by marshalling the structs the handlers pass.

func TestSentCardSerialisesTheRecipientUnderTo(t *testing.T) {
	// The transposition risk is pinned on the SQL side already, but the SQL
	// side is not where it is OBSERVABLE. Under `json:"from"` the field would
	// still hold the recipient's handle — it would just arrive under the key
	// that makes a client render a share you SENT as one you received.
	out, err := json.Marshal(SentCard{ID: "s1", ResourceLabel: "A chain", To: "bob_h"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["to"] != "bob_h" {
		t.Fatalf(`sent card must carry the recipient under "to": %s`, out)
	}
	if _, wrong := got["from"]; wrong {
		t.Fatalf(`sent card serialised a "from" key: %s`, out)
	}
}

func TestInboxCardSerialisesTheSenderUnderFrom(t *testing.T) {
	out, err := json.Marshal(Card{ID: "s1", ResourceLabel: "A chain", From: "alice_h"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["from"] != "alice_h" {
		t.Fatalf(`inbox card must carry the sender under "from": %s`, out)
	}
	if _, wrong := got["to"]; wrong {
		t.Fatalf(`inbox card serialised a "to" key: %s`, out)
	}
}

// An empty list is `[]`, never `null`, on both endpoints. The contract says
// `type: array`; a nil slice marshals to null, which every client then has to
// special-case. Passing nil is the point — it proves the guarantee belongs to
// the response shaping rather than to a repository that happens to return an
// initialised slice.
func TestEmptyListsSerialiseAsArraysNotNull(t *testing.T) {
	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"inbox", sharesPayload[Card](nil)},
		{"sent", sharesPayload[SentCard](nil)},
	} {
		out, err := json.Marshal(tc.body)
		if err != nil {
			t.Fatalf("%s: marshal: %v", tc.name, err)
		}
		if string(out) != `{"shares":[]}` {
			t.Fatalf("%s: want {\"shares\":[]}, got %s", tc.name, out)
		}
	}
}
