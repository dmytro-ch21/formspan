package session

import "time"

// RecordKind is a way of being best at an exercise.
//
// Which kinds apply is decided by the exercise's own load_type, the same
// data-driven rule the logging form and the workout template use — so a plank
// never advertises a weight record and a run never advertises reps.
type RecordKind string

const (
	// RecordHeaviest is the most weight moved for at least one rep. The number
	// people actually mean by "my squat".
	RecordHeaviest RecordKind = "heaviest_weight"
	// RecordOneRM is the best estimated single. It moves when you get stronger
	// at *any* rep range, which is what makes it the better progress signal —
	// and why it's shown alongside the heaviest rather than instead of it.
	RecordOneRM RecordKind = "estimated_1rm"
	// RecordMostReps is for bodyweight work, where load is fixed and the only
	// axis is repetitions.
	RecordMostReps RecordKind = "most_reps"
	RecordLongest  RecordKind = "longest_time"
	RecordFurthest RecordKind = "furthest_distance"
)

// RecordKindsFor lists the records an exercise can hold, from its load type.
//
// Deliberately mirrors measuresFor: a record can only exist for a measure the
// exercise actually records, so the two must not drift. If a load type gains
// a measure, it gains a record here.
func RecordKindsFor(loadType string) []RecordKind {
	switch loadType {
	case "weight_reps":
		return []RecordKind{RecordHeaviest, RecordOneRM}
	case "reps":
		return []RecordKind{RecordMostReps}
	case "time":
		return []RecordKind{RecordLongest}
	case "distance":
		return []RecordKind{RecordFurthest}
	case "distance_time":
		return []RecordKind{RecordFurthest, RecordLongest}
	}
	return nil
}

// Record is one best, and the set that produced it.
//
// The evidence travels with the number for the same reason it does on a
// suggestion: "142kg" alone is something to be trusted, while "142kg — 5 × 120
// at 2 RIR, on 14 March" is something to be checked. It also makes a wrong
// record self-diagnosing, because you can go and look at the set.
type Record struct {
	Kind RecordKind `json:"kind"`
	// Value in storage units — kilograms, reps, seconds or metres — so the
	// client formats it the same way it formats everything else.
	Value float64 `json:"value"`

	Reps      *int     `json:"reps"`
	WeightKg  *float64 `json:"weight_kg"`
	Seconds   *int     `json:"seconds"`
	DistanceM *int     `json:"distance_m"`
	RIR       *int     `json:"rir"`
	RPE       *float64 `json:"rpe"`

	AchievedAt time.Time `json:"achieved_at"`
	SessionID  string    `json:"session_id"`
	// True when the record was set in the most recent session containing this
	// exercise — the "you just did this" moment, and the only reason a client
	// needs to treat one record differently from another.
	IsRecent bool `json:"is_recent"`
}

// ExerciseRecords is every record one exercise holds. Absent kinds mean the
// exercise has none of that sort yet, not zero.
type ExerciseRecords struct {
	ExerciseID string   `json:"exercise_id"`
	Records    []Record `json:"records"`
}

// recentWindow is how long a record still counts as "new".
//
// Tied to a duration rather than to "the last session" because someone who
// trains twice a week should still see a Tuesday PR celebrated on Thursday,
// and someone mid-block shouldn't have a month-old best flagged as fresh.
const recentWindow = 14 * 24 * time.Hour
