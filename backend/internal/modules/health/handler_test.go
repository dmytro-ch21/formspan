package health

import "testing"

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
