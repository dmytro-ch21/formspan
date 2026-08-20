package bjj

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

func focusFixture(t *testing.T) (*PostgresRepository, *pgxpool.Pool, string) {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { pool.Close() })

	userID := "test_user_bjj_focus"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM bjj_focus WHERE user_id = $1`, userID); err != nil {
			t.Logf("cleanup focus: %v", err)
		}
	})
	// Own the library rows, rather than depending on `cmd/seed` having been
	// run — CI only migrates. That is the mistake the proficiency tests shipped
	// with, and it passed locally for a whole PR.
	seedTechnique(t, pool, "test-focus-a", "Armbar from Guard", "Submission", "Guard - Bottom")
	seedTechnique(t, pool, "test-focus-b", "Triangle from Guard", "Submission", "Guard - Bottom")
	seedTechnique(t, pool, "test-focus-c", "Knee Cut Pass", "Pass", "Half Guard - Top")
	return NewPostgresRepository(pool), pool, userID
}

// seedRoadmap owns its own curricula row rather than borrowing one — the same
// rule the technique fixtures follow, and for the same reason: CI only migrates,
// so anything `cmd/seed` would have written is simply absent there.
//
// User-owned and private, which is the cheapest row this table accepts:
// `curricula_source_matches_owner` makes (owner IS NULL) = (source <> 'user')
// bidirectional, and an ownerless row additionally has to be public.
func seedRoadmap(t *testing.T, pool *pgxpool.Pool, id, ownerUserID, name string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO curricula (id, owner_user_id, source, name, visibility)
		VALUES ($1, $2, 'user', $3, 'private')
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
		id, ownerUserID, name); err != nil {
		t.Fatalf("seed curriculum %s: %v", id, err)
	}
	t.Cleanup(func() {
		// After the focus cleanup (LIFO): bjj_focus_sources references this
		// row, and although that FK cascades, deleting the focus rows first
		// keeps the teardown honest about what removed what.
		if _, err := pool.Exec(ctx, `DELETE FROM curricula WHERE id = $1`, id); err != nil {
			t.Logf("cleanup curriculum %s: %v", id, err)
		}
	})
	return id
}

// focusOrigins reads the provenance column directly. Deliberately not exposed
// through Focus(): the API contract does not promise it, and a test that reads
// it through a serialiser is testing the serialiser.
func focusOrigins(t *testing.T, pool *pgxpool.Pool, userID string) map[string]string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT technique_id, origin FROM bjj_focus WHERE user_id = $1`, userID)
	if err != nil {
		t.Fatalf("read origins: %v", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, origin string
		if err := rows.Scan(&id, &origin); err != nil {
			t.Fatalf("scan origin: %v", err)
		}
		out[id] = origin
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read origins: %v", err)
	}
	return out
}

