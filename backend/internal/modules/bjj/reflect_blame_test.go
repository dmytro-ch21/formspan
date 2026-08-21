package bjj

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
)

// N118 (#507): a refusal must not be reported as the athlete's fault.
//
// The report: *"When I dictated today I first got an error that it's not
// articulated correctly and then I just resent again"* — and the resend, of the
// same words, worked. The message they paraphrased was this endpoint's 422:
// "could not read that as a session — try saying what happened in plainer
// terms". It says the athlete spoke badly, and it recommends a remedy that the
// one piece of field evidence says is not the remedy.
//
// **What this file can and cannot establish.** It cannot establish that a
// refusal is non-deterministic — that needs a live provider, and no fake
// drafter can answer it. It pins the two properties that are ours to decide:
// the message does not blame anybody, and it does not promise anything the
// truncation case would make false.

// Everything that tells somebody the failure was in how they spoke. Matched
// against the message a client actually receives, not against a constant, so
// a reworded string is checked rather than trusted.
var blameWords = regexp.MustCompile(`(?i)articulat|plainer|clearly|more clearly|say it differently|speak (up|clearly)|your (words|wording)`)

func TestARefusalDoesNotBlameTheAthleteForHowTheySpoke(t *testing.T) {
	h := NewDraftHandler(&fakeDrafter{err: ErrDraftRefused}, &memDraftUsage{})

	w := callDraft(t, h, aDictation)

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status %d, want 422 — this test is not on the refusal path", w.Code)
	}
	msg := decodeDraftError(t, w.Body.Bytes()).Error.Message
	if msg == "" {
		t.Fatal("a refusal must still say something; an empty message is the failure this replaced")
	}
	if blameWords.MatchString(msg) {
		t.Fatalf("the refusal message blames the athlete for how they spoke: %q\n"+
			"A refusal is one sample from a provider called at its default sampling "+
			"temperature — it is not a verdict on the sentence (N118).", msg)
	}
}

// The other half, and the reason the new wording is hedged.
//
// TRUNCATION maps onto ErrDraftRefused too (llm/openai.go, llm/anthropic.go both
// wrap ErrRefused for a cut-off response), and truncation genuinely IS
// deterministic. So the message may say a retry is worth trying and may not say
// it will work — the client spends one of ten drafts acting on it.
func TestARefusalPromisesNothingItCannotKeep(t *testing.T) {
	h := NewDraftHandler(&fakeDrafter{err: ErrDraftRefused}, &memDraftUsage{})

	msg := decodeDraftError(t, callDraft(t, h, aDictation).Body.Bytes()).Error.Message

	for _, promise := range []string{"will work", "always", "guaranteed", "try again and it"} {
		if strings.Contains(strings.ToLower(msg), promise) {
			t.Fatalf("the refusal message promises %q, which a truncated response makes false: %q", promise, msg)
		}
	}
}

// Every failure a client can meet here, held to the same bar.
//
// A per-arm test would pass while a new arm shipped with the old wording — the
// message that started this was one branch of a switch nobody was checking.
func TestNoDraftFailureBlamesTheAthlete(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"refused", ErrDraftRefused},
		{"answered but unusable", ErrDraftUnavailable},
		{"provider never answered", ErrDraftUnreachable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewDraftHandler(&fakeDrafter{err: tc.err}, &memDraftUsage{})
			msg := decodeDraftError(t, callDraft(t, h, aDictation).Body.Bytes()).Error.Message
			if msg == "" {
				t.Fatal("empty message")
			}
			if blameWords.MatchString(msg) {
				t.Fatalf("blames the athlete: %q", msg)
			}
		})
	}
}
