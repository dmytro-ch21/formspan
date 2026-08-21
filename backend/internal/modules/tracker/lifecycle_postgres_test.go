package tracker

// N78: the cap, the archive/restore/destroy lifecycle, and turning a preset on.
//
// A separate file from `postgres_test.go` because that one is about ONE thing —
// the partial-write restore path — and it says so at length. These are about
// what happens to a tracker over its life. Same package, same fixtures, same
// database lock (see main_test.go).

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// makeN creates n trackers for one athlete and returns their ids.
func makeN(t *testing.T, repo *PostgresRepository, user string, n int) []string {
	t.Helper()
	ids := make([]string, 0, n)
	for i := 0; i < n; i++ {
		in := fixture()
		in.ID = fmt.Sprintf("tr_cap_%s_%d", user, i)
		mustCreate(t, repo, user, in)
		ids = append(ids, in.ID)
	}
	return ids
}

// The cap refuses the ninth, and STOPPING one makes room for it.
//
// The second half is the half that matters. A cap with no way back is a dead
// end — the athlete wanted to track something else and the app's answer is no —
// so the test that the limit is survivable is as important as the test that it
// binds. Archived rows must not count against it.
func TestTheCapRefusesTheNinthAndArchivingMakesRoom(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()
	user := userA + "_cap"

	ids := makeN(t, repo, user, MaxLiveTrackers)

	ninth := fixture()
	ninth.ID = "tr_cap_ninth"
	_, err := repo.Create(ctx, user, ninth)
	if !errors.Is(err, ErrTooMany) {
		t.Fatalf("the %dth tracker was accepted (err=%v) — the cap does not bind",
			MaxLiveTrackers+1, err)
	}

	if err := repo.Archive(ctx, user, ids[0]); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if _, err := repo.Create(ctx, user, ninth); err != nil {
		t.Fatalf("stopping one did not make room: %v.\n"+
			"An archived tracker must not count against the cap, or the limit is "+
			"a dead end rather than a guardrail.", err)
	}
}

// At the cap, a RETRY of a create that already landed must still return the
// tracker rather than ErrTooMany.
//
// This is the failure that would be invisible in normal use and expensive in a
// dead spot: the outbox pushes a tracker, the response is lost, it retries, and
// a 409 classifies as permanent — so the phone marks it sent and the athlete's
// tracker exists on the server while the device believes it failed. The cap
// must never be the answer to a request that adds nothing.
func TestTheCapDoesNotBreakIdempotency(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()
	user := userA + "_capidem"

	ids := makeN(t, repo, user, MaxLiveTrackers)

	again := fixture()
	again.ID = ids[0]
	got, err := repo.Create(ctx, user, again)
	if err != nil {
		t.Fatalf("re-creating an existing tracker while at the cap failed: %v.\n"+
			"A retried create adds no row and must not be refused for a limit the "+
			"athlete is already inside.", err)
	}
	if got.ID != ids[0] {
		t.Fatalf("got %q, want the existing %q", got.ID, ids[0])
	}
}

// Restore is capped too. Without this, archiving eight and restoring them one
// by one walks straight past a limit Create enforces.
func TestRestoreIsCappedAsWell(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()
	user := userA + "_caprestore"

	ids := makeN(t, repo, user, MaxLiveTrackers)
	if err := repo.Archive(ctx, user, ids[0]); err != nil {
		t.Fatalf("archive: %v", err)
	}
	// Fill the freed slot with something else, so restoring would be the ninth.
	replacement := fixture()
	replacement.ID = "tr_cap_replacement"
	mustCreate(t, repo, user, replacement)

	err := repo.Restore(ctx, user, ids[0])
	if !errors.Is(err, ErrTooMany) {
		t.Fatalf("restore past the cap succeeded (err=%v) — Create's limit is "+
			"walkable by archiving and restoring", err)
	}
	// And it must not have half-happened.
	live, err := repo.List(ctx, user)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(live) != MaxLiveTrackers {
		t.Fatalf("%d live trackers after a refused restore, want %d", len(live), MaxLiveTrackers)
	}
}

// Restoring one that is already live is a no-op, not an error — that is what a
// retry looks like — and restoring one that does not exist is ErrNotFound.
func TestRestoreIsIdempotentAndOwnerScoped(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	in := fixture()
	in.ID = "tr_restore_idem"
	mustCreate(t, repo, userA, in)

	if err := repo.Restore(ctx, userA, in.ID); err != nil {
		t.Fatalf("restoring a live tracker must be a no-op, got %v", err)
	}
	if err := repo.Restore(ctx, userA, "tr_no_such_thing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("restoring a tracker that does not exist gave %v, want ErrNotFound", err)
	}
	// Another athlete's archived tracker is not restorable, and is reported as
	// absent rather than as forbidden — the same rule every read here follows.
	if err := repo.Archive(ctx, userA, in.ID); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if err := repo.Restore(ctx, userB, in.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another athlete restored it: %v", err)
	}
	if err := repo.Restore(ctx, userA, in.ID); err != nil {
		t.Fatalf("owner could not restore: %v", err)
	}
	live, err := repo.List(ctx, userA)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(live) != 1 {
		t.Fatalf("restored tracker is not back on the live list: %d rows", len(live))
	}
}