// focusClaims reads the roadmap claims on one athlete's row.
//
// Asserted directly, rather than only through what a release deletes, because
// the two origin guards — one on the attribution INSERT, one on the release
// DELETE — are REDUNDANT WITH EACH OTHER: either alone produces the right
// outcome, so an outcome-only test passes with either one removed. Both were
// mutation-tested and both survived until this helper existed, which is the
// exact shape that gets a load-bearing guard deleted as dead code.
func focusClaims(t *testing.T, pool *pgxpool.Pool, userID, techniqueID string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT curriculum_id FROM bjj_focus_sources
		WHERE user_id = $1 AND technique_id = $2 ORDER BY curriculum_id`, userID, techniqueID)
	if err != nil {
		t.Fatalf("read claims: %v", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan claim: %v", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read claims: %v", err)
	}
	return out
}

func focusIDs(list []Focus) []string {
	out := make([]string, len(list))
	for i, f := range list {
		out[i] = f.TechniqueID
	}
	return out
}

func TestSetFocusReplacesWholesaleAndKeepsTheAthletesOrder(t *testing.T) {
	repo, _, userID := focusFixture(t)
	ctx := context.Background()

	// Deliberately NOT alphabetical, and not id order — the list is ranked by
	// the athlete, so the read has to give back what was sent.
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-c", "test-focus-a"}, nil); err != nil {
		t.Fatalf("set focus: %v", err)
	}
	got, err := repo.Focus(ctx, userID)
	if err != nil {
		t.Fatalf("focus: %v", err)
	}
	if want := []string{"test-focus-c", "test-focus-a"}; !equalIDs(focusIDs(got), want) {
		t.Fatalf("order = %v, want %v", focusIDs(got), want)
	}
	if got[0].Name != "Knee Cut Pass" || got[0].Position != "Half Guard - Top" {
		t.Errorf("library join not applied: %+v", got[0])
	}

	// Replace, not merge: b arrives, c leaves.
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a", "test-focus-b"}, nil); err != nil {
		t.Fatalf("re-set focus: %v", err)
	}
	got, _ = repo.Focus(ctx, userID)
	if want := []string{"test-focus-a", "test-focus-b"}; !equalIDs(focusIDs(got), want) {
		t.Fatalf("after replace = %v, want %v", focusIDs(got), want)
	}
}

func TestReSavingAFocusListDoesNotResetStartedOn(t *testing.T) {
	// The property the whole column exists for. "You have been working on this
	// five weeks, consider rotating" is only answerable if the clock survives
	// the most ordinary edit there is — adding a technique, or reordering.
	//
	// A delete-then-insert implementation passes every other test in this file
	// and destroys this one silently: every entry comes back stamped today.
	repo, pool, userID := focusFixture(t)
	ctx := context.Background()

	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a"}, nil); err != nil {
		t.Fatalf("set focus: %v", err)
	}
	// Backdate it, standing in for "you added this five weeks ago".
	if _, err := pool.Exec(ctx, `
		UPDATE bjj_focus SET started_on = CURRENT_DATE - 35
		WHERE user_id = $1 AND technique_id = 'test-focus-a'`, userID); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	before, _ := repo.Focus(ctx, userID)
	if len(before) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(before))
	}

	// Add another and reorder — the existing entry moves to position 1.
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-b", "test-focus-a"}, nil); err != nil {
		t.Fatalf("re-set focus: %v", err)
	}
	after, _ := repo.Focus(ctx, userID)

	var kept, added Focus
	for _, f := range after {
		switch f.TechniqueID {
		case "test-focus-a":
			kept = f
		case "test-focus-b":
			added = f
		}
	}
	if kept.StartedOn != before[0].StartedOn {
		t.Errorf("started_on reset by a re-save: was %s, now %s — the rotation clock is destroyed "+
			"by reordering, which is the most ordinary edit there is",
			before[0].StartedOn, kept.StartedOn)
	}
	// ...and a genuinely new entry starts TODAY, asserted as equality rather
	// than "after the backdated one" — that weaker form is satisfied by any
	// date in the last five weeks, so an implementation stamping
	// CURRENT_DATE - 30 would pass it.
	var today string
	if err := pool.QueryRow(ctx, `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD')`).Scan(&today); err != nil {
		t.Fatalf("read today: %v", err)
	}
	if added.StartedOn != today {
		t.Errorf("a newly added technique got started_on %s, want %s", added.StartedOn, today)
	}
}

