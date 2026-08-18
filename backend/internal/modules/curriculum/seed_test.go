package curriculum

import (
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
)

// The syllabuses are content, so most of what can go wrong is a typo. These run
// without a database at all — a check that needs TEST_DATABASE_URL is a check
// that skipped silently for months.

// allItems walks a curriculum the way the seeder does: flat items first, then
// each phase's, so every shape check below covers both formats.
func allItems(c SeedCurriculum) []SeedItem {
	out := append([]SeedItem{}, c.Items...)
	for _, p := range c.Phases {
		out = append(out, p.Items...)
	}
	return out
}

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
		if c.ID == "" || c.Name == "" {
			t.Errorf("%q: id and name are required", c.ID)
		}
		if seen[c.ID] {
			// Two rows with one id means the second silently overwrites the
			// first on every deploy, and the file reads as if both shipped.
			t.Errorf("duplicate curriculum id %q", c.ID)
		}
		seen[c.ID] = true

		for i, p := range c.Phases {
			if p.Title == "" {
				// curriculum_phases_title_nonempty, caught before a deploy.
				t.Errorf("%s phase %d has no title", c.ID, i)
			}
		}

		items := allItems(c)
		if len(items) == 0 {
			t.Errorf("%q has no items", c.ID)
		}
		inThis := map[string]bool{}
		for i, it := range items {
			// The shape rules the curriculum_items_kind_shape CHECK enforces,
			// caught here rather than on a deploy.
			switch it.Kind {
			case "", "technique":
				if it.TechniqueID == "" {
					t.Errorf("%s item %d: empty technique_id", c.ID, i)
				}
				if it.Title != "" {
					t.Errorf("%s item %d (%s): a technique's name is the library's, not %q",
						c.ID, i, it.TechniqueID, it.Title)
				}
			case "concept":
				if it.Title == "" {
					t.Errorf("%s item %d: a concept needs a title", c.ID, i)
				}
				if it.TechniqueID != "" {
					t.Errorf("%s item %d (%s): a concept points at nothing", c.ID, i, it.Title)
				}
				if it.TargetScored != nil || it.TargetDefended != nil ||
					it.TargetSessions != nil || it.MinHitRate != nil ||
					it.TargetDrilledSessions != nil {
					t.Errorf("%s item %d (%s): a concept cannot carry criteria — no evidence stream could measure it",
						c.ID, i, it.Title)
				}
				continue
			default:
				t.Errorf("%s item %d: unknown kind %q", c.ID, i, it.Kind)
				continue
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
		for _, it := range allItems(c) {
			hasVolume := it.TargetScored != nil || it.TargetDefended != nil ||
				it.TargetDrilledSessions != nil

			// curriculum_items_hit_rate_needs_volume: a rate divides the
			// offensive attempt count, so on a defence-only item it would gate
			// on an unrelated number.
			if it.MinHitRate != nil && it.TargetScored == nil {
				t.Errorf("%s/%s: min_hit_rate without target_scored", c.ID, it.TechniqueID)
			}
			// curriculum_items_criteria_anchored: a criterion is anchored on
			// volume — offensive, defensive, or drilled spread — or it is not a
			// criterion. Without this an item could be completed on a 100%% hit
			// rate from a single score.
			if !hasVolume && (it.TargetSessions != nil || it.MinHitRate != nil) {
				t.Errorf("%s/%s: criteria with no volume anchor", c.ID, it.TechniqueID)
			}
			// curriculum_items_targets_positive
			for name, v := range map[string]*int{
				"target_scored":           it.TargetScored,
				"target_defended":         it.TargetDefended,
				"target_sessions":         it.TargetSessions,
				"target_drilled_sessions": it.TargetDrilledSessions,
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

// THE REFERENTIAL ONE: every technique_id has to exist in the library.
//
// A syllabus pointing at nothing is the failure most likely to ship — ids are
// hand-authored, the catalog is 542 entries, and nothing else checks. Seeding
// would fail loudly on deploy, which is late.
//
// Reads the EMBEDDED catalog, not the database, so it runs everywhere —
// including CI, which only migrates and never seeds. It used to query
// `techniques` and skip when that table was empty, which meant it skipped in
// exactly the place it most needed to run: measured against a freshly migrated,
// unseeded database, 597 passed / 1 skipped / exit 0, so the suite reported
// success while this assertion never executed once on the deploy path. Same
// fix and same reasoning as bjj's TestTheShippedLibraryStaysUnderTheProficiencyCap,
// which was written from this identical mistake.
//
// Both sides of the comparison are content files, and that is what makes the
// database unnecessary rather than merely inconvenient: `cmd/seed` inserts
// techniques from techniques.json and *then* curricula from curricula.json, so
// an id missing from that catalog is precisely and only what breaks the deploy.
// Querying a live table is in fact the WEAKER check — a hand-seeded local
// database also holds whatever the admin console authored (source='admin'), any
// of which would satisfy the foreign key for an id that no fresh deploy has.
func TestEverySeededTechniqueExistsInTheLibrary(t *testing.T) {
	catalog, err := technique.SeedData()
	if err != nil {
		t.Fatalf("read embedded catalog: %v", err)
	}
	// Not a skip. An empty catalog would make every id below "missing", which
	// tells you nothing about the syllabuses — but it is unreachable by
	// environment here (the file is compiled in), so it can only mean somebody
	// emptied techniques.json, and that is a failure rather than a condition.
	if len(catalog) == 0 {
		t.Fatal("the embedded technique catalog is empty")
	}
	inLibrary := make(map[string]bool, len(catalog))
	for _, tech := range catalog {
		inLibrary[tech.ID] = true
	}

	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// The same guard on the other side, for the same reason. An empty
	// curricula.json makes the loop below iterate nothing and report success —
	// and while TestTheSeedFileParsesAndIsShaped would also fail on that, it
	// does not run under a `-run` filter naming only this test, which is
	// exactly how this test gets invoked when somebody is investigating it.
	// A test whose whole point is that it never passes vacuously should not
	// depend on a sibling for that.
	if len(data) == 0 {
		t.Fatal("no syllabuses — the embedded file is empty")
	}
	for _, c := range data {
		for _, it := range allItems(c) {
			if it.Kind == "concept" {
				// A concept points at nothing, so there is nothing to check.
				continue
			}
			if !inLibrary[it.TechniqueID] {
				t.Errorf("%s: technique %q is not in the library", c.ID, it.TechniqueID)
			}
		}
	}
}

// The syllabus track's defining property, asserted rather than assumed.
//
// A reference is consulted and a roadmap is worked, and the ONLY thing in the
// data that separates them is whether items carry criteria: `countable_items`
// is what both clients switch on to decide whether to draw progress at all. A
// criterion authored onto a syllabus item would silently turn a reference into
// a roadmap nobody can finish — 73 milestones on white belt alone — and no
// existing test would notice, because a legal criterion is legal wherever it
// appears.
func TestNothingOnTheSyllabusTrackIsCompletable(t *testing.T) {
	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse seed: %v", err)
	}

	carries := func(it SeedItem) bool {
		return it.TargetScored != nil || it.TargetDefended != nil ||
			it.TargetSessions != nil || it.MinHitRate != nil ||
			it.TargetDrilledSessions != nil
	}

	syllabuses := 0
	for _, c := range data {
		if c.Track != "syllabus" {
			continue
		}
		syllabuses++
		items := 0
		for _, ph := range c.Phases {
			for _, it := range ph.Items {
				items++
				if carries(it) {
					t.Errorf("%s: item %q carries criteria; a syllabus is reference, not a roadmap",
						c.ID, it.TechniqueID+it.Title)
				}
			}
		}
		for _, it := range c.Items {
			items++
			if carries(it) {
				t.Errorf("%s: item %q carries criteria; a syllabus is reference, not a roadmap",
					c.ID, it.TechniqueID+it.Title)
			}
		}
		if items == 0 {
			t.Errorf("%s is on the syllabus track with no items, so this checked nothing", c.ID)
		}
	}
	if syllabuses == 0 {
		t.Fatal("no curriculum is on the syllabus track, so this test asserted nothing")
	}
}

// The other half of the same distinction. Without this, deleting every
// criterion in the file would satisfy the test above and quietly turn the whole
// feature into reading material.
func TestEveryBeltRoadmapStillHasMilestones(t *testing.T) {
	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse seed: %v", err)
	}
	checked := 0
	for _, c := range data {
		if c.Track != "belt" {
			continue
		}
		checked++
		countable := 0
		for _, ph := range c.Phases {
			for _, it := range ph.Items {
				if it.TargetScored != nil || it.TargetDefended != nil ||
					it.TargetSessions != nil || it.MinHitRate != nil ||
					it.TargetDrilledSessions != nil {
					countable++
				}
			}
		}
		if countable == 0 {
			t.Errorf("%s is a belt roadmap with nothing completable in it", c.ID)
		}
	}
	if checked == 0 {
		t.Fatal("no curriculum is on the belt track, so this test asserted nothing")
	}
}
