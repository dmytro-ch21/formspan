package llm

import (
	"os"
	"strings"
	"testing"
)

// Truncation is deterministic, so it must be a refusal on EVERY backend: a
// retryable status bills the caller a second time for the identical doomed
// request.
//
// The two providers disagreed once — OpenAI reported it, Anthropic let a
// cut-off response fall through to the caller's JSON parse and surface as
// "temporarily unavailable" — which is the divergence this package exists to
// stop. The test moved here with the providers (N36); it used to live in
// `nutrition`, reading files that are no longer there.
//
// A grep is the honest test: the alternative is a live billed call per
// provider, and this catches the regression review actually found.
func TestBothBackendsCallTruncationTheSameThing(t *testing.T) {
	for _, path := range []string{"anthropic.go", "openai.go"} {
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		text := string(src)
		if !strings.Contains(text, "response was cut off") {
			t.Errorf("%s does not handle truncation — a cut-off response will read as an outage", path)
		}
		// And that it is a REFUSAL, not merely handled. Reporting it as
		// unavailable is the exact bug: it reads as retryable.
		if !strings.Contains(text, "response was cut off\", ErrRefused") {
			t.Errorf("%s does not map truncation to ErrRefused — a retry would be billed for the same failure", path)
		}
	}
}
