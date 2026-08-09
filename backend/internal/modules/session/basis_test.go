package session

import "testing"

// The classification has to be total, and it has to fail loudly when it is not.
//
// A record kind with no basis is the failure this whole distinction exists to
// prevent: it would reach a client with nothing saying what sort of number it
// is, and every client renders an unclassified number as a measurement. So the
// interesting test is not "heaviest is measured" — it is "no kind escapes".
//
// Needs no database and no fixtures; these are pure vocabulary.

// recordedLoadTypes is the catalog's load-type vocabulary, mirroring the CHECK
// in migrations/000004_create_exercises.up.sql.
//
// Package-level and shared with onerm_test.go, which carried its own literal
// copy of the same list. Two hand-maintained copies of one vocabulary is two
// chances to forget the same thing — and the thing they guard is precisely
// "a new load type brought a new record kind and nobody classified it".
//
// It does not close the hole: a load type added to the migration and not to
// this list is still invisible to both guards. Deriving it from the CHECK
// constraint would need a database, which these tests deliberately do not use.
// One place to remember instead of three is the honest improvement here.
var recordedLoadTypes = []string{"weight_reps", "reps", "time", "distance", "distance_time"}

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