func TestReSavingAFocusListDoesNotRewriteProvenance(t *testing.T) {
	// THE RESTORE-PATH TEST, written before migration 000069 existed.
	//
	// `origin` is the second column on this table that must be set on insert and
	// never touched again, and adding a column to a shared write path has
	// silently blanked data three times in this repo — `exercise`'s updateWithin
	// under migrations 000052, 000057 and 000061. Every one of those put the new
	// column in the SET clause, every one was caught in review, and none was
	// caught by the suite. This is the suite catching it.
	//
	// The damage here would be quieter than a blanked field. Put `origin` in the
	// ON CONFLICT SET clause and a plain hand REORDER — which sends no roadmap,
	// so every id computes 'athlete' — relabels every roadmap-placed row as the
	// athlete's own. Nothing looks wrong; the list reads back identically. The
	// rows simply become undeletable, and deactivating the roadmap leaves its
	// techniques in BJJ logging, which is the bug the column was added to fix.
	repo, pool, userID := focusFixture(t)
	ctx := context.Background()
	roadmap := seedRoadmap(t, pool, "test-focus-roadmap", userID, "Test roadmap")

	// a arrives by hand; b arrives from the roadmap.
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a"}, nil); err != nil {
		t.Fatalf("hand set focus: %v", err)
	}
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-b", "test-focus-a"},
		&FocusSource{CurriculumID: roadmap, TechniqueIDs: []string{"test-focus-b"}}); err != nil {
		t.Fatalf("roadmap set focus: %v", err)
	}
	if got := focusOrigins(t, pool, userID); got["test-focus-a"] != originAthlete ||
		got["test-focus-b"] != originRoadmap {
		t.Fatalf("origins after the two writes = %v, want a=%s b=%s",
			got, originAthlete, originRoadmap)
	}

	// The most ordinary edit there is: reorder, by hand, no roadmap attached.
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a", "test-focus-b"}, nil); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	got := focusOrigins(t, pool, userID)
	if got["test-focus-b"] != originRoadmap {
		t.Errorf("a hand reorder rewrote the roadmap row's origin to %q — every roadmap row "+
			"now looks hand-picked, so deactivating the roadmap leaves them behind, "+
			"which is the whole bug", got["test-focus-b"])
	}
	if got["test-focus-a"] != originAthlete {
		t.Errorf("the hand-picked row's origin became %q", got["test-focus-a"])
	}

	// And the mirror: a ROADMAP write must not relabel the athlete's own row,
	// even when the roadmap names it. This is the both-sources case — the one
	// the ticket calls the hard part — and it is the same SET clause either way.
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a", "test-focus-b"},
		&FocusSource{CurriculumID: roadmap,
			TechniqueIDs: []string{"test-focus-a", "test-focus-b"}}); err != nil {
		t.Fatalf("roadmap re-apply: %v", err)
	}
	if got := focusOrigins(t, pool, userID); got["test-focus-a"] != originAthlete {
		t.Errorf("a roadmap naming a hand-picked technique took ownership of it (origin %q) — "+
			"deactivating would now delete something the athlete chose", got["test-focus-a"])
	}
}

func TestReleaseFocusSourceRemovesOnlyWhatTheRoadmapOwns(t *testing.T) {
	// The reported bug, and the thing that must not be fixed carelessly. Two
	// hand-picked techniques and one placed by a roadmap; deactivating the
	// roadmap takes exactly one row.
	repo, pool, userID := focusFixture(t)
	ctx := context.Background()
	roadmap := seedRoadmap(t, pool, "test-focus-roadmap", userID, "Test roadmap")

	if err := repo.SetFocus(ctx, userID,
		[]string{"test-focus-a", "test-focus-c"}, nil); err != nil {
		t.Fatalf("hand set focus: %v", err)
	}
	if err := repo.SetFocus(ctx, userID,
		[]string{"test-focus-b", "test-focus-a", "test-focus-c"},
		&FocusSource{CurriculumID: roadmap, TechniqueIDs: []string{"test-focus-b"}}); err != nil {
		t.Fatalf("apply roadmap: %v", err)
	}

	if err := repo.ReleaseFocusSource(ctx, userID, roadmap); err != nil {
		t.Fatalf("release: %v", err)
	}
	got, err := repo.Focus(ctx, userID)
	if err != nil {
		t.Fatalf("focus: %v", err)
	}
	ids := focusIDs(got)
	if len(ids) != 2 {
		t.Fatalf("after deactivation the list is %v, want the two hand-picked entries", ids)
	}
	for _, id := range ids {
		if id == "test-focus-b" {
			t.Errorf("the roadmap's technique survived deactivation: %v — this is the bug", ids)
		}
	}
	// Asserted as a set membership rather than by count alone: a fix that
	// deleted the wrong row would still leave two.
	for _, want := range []string{"test-focus-a", "test-focus-c"} {
		if !containsID(ids, want) {
			t.Errorf("hand-picked %s was deleted by a roadmap deactivation — %v", want, ids)
		}
	}

	// The claim is gone too, so a second deactivation cannot find anything to
	// act on. Idempotence matters here because the composition root calls this
	// before Archive, and a client retry replays both.
	if err := repo.ReleaseFocusSource(ctx, userID, roadmap); err != nil {
		t.Fatalf("second release: %v", err)
	}
	if again, _ := repo.Focus(ctx, userID); len(focusIDs(again)) != 2 {
		t.Errorf("a repeated deactivation changed the list: %v", focusIDs(again))
	}
}

