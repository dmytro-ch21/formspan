// Package narration serves VOLA's day narration (N570, #1131): a few plain
// sentences about the athlete's day, written by a model from facts the phone
// sends, and never containing a fact the phone did not send.
//
// # What the server does and does not know
//
// The phone is the authority on the athlete's day: its SQLite holds the rows,
// and `apps/mobile/lib/dayPanel.ts` assembles them into facts, each checked
// against those rows by `unbackedFacts` in its tests. This server never reads
// the athlete's tables to build a prompt. It receives the facts, asks the model
// to narrate them, and checks every sentence that comes back against the facts
// it was given (see guard.go).
//
// That split is deliberate. It keeps the offline-first rule (the phone's own
// data is what gets narrated), and it makes "only the caller's data reaches the
// prompt" structural rather than a filter someone could forget: there is no
// query here that could read somebody else's rows.
//
// # What is stored
//
// One metering row per call: who, whether it worked, which model, how many
// sentences survived, and token usage. Never the facts and never the sentences.
package narration

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	// ErrInvalidInput is a request that cannot succeed. It is detected before
	// the quota is checked, so it never costs the athlete a narration.
	ErrInvalidInput = errors.New("narration: invalid input")
	// ErrNarrationRefused is the model declining, or its output being truncated.
	// Billed, so metered.
	ErrNarrationRefused = errors.New("narration: could not narrate the day this time")
	// ErrNarrationUnavailable is the upstream erroring or answering with
	// something unusable. Billed when the call completed, so metered.
	ErrNarrationUnavailable = errors.New("narration: narrating the day is unavailable")
	// ErrNarrationUnreachable is the provider never answering at all. Nothing was
	// spent, so it is not metered: charging an athlete for a provider outage
	// locks them out after service returns (F16, #367, the same rule as bjj).
	// It wraps ErrNarrationUnavailable, so check it first.
	ErrNarrationUnreachable = fmt.Errorf("%w: the provider never answered", ErrNarrationUnavailable)
	// ErrQuotaExhausted is the per-athlete rolling cap.
	ErrQuotaExhausted = errors.New("narration: daily narration limit reached")
)

// The request's bounds. A day panel carries a dozen facts at most; these are
// generous ceilings that keep a prompt, and therefore a bill, bounded.
const (
	MaxFacts          = 60
	MaxKeyRunes       = 120
	MaxLabelRunes     = 200
	MaxNumbersPerFact = 12
	MaxNumberChars    = 12
	MaxNamesPerFact   = 4
	MaxNameRunes      = 120
	// MaxSentences is how many guarded sentences are returned. The prompt asks
	// for at most this many; the handler enforces it.
	MaxSentences = 3
)

// knownKinds is every `DayFact` kind in `apps/mobile/lib/dayPanel.ts`. A kind
// outside it is a client this server does not understand, refused rather than
// narrated on a guess.
//
//nolint:gochecknoglobals // vocabulary, not state
var knownKinds = map[string]bool{
	"session-open": true, "planned": true, "plan-done": true, "logged": true,
	"next-planned": true, "tracker": true, "food-eaten": true,
	"nutrition-target": true, "last-checkin": true, "phase-goal": true,
}

// numberFormat is one number as the phone's `backedNumbers` spells it: whole, or
// to one decimal.
var numberFormat = regexp.MustCompile(`^\d+(\.\d)?$`)

// Fact is one day-panel fact, as the phone states it.
type Fact struct {
	// Key is the fact's stable key (`food-eaten:2026-09-12`). Sentences cite it.
	Key string `json:"key"`
	// Kind is the `DayFact` kind.
	Kind string `json:"kind"`
	// Label is the fact in words, built deterministically by the phone. It is
	// what the model reads.
	Label string `json:"label"`
	// Numbers is every number the fact states: the phone's `backedNumbers`.
	Numbers []string `json:"numbers"`
	// Names is every name the fact quotes (a session's, a tracker's, a
	// workout's): the phone's `namesOf`. The athlete wrote these.
	Names []string `json:"names"`
}

// Input is a narration request.
type Input struct {
	Facts []Fact `json:"facts"`
}

