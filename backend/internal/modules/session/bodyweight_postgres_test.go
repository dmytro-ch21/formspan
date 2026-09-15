package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// N453 (#756): the bodyweight a session was performed at, derived when the
// session is read. Each test below goes red when the line it names is
// removed from `body.SQLLatestWeightOnOrBefore` or from GetDetail. The
// mutation table in the PR records which mutation turned which test red.

// ownWeighIns clears these athletes' check-ins now and again after the test.
// Clearing first repairs a row an interrupted run left behind rather than
// trusting it.
func ownWeighIns(t *testing.T, pool *pgxpool.Pool, users ...string) {
	t.Helper()
	clear := func() error {
		_, err := pool.Exec(context.Background(),
			`DELETE FROM body_checkins WHERE user_id = ANY($1)`, users)
		return err
	}
	if err := clear(); err != nil {
		t.Fatalf("clear check-ins: %v", err)
	}
	t.Cleanup(func() {
		if err := clear(); err != nil {
			t.Logf("cleanup check-ins: %v", err)
		}
	})
}

// seedWeighIn records a check-in. A nil kg records a girths-only check-in
// (a waist and no weight), which must never count as a weigh-in.
func seedWeighIn(t *testing.T, pool *pgxpool.Pool, user, on string, kg *float64) {
	t.Helper()
	var waist *float64
	if kg == nil {
		w := 80.0
		waist = &w
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO body_checkins (user_id, measured_on, weight_kg, waist_cm)
		VALUES ($1, $2::date, $3, $4)
		ON CONFLICT (user_id, measured_on) DO UPDATE
		SET weight_kg = EXCLUDED.weight_kg, waist_cm = EXCLUDED.waist_cm`,
		user, on, kg, waist); err != nil {
		t.Fatalf("seed check-in %s on %s: %v", user, on, err)
	}
}

func dropWeighIn(t *testing.T, pool *pgxpool.Pool, user, on string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`DELETE FROM body_checkins WHERE user_id = $1 AND measured_on = $2::date`, user, on); err != nil {
		t.Fatalf("drop check-in %s on %s: %v", user, on, err)
	}
}

// pullUpSessionAt logs two completed reps-only sets, the shape of a
// bodyweight exercise: reps and no weight.
func pullUpSessionAt(t *testing.T, repo *PostgresRepository, pool *pgxpool.Pool, id, user string, at time.Time) {
	t.Helper()
	in := strengthSession(id, user, []Set{
		{ExerciseID: exPullUp, Position: 1, SetType: SetTypeWorking, Reps: ptrInt(10), Completed: true},
		{ExerciseID: exPullUp, Position: 2, SetType: SetTypeWorking, Reps: ptrInt(8), Completed: true},
	})
	in.StartedAt = at
	cleanup(t, pool, id)
	if _, err := repo.Create(context.Background(), in); err != nil {
		t.Fatalf("create %s: %v", id, err)
	}
}

func requireBodyweight(t *testing.T, got *Bodyweight, wantKg float64, wantOn string) {
	t.Helper()
	if got == nil {
		t.Fatalf("bodyweight = nil, want %.1f kg from %s", wantKg, wantOn)
	}
	if !closeEnough(got.WeightKg, wantKg) || got.MeasuredOn != wantOn {
		t.Fatalf("bodyweight = %.2f kg from %s, want %.1f kg from %s",
			got.WeightKg, got.MeasuredOn, wantKg, wantOn)
	}
}

func kg(v float64) *float64 { return &v }

func TestGetDetail_PicksTheLatestWeighInOnOrBeforeTheSessionDay(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const me = "bw_user_latest"
	ownWeighIns(t, pool, me)
	pullUpSessionAt(t, repo, pool, "bw_latest", me, time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC))

	seedWeighIn(t, pool, me, "2026-03-02", kg(70))
	seedWeighIn(t, pool, me, "2026-03-09", kg(80.5))
	seedWeighIn(t, pool, me, "2026-03-12", kg(81.3)) // the session's own day counts

	_, bw, err := repo.GetDetail(ctx, me, "bw_latest", "UTC")
	if err != nil {
		t.Fatalf("get detail: %v", err)
	}
	requireBodyweight(t, bw, 81.3, "2026-03-12")

	// With the same-day reading gone, the newest EARLIER one wins, not the
	// oldest.
	dropWeighIn(t, pool, me, "2026-03-12")
	_, bw, err = repo.GetDetail(ctx, me, "bw_latest", "UTC")
	if err != nil {
		t.Fatalf("get detail after drop: %v", err)
	}
	requireBodyweight(t, bw, 80.5, "2026-03-09")
}

func TestGetDetail_IgnoresAWeighInAfterTheSessionDay(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const me = "bw_user_after"
	ownWeighIns(t, pool, me)
	pullUpSessionAt(t, repo, pool, "bw_after", me, time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC))

	// Only a LATER reading: the answer is none, never "the closest one".
	seedWeighIn(t, pool, me, "2026-03-13", kg(95))
	_, bw, err := repo.GetDetail(ctx, me, "bw_after", "UTC")
	if err != nil {
		t.Fatalf("get detail: %v", err)
	}
	if bw != nil {
		t.Fatalf("a check-in dated after the session was used: %.1f kg from %s", bw.WeightKg, bw.MeasuredOn)
	}

	// An earlier one alongside it is chosen, even though the later one is closer.
	seedWeighIn(t, pool, me, "2026-03-02", kg(70))
	_, bw, err = repo.GetDetail(ctx, me, "bw_after", "UTC")
	if err != nil {
		t.Fatalf("get detail with earlier: %v", err)
	}
	requireBodyweight(t, bw, 70, "2026-03-02")
}

func TestGetDetail_NoWeighInIsNilNotAGuess(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const me = "bw_user_none"
	ownWeighIns(t, pool, me)
	pullUpSessionAt(t, repo, pool, "bw_none", me, time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC))

	s, bw, err := repo.GetDetail(ctx, me, "bw_none", "UTC")
	if err != nil {
		t.Fatalf("get detail: %v", err)
	}
	if bw != nil {
		t.Fatalf("no check-ins, but got %.1f kg from %s", bw.WeightKg, bw.MeasuredOn)
	}
	// The session itself is unaffected by having nothing to attach.
	if s == nil || s.ID != "bw_none" || len(s.Sets) != 2 {
		t.Fatalf("session = %+v, want bw_none with its 2 sets", s)
	}

	// A girths-only check-in is not a weigh-in. On its own it is still none...
	seedWeighIn(t, pool, me, "2026-03-11", nil)
	_, bw, err = repo.GetDetail(ctx, me, "bw_none", "UTC")
	if err != nil {
		t.Fatalf("get detail with girths only: %v", err)
	}
	if bw != nil {
		t.Fatalf("a girths-only check-in was read as a weigh-in: %.1f kg from %s", bw.WeightKg, bw.MeasuredOn)
	}
	// ...and it does not shadow an older real weigh-in.
	seedWeighIn(t, pool, me, "2026-03-01", kg(72))
	_, bw, err = repo.GetDetail(ctx, me, "bw_none", "UTC")
	if err != nil {
		t.Fatalf("get detail with older weight: %v", err)
	}
	requireBodyweight(t, bw, 72, "2026-03-01")
}

func TestGetDetail_NeverReadsAnotherAthletesCheckIns(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const me, other = "bw_user_owner", "bw_user_other"
	ownWeighIns(t, pool, me, other)
	pullUpSessionAt(t, repo, pool, "bw_iso", me, time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC))

	// Somebody else weighed in on the session's very day. I have nothing.
	seedWeighIn(t, pool, other, "2026-03-12", kg(120))
	_, bw, err := repo.GetDetail(ctx, me, "bw_iso", "UTC")
	if err != nil {
		t.Fatalf("get detail: %v", err)
	}
	if bw != nil {
		t.Fatalf("another athlete's check-in appeared on my session: %.1f kg from %s", bw.WeightKg, bw.MeasuredOn)
	}

	// My own older reading wins over their closer one.
	seedWeighIn(t, pool, me, "2026-03-01", kg(75))
	_, bw, err = repo.GetDetail(ctx, me, "bw_iso", "UTC")
	if err != nil {
		t.Fatalf("get detail with my own: %v", err)
	}
	requireBodyweight(t, bw, 75, "2026-03-01")

	// And they cannot read my session at all, which would otherwise hand
	// them my bodyweight.
	if _, bw, err := repo.GetDetail(ctx, other, "bw_iso", "UTC"); !errors.Is(err, ErrNotFound) || bw != nil {
		t.Fatalf("other athlete reading my session: bw=%v err=%v, want nil and ErrNotFound", bw, err)
	}
}

func TestGetDetail_ResolvesTheSessionDayInTheCallersZone(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const me = "bw_user_tz"
	ownWeighIns(t, pool, me)
	// 02:30 UTC on the 13th is 19:30 on the 12th in Los Angeles (PDT, UTC-7,
	// since DST began on 8 March 2026). The athlete trained on the 12th and
	// weighed in again on the morning of the 13th.
	pullUpSessionAt(t, repo, pool, "bw_tz", me, time.Date(2026, 3, 13, 2, 30, 0, 0, time.UTC))
	seedWeighIn(t, pool, me, "2026-03-12", kg(80))
	seedWeighIn(t, pool, me, "2026-03-13", kg(90))

	_, bw, err := repo.GetDetail(ctx, me, "bw_tz", "America/Los_Angeles")
	if err != nil {
		t.Fatalf("get detail LA: %v", err)
	}
	// The next morning's reading is LATER than the session, so it must not be used.
	requireBodyweight(t, bw, 80, "2026-03-12")

	// The same instant, asked about in UTC, is the 13th.
	_, bw, err = repo.GetDetail(ctx, me, "bw_tz", "UTC")
	if err != nil {
		t.Fatalf("get detail UTC: %v", err)
	}
	requireBodyweight(t, bw, 90, "2026-03-13")
}

// The regression guard for decision 3 (display only). A bodyweight on file
// must change NOTHING about the sets or any figure computed from them: every
// reps-only set keeps a nil weight, and volume and history report the same
// tonnage (zero) they did before N453.
func TestGetDetail_BodyweightNeverReachesSetsOrTonnage(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const me = "bw_user_tonnage"
	ownWeighIns(t, pool, me)
	at := time.Date(2026, 3, 12, 12, 0, 0, 0, time.UTC)
	pullUpSessionAt(t, repo, pool, "bw_tonnage", me, at)
	seedWeighIn(t, pool, me, "2026-03-10", kg(82.4))

	s, bw, err := repo.GetDetail(ctx, me, "bw_tonnage", "UTC")
	if err != nil {
		t.Fatalf("get detail: %v", err)
	}
	requireBodyweight(t, bw, 82.4, "2026-03-10")

	for i, set := range s.Sets {
		if set.WeightKg != nil {
			t.Fatalf("set %d gained weight_kg = %.1f from the check-in; bodyweight is display only", i, *set.WeightKg)
		}
	}
	v := Summarise(s.Sets)
	if v.TonnageKg != 0 || v.TotalReps != 18 || v.WorkingSets != 2 {
		t.Fatalf("volume = %+v, want 0 kg tonnage over 18 reps in 2 sets", v)
	}

	// GetDetail's session is exactly Get's: the detail view reads the same
	// sets every other path does.
	plain, err := repo.Get(ctx, me, "bw_tonnage")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got, want := Summarise(plain.Sets), v; got.TonnageKg != want.TonnageKg || got.TotalReps != want.TotalReps {
		t.Fatalf("Get volume %+v disagrees with GetDetail volume %+v", got, want)
	}

	h, err := repo.History(ctx, me, HistoryFilter{
		From: at.Add(-24 * time.Hour), To: at.Add(24 * time.Hour), TZ: "UTC",
	})
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if h.Totals.TonnageKg != 0 || h.Totals.TotalReps != 18 {
		t.Fatalf("history totals = %+v, want 0 kg tonnage over 18 reps", h.Totals)
	}
}
