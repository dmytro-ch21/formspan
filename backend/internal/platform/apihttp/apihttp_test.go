package apihttp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The repositories wrap every failure (`fmt.Errorf("session: list: %w", err)`),
// so the check has to survive wrapping — that's the whole reason it's
// errors.Is and not an equality test.
func TestClientGone(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"bare cancellation", context.Canceled, true},
		{"wrapped once", fmt.Errorf("session: list: %w", context.Canceled), true},
		{"wrapped twice", fmt.Errorf("outer: %w", fmt.Errorf("scan: %w", context.Canceled)), true},
		// Our own timeout elapsing is a real problem and must stay a 500.
		{"deadline exceeded", context.DeadlineExceeded, false},
		{"an ordinary failure", errors.New("connection refused"), false},
		// A driver that only stringifies the cause is not a match, and
		// shouldn't be — silently swallowing real errors because their text
		// happens to read "context canceled" is worse than a false 500.
		{"the words, unwrapped", errors.New("context canceled"), false},
		{"nil", nil, false},
	}
	for _, c := range cases {
		if got := ClientGone(c.err); got != c.want {
			t.Errorf("%s: ClientGone = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestWriteInternal_AbortIsNotAServerError(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/profile", nil)

	gone := httptest.NewRecorder()
	WriteInternal(gone, req, "profile", fmt.Errorf("profile: scan: %w", context.Canceled))
	if gone.Code != StatusClientClosed {
		t.Errorf("aborted request: status %d, want %d", gone.Code, StatusClientClosed)
	}
	// Nobody is listening; writing a body is pointless and a JSON error shape
	// would be misleading if it were somehow read.
	if gone.Body.Len() != 0 {
		t.Errorf("aborted request wrote a body: %q", gone.Body.String())
	}

	real := httptest.NewRecorder()
	WriteInternal(real, req, "profile", errors.New("the database is on fire"))
	if real.Code != http.StatusInternalServerError {
		t.Errorf("real failure: status %d, want 500", real.Code)
	}
	// And it must never leak the cause.
	if body := real.Body.String(); !contains(body, `"code":"internal"`) || contains(body, "on fire") {
		t.Errorf("real failure body leaked or malformed: %s", body)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
