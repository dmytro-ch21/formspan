package feed

import (
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/modules/profile"
)

// FeedWindowDays is what N13's "configurable in one place" claim actually
// rests on — it is pure, so it is testable without a database, unlike almost
// everything else in this package.

// This pins today's value (3), which is deliberate: it is a change
// detector, not a claim that 3 is special. Changing FeedWindow on purpose
// means updating this assertion on purpose too — that friction is the
// point, so the person making the change notices every place the number
// used to appear, rather than the number quietly drifting under a test
// that was written to protect it.
func TestFeedWindowDaysMatchesTheCurrentThreeDayWindow(t *testing.T) {
	if got := FeedWindowDays(); got != 3 {
		t.Fatalf("FeedWindowDays() = %d, want 3 — if you changed FeedWindow on "+
			"purpose, update this literal too", got)
	}
}

// The invariant FeedWindowDays' own doc comment names: a window that is not
// a whole multiple of 24h would silently floor rather than fail. This is the
// test that turns "would silently floor" into "does not compile a passing
// suite" — change FeedWindow to something like 80h and this is the one
// assertion in the package that goes red for the right reason, rather than
// leaving window_days quietly wrong on every response.
func TestFeedWindowIsAWholeNumberOfDays(t *testing.T) {
	if FeedWindow%(24*time.Hour) != 0 {
		t.Fatalf("FeedWindow (%v) is not a whole number of days — FeedWindowDays() "+
			"would silently floor it rather than report the true window", FeedWindow)
	}
}

// TestAvatarKeyMatchesProfilesAvatarKey pins this package's own avatarKey
// (postgres.go) against profile.AvatarKey directly. It is one of the few
// places this package is allowed to import a sibling module — see
// avatarKey's own doc comment for the argument, which is the same one this
// file's `Detail` already relies on against `sessioncard.Detail` in
// postgres_test.go. Without this, the two hash functions could drift and a
// feed row would silently presign the wrong object.
func TestAvatarKeyMatchesProfilesAvatarKey(t *testing.T) {
	for _, id := range []string{"a_user", "fd_alice", "some-other-id-42", ""} {
		if got, want := avatarKey(id), profile.AvatarKey(id); got != want {
			t.Errorf("avatarKey(%q) = %q, want %q (profile.AvatarKey)", id, got, want)
		}
	}
}
