package session

// Basis says what kind of number something is: what happened, what was derived
// from what happened, or what the athlete thought about it.
//
// # Why this exists
//
// "What you did" and "how it felt" are different kinds of data, and they were
// sitting in the same structs and rendering in the same rows with nothing
// marking which was which. A BJJ session detail put "60 min on the mat", "25
// min rolling" and "— effort" in three identical tiles: two measurements and an
// opinion, given equal weight by the layout. A records list puts a heaviest
// lift beside an estimated 1RM the same way.
//
// The risk is not that today's code averages a rating into a metric — nothing
// does. It is that nothing STOPS the next reader from doing it, and the result
// would be a number that looks like a measurement and is not.
//
// # Why three and not two
//
// A measured/subjective binary cannot describe `estimated_1rm`, and this app
// already knows it. `apps/mobile/lib/units.ts` renders an estimate at whole
// display units precisely because "a logged set is a measurement — 62.55kg is
// what was on the bar. A one-rep max derived from a rep-max curve is not, and
// '143.88kg' invites reading a modelled number as a measured one." That
// distinction was already correct; it was only living in a formatter.
//
// So: an estimate is its own kind. It is not a measurement, and it is not an
// opinion either — it is a documented formula over both.
//
// # The reading rules
//
// These are the point of the file. Each is a rule about what may be computed
// from what, and each is enforced or pinned somewhere rather than only stated:
//
//  1. A MEASURED value is never judged, ranked or gated by a REPORTED one. A
//     heaviest lift is the heaviest lift whether it felt easy or awful, and a
//     record that could be beaten by claiming a harder RPE would not be a
//     record.
//
//  2. A MODELLED value MAY consume reported inputs — but it must say that it
//     is modelled, and it must be able to state what went into it. This is the
//     rule that keeps `estimated_1rm` honest rather than banning it: RIR is
//     genuinely how a submaximal set becomes a one-rep-max estimate, and
//     stripping it out would make the estimate worse, not more objective. What
//     was wrong was never the arithmetic; it was that the output rendered as a
//     peer of the measured record beside it.
//
//  3. No aggregate may span a window in which a reported input was collected
//     for only part of the time. `TrackEffortProvider` lets an athlete turn
//     RIR/RPE collection off and on at will, so an average over such a window
//     is computed from a silently changing sample — and the change is invisible
//     in the output. Nothing aggregates a reported value today. Writing the
//     rule while that is still true is the cheap moment.
//
// # Why a marker and not separate tables
//
// The alternatives were separate tables, or a nested `reported` object in the
// wire payloads. Both move field shapes, and the fields in question
// (`session_sets.rir`/`rpe`, `bjj_session_details.session_rpe`) are carried by
// the offline outbox, the SQLite mirror on every phone and a hand-maintained
// OpenAPI contract. That is a large, migration-shaped change to express a
// distinction a marker expresses exactly as well.
//
// The marker is also the more honest model of the thing: `rir` is not stored in
// the wrong place. It belongs on the set it describes. What was missing was the
// statement that it is a different KIND of fact from the reps beside it.
//
// # Why the classification is per-vocabulary and not per-row
//
// `BasisFor` maps a `RecordKind`, not a `Record`. The basis is a property of
// the vocabulary — every `estimated_1rm` that has ever existed is modelled —
// so serving it per row would ship a constant on every record and let a cached
// row carry a stale classification if the vocabulary ever changed. The clients
// derive it from `kind` the same way, and `basisParity` keeps the copies
// honest.
type Basis string

const (
	// Measured is what happened, as recorded: the weight on the bar, the reps
	// completed, the seconds held, the rounds rolled.
	Measured Basis = "measured"
	// Modelled is derived from measurements by a documented formula, and may
	// legitimately consume reported inputs. See rule 2.
	Modelled Basis = "modelled"
	// Reported is the athlete's own account: RIR, RPE, session RPE, notes. True
	// as a report, and never evidence of a measurement.
	Reported Basis = "reported"
)

// BasisFor classifies a record kind.
//
// Deliberately total over the vocabulary with no `default` arm returning a
// plausible-looking zero value: an unclassified kind would render as a
// measurement, which is the exact failure this file exists to prevent. A new
// kind must be added here, and TestBasisFor_ClassifiesEveryRecordKind fails
// until it is.
func BasisFor(k RecordKind) (Basis, bool) {
	switch k {
	case RecordHeaviest, RecordMostReps, RecordLongest, RecordFurthest:
		return Measured, true
	case RecordOneRM:
		// The one modelled record. Epley over reps and weight, with RIR/RPE
		// folded in as effective reps — see the `candidate` CTE in postgres.go.
		return Modelled, true
	}
	return "", false
}

// ReportedFields names the per-set fields that are the athlete's own account.
//
// Exported so the clients and the tests can agree on one list rather than each
// carrying its own idea of what counts as an opinion. `notes` is here for the
// same reason RIR is: it is true as a report and is not a measurement of
// anything.
func ReportedFields() []string { return []string{"rir", "rpe", "notes"} }
