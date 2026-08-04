package bjj

import (
	"context"
	"errors"
	"os"
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
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-c", "test-focus-a"}); err != nil {
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
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a", "test-focus-b"}); err != nil {
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

	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a"}); err != nil {
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
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-b", "test-focus-a"}); err != nil {
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
	if !kept.StartedOn.Equal(before[0].StartedOn) {
		t.Errorf("started_on reset by a re-save: was %s, now %s — the rotation clock is destroyed "+
			"by reordering, which is the most ordinary edit there is",
			before[0].StartedOn.Format("2006-01-02"), kept.StartedOn.Format("2006-01-02"))
	}
	// ...and a genuinely new entry starts today, or the column means nothing
	// in the other direction.
	if !added.StartedOn.After(before[0].StartedOn) {
		t.Errorf("a newly added technique got started_on %s, want today",
			added.StartedOn.Format("2006-01-02"))
	}
}

func TestSetFocusToEmptyClearsTheList(t *testing.T) {
	// Finishing a block is a normal thing to do, and it must not be
	// unexpressible. `<> ALL('{}')` is true for every row, which is what makes
	// the prune work here — `NOT IN ()` would not even parse.
	repo, _, userID := focusFixture(t)
	ctx := context.Background()

	if err := repo.SetFocus(ctx, userID, []string{"test-focus-a", "test-focus-b"}); err != nil {
		t.Fatalf("set focus: %v", err)
	}
	if err := repo.SetFocus(ctx, userID, []string{}); err != nil {
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

	err := repo.SetFocus(ctx, userID, []string{"test-focus-a", "no-such-technique"})
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

	if err := repo.SetFocus(ctx, other, []string{"test-focus-a", "test-focus-b"}); err != nil {
		t.Fatalf("set other's focus: %v", err)
	}
	if err := repo.SetFocus(ctx, userID, []string{"test-focus-c"}); err != nil {
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