// **The distinction the ticket is built on**: archiving keeps every entry,
// destroying takes them with it, and the two are separate calls.
//
// Both halves in one test on purpose. Asserting only that archive keeps history
// would pass against an implementation where nothing ever deletes; asserting
// only that destroy removes it would pass against one where archive deletes
// too. It is the CONTRAST that carries the meaning.
func TestArchiveKeepsEntriesAndDestroyTakesThem(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()
	user := userA + "_destroy"

	countEntries := func(trackerID string) int {
		t.Helper()
		es, err := repo.Entries(ctx, user, "2026-01-01", "2026-12-31")
		if err != nil {
			t.Fatalf("entries: %v", err)
		}
		n := 0
		for _, e := range es {
			if e.TrackerID == trackerID {
				n++
			}
		}
		return n
	}
	seed := func(id string) {
		t.Helper()
		in := fixture()
		in.ID = id
		mustCreate(t, repo, user, in)
		for i := 0; i < 3; i++ {
			_, err := repo.LogEntry(ctx, user, id, NewEntry{
				ID: fmt.Sprintf("%s_e%d", id, i), LoggedOn: "2026-03-01",
				LoggedAt: time.Now().UTC(), Amount: 250,
			})
			if err != nil {
				t.Fatalf("log: %v", err)
			}
		}
	}

	seed("tr_keep")
	seed("tr_gone")

	if err := repo.Archive(ctx, user, "tr_keep"); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if n := countEntries("tr_keep"); n != 3 {
		t.Fatalf("archiving left %d of 3 entries.\n"+
			"\"A tracker you stop is not a tracker whose past disappears\" — this "+
			"is that sentence as an assertion.", n)
	}

	if err := repo.Destroy(ctx, user, "tr_gone"); err != nil {
		t.Fatalf("destroy: %v", err)
	}
	if n := countEntries("tr_gone"); n != 0 {
		t.Fatalf("destroying left %d entries behind.\n"+
			"The confirmation copy promises the history goes with it; orphaned "+
			"rows would make that copy a lie.", n)
	}
	if _, err := repo.getOwned(ctx, user, "tr_gone"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the destroyed tracker is still there: %v", err)
	}
	// The archived one is untouched by its neighbour's destruction.
	if n := countEntries("tr_keep"); n != 3 {
		t.Fatalf("destroying one tracker took %d of another's entries", 3-n)
	}
}

// Destroying is owner-scoped and idempotent, and it refuses a provisioned row.
func TestDestroyIsOwnerScopedIdempotentAndRefusesAPreset(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	in := fixture()
	in.ID = "tr_destroy_scope"
	mustCreate(t, repo, userA, in)

	// Another athlete's destroy must not touch it, and must not say so either.
	if err := repo.Destroy(ctx, userB, in.ID); err != nil {
		t.Fatalf("cross-user destroy errored, which also confirms the row exists: %v", err)
	}
	if _, err := repo.getOwned(ctx, userA, in.ID); err != nil {
		t.Fatalf("another athlete destroyed it: %v", err)
	}

	if err := repo.Destroy(ctx, userA, in.ID); err != nil {
		t.Fatalf("destroy: %v", err)
	}
	if err := repo.Destroy(ctx, userA, in.ID); err != nil {
		t.Fatalf("destroying twice must not error — a retry over a flaky "+
			"connection is the common case: %v", err)
	}

	// A provisioned row is refused: deleting it deletes the record that
	// provisioning happened, so the next list hands it straight back.
	if err := repo.EnsureDefaults(ctx, userA, DefaultsFor(userA)); err != nil {
		t.Fatalf("provision: %v", err)
	}
	waterID := PresetID(userA, "water")
	err := repo.Destroy(ctx, userA, waterID)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("destroying a provisioned preset gave %v, want ErrInvalidInput.\n"+
			"Allowing it makes the delete silently undo itself on the next list.", err)
	}
	if _, err := repo.getOwned(ctx, userA, waterID); err != nil {
		t.Fatalf("the refused destroy removed it anyway: %v", err)
	}
}

// The archived list is its own list: owner-scoped, and disjoint from the live
// one. A tracker must never be on both.
func TestArchivedListIsSeparateAndOwnerScoped(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()

	mine := fixture()
	mine.ID = "tr_arch_mine"
	mustCreate(t, repo, userA, mine)
	theirs := fixture()
	theirs.ID = "tr_arch_theirs"
	mustCreate(t, repo, userB, theirs)

	// A LIVE tracker for the same athlete, and it is the whole discriminating
	// vector rather than scenery. Without it userA owns exactly one row, that
	// row is archived, and "every row of mine" and "every archived row of mine"
	// return the same list — so dropping `archived_at IS NOT NULL` from the
	// query passes this test. Measured: it did, until this line existed.
	alsoLive := fixture()
	alsoLive.ID = "tr_arch_still_live"
	mustCreate(t, repo, userA, alsoLive)

	for _, row := range []struct{ user, id string }{{userA, mine.ID}, {userB, theirs.ID}} {
		if err := repo.Archive(ctx, row.user, row.id); err != nil {
			t.Fatalf("archive: %v", err)
		}
	}

	got, err := repo.ListArchived(ctx, userA)
	if err != nil {
		t.Fatalf("list archived: %v", err)
	}
	if len(got) != 1 || got[0].ID != mine.ID {
		t.Fatalf("archived list is %v, want exactly the caller's own tracker", got)
	}
	if got[0].ArchivedAt == nil {
		t.Fatal("an archived tracker came back with a null archived_at")
	}
	live, err := repo.List(ctx, userA)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(live) != 1 || live[0].ID != alsoLive.ID {
		t.Fatalf("live list is %v, want exactly the un-archived tracker", live)
	}
}

