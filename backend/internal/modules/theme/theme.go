// Package theme holds what a training week is about.
//
// One sentence, per week, per athlete — "deload", "guard retention", "chase the
// squat". It is deliberately the coarsest thing in the app that expresses
// intent, and it is deliberately NOT a list of anything.
//
// # Why this is not a second focus list
//
// `bjj_focus` already answers "what am I working on": a rolling list of three
// to five TECHNIQUES, ranked by the athlete, BJJ-only, each carrying the date it
// joined so that "you have been on this five weeks" is answerable. A theme is
// week-boxed, coarse, and covers whatever the athlete trains.
//
// A theme is a LABEL BESIDE that list, never a container for it, and the rule
// that holds the line is that a theme stores no technique ids and no exercise
// ids. Prose only. See the migration for the alternative that was rejected and
// why.
package theme

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrNotFound     = errors.New("theme: not found")
	ErrInvalidInput = errors.New("theme: invalid input")
)

// MaxTitle and MaxNotes mirror the CHECKs in migration 000045. Duplicated on
// purpose: the database is the guarantee, this is the error message. A caller
// deserves "title is too long" rather than a constraint name.
const (
	MaxTitle = 80
	MaxNotes = 500
)

// Theme is one week's intent.
type Theme struct {
	// WeekStart is the Monday of the week, as a calendar date (YYYY-MM-DD).
	WeekStart string    `json:"week_start"`
	Title     string    `json:"title"`
	Notes     string    `json:"notes"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Input is what a caller may set.
type Input struct {
	Title string `json:"title"`
	Notes string `json:"notes"`
}

// IsMonday reports whether a YYYY-MM-DD string is a Monday.
//
// Checked here as well as by the database, and the reason is the error rather
// than the safety: a week that does not start on a Monday would silently overlap
// its neighbours, and the caller should be told that in those words rather than
// receiving a constraint violation. Parsing in UTC is correct because the value
// is a calendar date with no instant attached — see the migration.
func IsMonday(day string) bool {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return false
	}
	return t.Weekday() == time.Monday
}

// ValidDay reports whether a string is a well-formed calendar date.
func ValidDay(day string) bool {
	_, err := time.Parse("2006-01-02", day)
	return err == nil
}

// CleanTitle trims a submitted title and reports whether it is usable.
//
// Extracted from the handler because the rule it encodes cannot be reached by a
// handler test: a VALID title passes validation and goes on to the repository,
// and the repository needs claims that `auth`'s unexported context key makes
// impossible to forge. So the accepting case — the only one that catches a
// bytes-for-runes swap — was untestable in place.
//
// **Runes, not bytes**, and that is the whole point. `len` would refuse 80
// Japanese characters at 240 bytes while the column counts code points. The
// workout rename endpoint fell into exactly this and its test file records that
// asserting only "81 is refused" passes against the bug, because under `len`
// both 80 and 81 are refused — one of them for the wrong reason.
func CleanTitle(raw string) (string, bool) {
	title := strings.TrimSpace(raw)
	if title == "" {
		return "", false
	}
	return title, utf8.RuneCountInString(title) <= MaxTitle
}

// ValidNotes reports whether notes fit, counting code points for the same
// reason CleanTitle does.
func ValidNotes(notes string) bool {
	return utf8.RuneCountInString(notes) <= MaxNotes
}

type Repository interface {
	// List returns the caller's themes for weeks in [from, to], oldest first.
	List(ctx context.Context, userID, from, to string) ([]Theme, error)
	// Get returns one week's theme, or ErrNotFound.
	Get(ctx context.Context, userID, weekStart string) (*Theme, error)
	// Set writes the theme for a week, creating or replacing it. A week holds
	// at most one theme, so there is no separate create and update — the caller
	// names the week and says what it is about.
	Set(ctx context.Context, userID, weekStart string, in Input) (*Theme, error)
	// Delete removes a week's theme. Absent is ErrNotFound rather than success,
	// so a client can tell "there was nothing" from "it is gone".
	Delete(ctx context.Context, userID, weekStart string) error
}