func TestDeactivatingOneRoadmapLeavesAnotherRoadmapsTechniquesAlone(t *testing.T) {
	// Two roadmaps, and they OVERLAP — which is the case a single
	// source_curriculum_id column gets wrong. On a list capped at five, two
	// enrolled syllabuses sharing a technique is ordinary, not exotic.
	repo, pool, userID := focusFixture(t)
	ctx := context.Background()
	first := seedRoadmap(t, pool, "test-focus-roadmap", userID, "First roadmap")
	second := seedRoadmap(t, pool, "test-focus-roadmap-2", userID, "Second roadmap")

	// First roadmap brings a and b.
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a", "test-focus-b"},
		&FocusSource{CurriculumID: first,
			TechniqueIDs: []string{"test-focus-a", "test-focus-b"}}); err != nil {
		t.Fatalf("apply first roadmap: %v", err)
	}
	// Second roadmap wants b and c. b is already there — it must gain a second
	// claim rather than staying the first roadmap's alone.
	if err := repo.SetFocus(ctx, userID,
		[]string{"test-focus-b", "test-focus-c", "test-focus-a"},
		&FocusSource{CurriculumID: second,
			TechniqueIDs: []string{"test-focus-b", "test-focus-c"}}); err != nil {
		t.Fatalf("apply second roadmap: %v", err)
	}

	if err := repo.ReleaseFocusSource(ctx, userID, first); err != nil {
		t.Fatalf("release first: %v", err)
	}
	ids := focusIDs(mustFocus(t, repo, userID))
	if containsID(ids, "test-focus-a") {
		t.Errorf("the deactivated roadmap's exclusive technique survived: %v", ids)
	}
	if !containsID(ids, "test-focus-b") {
		t.Errorf("deactivating one roadmap took a technique the OTHER one is still working: %v — "+
			"this is what a single-valued provenance column gets wrong", ids)
	}
	if !containsID(ids, "test-focus-c") {
		t.Errorf("the other roadmap's own technique was removed: %v", ids)
	}

	// And deactivating the second one now clears the rest, since nothing is
	// left asking for them.
	if err := repo.ReleaseFocusSource(ctx, userID, second); err != nil {
		t.Fatalf("release second: %v", err)
	}
	if rest := focusIDs(mustFocus(t, repo, userID)); len(rest) != 0 {
		t.Errorf("after both roadmaps were deactivated the list still holds %v", rest)
	}
}

func TestATechniqueHeldByBothHandAndRoadmapSurvivesDeactivation(t *testing.T) {
	// The hard part, stated by the ticket. The athlete picked it; a roadmap
	// happens to include it. Deactivating the roadmap must not take the
	// athlete's own choice with it.
	repo, pool, userID := focusFixture(t)
	ctx := context.Background()
	roadmap := seedRoadmap(t, pool, "test-focus-roadmap", userID, "Test roadmap")

	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a"}, nil); err != nil {
		t.Fatalf("hand set focus: %v", err)
	}
	// The roadmap contains a as well as b, and names both — exactly what
	// roadmapFocus.ts sends, since it lists every roadmap technique in the
	// proposal.
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a", "test-focus-b"},
		&FocusSource{CurriculumID: roadmap,
			TechniqueIDs: []string{"test-focus-a", "test-focus-b"}}); err != nil {
		t.Fatalf("apply roadmap: %v", err)
	}

	// The claim is refused OUTRIGHT, not merely ineffective. Asserted here
	// because the release's own origin check would produce the same visible
	// outcome even if this one were removed — see focusClaims.
	if claims := focusClaims(t, pool, userID, "test-focus-a"); len(claims) != 0 {
		t.Errorf("a roadmap registered a claim %v on a hand-picked technique — the row is now "+
			"one guard away from being deleted by a deactivation the athlete never asked for",
			claims)
	}
	if claims := focusClaims(t, pool, userID, "test-focus-b"); len(claims) != 1 {
		t.Errorf("the roadmap's own technique carries claims %v, want exactly one", claims)
	}

	if err := repo.ReleaseFocusSource(ctx, userID, roadmap); err != nil {
		t.Fatalf("release: %v", err)
	}
	ids := focusIDs(mustFocus(t, repo, userID))
	if !containsID(ids, "test-focus-a") {
		t.Errorf("a technique the athlete chose by hand was deleted because a roadmap also "+
			"listed it: %v — this is the data-loss half of the bug", ids)
	}
	if containsID(ids, "test-focus-b") {
		t.Errorf("the roadmap's own technique survived: %v", ids)
	}
}

