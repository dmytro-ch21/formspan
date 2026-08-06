package technique

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// Authoring the catalog from the admin console rather than from a deploy.
//
// The loop this replaces: edit `techniques.json`, commit, deploy, re-seed. That
// is the wrong shape for content — you get shown a pass in class whose name is
// not in the list, and you cannot record it until someone opens a laptop.
//
// WHAT MAKES THIS DIFFERENT FROM ORDINARY CRUD
//
// A technique id is a foreign key in `bjj_session_tags`. Once anyone has logged
// against it, it is a permanent reference in their training record — so ids are
// generated once and never change, and a typo is not something a later edit can
// take back. That single fact drives most of the rules below.

// slugUnsafe is everything that is not a lowercase letter, digit or hyphen.
var slugUnsafe = regexp.MustCompile(`[^a-z0-9]+`)

// Slug turns a name into a catalog id: "São Paulo Pass" → "sao-paulo-pass".
//
// Generated rather than typed, because the id outlives every other field. It
// is derived from the name ONCE, at creation, and then frozen — renaming the
// technique later leaves the id alone, which looks inconsistent and is the
// correct trade: an id that tracks the name is an id that changes, and this one
// cannot.
//
// Diacritics are folded rather than stripped so "São Paulo" does not become
// "s-o-paulo".
func Slug(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	for _, r := range s {
		if folded, ok := foldASCII[r]; ok {
			b.WriteString(folded)
			continue
		}
		b.WriteRune(r)
	}
	s = slugUnsafe.ReplaceAllString(b.String(), "-")
	return strings.Trim(s, "-")
}

// foldASCII covers the accented letters that actually turn up in grappling
// vocabulary — Portuguese and Japanese romanisation, mostly. Deliberately not a
// full Unicode normalisation: `golang.org/x/text` is a dependency this project
// does not have, and the failure mode of a missing letter here is a slightly
// uglier slug, not wrong data.
var foldASCII = map[rune]string{
	'á': "a", 'à': "a", 'â': "a", 'ã': "a", 'ä': "a", 'å': "a",
	'é': "e", 'è': "e", 'ê': "e", 'ë': "e",
	'í': "i", 'ì': "i", 'î': "i", 'ï': "i",
	'ó': "o", 'ò': "o", 'ô': "o", 'õ': "o", 'ö': "o",
	'ú': "u", 'ù': "u", 'û': "u", 'ü': "u",
	'ç': "c", 'ñ': "n", 'ß': "ss",
}

// ContentRepository is the write side of the catalog.
type ContentRepository interface {
	// CreateTechnique writes a new admin-authored technique.
	//
	// Returns ErrAlreadyExists if the id is taken — including by a seeded row,
	// which is the collision that matters: an admin row shadowing a seeded id
	// would be reverted by the next deploy in the confusing half-way sense
	// (the upsert skips it, so the two disagree forever).
	CreateTechnique(ctx context.Context, t Technique) (Technique, error)
	// UpdateTechnique edits ANY technique and takes ownership of it.
	//
	// The write sets `source` to "admin", which the seeder skips — without
	// that, the next deploy would silently revert the edit. Returns ErrNotFound
	// only when the id does not exist.
	UpdateTechnique(ctx context.Context, t Technique) (Technique, error)
	// SearchAll finds any technique by name, id or alias, seeded included, so
	// the console can reach the whole catalog rather than only what it wrote.
	SearchAll(ctx context.Context, query string) ([]Technique, error)
	// Publish makes a draft visible to athletes. One-way — see the
	// implementation for why there is no unpublish.
	//
	// ErrNotFound covers both "no such id" and "already published": the caller
	// is acting on a stale view either way, and a success it did not cause is
	// worse than a 404 it can refresh past.
	Publish(ctx context.Context, id string) (Technique, error)
	// KnownPositions returns the distinct `position` values in the catalog.
	//
	// The vocabulary is derived from the library rather than hardcoded — the
	// same choice validate() makes for `to_position`, and for the same reason:
	// the set grows (leg entanglement became a family; "Other" exists for the
	// technical standup) and a second list to maintain is a second list to
	// forget.
	KnownPositions(ctx context.Context) ([]string, error)
	// GetTechnique reads the current row, so a partial update can overlay onto
	// it rather than replacing it.
	GetTechnique(ctx context.Context, id string) (Technique, error)
	// AdminAuthored returns every console-authored technique.
	//
	// The console needs it to list what it can edit, and nothing else can
	// answer that: `Summary` carries no `source`, so the public list cannot
	// tell a seeded entry from an authored one, and adding the field there
	// would put 8 KB of "seed" on every client's list to serve one screen.
	//
	// cmd/exportcontent reads the same method for the same reason — one
	// definition of "what the console owns", rather than a second query that
	// can disagree with the first about which rows the export will carry.
	//
	// DELIBERATELY UNCAPPED, and adding a LIMIT here would be silent data loss
	// rather than a performance fix. The export MERGES rather than replaces, so
	// truncation does not error anywhere: already-exported entries survive, the
	// newest rows simply never reach techniques.json, `verifyContains` only
	// checks the truncated slice so it passes, and `-adopt` then adopts only
	// ids already in the file. The newest authored content would stay
	// database-only and quietly miss the promotion path — exactly the loss
	// cmd/exportcontent exists to prevent.
	//
	// Unbounded is safe because the set only grows one row at a time:
	// CreateTechnique's INSERT is the ONLY code anywhere that writes
	// source='admin' (UpsertAll never names the column, so bulk seeds and
	// imports land as 'seed'), and AdoptAsSeeded only moves admin->seed. If a
	// bulk authoring path is ever added, that invariant is what it breaks.
	//
	// If the HTTP surface ever needs a cap, it needs a SEPARATE method. The
	// export cannot tolerate a truncated one.
	AdminAuthored(ctx context.Context) ([]Technique, error)
}

// ValidateForWrite is every rule an admin-authored technique must pass.
//
// `known` is the catalog's existing position vocabulary. Both cross-references
// are checked against it rather than against a constant, because a position
// that no client recognises is the worst failure this data has: it seeds, it
// renders, and it returns an empty list forever with nothing reporting a fault.
func ValidateForWrite(t Technique, known []string) error {
	if err := ValidateFields(t); err != nil {
		return fmt.Errorf("%w: %s", ErrInvalidInput, err)
	}
	in := make(map[string]bool, len(known))
	for _, p := range known {
		in[p] = true
	}
	if !in[t.Position] {
		return fmt.Errorf("%w: position %q is not one the library uses — pick one of: %s",
			ErrInvalidInput, t.Position, strings.Join(known, ", "))
	}
	if t.ToPosition != "" && !in[t.ToPosition] {
		return fmt.Errorf("%w: to_position %q is not one the library uses", ErrInvalidInput, t.ToPosition)
	}
	return nil
}
