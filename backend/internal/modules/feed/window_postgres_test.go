package feed

import (
	"context"
	"testing"
	"time"
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
	alice := person(t, h.pool, "fd_wa", "fd_wa_h", true)
	bob := person(t, h.pool, "fd_wb", "fd_wb_h", true)
	befriend(t, h, alice, "fd_wa_h", bob, "fd_wb_h")

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

	// The count must agree with the list. This is the half that has bitten
	// this file twice: a window applied only to the page query leaves the
	// total promising rows the list will never return, and "+1 more" that
	// loads nothing is worse than no total at all.
	if page.Total != 2 {
		t.Fatalf("total is %d but the list returned %d — the count is not windowed",
			page.Total, len(got))
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
}
