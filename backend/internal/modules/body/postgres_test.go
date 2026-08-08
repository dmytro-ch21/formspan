package body

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered before any cleanup that still needs the pool: t.Cleanup runs
	// LIFO and strictly after every defer, so a `defer pool.Close()` here would
	// close it out from under the deletes below.
	t.Cleanup(pool.Close)
	return pool
}

func repoFor(t *testing.T, userID string) *PostgresRepository {
	t.Helper()
	pool := testPool(t)
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM body_checkins WHERE user_id = $1`, userID)
		_, _ = pool.Exec(ctx, `DELETE FROM body_phases WHERE user_id = $1`, userID)
	})
	return NewPostgresRepository(pool)
}

func f(v float64) *float64 { return &v }
func s(v string) *string   { return &v }

func TestSaveCheckin_IsAnUpsertOnTheDay(t *testing.T) {
	// The property an offline check-in depends on: re-sending the same day is
	// the same as sending it once, not a second row and not a failure.
	ctx := context.Background()
	r := repoFor(t, "u_upsert")

	first, err := r.SaveCheckin(ctx, Checkin{UserID: "u_upsert", MeasuredOn: "2026-08-01", WeightKG: f(82.4)})
	if err != nil {
		t.Fatalf("first save: %v", err)
	}
	if first.WeightKG == nil || *first.WeightKG != 82.4 {
		t.Fatalf("weight = %v, want 82.4", first.WeightKG)
	}

	if _, err := r.SaveCheckin(ctx, Checkin{UserID: "u_upsert", MeasuredOn: "2026-08-01", WeightKG: f(82.1)}); err != nil {
		t.Fatalf("second save: %v", err)
	}
	list, err := r.ListCheckins(ctx, "u_upsert", "2026-08-01", "2026-08-01")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("got %d rows for one day, want 1 — the day is not the key", len(list))
	}
	if *list[0].WeightKG != 82.1 {
		t.Errorf("weight = %v, want the second save to win", *list[0].WeightKG)
	}
}

func TestSaveCheckin_AbsentMeansNotMeasuredNotCleared(t *testing.T) {
	/*
		The load-bearing one.

		A weekly girth check-in sends girths and no weight. Without the COALESCE
		in the upsert it would erase the weight recorded that morning — silently,
		and only noticed later as a hole in the trend.
	*/
	ctx := context.Background()
	r := repoFor(t, "u_coalesce")

	if _, err := r.SaveCheckin(ctx, Checkin{UserID: "u_coalesce", MeasuredOn: "2026-08-02", WeightKG: f(80)}); err != nil {
		t.Fatalf("weight save: %v", err)
	}
	got, err := r.SaveCheckin(ctx, Checkin{UserID: "u_coalesce", MeasuredOn: "2026-08-02", WaistCM: f(81.5)})
	if err != nil {
		t.Fatalf("girth save: %v", err)
	}
	if got.WeightKG == nil {
		t.Error("the morning's weight was erased by a girth-only check-in")
	} else if *got.WeightKG != 80 {
		t.Errorf("weight = %v, want 80", *got.WeightKG)
	}
	if got.WaistCM == nil || *got.WaistCM != 81.5 {
		t.Errorf("waist = %v, want 81.5", got.WaistCM)
	}
}

func TestSaveCheckin_DoesNotFlipTheMeasuredSide(t *testing.T) {
	/*
		Found in review, and it destroys the one thing the field exists for.

		`measured_side` was written unconditionally, and both handler and repo
		defaulted an empty value to "right" — so girths taken on the LEFT,
		followed by that evening's weight-only save (which naturally says
		nothing about a side), silently relabelled the left-side series as
		right. Two series that cannot be compared to anything, including each
		other.
	*/
	ctx := context.Background()
	r := repoFor(t, "u_side")

	if _, err := r.SaveCheckin(ctx, Checkin{
		UserID: "u_side", MeasuredOn: "2026-08-09", ThighCM: f(58), MeasuredSide: SideLeft,
	}); err != nil {
		t.Fatalf("girth save: %v", err)
	}
	// A weight-only save, saying nothing about the side.
	got, err := r.SaveCheckin(ctx, Checkin{UserID: "u_side", MeasuredOn: "2026-08-09", WeightKG: f(81)})
	if err != nil {
		t.Fatalf("weight save: %v", err)
	}
	if got.MeasuredSide != SideLeft {
		t.Errorf("measured_side = %q, want left — a weight-only save relabelled the girths", got.MeasuredSide)
	}
	// And a first insert still gets the column default rather than an empty.
	first, err := r.SaveCheckin(ctx, Checkin{UserID: "u_side", MeasuredOn: "2026-08-10", WeightKG: f(81)})
	if err != nil {
		t.Fatalf("first save: %v", err)
	}
	if first.MeasuredSide != SideRight {
		t.Errorf("default side = %q, want right", first.MeasuredSide)
	}
}

func TestAttachPhotoKey_LeavesNotesAndMeasurementsAlone(t *testing.T) {
	// Also from review: minting an upload URL went through the full save path,
	// which REPLACES notes by design — so asking for a photo slot wiped
	// whatever the athlete wrote that morning.
	ctx := context.Background()
	r := repoFor(t, "u_photo")

	if _, err := r.SaveCheckin(ctx, Checkin{
		UserID: "u_photo", MeasuredOn: "2026-08-09", WeightKG: f(81),
		MeasuredSide: SideLeft, Notes: "felt strong",
	}); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := r.AttachPhotoKey(ctx, "u_photo", "2026-08-09", "checkins/u_photo/2026-08-09.jpg")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if got.Notes != "felt strong" {
		t.Errorf("notes = %q — attaching a photo erased them", got.Notes)
	}
	if got.WeightKG == nil || *got.WeightKG != 81 {
		t.Errorf("weight = %v, want 81", got.WeightKG)
	}
	if got.MeasuredSide != SideLeft {
		t.Errorf("measured_side = %q, want left", got.MeasuredSide)
	}
	if got.PhotoKey == nil || *got.PhotoKey != "checkins/u_photo/2026-08-09.jpg" {
		t.Errorf("photo_key = %v", got.PhotoKey)
	}
}

func TestCreatePhase_IsIdempotentOnRetry(t *testing.T) {
	/*
		The client generates the id precisely so a retry is not a second phase —
		and a plain INSERT made that a lie: the retry hit the primary key and
		came back 400 "that already exists", which is the wrong status for a
		conflict and blames the caller's input. Raised in review.
	*/
	ctx := context.Background()
	r := repoFor(t, "u_retry")
	const id = "88888888-8888-8888-8888-888888888888"
	in := Phase{ID: id, UserID: "u_retry", Kind: KindCut, StartedOn: "2026-08-01"}

	first, err := r.CreatePhase(ctx, in)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	again, err := r.CreatePhase(ctx, in)
	if err != nil {
		t.Fatalf("retry errored instead of returning the original: %v", err)
	}
	if again.ID != first.ID || again.StartedOn != first.StartedOn {
		t.Errorf("retry returned a different phase: %+v vs %+v", again, first)
	}
	// A DIFFERENT id while one is live is still the 409 — the conflict target
	// names the primary key only, so the partial index still raises.
	if _, err := r.CreatePhase(ctx, Phase{
		ID: "99999999-9999-9999-9999-999999999999", UserID: "u_retry",
		Kind: KindLeanBulk, StartedOn: "2026-08-02",
	}); !errors.Is(err, ErrPhaseActive) {
		t.Errorf("err = %v, want ErrPhaseActive", err)
	}
}

func TestCreatePhase_WillNotHandBackSomebodyElsesPhase(t *testing.T) {
	// The re-fetch is scoped to (id, user_id). Unscoped, replaying a guessed
	// UUID would return another athlete's phase.
	ctx := context.Background()
	owner := repoFor(t, "u_pown")
	other := repoFor(t, "u_pother")
	const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

	if _, err := owner.CreatePhase(ctx, Phase{ID: id, UserID: "u_pown", Kind: KindCut, StartedOn: "2026-08-01"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := other.CreatePhase(ctx, Phase{ID: id, UserID: "u_pother", Kind: KindCut, StartedOn: "2026-08-01"})
	if err == nil {
		t.Fatalf("returned another athlete's phase: %+v", got)
	}
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound rather than an exists oracle", err)
	}
}

func TestListCheckins_IsScopedToTheCallerAndTheWindow(t *testing.T) {
	// Cross-user reads are the bug this codebase's reviewers have caught twice.
	ctx := context.Background()
	mine := repoFor(t, "u_mine")
	theirs := repoFor(t, "u_theirs")

	if _, err := mine.SaveCheckin(ctx, Checkin{UserID: "u_mine", MeasuredOn: "2026-08-05", WeightKG: f(80)}); err != nil {
		t.Fatalf("save mine: %v", err)
	}
	if _, err := theirs.SaveCheckin(ctx, Checkin{UserID: "u_theirs", MeasuredOn: "2026-08-05", WeightKG: f(99)}); err != nil {
		t.Fatalf("save theirs: %v", err)
	}
	// Outside the window.
	if _, err := mine.SaveCheckin(ctx, Checkin{UserID: "u_mine", MeasuredOn: "2026-07-01", WeightKG: f(85)}); err != nil {
		t.Fatalf("save old: %v", err)
	}

	list, err := mine.ListCheckins(ctx, "u_mine", "2026-08-01", "2026-08-31")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("got %d, want 1 — the window or the user scope is not applied", len(list))
	}
	if list[0].UserID != "u_mine" {
		t.Errorf("returned another athlete's check-in: %s", list[0].UserID)
	}
}

func TestListCheckins_NewestFirst(t *testing.T) {
	ctx := context.Background()
	r := repoFor(t, "u_order")
	for _, d := range []string{"2026-08-01", "2026-08-03", "2026-08-02"} {
		if _, err := r.SaveCheckin(ctx, Checkin{UserID: "u_order", MeasuredOn: d, WeightKG: f(80)}); err != nil {
			t.Fatalf("save %s: %v", d, err)
		}
	}
	list, err := r.ListCheckins(ctx, "u_order", "2026-08-01", "2026-08-31")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	want := []string{"2026-08-03", "2026-08-02", "2026-08-01"}
	for i, d := range want {
		if list[i].MeasuredOn != d {
			t.Fatalf("order = %v, want newest first %v", []string{list[0].MeasuredOn, list[1].MeasuredOn, list[2].MeasuredOn}, want)
		}
	}
}

func TestDeleteCheckin_IsHowAValueIsCleared(t *testing.T) {
	// The save coalesces, so a mistyped measurement cannot be nulled through
	// it. Deleting the day is the documented way out, and it must be scoped.
	ctx := context.Background()
	r := repoFor(t, "u_delete")
	if _, err := r.SaveCheckin(ctx, Checkin{UserID: "u_delete", MeasuredOn: "2026-08-06", WeightKG: f(180)}); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := r.DeleteCheckin(ctx, "u_delete", "2026-08-06"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := r.GetCheckin(ctx, "u_delete", "2026-08-06"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
	// Deleting somebody else's day, or a day that is not there, is a 404 rather
	// than a silent success.
	if err := r.DeleteCheckin(ctx, "u_delete", "2026-08-06"); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete err = %v, want ErrNotFound", err)
	}
}

func TestCreatePhase_RefusesASecondLiveOne(t *testing.T) {
	/*
		Enforced by a partial unique index rather than by an application check,
		because two concurrent "start a phase" requests are exactly the race an
		application check loses — and the athlete would then be measuring
		against two targets with no way to tell which the card used.
	*/
	ctx := context.Background()
	r := repoFor(t, "u_phase")

	if _, err := r.CreatePhase(ctx, Phase{
		ID: "11111111-1111-1111-1111-111111111111", UserID: "u_phase",
		Kind: KindCut, StartedOn: "2026-08-01",
	}); err != nil {
		t.Fatalf("first phase: %v", err)
	}
	_, err := r.CreatePhase(ctx, Phase{
		ID: "22222222-2222-2222-2222-222222222222", UserID: "u_phase",
		Kind: KindLeanBulk, StartedOn: "2026-08-02",
	})
	if !errors.Is(err, ErrPhaseActive) {
		t.Fatalf("err = %v, want ErrPhaseActive", err)
	}
}

func TestEndPhase_FreesTheSlotAndIsIdempotent(t *testing.T) {
	ctx := context.Background()
	r := repoFor(t, "u_end")
	const id = "33333333-3333-3333-3333-333333333333"

	if _, err := r.CreatePhase(ctx, Phase{ID: id, UserID: "u_end", Kind: KindCut, StartedOn: "2026-08-01"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	ended, err := r.EndPhase(ctx, "u_end", id, "2026-08-20")
	if err != nil {
		t.Fatalf("end: %v", err)
	}
	if ended.EndedOn == nil || *ended.EndedOn != "2026-08-20" {
		t.Fatalf("ended_on = %v, want 2026-08-20", ended.EndedOn)
	}
	// Ending it again is a 404, not a second write that would move the date.
	if _, err := r.EndPhase(ctx, "u_end", id, "2026-08-25"); !errors.Is(err, ErrNotFound) {
		t.Errorf("second end err = %v, want ErrNotFound", err)
	}
	// And the slot is free.
	if _, err := r.CreatePhase(ctx, Phase{
		ID: "44444444-4444-4444-4444-444444444444", UserID: "u_end",
		Kind: KindMaintenance, StartedOn: "2026-08-21",
	}); err != nil {
		t.Errorf("ending a phase did not free the slot: %v", err)
	}
}

func TestEndPhase_CannotEndSomebodyElsesPhase(t *testing.T) {
	// Scoped by user_id as well as id. A 404 rather than a 403, because
	// confirming the id exists is itself the leak.
	ctx := context.Background()
	mine := repoFor(t, "u_owner")
	_ = repoFor(t, "u_attacker")
	const id = "55555555-5555-5555-5555-555555555555"

	if _, err := mine.CreatePhase(ctx, Phase{ID: id, UserID: "u_owner", Kind: KindCut, StartedOn: "2026-08-01"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := mine.EndPhase(ctx, "u_attacker", id, "2026-08-10"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound — another athlete ended this phase", err)
	}
	if p, err := mine.ActivePhase(ctx, "u_owner"); err != nil || p.EndedOn != nil {
		t.Error("the phase was ended by somebody who does not own it")
	}
}

func TestActivePhase_IsTheOneWithNoEndDate(t *testing.T) {
	ctx := context.Background()
	r := repoFor(t, "u_active")
	const done = "66666666-6666-6666-6666-666666666666"
	const live = "77777777-7777-7777-7777-777777777777"

	if _, err := r.CreatePhase(ctx, Phase{ID: done, UserID: "u_active", Kind: KindCut, StartedOn: "2026-06-01"}); err != nil {
		t.Fatalf("create done: %v", err)
	}
	if _, err := r.EndPhase(ctx, "u_active", done, "2026-07-01"); err != nil {
		t.Fatalf("end: %v", err)
	}
	if _, err := r.CreatePhase(ctx, Phase{
		ID: live, UserID: "u_active", Kind: KindMakingWeight, StartedOn: "2026-07-02",
		TargetOn: s("2026-09-20"), TargetWeightKG: f(77.1),
	}); err != nil {
		t.Fatalf("create live: %v", err)
	}

	got, err := r.ActivePhase(ctx, "u_active")
	if err != nil {
		t.Fatalf("active: %v", err)
	}
	if got.ID != live {
		t.Errorf("active = %s, want the unended one", got.ID)
	}
	// History keeps both — the numbers recorded in June are only readable
	// against the phase that was running in June.
	all, err := r.ListPhases(ctx, "u_active")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Errorf("got %d phases, want both kept", len(all))
	}
}

func TestActivePhase_NoneIsNotFoundNotAnEmptyPhase(t *testing.T) {
	// An empty Phase{} would render as a live cut starting in year zero.
	ctx := context.Background()
	r := repoFor(t, "u_nophase")
	if _, err := r.ActivePhase(ctx, "u_nophase"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestSaveCheckin_OutOfRangeIsRejectedByTheDatabaseToo(t *testing.T) {
	// Domain validation catches this first; the CHECK constraints are the
	// backstop for any path that skips Validate, and this asserts they exist
	// rather than assuming the migration ran as written.
	ctx := context.Background()
	r := repoFor(t, "u_range")
	if _, err := r.SaveCheckin(ctx, Checkin{UserID: "u_range", MeasuredOn: "2026-08-07", WeightKG: f(900)}); err == nil {
		t.Error("a 900kg bodyweight was stored")
	} else if !errors.Is(err, ErrInvalidInput) {
		t.Errorf("err = %v, want it translated to ErrInvalidInput rather than raw SQL", err)
	}
}

func TestPhotoKey_IsPrefixedByTheAthlete(t *testing.T) {
	// The layout is what makes "delete everything belonging to this account" a
	// prefix operation, which a deletion request will need.
	if got := PhotoKey("user_abc", "2026-08-08"); got != "checkins/user_abc/2026-08-08.jpg" {
		t.Errorf("PhotoKey = %q", got)
	}
}
