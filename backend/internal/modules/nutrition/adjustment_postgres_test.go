package nutrition

import (
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

const adjOn = "2026-08-19"

func adjDay(offset int) string { return dayOffset(adjOn, offset) }

// seedFortnight writes a target, a phase, `weighins` readings per half and
// `loggedDays` days of intake that clear the bar.
func seedFortnight(t *testing.T, r *PostgresRepository, pool *pgxpool.Pool, uid string, loggedDays int, kcalPerDay, weightKG float64) {
	t.Helper()
	if _, err := r.SaveTarget(ctx(), Target{
		UserID: uid, EffectiveOn: adjDay(-30), Kcal: 2400,
		ProteinG: 180, CarbG: 240, FatG: 70, Source: TargetDerived,
	}); err != nil {
		t.Fatalf("target: %v", err)
	}
	// `id` is client-generated on this table — no default — and the partial
	// unique index means only one live phase per athlete.
	mustExec(t, pool, `INSERT INTO body_phases (id, user_id, kind, started_on)
		VALUES (gen_random_uuid(), $1, 'cut', $2::date)`, uid, adjDay(-30))
	for i := 0; i < 12; i++ {
		mustExec(t, pool, `INSERT INTO body_checkins (user_id, measured_on, weight_kg)
			VALUES ($1, $2::date, $3)`, uid, adjDay(-i), weightKG)
	}
	for i := 0; i < loggedDays; i++ {
		mustExec(t, pool, `INSERT INTO nutrition_entries
			(id, user_id, eaten_on, meal, name, servings, serving_label, kcal, protein_g, carb_g, fat_g)
			VALUES (gen_random_uuid(), $1, $2::date, 'dinner', 'fixture', 1, '1 serving', $3, 10, 10, 10)`,
			uid, adjDay(-i), kcalPerDay)
	}
}

func TestAdherenceCountsDaysThatClearHalfTheTarget(t *testing.T) {
	// The HAVING clause, which is SQL behaviour and cannot be proven by reading
	// the query string. A day with a token entry on it is not a record of
	// eating, and counting it would let a fortnight of near-silence clear the
	// guard that exists to catch exactly that.
	uid := "adj-adherence"
	pool := testPool(t)
	r := repoFor(t, uid)
	seedFortnight(t, r, pool, uid, 12, 1500, 80) // 1500 >= 1200, so all 12 count

	in, err := r.AdjustmentInputs(ctx(), uid, adjOn)
	if err != nil {
		t.Fatalf("inputs: %v", err)
	}
	if in.DaysLogged != 12 {
		t.Fatalf("days_logged = %d, want 12", in.DaysLogged)
	}

	// Now the same twelve days, each holding a token 100 kcal.
	uid2 := "adj-token"
	r2 := repoFor(t, uid2)
	seedFortnight(t, r2, pool, uid2, 12, 100, 80) // 100 < 1200, so none count
	in2, err := r2.AdjustmentInputs(ctx(), uid2, adjOn)
	if err != nil {
		t.Fatalf("inputs: %v", err)
	}
	if in2.DaysLogged != 0 {
		t.Fatalf("days_logged = %d for twelve token days, want 0", in2.DaysLogged)
	}
}

func TestTheEvidenceWindowStopsAtAFortnight(t *testing.T) {
	// Rows outside the window are not evidence about it. Bounded in SQL, so
	// this is the only place the boundary can be checked.
	uid := "adj-window"
	pool := testPool(t)
	r := repoFor(t, uid)
	seedFortnight(t, r, pool, uid, 0, 0, 80)

	// One weigh-in and one full day, both a month ago.
	mustExec(t, pool, `INSERT INTO body_checkins (user_id, measured_on, weight_kg)
		VALUES ($1, $2::date, 95)`, uid, adjDay(-40))
	mustExec(t, pool, `INSERT INTO nutrition_entries
		(id, user_id, eaten_on, meal, name, servings, serving_label, kcal, protein_g, carb_g, fat_g)
		VALUES (gen_random_uuid(), $1, $2::date, 'dinner', 'old', 1, '1 serving', 3000, 10, 10, 10)`,
		uid, adjDay(-40))

	in, err := r.AdjustmentInputs(ctx(), uid, adjOn)
	if err != nil {
		t.Fatalf("inputs: %v", err)
	}
	if in.DaysLogged != 0 {
		t.Errorf("days_logged = %d — a day outside the window was counted", in.DaysLogged)
	}
	for _, w := range in.Weighins {
		if w.KG == 95 {
			t.Errorf("a weigh-in from %s leaked into the window", w.On)
		}
	}
	if len(in.Weighins) != 12 {
		t.Errorf("weigh-ins = %d, want the 12 inside the fortnight", len(in.Weighins))
	}
}

func TestOneAthletesEvidenceIsNeverAnothers(t *testing.T) {
	// The cross-user bug the reviewers have caught twice in this codebase, in
	// two different modules. A single-user test passes against it, so this one
	// seeds a second athlete with LOUDER data: if any filter is missing, their
	// rows dominate and the assertions below fail rather than merely wobble.
	mine, theirs := "adj-mine", "adj-theirs"
	pool := testPool(t)
	r := repoFor(t, mine, theirs)
	seedFortnight(t, r, pool, mine, 3, 2000, 80)
	seedFortnight(t, r, pool, theirs, 14, 3000, 120)

	in, err := r.AdjustmentInputs(ctx(), mine, adjOn)
	if err != nil {
		t.Fatalf("inputs: %v", err)
	}
	if in.DaysLogged != 3 {
		t.Errorf("days_logged = %d, want 3 — another athlete's days were counted", in.DaysLogged)
	}
	for _, w := range in.Weighins {
		if w.KG == 120 {
			t.Fatalf("another athlete's weigh-in reached this proposal: %+v", w)
		}
	}
	if len(in.Weighins) != 12 {
		t.Errorf("weigh-ins = %d, want 12", len(in.Weighins))
	}
}

func TestNoTargetYieldsInputsThatBlockRatherThanAnError(t *testing.T) {
	// A brand-new athlete asking is a legitimate question, not a failure.
	uid := "adj-none"
	r := repoFor(t, uid)
	in, err := r.AdjustmentInputs(ctx(), uid, adjOn)
	if err != nil {
		t.Fatalf("inputs: %v", err)
	}
	adj, blocked := ProposeAdjustment(in)
	if adj != nil {
		t.Fatalf("proposed %+v for an athlete with no target", adj)
	}
	if len(blocked) != 1 || blocked[0] != BlockedNoTarget {
		t.Fatalf("blocked_by = %v, want [%s]", blocked, BlockedNoTarget)
	}
}

func TestTheLiveTargetIsTheOneInForceOnTheDay(t *testing.T) {
	// A target set AFTER the day being judged must not be the one judged, or
	// re-asking about last week silently uses this week's number.
	uid := "adj-live"
	pool := testPool(t)
	r := repoFor(t, uid)
	seedFortnight(t, r, pool, uid, 12, 2000, 80)
	if _, err := r.SaveTarget(ctx(), Target{
		UserID: uid, EffectiveOn: adjDay(1), Kcal: 3300,
		ProteinG: 180, CarbG: 240, FatG: 70, Source: TargetManual,
	}); err != nil {
		t.Fatalf("future target: %v", err)
	}
	in, err := r.AdjustmentInputs(ctx(), uid, adjOn)
	if err != nil {
		t.Fatalf("inputs: %v", err)
	}
	if in.TargetKcal != 2400 {
		t.Fatalf("target = %d, want the 2400 live on %s, not tomorrow's 3300", in.TargetKcal, adjOn)
	}
	if in.TargetEffectiveOn != adjDay(-30) {
		t.Fatalf("effective_on = %s, want %s", in.TargetEffectiveOn, adjDay(-30))
	}
}

var _ = fmt.Sprintf