// Validate checks the request before any token is spent.
//
// It also refuses a label that states a number its own `numbers` does not
// back. Such a label would hand the model a figure the guard would then drop
// from every sentence quoting it, a disagreement that can only be a client bug.
func (in Input) Validate() error {
	if len(in.Facts) == 0 {
		return fmt.Errorf("%w: there is nothing to narrate", ErrInvalidInput)
	}
	if len(in.Facts) > MaxFacts {
		return fmt.Errorf("%w: more than %d facts", ErrInvalidInput, MaxFacts)
	}
	seen := make(map[string]bool, len(in.Facts))
	for i, f := range in.Facts {
		key := strings.TrimSpace(f.Key)
		switch {
		case key == "":
			return fmt.Errorf("%w: fact %d has no key", ErrInvalidInput, i)
		case utf8.RuneCountInString(f.Key) > MaxKeyRunes:
			return fmt.Errorf("%w: fact %d's key is longer than %d characters", ErrInvalidInput, i, MaxKeyRunes)
		case seen[f.Key]:
			return fmt.Errorf("%w: fact key %q appears twice", ErrInvalidInput, f.Key)
		case !knownKinds[f.Kind]:
			return fmt.Errorf("%w: fact %d has an unknown kind", ErrInvalidInput, i)
		case strings.TrimSpace(f.Label) == "":
			return fmt.Errorf("%w: fact %d has no label", ErrInvalidInput, i)
		case utf8.RuneCountInString(f.Label) > MaxLabelRunes:
			return fmt.Errorf("%w: fact %d's label is longer than %d characters", ErrInvalidInput, i, MaxLabelRunes)
		case len(f.Numbers) > MaxNumbersPerFact:
			return fmt.Errorf("%w: fact %d states more than %d numbers", ErrInvalidInput, i, MaxNumbersPerFact)
		case len(f.Names) > MaxNamesPerFact:
			return fmt.Errorf("%w: fact %d quotes more than %d names", ErrInvalidInput, i, MaxNamesPerFact)
		}
		seen[f.Key] = true
		backed := make(map[string]bool, len(f.Numbers))
		for _, n := range f.Numbers {
			if len(n) > MaxNumberChars || !numberFormat.MatchString(n) {
				return fmt.Errorf("%w: fact %d has a malformed number", ErrInvalidInput, i)
			}
			backed[normalise(n)] = true
		}
		for _, name := range f.Names {
			if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > MaxNameRunes {
				return fmt.Errorf("%w: fact %d has an empty or over-long name", ErrInvalidInput, i)
			}
		}
		for _, raw := range numberPattern.FindAllString(stripNames(f.Label, f.Names), -1) {
			if !backed[normalise(raw)] {
				return fmt.Errorf("%w: fact %d's label states a number its numbers do not", ErrInvalidInput, i)
			}
		}
	}
	return nil
}

// DailyNarrations is the per-athlete cap: the owner's "4-5 gens per day", at its
// top. The phone schedules against the same number (`DAILY_NARRATIONS` in
// `apps/mobile/lib/narrationTrigger.ts`); this is the one that is enforced,
// because the server owns the spend. N570's last part attaches the measured cost.
const DailyNarrations = 5

// QuotaWindow is rolling, not a calendar day, for `bjj.DraftQuotaWindow`'s
// reasons: no timezone needed, and no gaming it at midnight.
const QuotaWindow = 24 * time.Hour

// Quota is what the athlete has left. The decision is Allowed, computed here so
// a client cannot reach a different answer from the numbers.
type Quota struct {
	Used      int        `json:"used"`
	Limit     int        `json:"limit"`
	Remaining int        `json:"remaining"`
	ResetsAt  *time.Time `json:"resets_at"`
}

// Allowed reports whether one more call may be made.
func (q Quota) Allowed() bool { return q.Remaining > 0 }

// NewQuota builds the report from a count and the OLDEST call in the window.
// Remaining is clamped at zero, so a cap lowered in a deploy never reports a
// negative count.
func NewQuota(used int, oldest *time.Time) Quota {
	remaining := DailyNarrations - used
	if remaining < 0 {
		remaining = 0
	}
	q := Quota{Used: used, Limit: DailyNarrations, Remaining: remaining}
	if oldest != nil {
		resets := oldest.Add(QuotaWindow)
		q.ResetsAt = &resets
	}
	return q
}

// Record is one call, written whether or not it produced a narration.
type Record struct {
	UserID        string
	Succeeded     bool
	Model         string
	SentencesKept int
	Usage         Usage
}

// UsageRepository counts and records calls.
type UsageRepository interface {
	Quota(ctx context.Context, userID string, now time.Time) (Quota, error)
	Record(ctx context.Context, rec Record) error
}

// CheckQuota is the gate. It runs BEFORE the model call, never after: a check
// afterwards is a receipt, not a quota. Advisory under concurrency, as
// `bjj.CheckDraftQuota` states and for the same priced-in reason.
func CheckQuota(ctx context.Context, repo UsageRepository, userID string, now time.Time) (Quota, error) {
	q, err := repo.Quota(ctx, userID, now)
	if err != nil {
		return Quota{}, err
	}
	if !q.Allowed() {
		return q, fmt.Errorf("%w: %d narrations in the last day", ErrQuotaExhausted, q.Used)
	}
	return q, nil
}

// normalise spells a number one way: `1,840` → `1840`, `82.40` → `82.4`,
// `09` → `9`. The same result as the phone's `String(Number(...))` for every
// number a fact can state (at most MaxNumberChars characters).
//
// For a number in model PROSE, JavaScript spells 1e21 or more, or below 1e-6, in
// exponent form (`1.2e+21`, `1e-7`) and this does not. Neither can be a number a
// fact states, so both are dropped as unbacked on both sides: the verdict matches
// and only the `detail` string differs. Raised in review.
func normalise(raw string) string {
	s := strings.ReplaceAll(raw, ",", "")
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return s
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}