func TestReleaseRefusesToDeleteARowItDoesNotOwnEvenIfAClaimNamesIt(t *testing.T) {
	// The release's OWN origin guard, exercised against a state SetFocus cannot
	// produce — a claim on a row whose origin is not 'roadmap'.
	//
	// That state is unreachable today precisely because the attribution INSERT
	// refuses to create it, which is why the guard survived mutation until this
	// test: the two checks cover for each other. Constructed by hand here, so the
	// release is proved to defend itself rather than to be defended by its
	// neighbour. A second writer to this table — which 000031's own comment
	// anticipates — would have no such neighbour.
	repo, pool, userID := focusFixture(t)
	ctx := context.Background()
	roadmap := seedRoadmap(t, pool, "test-focus-roadmap", userID, "Test roadmap")

	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a"}, nil); err != nil {
		t.Fatalf("hand set focus: %v", err)
	}
	// The state the guard exists for: an athlete-owned row that a claim names.
	if _, err := pool.Exec(ctx, `
		INSERT INTO bjj_focus_sources (user_id, technique_id, curriculum_id)
		VALUES ($1, 'test-focus-a', $2)`, userID, roadmap); err != nil {
		t.Fatalf("plant claim: %v", err)
	}

	if err := repo.ReleaseFocusSource(ctx, userID, roadmap); err != nil {
		t.Fatalf("release: %v", err)
	}
	if ids := focusIDs(mustFocus(t, repo, userID)); !containsID(ids, "test-focus-a") {
		t.Errorf("a row the athlete owns was deleted because a claim named it: %v — "+
			"origin is what decides ownership, and a stray claim must not override it", ids)
	}
	// The claim itself is still withdrawn: the roadmap has let go, it simply
	// took nothing with it.
	if claims := focusClaims(t, pool, userID, "test-focus-a"); len(claims) != 0 {
		t.Errorf("the claim survived the release: %v", claims)
	}
}

func TestRowsPredatingProvenanceAreNeverRemovedByADeactivation(t *testing.T) {
	// The migration's choice, asserted rather than described in a comment.
	//
	// A row written before migration 000069 carries origin 'unknown', and we do
	// not know whether the athlete chose it or a roadmap did. The safe reading is
	// the athlete's: a deactivation leaves it alone. The cost is that an athlete
	// already carrying stale roadmap techniques keeps them until they clear them
	// by hand; the alternative deletes choices that were never a roadmap's.
	repo, pool, userID := focusFixture(t)
	ctx := context.Background()
	roadmap := seedRoadmap(t, pool, "test-focus-roadmap", userID, "Test roadmap")

	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a"}, nil); err != nil {
		t.Fatalf("set focus: %v", err)
	}
	// Stand in for a row this migration found already in the table.
	if _, err := pool.Exec(ctx, `
		UPDATE bjj_focus SET origin = 'unknown' WHERE user_id = $1`, userID); err != nil {
		t.Fatalf("age the row: %v", err)
	}

	// A roadmap now names it. It must NOT be able to take ownership — that would
	// turn the safe choice back into the destructive one on the next apply.
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a"},
		&FocusSource{CurriculumID: roadmap, TechniqueIDs: []string{"test-focus-a"}}); err != nil {
		t.Fatalf("apply roadmap: %v", err)
	}
	if got := focusOrigins(t, pool, userID); got["test-focus-a"] != originUnknown {
		t.Errorf("a roadmap took ownership of a pre-provenance row (origin now %q)", got["test-focus-a"])
	}
	if err := repo.ReleaseFocusSource(ctx, userID, roadmap); err != nil {
		t.Fatalf("release: %v", err)
	}
	if ids := focusIDs(mustFocus(t, repo, userID)); !containsID(ids, "test-focus-a") {
		t.Errorf("a pre-provenance row was deleted by a deactivation: %v", ids)
	}
}

