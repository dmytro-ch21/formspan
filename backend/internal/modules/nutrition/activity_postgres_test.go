package nutrition

import "testing"

// The read half of N93: `TargetInputs` picks the athlete's stored level up off
// the `profiles` row it was already selecting.
//
// Integration rather than a query-string assertion, for the reason this module
// learned once already — an earlier draft of the training query filtered on a
// `warmup` column that does not exist, compiled perfectly, and only a live
// query found it. Adding a column to a SELECT is the same class of change.

func TestTargetInputsReadsTheStoredActivityLevel(t *testing.T) {
	r := repoFor(t, uid)
	pool := testPool(t)

	mustExec(t, pool, `INSERT INTO profiles (user_id, date_of_birth, sex, height_cm, activity_level)
		VALUES ($1, '1996-08-17', 'male', 180, 'active')`, uid)

	in, err := r.TargetInputs(ctx(), uid, "2026-08-18")
	if err != nil {
		t.Fatalf("target inputs: %v", err)
	}
	if in.ActivityLevel == nil {
		t.Fatal("a stored level did not come back — the derivation would silently assume light")
	}
	if *in.ActivityLevel != ActivityActive {
		t.Fatalf("activity level %q, want active", *in.ActivityLevel)
	}
}

func TestTargetInputsReportsNeverChosenAsNil(t *testing.T) {
	r := repoFor(t, uid)
	pool := testPool(t)

	mustExec(t, pool, `INSERT INTO profiles (user_id, date_of_birth, sex, height_cm)
		VALUES ($1, '1996-08-17', 'male', 180)`, uid)

	in, err := r.TargetInputs(ctx(), uid, "2026-08-18")
	if err != nil {
		t.Fatalf("target inputs: %v", err)
	}
	// Nil rather than "" or "light". The handler turns nil into the documented
	// default AND reports that it assumed; a repository that pre-substituted
	// the default here would take that distinction away before anyone could
	// act on it.
	if in.ActivityLevel != nil {
		t.Fatalf("never chosen must be nil, got %q", *in.ActivityLevel)
	}
}

func TestTargetInputsDropsALevelTheVocabularyNoLongerKnows(t *testing.T) {
	r := repoFor(t, uid)
	pool := testPool(t)

	// Reachable because the column has no CHECK constraint, by the house
	// convention that an enumerated vocabulary is validated in Go — so a
	// spelling retired by a later release can outlive its own validator.
	mustExec(t, pool, `INSERT INTO profiles (user_id, date_of_birth, sex, height_cm, activity_level)
		VALUES ($1, '1996-08-17', 'male', 180, 'moderate')`, uid)

	in, err := r.TargetInputs(ctx(), uid, "2026-08-18")
	if err != nil {
		t.Fatalf("target inputs: %v", err)
	}
	// Dropped, not carried. Carried, it would reach ResolveActivity, fall
	// through ActivityFactors to a zero multiplier, and the response would
	// still claim the athlete had chosen — a wrong number presented as their
	// own decision. "Never chosen" is the truthful answer for a level this
	// version cannot honour.
	if in.ActivityLevel != nil {
		t.Fatalf("an unknown level must be dropped, got %q", *in.ActivityLevel)
	}
}
