package curriculum

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The syllabuses are content, so most of what can go wrong is a typo. These run
// without a database wherever possible, because a check that needs
// TEST_DATABASE_URL is a check that skipped silently for months.

func TestTheSeedFileParsesAndIsShaped(t *testing.T) {
	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("no syllabuses — the embedded file is empty")
	}

	seen := map[string]bool{}
	for _, c := range data {
		if c.ID == "" || c.Name == "" || c.Belt == "" {
			t.Errorf("%q: id, name and belt are all required", c.ID)
		}
		if seen[c.ID] {
			// Two rows with one id means the second silently overwrites the
			// first on every deploy, and the file reads as if both shipped.
			t.Errorf("duplicate curriculum id %q", c.ID)
		}
		seen[c.ID] = true

		if len(c.Items) == 0 {
			t.Errorf("%q has no items", c.ID)
		}
		inThis := map[string]bool{}
		for i, it := range c.Items {
			if it.TechniqueID == "" {
				t.Errorf("%s item %d: empty technique_id", c.ID, i)
			}
			if inThis[it.TechniqueID] {
				// curriculum_items_technique_unique would reject this at seed
				// time, but on a deploy rather than here.
				t.Errorf("%s: %s appears twice", c.ID, it.TechniqueID)
			}
			inThis[it.TechniqueID] = true
		}
	}
}

// The two CHECK constraints, enforced here so a bad syllabus fails a test run
// rather than a production seed.
func TestEverySeededCriterionIsLegal(t *testing.T) {
	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	for _, c := range data {
		for _, it := range c.Items {
			hasVolume := it.TargetScored != nil || it.TargetDefended != nil

			// curriculum_items_hit_rate_needs_volume: a rate divides the
			// offensive attempt count, so on a defence-only item it would gate
			// on an unrelated number.
			if it.MinHitRate != nil && it.TargetScored == nil {
				t.Errorf("%s/%s: min_hit_rate without target_scored", c.ID, it.TechniqueID)
			}
			// curriculum_items_criteria_anchored: a criterion is anchored on
			// volume or it is not a criterion. Without this an item could be
			// completed on a 100%% hit rate from a single score.
			if !hasVolume && (it.TargetSessions != nil || it.MinHitRate != nil) {
				t.Errorf("%s/%s: criteria with no volume anchor", c.ID, it.TechniqueID)
			}
			// curriculum_items_targets_positive
			for name, v := range map[string]*int{
				"target_scored":   it.TargetScored,
				"target_defended": it.TargetDefended,
				"target_sessions": it.TargetSessions,
			} {
				if v != nil && *v <= 0 {
					t.Errorf("%s/%s: %s is %d, must be positive", c.ID, it.TechniqueID, name, *v)
				}
			}
			if it.MinHitRate != nil && (*it.MinHitRate <= 0 || *it.MinHitRate > 1) {
				t.Errorf("%s/%s: min_hit_rate %v out of range", c.ID, it.TechniqueID, *it.MinHitRate)
			}
		}
	}
}

// THE ONE THAT NEEDS A DATABASE: every technique_id has to exist in the library.
//
// A syllabus pointing at nothing is the failure most likely to ship — ids are
// hand-authored, the catalog is 466 entries, and nothing else checks. Seeding
// would fail loudly on deploy, which is late.
func TestEverySeededTechniqueExistsInTheLibrary(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	var libraryCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM techniques`).Scan(&libraryCount); err != nil {
		t.Fatalf("count techniques: %v", err)
	}
	if libraryCount == 0 {
		// Not a pass. An empty catalog would make every id below "missing",
		// which is a true statement about a database nobody seeded and tells
		// you nothing about the syllabuses.
		t.Skip("technique library is empty in the test database — run cmd/seed against it first")
	}

	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	for _, c := range data {
		for _, it := range c.Items {
			var exists bool
			err := pool.QueryRow(context.Background(),
				`SELECT true FROM techniques WHERE id = $1`, it.TechniqueID).Scan(&exists)
			if err != nil {
				t.Errorf("%s: technique %q is not in the library", c.ID, it.TechniqueID)
			}
		}
	}
}