func TestReleaseFocusSourceIsScopedToTheCaller(t *testing.T) {
	// Same shape as TestFocusIsScopedToTheCaller, and it needs saying separately
	// because this is a DELETE keyed on a curriculum id — which is shared between
	// athletes by design, since a public syllabus is enrolled in by many.
	repo, pool, userID := focusFixture(t)
	ctx := context.Background()
	const other = "test_user_bjj_focus_other"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM bjj_focus WHERE user_id = $1`, other); err != nil {
			t.Logf("cleanup other: %v", err)
		}
	})
	roadmap := seedRoadmap(t, pool, "test-focus-roadmap", userID, "Test roadmap")

	for _, u := range []string{userID, other} {
		if err := repo.SetFocus(ctx, u, []string{"test-focus-a"},
			&FocusSource{CurriculumID: roadmap, TechniqueIDs: []string{"test-focus-a"}}); err != nil {
			t.Fatalf("apply roadmap for %s: %v", u, err)
		}
	}

	if err := repo.ReleaseFocusSource(ctx, userID, roadmap); err != nil {
		t.Fatalf("release: %v", err)
	}
	if ids := focusIDs(mustFocus(t, repo, other)); len(ids) != 1 {
		t.Errorf("one athlete leaving a curriculum emptied another athlete's focus list: %v", ids)
	}
	if ids := focusIDs(mustFocus(t, repo, userID)); len(ids) != 0 {
		t.Errorf("caller's own roadmap row survived: %v", ids)
	}

	// AND THE OTHER ATHLETE'S CLAIM SURVIVES, which the row count alone does not
	// prove — this is the half that mutation-testing found missing.
	//
	// Drop the user scope from the claim delete and the outer DELETE still only
	// reaches the caller's rows, so both assertions above stay green. What
	// silently happens instead is that the OTHER athlete's claim is withdrawn
	// while their focus row stays: origin 'roadmap', no claim, so no future
	// release can ever name it. Their roadmap technique is stranded in the
	// wizard permanently — the reported bug, made unfixable, in somebody else's
	// account.
	if claims := focusClaims(t, pool, other, "test-focus-a"); len(claims) != 1 {
		t.Fatalf("another athlete's claim on the same curriculum was withdrawn by this "+
			"caller leaving it: claims = %v. Their focus row can now never be released.", claims)
	}
	// Demonstrated rather than asserted structurally: their own deactivation
	// still works, which is what a withdrawn claim would have broken.
	if err := repo.ReleaseFocusSource(ctx, other, roadmap); err != nil {
		t.Fatalf("release for other: %v", err)
	}
	if ids := focusIDs(mustFocus(t, repo, other)); len(ids) != 0 {
		t.Errorf("the other athlete's own deactivation left %v behind", ids)
	}
}

func TestSetFocusRejectsAnUnknownCurriculum(t *testing.T) {
	// The curricula FK, surfaced as invalid input rather than escaping as a raw
	// constraint error and becoming a 500 — the same treatment the technique FK
	// already gets.
	repo, _, userID := focusFixture(t)
	ctx := context.Background()

	err := repo.SetFocus(ctx, userID, []string{"test-focus-a"},
		&FocusSource{CurriculumID: "no-such-curriculum", TechniqueIDs: []string{"test-focus-a"}})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("error = %v, want ErrInvalidInput", err)
	}
	if got, _ := repo.Focus(ctx, userID); len(got) != 0 {
		t.Errorf("a rejected save left %v behind — the transaction did not roll back", focusIDs(got))
	}
}

func mustFocus(t *testing.T, repo *PostgresRepository, userID string) []Focus {
	t.Helper()
	got, err := repo.Focus(context.Background(), userID)
	if err != nil {
		t.Fatalf("focus: %v", err)
	}
	return got
}

func containsID(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

func TestSetFocusToEmptyClearsTheList(t *testing.T) {
	// Finishing a block is a normal thing to do, and it must not be
	// unexpressible. `<> ALL('{}')` is true for every row, which is what makes
	// the prune work here — `NOT IN ()` would not even parse.
	repo, _, userID := focusFixture(t)
	ctx := context.Background()

	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a", "test-focus-b"}, nil); err != nil {
		t.Fatalf("set focus: %v", err)
	}
	if err := repo.SetFocus(ctx, userID, []string{}, nil); err != nil {
		t.Fatalf("clear focus: %v", err)
	}
	got, err := repo.Focus(ctx, userID)
	if err != nil {
		t.Fatalf("focus: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("list not cleared: %v", focusIDs(got))
	}
	if got == nil {
		t.Error("nil slice marshals to null; clients iterate this without a null check")
	}
}

func TestSetFocusRejectsAnUnknownTechnique(t *testing.T) {
	// The FK is the real guard; this checks it surfaces as invalid input
	// rather than escaping as a raw constraint error and becoming a 500.
	repo, _, userID := focusFixture(t)
	ctx := context.Background()

	err := repo.SetFocus(ctx, userID, []string{"test-focus-a", "no-such-technique"}, nil)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("error = %v, want ErrInvalidInput", err)
	}
	// And the whole call rolls back: a partially-applied focus list would
	// leave the athlete with a list they never asked for.
	got, _ := repo.Focus(ctx, userID)
	if len(got) != 0 {
		t.Errorf("a rejected save left %v behind — the transaction did not roll back", focusIDs(got))
	}
}

func TestFocusIsScopedToTheCaller(t *testing.T) {
	repo, pool, userID := focusFixture(t)
	ctx := context.Background()
	const other = "test_user_bjj_focus_other"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM bjj_focus WHERE user_id = $1`, other); err != nil {
			t.Logf("cleanup other: %v", err)
		}
	})

	if err := repo.SetFocus(ctx, other, []string{"test-focus-a", "test-focus-b"}, nil); err != nil {
		t.Fatalf("set other's focus: %v", err)
	}
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-c"}, nil); err != nil {
		t.Fatalf("set focus: %v", err)
	}

	mine, _ := repo.Focus(ctx, userID)
	if !equalIDs(focusIDs(mine), []string{"test-focus-c"}) {
		t.Fatalf("caller sees %v, want only their own", focusIDs(mine))
	}
	// And replacing mine must not touch theirs — the prune is user-scoped.
	theirs, _ := repo.Focus(ctx, other)
	if len(theirs) != 2 {
		t.Errorf("another athlete's list was pruned by this caller's save: %v", focusIDs(theirs))
	}
}

func equalIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestSetFocusTreatsNilAsEmptyRatherThanANoOp(t *testing.T) {
	// nil and empty are different things to pgx: `[]string(nil)` binds as SQL
	// NULL, and `technique_id <> ALL(NULL)` is NULL for every row — so the
	// prune deleted nothing and a PUT with no body returned 200 having changed
	// nothing, with a response body that looked right because it is a
	// read-back of the untouched list.
	//
	// Exactly the failure the `<> ALL` choice was made to avoid; the NULL just
	// moved from an element of the array to the array parameter. The handler
	// rejects a missing field too, so this covers the repository's own guard.
	repo, _, userID := focusFixture(t)
	ctx := context.Background()

	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a", "test-focus-b"}, nil); err != nil {
		t.Fatalf("set focus: %v", err)
	}
	if err := repo.SetFocus(ctx, userID, nil, nil); err != nil {
		t.Fatalf("set focus nil: %v", err)
	}
	got, err := repo.Focus(ctx, userID)
	if err != nil {
		t.Fatalf("focus: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("a nil list left %v in place — the prune was a silent no-op", focusIDs(got))
	}
}

func TestConcurrentSavesOfDifferentOrderingsDoNotDeadlock(t *testing.T) {
	// The upsert takes one row lock per technique. Iterating in the ATHLETE's
	// order means two devices saving the same techniques ranked differently
	// take the same locks in opposite orders — measured at 23 deadlocks in 40
	// rounds before the fix, each surfacing as a 500.
	//
	// SetFocus therefore iterates in technique_id order while keeping
	// `position` from the original index, so every transaction takes locks in
	// the same sequence and the stored ranking is unaffected.
	repo, pool, userID := focusFixture(t)
	ctx := context.Background()
	const other = "test_user_bjj_focus_race"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM bjj_focus WHERE user_id = $1`, other); err != nil {
			t.Logf("cleanup race user: %v", err)
		}
	})

	forward := []string{"test-focus-a", "test-focus-b", "test-focus-c"}
	reverse := []string{"test-focus-c", "test-focus-b", "test-focus-a"}
	// Pre-existing rows are the ones that collide: an uncommitted INSERT is
	// invisible to the other transaction, so both users need the rows already.
	if err := repo.SetFocus(ctx, userID, forward, nil); err != nil {
		t.Fatalf("prime: %v", err)
	}

	const rounds = 25
	errs := make(chan error, rounds*2)
	for i := 0; i < rounds; i++ {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); errs <- repo.SetFocus(ctx, userID, forward, nil) }()
		go func() { defer wg.Done(); errs <- repo.SetFocus(ctx, userID, reverse, nil) }()
		wg.Wait()
	}
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent save failed: %v", err)
		}
	}

	// And the list is still coherent afterwards — one of the two orderings,
	// not an interleaving of both.
	got, _ := repo.Focus(ctx, userID)
	if !equalIDs(focusIDs(got), forward) && !equalIDs(focusIDs(got), reverse) {
		t.Errorf("concurrent saves interleaved into %v", focusIDs(got))
	}
}
