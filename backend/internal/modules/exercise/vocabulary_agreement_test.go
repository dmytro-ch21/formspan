package exercise

import (
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
)

// The two catalogs spell the same six words the same way — enforced, not asked.
//
// `status` and the four revision actions are declared separately in each module
// rather than shared, which is the right trade for six strings: a `content`
// package existing only to hold them would couple two domains that otherwise
// have nothing to say to each other. What that trade costs is a comment in each
// file asking the next person not to let them drift, and this repo's own note
// on the subject is that a vocabulary that drifts is its most-repeated failure.
// A comment is not a gate. This is.
//
// Drift is not theoretical and would not be loud. The console renders whatever
// string the API returns, so an exercise action of "published" against a
// technique action of "publish" produces a history that reads fine and a shared
// `RevisionHistory` component that cannot filter or style either consistently.
// The database CHECK constraints pin each side independently, so the two could
// disagree with every migration applied and every test but this one green.
//
// It lives here rather than in `technique` only because the dependency has to
// point one way; neither package imports the other, so there is no cycle.
func TestTheTwoCatalogsAgreeOnTheirSharedVocabulary(t *testing.T) {
	for _, c := range []struct {
		what              string
		exercise, techniq string
	}{
		{"status published", StatusPublished, technique.StatusPublished},
		{"status draft", StatusDraft, technique.StatusDraft},
		{"action create", ActionCreate, technique.ActionCreate},
		{"action update", ActionUpdate, technique.ActionUpdate},
		{"action publish", ActionPublish, technique.ActionPublish},
		{"action restore", ActionRestore, technique.ActionRestore},
	} {
		if c.exercise != c.techniq {
			t.Errorf("%s drifted: exercise %q, technique %q", c.what, c.exercise, c.techniq)
		}
	}
}
