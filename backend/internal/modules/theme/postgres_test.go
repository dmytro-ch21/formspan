package theme

import (
	"context"
	"errors"
	"os"
	"strings"
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
	// LIFO and strictly after every defer, so `defer pool.Close()` here would
	// close it out from under the deletes below.
	t.Cleanup(pool.Close)
	return pool
}

func repoFor(t *testing.T, userID string) *PostgresRepository {
	t.Helper()
	pool := testPool(t)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM training_themes WHERE user_id = $1`, userID)
	})
	return NewPostgresRepository(pool)
}

func TestSetCreatesThenReplaces(t *testing.T) {
	repo := repoFor(t, "u_theme_set")
	ctx := context.Background()

	first, err := repo.Set(ctx, "u_theme_set", "2026-08-03", Input{Title: "Guard retention"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if first.Title != "Guard retention" || first.WeekStart != "2026-08-03" {
		t.Fatalf("unexpected: %+v", first)
	}

	second, err := repo.Set(ctx, "u_theme_set", "2026-08-03", Input{Title: "Deload", Notes: "back is grumpy"})
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if second.Title != "Deload" || second.Notes != "back is grumpy" {
		t.Errorf("replace did not take: %+v", second)
	}
	// A week holds ONE theme. If Set inserted rather than upserted, the second
	// call would have failed on the primary key — or worse, in a shape where it
	// did not, the week would now have two.
	got, err := repo.List(ctx, "u_theme_set", "2026-08-03", "2026-08-03")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Errorf("a week should hold exactly one theme, got %d", len(got))
	}
	// When the week was first given a theme stays true even after the wording
	// changes — that is why the upsert does not touch created_at.
	if !second.CreatedAt.Equal(first.CreatedAt) {
		t.Errorf("created_at moved on update: %v -> %v", first.CreatedAt, second.CreatedAt)
	}
}

// The constraint that keeps two themes from covering the same days.
func TestSetRefusesAWeekThatIsNotAMonday(t *testing.T) {
	repo := repoFor(t, "u_theme_monday")
	// 2026-08-04 is a Tuesday.
	_, err := repo.Set(context.Background(), "u_theme_monday", "2026-08-04", Input{Title: "Nope"})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
	if !strings.Contains(err.Error(), "Monday") {
		t.Errorf("the error should say what is wrong, got %q", err)
	}
}

func TestListIsScopedToTheCallerAndTheWindow(t *testing.T) {
	repo := repoFor(t, "u_theme_mine")
	other := repoFor(t, "u_theme_other")
	ctx := context.Background()

	for _, wk := range []string{"2026-07-27", "2026-08-03", "2026-08-10"} {
		if _, err := repo.Set(ctx, "u_theme_mine", wk, Input{Title: "mine " + wk}); err != nil {
			t.Fatal(err)
		}
	}
	// Another athlete's theme in the same week. Cross-user leakage here would
	// be invisible in a single-user fixture.
	if _, err := other.Set(ctx, "u_theme_other", "2026-08-03", Input{Title: "theirs"}); err != nil {
		t.Fatal(err)
	}

	got, err := repo.List(ctx, "u_theme_mine", "2026-08-03", "2026-08-10")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("window should hold 2 weeks, got %d: %+v", len(got), got)
	}
	if got[0].WeekStart != "2026-08-03" || got[1].WeekStart != "2026-08-10" {
		t.Errorf("not ordered oldest first: %+v", got)
	}
	for _, x := range got {
		if x.Title == "theirs" {
			t.Fatal("another athlete's theme leaked into this list")
		}
	}
}

func TestGetAndDeleteAreScopedToTheCaller(t *testing.T) {
	repo := repoFor(t, "u_theme_a")
	other := repoFor(t, "u_theme_b")
	ctx := context.Background()

	if _, err := repo.Set(ctx, "u_theme_a", "2026-08-03", Input{Title: "mine"}); err != nil {
		t.Fatal(err)
	}

	// Somebody else's week is not found, rather than forbidden — a 403 would
	// confirm it exists.
	if _, err := other.Get(ctx, "u_theme_b", "2026-08-03"); !errors.Is(err, ErrNotFound) {
		t.Errorf("another athlete's week should be ErrNotFound, got %v", err)
	}
	if err := other.Delete(ctx, "u_theme_b", "2026-08-03"); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleting another athlete's week should be ErrNotFound, got %v", err)
	}
	// ...and it must still be there.
	if _, err := repo.Get(ctx, "u_theme_a", "2026-08-03"); err != nil {
		t.Errorf("the owner's theme was affected: %v", err)
	}

	if err := repo.Delete(ctx, "u_theme_a", "2026-08-03"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	// Absent is not success — a client should be able to tell "there was
	// nothing" from "it is gone".
	if err := repo.Delete(ctx, "u_theme_a", "2026-08-03"); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleting twice should be ErrNotFound, got %v", err)
	}
}

func TestListReturnsAnEmptySliceRatherThanNil(t *testing.T) {
	repo := repoFor(t, "u_theme_empty")
	got, err := repo.List(context.Background(), "u_theme_empty", "2026-08-03", "2026-08-10")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		// Serialises as `null` rather than `[]`, and a client mapping over the
		// result should not have to defend against that.
		t.Error("List returned nil; the handler would serialise null")
	}
}
