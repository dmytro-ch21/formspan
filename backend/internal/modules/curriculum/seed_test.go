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

// carriesCriteria is the five-field check, in ONE place. It was written out
// three times across this file before review pointed out that a sixth criterion
// field on SeedItem would have to be remembered in all of them.
func carriesCriteria(it SeedItem) bool {
	return it.TargetScored != nil || it.TargetDefended != nil ||
		it.TargetSessions != nil || it.MinHitRate != nil ||
		it.TargetDrilledSessions != nil
}

// The track vocabulary is CLOSED, and this is the assertion that makes the two
// guards below mean what they say.
//
// Both of them filter on an exact track string. Without this, a curriculum on a
// typo'd track — "sylabus" — escapes both entirely, and so does any track added
// later. Review found the hole by noticing that `novice-fundamentals` was
// already outside them: it is a roadmap with ten countable items on the
// `foundations` track, and stripping every criterion from it left the whole
// suite green.
func TestTheSeededTrackVocabularyIsClosed(t *testing.T) {
	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse seed: %v", err)
	}
	known := map[string]bool{"belt": true, "foundations": true, "syllabus": true}
	seen := map[string]bool{}
	for _, c := range data {
		if c.Track == "" {
			t.Errorf("%s has no track; every VOLA-authored curriculum belongs to a browse section", c.ID)
			continue
		}
		if !known[c.Track] {
			t.Errorf("%s is on unknown track %q — add it to this list and to the guards below, "+
				"or it is silently exempt from both", c.ID, c.Track)
		}
		seen[c.Track] = true
	}
	for tr := range known {
		if !seen[tr] {
			t.Errorf("no seeded curriculum is on track %q, so the guards keyed on it check nothing", tr)
		}
	}
}

// The syllabus track's defining property, asserted rather than assumed.
//
// A reference is consulted and a roadmap is worked, and the ONLY thing in the
// data separating them is whether items carry criteria: `countable_items` is
// what both clients switch on to decide whether to draw progress at all. A
// criterion authored onto a syllabus item would silently turn a reference into
// a roadmap nobody can finish — 73 milestones on white belt alone — and no
// existing test would notice, because a legal criterion is legal wherever it
// appears.
func TestNothingOnTheSyllabusTrackIsCompletable(t *testing.T) {
	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse seed: %v", err)
	}

	syllabuses := 0
	for _, c := range data {
		if c.Track != "syllabus" {
			continue
		}
		syllabuses++
		items := allItems(c)
		if len(items) == 0 {
			t.Errorf("%s is on the syllabus track with no items, so this checked nothing", c.ID)
		}
		for _, it := range items {
			if carriesCriteria(it) {
				t.Errorf("%s: item %q carries criteria; a syllabus is reference, not a roadmap",
					c.ID, it.TechniqueID+it.Title)
			}
		}
	}
	if syllabuses == 0 {
		t.Fatal("no curriculum is on the syllabus track, so this test asserted nothing")
	}
}

// The other half of the same distinction, over EVERY non-syllabus track rather
// than just "belt" — which is the fix for the hole described above. Without
// this, deleting every criterion in the file would satisfy the test above and
// quietly turn the whole feature into reading material.
func TestEveryNonSyllabusCurriculumStillHasMilestones(t *testing.T) {
	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse seed: %v", err)
	}
	checked := 0
	for _, c := range data {
		if c.Track == "syllabus" {
			continue
		}
		checked++
		countable := 0
		for _, it := range allItems(c) {
			if carriesCriteria(it) {
				countable++
			}
		}
		if countable == 0 {
			t.Errorf("%s is on track %q with nothing completable in it", c.ID, c.Track)
		}
	}
	if checked == 0 {
		t.Fatal("every seeded curriculum is a syllabus, so this test asserted nothing")
	}
}

