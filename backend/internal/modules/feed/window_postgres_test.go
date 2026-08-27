package feed

import (
	"context"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/modules/session"
)

// age moves a finished session's end time into the past.
//
// `train` finishes everything half an hour ago, which is the right default for
// every other test here and useless for this one — the window is the only
// behaviour in this package that depends on WHEN a session ended rather than
// whether it did.
func age(t *testing.T, h *harness, id string, ago time.Duration) {
	t.Helper()
	ended := time.Now().UTC().Add(-ago)
	if _, err := h.pool.Exec(context.Background(),
		`UPDATE sessions SET started_at = $2, ended_at = $3 WHERE id = $1`,
		id, ended.Add(-30*time.Minute), ended); err != nil {
		t.Fatalf("age %s: %v", id, err)
	}
}

// The feed answers "what are my friends doing", and a session from last week
// does not answer it. Nothing is deleted — the owner's history, calendar and
// session list are untouched; this is a window on one surface.
func TestTheFeedReachesBackThreeDaysAndNoFurther(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_win_a", "fd_win_a_h", true)
	bob := person(t, h.pool, "fd_win_b", "fd_win_b_h", true)
	befriend(t, h, alice, "fd_win_a_h", bob, "fd_win_b_h")

	train(t, h, bob, "fd_w_now", "This morning", true, nil)
	train(t, h, bob, "fd_w_edge", "Just inside", true, nil)
	train(t, h, bob, "fd_w_old", "Last week", true, nil)
	age(t, h, "fd_w_edge", FeedWindow-time.Hour)
	age(t, h, "fd_w_old", 7*24*time.Hour)

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	got := ids(page)
	if len(got) != 2 {
		t.Fatalf("want the two recent sessions, got %v", got)
	}
	for _, id := range got {
		if id == "fd_w_old" {
			t.Fatalf("a week-old session is still in the feed: %v", got)
		}
	}
	// N13 (#379): a real, populated page — not just the no-friends shortcut
	// — reports the same window it enforced.
	if page.WindowDays != FeedWindowDays() {
		t.Fatalf("window_days = %d, want %d", page.WindowDays, FeedWindowDays())
	}

	// The count must agree with the list — the half that has bitten this file
	// twice, and the reason the window lives in `visibleFrom` rather than
	// beside the LIMIT.
	//
	// **`limit` is 1, and that is the entire point of this second call.** With
	// a limit above the row count, `List` takes its short-circuit —
	// `offset == 0 && len(items) < limit` sets `Total = len(Items)` and the
	// count query never runs. Asserting `page.Total` on the call above
	// therefore tested the length of a slice against itself: proven by
	// mutation, removing the window from the count alone left this whole
	// package green. A limit BELOW the visible count is what makes the page
	// fill and the count actually execute.
	filled, err := h.repo.List(ctx, alice, 1, 0)
	if err != nil {
		t.Fatalf("list one: %v", err)
	}
	if len(ids(filled)) != 1 {
		t.Fatalf("want a full page of one, got %v", ids(filled))
	}
	if filled.Total != 2 {
		t.Fatalf("total is %d, want 2 — the COUNT query is not windowed, so it is "+
			"promising a row the list will never return", filled.Total)
	}
}

// The WIDTH, pinned as a literal — and this test exists because the two either
// side of it do not pin it.
//
// They age their fixtures relative to `FeedWindow`, so they prove the boundary
// is enforced wherever the constant puts it and say nothing about where that
// is: measured by mutation, widening the window to seven days or narrowing it
// to one leaves both of them green. Three days is the requirement, so three
// days needs an assertion of its own rather than a definition that agrees with
// itself.
func TestTheWindowIsThreeDays(t *testing.T) {
	if FeedWindow != 72*time.Hour {
		t.Fatalf("FeedWindow is %v, want 72h — the feed is specified as three days, "+
			"and every other test here measures against this constant rather than "+
			"against that requirement", FeedWindow)
	}
}

// The boundary is the assertion worth having: a test that only checks "a week
// ago is gone" passes for any window from a minute to six days.
func TestTheWindowsEdgeIsWhereItSaysItIs(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	alice := person(t, h.pool, "fd_ea", "fd_ea_h", true)
	bob := person(t, h.pool, "fd_eb", "fd_eb_h", true)
	befriend(t, h, alice, "fd_ea_h", bob, "fd_eb_h")

	train(t, h, bob, "fd_e_in", "Inside", true, nil)
	train(t, h, bob, "fd_e_out", "Outside", true, nil)
	// Ten minutes either side of the boundary, so this fails if the window is
	// moved in either direction rather than only if it is removed.
	age(t, h, "fd_e_in", FeedWindow-10*time.Minute)
	age(t, h, "fd_e_out", FeedWindow+10*time.Minute)

	page, err := h.repo.List(ctx, alice, 30, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	got := ids(page)
	if len(got) != 1 || got[0] != "fd_e_in" {
		t.Fatalf("want only the session inside the window, got %v", got)
	}
}

// The window trims the FEED, and nothing else. An owner's own history is a
// different surface with a different purpose, and the request that produced
// this window was explicit that it applies to friends' posts only.
func TestTheWindowDoesNotTouchTheOwnersOwnHistory(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	bob := person(t, h.pool, "fd_ha", "fd_ha_h", true)

	train(t, h, bob, "fd_h_old", "Last week", true, nil)
	age(t, h, "fd_h_old", 7*24*time.Hour)

	// The session module is what the owner's own screens read.
	got, err := h.sessions.Get(ctx, bob, "fd_h_old")
	if err != nil {
		t.Fatalf("the owner can no longer read their own week-old session: %v", err)
	}
	if got.ID != "fd_h_old" {
		t.Fatalf("got session %q", got.ID)
	}

	// And the LIST, which is the surface the owner's history screen actually
	// reads — `Get` alone would leave the claim in this test's name resting on
	// a fetch nobody makes from a history view.
	own, err := h.sessions.List(ctx, bob, session.Filter{})
	if err != nil {
		t.Fatalf("list the owner's own sessions: %v", err)
	}
	for _, s := range own.Sessions {
		if s.ID == "fd_h_old" {
			return
		}
	}
	t.Fatal("a week-old session vanished from the owner's own session list — the feed's " +
		"window is not supposed to touch any surface but the feed")
}
