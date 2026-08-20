package curriculum

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The belt roadmaps are authored FROM docs/design/bjj-belt-curriculum.md, which
// the user supplied and ruled authoritative (see the doc's own header). N97
// re-authored all four against it.
//
// This is the check that keeps that true. Without it "the order matches the
// document" is a claim in a PR description, and the next person to reorder a
// phase — or to edit the document — has nothing telling them the two have come
// apart. The failure mode is silent by construction: a curriculum with the
// wrong phase order is still a perfectly legal curriculum, seeds fine, renders
// fine, and simply teaches a different syllabus than the one that was agreed.
//
// It reads the document off disk rather than embedding it, because the file
// lives outside the Go module and `go:embed` cannot reach it. That makes the
// path the one thing that can rot, so an unreadable or unparseable document is
// a FAILURE here and never a skip — a skip would restore exactly the silence
// this exists to end.
const curriculumDoc = "../../../../docs/design/bjj-belt-curriculum.md"

// "## WHITE BELT — Learn the Basic Game" → "white".
var docBeltHeading = regexp.MustCompile(`(?m)^## ([A-Z]+) BELT\b`)

// "### 3. Understand Guard" → "3", "Understand Guard". The number is required:
// the per-belt "### White belt fundamental flow" section is not a milestone,
// and matching it would put an unnumbered heading into the middle of the list.
var docMilestone = regexp.MustCompile(`(?m)^### (\d+)\.\s+(.+?)\s*$`)

// docMilestones returns belt → ordered milestone titles, as the document has them.
func docMilestones(t *testing.T) map[string][]string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(curriculumDoc))
	if err != nil {
		t.Fatalf("read %s: %v — the belt roadmaps are authored from this file; "+
			"if it moved, move this test with it rather than deleting the check", curriculumDoc, err)
	}
	text := string(raw)

	heads := docBeltHeading.FindAllStringSubmatchIndex(text, -1)
	if len(heads) == 0 {
		t.Fatalf("%s has no belt headings — the parse below would report every belt as "+
			"matching nothing, which is not the same as the document being wrong", curriculumDoc)
	}

	out := map[string][]string{}
	for i, h := range heads {
		belt := strings.ToLower(text[h[2]:h[3]])
		end := len(text)
		if i+1 < len(heads) {
			end = heads[i+1][0]
		}
		var titles []string
		for _, m := range docMilestone.FindAllStringSubmatch(text[h[0]:end], -1) {
			titles = append(titles, m[2])
		}
		if len(titles) == 0 {
			t.Fatalf("%s: belt %q has no numbered milestones", curriculumDoc, belt)
		}
		out[belt] = titles
	}
	return out
}

// The acceptance criterion of N97, asserted rather than described: every belt
// roadmap's phases are the document's milestones, same titles, same order.
func TestEveryBeltRoadmapMatchesTheSuppliedDocument(t *testing.T) {
	want := docMilestones(t)

	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse seed: %v", err)
	}

	checked := 0
	for _, c := range data {
		if c.Track != "belt" {
			continue
		}
		titles, ok := want[c.Belt]
		if !ok {
			// A fifth belt roadmap with no counterpart in the document is not
			// something to pass over quietly: either the document gained a belt
			// and this curriculum was not re-authored, or a curriculum was added
			// from somewhere else entirely.
			t.Errorf("%s is on the belt track wearing belt %q, which %s does not describe",
				c.ID, c.Belt, curriculumDoc)
			continue
		}
		checked++

		got := make([]string, 0, len(c.Phases))
		for _, p := range c.Phases {
			got = append(got, p.Title)
		}
		if len(got) != len(titles) {
			t.Errorf("%s has %d milestones, the document has %d\n  got:  %v\n  want: %v",
				c.ID, len(got), len(titles), got, titles)
			continue
		}
		for i := range titles {
			if got[i] != titles[i] {
				t.Errorf("%s milestone %d is %q, the document says %q", c.ID, i+1, got[i], titles[i])
			}
		}
	}

	// Same guard as TestTheSeededTrackVocabularyIsClosed and for the same
	// reason: a filter that matches nothing reports success. If the `belt`
	// track is ever renamed, this test would go quietly green while checking
	// nothing at all.
	if checked != len(want) {
		t.Fatalf("compared %d belt roadmaps against %d belts in the document — "+
			"every belt the document describes must have a roadmap and vice versa", checked, len(want))
	}
}

// The other half, and the reason the ruling on the orphaned phases needs
// defending rather than merely recording.
//
// The seed used to open every belt with a `How this belt works` phase and close
// it with `The graduation standard`, neither of which the document has. N97
// removed both — a twelfth milestone the document does not carry would fail the
// test above — and moved their content into the curriculum DESCRIPTION, which
// both clients already render above the milestone list.
//
// So the description is now load-bearing content rather than a caption, and an
// empty or perfunctory one silently drops the belt's framing on the floor. That
// is invisible: a curriculum with no description renders as a list with no
// heading and looks merely plain.
func TestEveryBeltRoadmapExplainsItselfInItsDescription(t *testing.T) {
	data, err := SeedData()
	if err != nil {
		t.Fatalf("parse seed: %v", err)
	}
	const minDescription = 200

	checked := 0
	for _, c := range data {
		if c.Track != "belt" {
			continue
		}
		checked++
		if n := len(c.Description); n < minDescription {
			t.Errorf("%s has a %d-character description; it carries the belt's goal and its "+
				"fundamental flow now that the framing phases are gone (want >= %d)",
				c.ID, n, minDescription)
		}
		if !strings.Contains(strings.ToLower(c.Description), "goal") {
			t.Errorf("%s's description does not state the belt's goal, which is the half of the "+
				"retired `How this belt works` phase the document supplies", c.ID)
		}
	}
	if checked == 0 {
		t.Fatal("no curriculum is on the belt track, so this test asserted nothing")
	}
}