// N110 (#480), completed by F28 (#720): the belt/syllabus PAIRING — every
// belt has exactly one syllabus and vice versa — AND, now that the content
// is reconciled, the phase-title/order parity N110 originally asked for.
//
// A belt's roadmap (`<belt>-belt-basics`, track "belt") and its reference
// syllabus (`<belt>-belt-syllabus`, track "syllabus") are meant to be one
// spine at two depths — the syllabus is what exists, the roadmap is the
// worked subset an athlete is measured on — and they share a Belt value.
// Before N110 landed, nothing in the suite asserted the pairing at all: a
// belt could lose its syllabus, or a syllabus its belt, and every other
// guard in this file would stay green, because each of them iterates ONE
// track at a time.
//
// # Why the phase-title/order half took a second ticket
//
// N110 was filed on the claim that "a belt's roadmap and its syllabus share
// their phase titles and their order, and differ only in depth and in
// whether items carry criteria." PR #719 measured that claim against the
// embedded content (per this repo's "verify that a check can fail" rule)
// and found it false on every one of the four pairs: white and purple
// matched in phase COUNT (11/11, 10/10) but not in title TEXT — the roadmap
// carries docs/design/bjj-belt-curriculum.md's Title Case milestone names
// verbatim (TestEveryBeltRoadmapMatchesTheSuppliedDocument in
// document_test.go enforces that) while the syllabus predated that document
// (N20/#277) and read in its own sentence-case narrative voice; blue and
// brown additionally disagreed on phase COUNT (10 vs 9, 10 vs 7), so no
// title normalisation alone could have closed the gap. #719 shipped the
// weaker pairing-only guard below rather than commit a permanently-red
// literal test, and filed F28 (#720) to do the content reconciliation this
// stronger assertion needed to be buildable at all.
//
// F28 did that reconciliation directly in curricula.json: white and purple's
// syllabus phase titles were rewritten to the roadmap's Title Case wording
// (purple also needed its phases REORDERED — its content was not
// positionally aligned with the roadmap the way white's was, despite the
// matching count — and one pair of phases merged); blue and brown's syllabus
// phase counts were brought in line with their roadmaps by moving existing
// items between phases and, where a roadmap milestone had no syllabus
// content at all, adding a phase for it (backfilled from the roadmap's own
// items/concepts, never invented). See the 2026-08-28 and F28 history
// entries for the full per-belt mapping and reasoning.
func TestEveryBeltRoadmapAndSyllabusPairAndAgreeOnPhases(t *testing.T) {
	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse seed: %v", err)
	}

	roadmaps := map[string]SeedCurriculum{}   // belt -> curriculum
	syllabuses := map[string]SeedCurriculum{} // belt -> curriculum
	for _, c := range data {
		switch c.Track {
		case "belt":
			if prev, dup := roadmaps[c.Belt]; dup {
				t.Errorf("two curricula on the belt track share belt %q: %s and %s", c.Belt, prev.ID, c.ID)
				continue
			}
			roadmaps[c.Belt] = c
		case "syllabus":
			if prev, dup := syllabuses[c.Belt]; dup {
				t.Errorf("two curricula on the syllabus track share belt %q: %s and %s", c.Belt, prev.ID, c.ID)
				continue
			}
			syllabuses[c.Belt] = c
		}
	}

	if len(roadmaps) == 0 {
		t.Fatal("no curriculum is on the belt track, so this test asserted nothing")
	}
	if len(syllabuses) == 0 {
		t.Fatal("no curriculum is on the syllabus track, so this test asserted nothing")
	}

	// novice-fundamentals is handled EXPLICITLY, not by silent exemption: it
	// carries no Belt at all (it sits on the "foundations" track instead), so
	// it can never appear in either map above. Assert that stays true, so a
	// FUTURE syllabus authored for it doesn't quietly go unpaired the same
	// way a belt/syllabus pair could.
	found := false
	for _, c := range data {
		if c.ID != "novice-fundamentals" {
			continue
		}
		found = true
		if c.Track != "foundations" || c.Belt != "" {
			t.Errorf("novice-fundamentals is the one curriculum expected to have no belt/syllabus "+
				"counterpart, on track %q with no belt — got track=%q belt=%q; if that changed, it may "+
				"now need a counterpart on the other track", "foundations", c.Track, c.Belt)
		}
	}
	if !found {
		t.Error("novice-fundamentals is missing entirely — this test's handling of curricula with no " +
			"counterpart assumes it exists and is exempt by design, not by accident")
	}

	checked := 0
	for belt, roadmap := range roadmaps {
		syllabus, ok := syllabuses[belt]
		if !ok {
			t.Errorf("%s (belt %q) has no syllabus counterpart", roadmap.ID, belt)
			continue
		}
		checked++

		// The stronger invariant N110 asked for: same phase titles, same
		// order. Compared by index rather than by set, so a REORDER (not
		// just a rename or a drop) is caught too — the purple belt
		// reconciliation needed exactly that distinction, since its old
		// syllabus phases existed but were not positionally aligned with
		// the roadmap.
		rt := make([]string, len(roadmap.Phases))
		for i, p := range roadmap.Phases {
			rt[i] = p.Title
		}
		st := make([]string, len(syllabus.Phases))
		for i, p := range syllabus.Phases {
			st[i] = p.Title
		}
		if len(rt) != len(st) {
			t.Errorf("%s has %d phases, its syllabus counterpart %s has %d\n  roadmap:  %v\n  syllabus: %v",
				roadmap.ID, len(rt), syllabus.ID, len(st), rt, st)
			continue
		}
		for i := range rt {
			if rt[i] != st[i] {
				t.Errorf("%s phase %d is %q, %s phase %d is %q — roadmap and syllabus must carry "+
					"identical phase titles in identical order",
					roadmap.ID, i, rt[i], syllabus.ID, i, st[i])
			}
		}
	}
	for belt, syllabus := range syllabuses {
		if _, ok := roadmaps[belt]; !ok {
			t.Errorf("%s (belt %q) has no belt-track counterpart", syllabus.ID, belt)
		}
	}
	if checked == 0 {
		t.Fatal("checked zero belt/syllabus pairs")
	}
}