// The cap's ERROR is computed from LIVE rows, and this is the input that tells
// a right implementation from a wrong one.
//
// `atCap` never decides whether the insert happens — the statement's own WHERE
// does — so counting archived rows too is invisible on every ordinary path.
// It becomes visible in exactly one place: when the insert wrote nothing and
// the repository has to say WHY. An athlete with eight stopped trackers and
// none running who reuses a taken id must be told the id is taken, not that
// they are full, because "stop one first" is advice they cannot act on.
//
// Written after a mutation survived: counting every row instead of the live
// ones passed the whole suite, because no test ever put an athlete in the state
// where the two answers differ. A guard is only exercised by the input it is
// meant to reject.
func TestTheCapReportsOnLiveRowsWhenAnIDIsTaken(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()
	user := userA + "_capreason"

	// MaxLiveTrackers rows, every one of them stopped. Zero live.
	for _, id := range makeN(t, repo, user, MaxLiveTrackers) {
		if err := repo.Archive(ctx, user, id); err != nil {
			t.Fatalf("archive: %v", err)
		}
	}

	// An id that exists and is not theirs.
	taken := fixture()
	taken.ID = "tr_cap_taken_by_other"
	mustCreate(t, repo, userB, taken)

	_, err := repo.Create(ctx, user, taken)
	if errors.Is(err, ErrTooMany) {
		t.Fatalf("reported the cap for an athlete with zero live trackers.\n"+
			"They have %d stopped ones, which do not count — and 'stop one first' "+
			"is advice they cannot act on. The id was taken.", MaxLiveTrackers)
	}
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("got %v, want ErrAlreadyExists", err)
	}
}

// AddPreset provisions, is idempotent, and RESTORES rather than doing nothing.
//
// The restore half is the one that would ship broken: the (user_id, preset)
// unique index absorbs the second insert, so a plain provision returns no row
// and the athlete taps "Coffee" and watches nothing happen.
//
// Uses a synthetic preset rather than a shipped one because on this branch the
// only preset is water, which is `Default: true` — coffee (N77) has not merged
// here. Testing the REPOSITORY method directly is the right level anyway: the
// handler's job is looking the key up in the compiled catalogue, and that is
// covered in handler_test.go.
func TestAddPresetProvisionsIsIdempotentAndRestores(t *testing.T) {
	repo, _ := newTestRepo(t)
	ctx := context.Background()
	user := userA + "_preset"

	in := fixture()
	in.Preset = "synthetic"
	in.ID = PresetID(user, "synthetic")
	in.Name = "Synthetic"

	first, err := repo.AddPreset(ctx, user, in)
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if first.Preset != "synthetic" {
		t.Fatalf("provisioned row carries preset %q", first.Preset)
	}

	second, err := repo.AddPreset(ctx, user, in)
	if err != nil {
		t.Fatalf("adding twice: %v", err)
	}
	if second.ID != first.ID || !second.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("adding twice created a second row: %v then %v", first, second)
	}

	// Log something, stop it, turn it back on: the history has to survive the
	// round trip, or "turn coffee off" is indistinguishable from "delete it".
	if _, err := repo.LogEntry(ctx, user, in.ID, NewEntry{
		ID: "tr_preset_entry", LoggedOn: "2026-03-02",
		LoggedAt: time.Now().UTC(), Amount: 250,
	}); err != nil {
		t.Fatalf("log: %v", err)
	}
	if err := repo.Archive(ctx, user, in.ID); err != nil {
		t.Fatalf("archive: %v", err)
	}

	back, err := repo.AddPreset(ctx, user, in)
	if err != nil {
		t.Fatalf("re-adding an archived preset: %v", err)
	}
	if back.ArchivedAt != nil {
		t.Fatal("re-adding an archived preset returned it still archived — the " +
			"athlete taps it and nothing appears on Today")
	}
	live, err := repo.List(ctx, user)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(live) != 1 || live[0].ID != in.ID {
		t.Fatalf("live list is %v, want the restored preset", live)
	}
	es, err := repo.Entries(ctx, user, "2026-01-01", "2026-12-31")
	if err != nil {
		t.Fatalf("entries: %v", err)
	}
	if len(es) != 1 {
		t.Fatalf("%d entries survived turning a preset off and on, want 1", len(es))
	}
}
