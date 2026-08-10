package session

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The classification has to be total, and it has to fail loudly when it is not.
//
// A record kind with no basis is the failure this whole distinction exists to
// prevent: it would reach a client with nothing saying what sort of number it
// is, and every client renders an unclassified number as a measurement. So the
// interesting test is not "heaviest is measured" — it is "no kind escapes".
//
// Needs no database and no fixtures; these are pure vocabulary.

// recordedLoadTypes is the catalog's load-type vocabulary, READ FROM THE
// MIGRATION rather than copied out of it.
//
// It was a literal list in two test files, and that left the hole this guard is
// supposed to close: a load type added to the schema and not to the list is
// invisible to every check below, so the new record kind it brings goes
// unclassified and renders as a measurement. A hand-copied vocabulary cannot
// guard against forgetting to update a hand-copied vocabulary.
//
// Parsing the CHECK needs no database — the migration is a file, and the
// constraint is the same text `migrate up` will apply. That is the whole reason
// this is sound: there is no second source to drift from, and a database would
// only tell us what this file already says.
//
// Panics rather than returning an error. A parse that quietly returned nothing
// would make every loop below pass by iterating zero times, which is the exact
// failure mode `TestAllRecordKinds_CoversTheVocabulary` exists to prevent.
var recordedLoadTypes = loadTypesFromMigration()

func loadTypesFromMigration() []string {
	// Every up migration, not the one file that happened to create the table.
	// Pinned to 000004 this parse was a hand-copy one notch removed: an ALTER
	// in a later migration lengthening the IN-list would leave this reading the
	// original five values with no error — the same silent short list, sourced
	// from a stale file instead of a stale literal. Migrations are zero-padded,
	// so Glob's sorted order is application order and the last file carrying
	// the constraint is the one the schema actually ends up with.
	//
	// The parse's contract: supersession must be WRITTEN as another
	// `load_type IN (...)` list. An `= ANY (ARRAY[...])` rewrite or a
	// conversion to an enum type is invisible here and would leave this
	// silently reading the superseded list — keep the IN form.
	const glob = "../../../migrations/*.up.sql"
	paths, err := filepath.Glob(glob)
	if err != nil || len(paths) == 0 {
		panic(fmt.Sprintf("session: cannot list the migrations (%s): %v", glob, err))
	}
	// `load_type IN ('weight_reps', 'reps', ...)` — anchored on the column at
	// both ends so a different IN-list cannot be picked up by accident: `\b`
	// on the left, or a future `payload_type IN (...)` in a later file would
	// supersede the real list with no error.
	re := regexp.MustCompile(`\bload_type\s+IN\s*\(([^)]*)\)`)
	var list []byte
	var from string
	for _, p := range paths {
		src, err := os.ReadFile(p)
		if err != nil {
			panic(fmt.Sprintf("session: cannot read migration %s: %v", p, err))
		}
		for _, m := range re.FindAllSubmatch(src, -1) {
			// A later file superseding an earlier one is the point of the scan.
			// Two DISTINCT lists in the SAME file is something else: there is
			// no order to break the tie, so refuse to guess which is the
			// constraint.
			if from == p && !bytes.Equal(m[1], list) {
				panic(fmt.Sprintf("session: %s has two different `load_type IN (...)` lists — cannot tell which is the CHECK", p))
			}
			list, from = m[1], p
		}
	}
	if from == "" {
		panic("session: no migration has a `load_type IN (...)` CHECK — did it move or get renamed?")
	}
	// `[^']+`, not `[a-z_]+`. The narrow class silently DROPPED any value with a
	// digit or a capital in it — a future `'zone2'` parsed back to the original
	// five with no error, which is the same silent short list this whole
	// derivation exists to prevent, one notch narrower. Raised in review.
	var out []string
	for _, q := range regexp.MustCompile(`'([^']+)'`).FindAllSubmatch(list, -1) {
		out = append(out, string(q[1]))
	}
	// Every value is two quotes, so a parse that missed one is arithmetic rather
	// than a judgement call. `len(out) == 0` alone only catches total failure.
	if quotes := bytes.Count(list, []byte("'")); quotes != 2*len(out) {
		panic(fmt.Sprintf(
			"session: the load_type CHECK has %d quote characters but parsed %d values — the parse is dropping some",
			quotes, len(out)))
	}
	if len(out) == 0 {
		panic("session: parsed the load_type CHECK but found no values in it")
	}
	return out
}

// allRecordKinds is the vocabulary, written out.
//
// Deliberately a literal list rather than one derived from `RecordKindsFor`,
// which only returns the kinds reachable from a load type. Deriving it would
// make this test agree with whatever that function happens to cover, and a kind
// added to the vocabulary but not yet wired to a load type — exactly the state
// a new record is in while it is being built — would slip through unclassified.
var allRecordKinds = []RecordKind{
	RecordHeaviest,
	RecordOneRM,
	RecordMostReps,
	RecordLongest,
	RecordFurthest,
}

func TestBasisFor_ClassifiesEveryRecordKind(t *testing.T) {
	for _, k := range allRecordKinds {
		b, ok := BasisFor(k)
		if !ok {
			t.Errorf("record kind %q has no basis: add it to BasisFor", k)
			continue
		}
		if b != Measured && b != Modelled && b != Reported {
			t.Errorf("record kind %q has basis %q, which is not one of the three", k, b)
		}
	}
}

// Guards the guard. If `allRecordKinds` drifts below the real vocabulary, the
// loop above passes by checking fewer things — the same way a walker pointed at
// the wrong directory passes by finding nothing.
func TestAllRecordKinds_CoversTheVocabulary(t *testing.T) {
	// Every kind any load type can produce must appear in the list above.
	for _, lt := range recordedLoadTypes {
		for _, k := range RecordKindsFor(lt) {
			found := false
			for _, known := range allRecordKinds {
				if known == k {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("load type %q produces record kind %q, which allRecordKinds omits", lt, k)
			}
		}
	}
}

// The one classification with a consequence, pinned against a literal.
//
// `estimated_1rm` is the only modelled record, and it is modelled *because* the
// query behind it folds RIR/RPE into effective reps. If someone ever reclassifies
// it as measured, the clients stop labelling it and it becomes a self-rating
// rendered as a measurement — which is the defect, restored.
func TestBasisFor_EstimatedOneRMIsModelled(t *testing.T) {
	b, ok := BasisFor(RecordOneRM)
	if !ok {
		t.Fatal("estimated_1rm has no basis")
	}
	if b != Modelled {
		t.Errorf("estimated_1rm basis = %q, want %q — it consumes RIR/RPE as effective reps", b, Modelled)
	}
}

// The measured kinds must not quietly become modelled either. Stated as a
// literal so a blanket change to BasisFor cannot satisfy both this and the test
// above by returning one value for everything.
func TestBasisFor_LoggedSetsAreMeasured(t *testing.T) {
	for _, k := range []RecordKind{RecordHeaviest, RecordMostReps, RecordLongest, RecordFurthest} {
		b, _ := BasisFor(k)
		if b != Measured {
			t.Errorf("%s basis = %q, want %q — it is what was logged", k, b, Measured)
		}
	}
}

func TestBasisFor_RejectsAnUnknownKind(t *testing.T) {
	if _, ok := BasisFor(RecordKind("vibes")); ok {
		t.Error("BasisFor accepted an unknown kind; an unclassified number renders as a measurement")
	}
}
