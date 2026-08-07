package exercise

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/discipline"
)

// The write side of the exercise catalog, mirroring internal/modules/technique's
// content.go. Read that one first — the reasoning is the same and is written out
// there; this file records only what differs for exercises.

// ErrNotFound already exists in exercise.go — the read path has always needed
// it. These two are the write path's.
var (
	ErrAlreadyExists = errors.New("exercise: already exists")
	ErrInvalidInput  = errors.New("exercise: invalid input")
)

// slugUnsafe is everything that is not a lowercase letter, digit or hyphen.
var slugUnsafe = regexp.MustCompile(`[^a-z0-9]+`)

// Slug derives the permanent id from the name.
//
// The same rule the technique catalog uses, and duplicated rather than shared
// for the same reason a second copy is usually wrong: the two catalogs are
// separate modules with separate vocabularies, and importing one into the other
// to save twelve lines couples them. If a third catalog appears, promote it.
//
// The id outlives every other field — it is a foreign key in workout items and
// logged sets — so it is derived once at creation and never from an update.
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
	return strings.Trim(slugUnsafe.ReplaceAllString(b.String(), "-"), "-")
}

// foldASCII covers the accented letters that turn up in exercise vocabulary —
// far less than in grappling, but "Bulgarian split squat" is not the only name
// somebody types with a diacritic. Deliberately not full Unicode normalisation;
// a missing letter produces a slightly uglier slug, not wrong data.
var foldASCII = map[rune]string{
	'á': "a", 'à': "a", 'â': "a", 'ã': "a", 'ä': "a", 'å': "a",
	'é': "e", 'è': "e", 'ê': "e", 'ë': "e",
	'í': "i", 'ì': "i", 'î': "i", 'ï': "i",
	'ó': "o", 'ò': "o", 'ô': "o", 'õ': "o", 'ö': "o",
	'ú': "u", 'ù': "u", 'û': "u", 'ü': "u",
	'ç': "c", 'ñ': "n", 'ß': "ss",
}

// ContentRepository is the write side of the catalog.
//
// Note what is ABSENT: nothing here touches media. Media lives in its own table
// (`exercise_media`) keyed by exercise id, so an admin write to `exercises`
// cannot clobber it — which is what makes authoring safe without an upload
// path. An exercise authored here simply has none, and a later deploy can add
// some without the console having to know.
// Revision is one recorded state of an exercise, as it looked after a console
// write. The twin of technique.Revision — see migration 000039.
type Revision struct {
	Revision  int       `json:"revision"`
	Actor     string    `json:"actor"`
	Action    string    `json:"action"`
	Payload   Exercise  `json:"payload"`
	CreatedAt time.Time `json:"created_at"`
}

// The four things that produce a revision. Same vocabulary as the technique
// catalog's, and the same warning applies: one concept, one contract enum, so
// they must not drift.
const (
	ActionCreate  = "create"
	ActionUpdate  = "update"
	ActionPublish = "publish"
	ActionRestore = "restore"
)

type ContentRepository interface {
	// CreateExercise writes a new admin-authored exercise. ErrAlreadyExists if
	// the id is taken, including by a seeded row — an admin row shadowing a
	// seeded id would be skipped by the deploy's upsert, leaving the two to
	// disagree forever.
	//
	// `actor` is the caller's own id from the request's claims, never a value a
	// client sent — a parameter rather than a field on Exercise, because a
	// field there is a field a JSON body could set.
	CreateExercise(ctx context.Context, e Exercise, actor string) (Exercise, error)
	// UpdateExercise edits ANY exercise and takes ownership of it: the write
	// sets `source` to "admin", which the seeder skips. Without that flip the
	// next deploy would silently revert the edit. ErrNotFound now means only
	// that the id does not exist.
	UpdateExercise(ctx context.Context, e Exercise, actor string) (Exercise, error)
	// Publish makes a draft visible to athletes. One-way.
	Publish(ctx context.Context, id, actor string) (Exercise, error)
	// SearchAll reaches the whole catalog, seeded rows included.
	SearchAll(ctx context.Context, query string) ([]Exercise, error)
	// Revisions returns the history, newest first; empty for an untouched row.
	Revisions(ctx context.Context, id string) ([]Revision, error)
	// Restore writes an earlier revision's content back as a new revision.
	Restore(ctx context.Context, id string, revision int, actor string) (Exercise, error)
	// GetExercise reads the current row so a partial update can overlay onto it.
	GetExercise(ctx context.Context, id string) (Exercise, error)
	// AdminAuthored returns every console-authored exercise.
	//
	// DELIBERATELY UNCAPPED, for the reason spelled out on the technique
	// interface: cmd/exportcontent reads the same method, the export MERGES
	// rather than replaces, and a LIMIT would therefore not error anywhere — the
	// newest rows would simply never reach the seed files. If the HTTP surface
	// ever needs a cap it needs a separate method.
	AdminAuthored(ctx context.Context) ([]Exercise, error)
	// AdoptAsSeeded hands rows to the deploy once the exported JSON is released.
	AdoptAsSeeded(ctx context.Context, ids []string) error
}

// ValidateForWrite is every rule an admin-authored exercise must satisfy.
//
// Deliberately reuses the SAME vocabularies the seeder validates against
// (`validMovementPatterns`, `validLoadTypes`, `discipline.ValidSport`) rather
// than restating them. Two validators for one catalog is how a vocabulary
// drifts, and a movement_pattern no rule recognises is the worst kind of bad
// data here: it seeds, it renders, and it silently drops the exercise out of
// every cross-sport rule that reasons over the pattern — being wrong looks
// exactly like being right.
func ValidateForWrite(e Exercise) error {
	switch {
	case e.ID == "":
		return fmt.Errorf("%w: entry %q has no id", ErrInvalidInput, e.Name)
	case e.Name == "":
		return fmt.Errorf("%w: %q needs a name", ErrInvalidInput, e.ID)
	case len(e.Name) > maxNameLen || len(e.ID) > maxNameLen:
		// The id is DERIVED from the name and permanent — a foreign key in
		// workout items and logged sets. Unbounded, a long name either fails on
		// Postgres's btree limit or, worse, succeeds and mints an id nobody can
		// take back. The longest name in the shipped catalog is 63 characters.
		return fmt.Errorf("%w: %q name is too long (max %d)", ErrInvalidInput, e.ID, maxNameLen)
	case !discipline.ValidSport(e.Sport):
		return fmt.Errorf("%w: %q has unknown sport %q", ErrInvalidInput, e.ID, e.Sport)
	case !validMovementPatterns[e.MovementPattern]:
		return fmt.Errorf("%w: %q has unknown movement_pattern %q — the coarse vocabulary the cross-sport rules read is: %s",
			ErrInvalidInput, e.ID, e.MovementPattern, strings.Join(sortedKeys(validMovementPatterns), ", "))
	case !validLoadTypes[e.LoadType]:
		return fmt.Errorf("%w: %q has unknown load_type %q — one of: %s",
			ErrInvalidInput, e.ID, e.LoadType, strings.Join(loadTypeNames(), ", "))
	}
	return nil
}

// maxNameLen bounds the name, and therefore the derived id.
const maxNameLen = 200

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func loadTypeNames() []string {
	out := make([]string, 0, len(validLoadTypes))
	for k := range validLoadTypes {
		out = append(out, string(k))
	}
	sort.Strings(out)
	return out
}
