package bjj

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

/*
The position map.

Its own fixture rather than `profFixture`'s, because these tests need the
POSITION to vary — the shared seeder hard-codes 'Guard' on every tag, which is
exactly the column under test here.
*/

func posFixture(t *testing.T, userID string) (*PostgresRepository, *pgxpool.Pool) {
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
	// Registered first so LIFO closes it last — see the t.Cleanup gotcha.
	t.Cleanup(func() { pool.Close() })
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID); err != nil {
			t.Logf("cleanup sessions: %v", err)
		}
	})
	return NewPostgresRepository(pool), pool
}

type posTag struct {
	position string
	event    string
	count    int
}

func seedPositions(
	t *testing.T, pool *pgxpool.Pool, userID, sessionID string,
	startedAt time.Time, tags []posTag,
) {
	t.Helper()
	ctx := context.Background()
	seedSession(t, pool, sessionID, userID)
	if _, err := pool.Exec(ctx,
		`UPDATE sessions SET started_at = $2 WHERE id = $1`, sessionID, startedAt); err != nil {
		t.Fatalf("set started_at: %v", err)
	}
	for _, tg := range tags {
		if _, err := pool.Exec(ctx, `
			INSERT INTO bjj_session_tags
				(session_id, user_id, category, event, position, technique_id, count)
			VALUES ($1, $2, 'submission', $3, $4, NULL, $5)`,
			sessionID, userID, tg.event, tg.position, tg.count); err != nil {
			t.Fatalf("seed tag %s/%s: %v", tg.position, tg.event, err)
		}
	}
}

func byPosition(rows []PositionStat, name string) *PositionStat {
	for i := range rows {
		if rows[i].Position == name {
			return &rows[i]
		}
	}
	return nil
}

func TestListPositions_FoldsBothDirectionsAcrossSessions(t *testing.T) {
	// The point of the view: what you finish from a position and what gets done
	// to you there, side by side, summed over every session rather than the
	// most recent one.
	const userID = "test_user_bjj_positions_fold"
	repo, pool := posFixture(t, userID)
	ctx := context.Background()

	seedPositions(t, pool, userID, "pos_s1", time.Now().Add(-72*time.Hour), []posTag{
		{"Half Guard", "conceded", 3},
		{"Half Guard", "defended", 1},
		{"Closed Guard", "scored", 2},
	})
	seedPositions(t, pool, userID, "pos_s2", time.Now().Add(-24*time.Hour), []posTag{
		{"Half Guard", "conceded", 4},
		{"Half Guard", "attempted", 2},
		{"Half Guard", "drilled", 6},
		{"Closed Guard", "scored", 1},
	})

	rows, err := repo.ListPositions(ctx, userID)
	if err != nil {
		t.Fatalf("ListPositions: %v", err)
	}

	hg := byPosition(rows, "Half Guard")
	if hg == nil {
		t.Fatal("Half Guard missing from the map")
	}
	if hg.Conceded != 7 {
		t.Errorf("conceded = %d, want 7 summed across both sessions", hg.Conceded)
	}
	if hg.Attempted != 2 || hg.Defended != 1 {
		t.Errorf("attempted/defended = %d/%d, want 2/1", hg.Attempted, hg.Defended)
	}
	if hg.Drilled != 6 {
		t.Errorf("drilled = %d, want 6", hg.Drilled)
	}
	if hg.Sessions != 2 {
		t.Errorf("sessions = %d, want 2 — the honesty check on every count above", hg.Sessions)
	}
	if hg.Live() != 10 {
		t.Errorf("Live() = %d, want 10 (scored+attempted+conceded+defended, drilled excluded)", hg.Live())
	}

	cg := byPosition(rows, "Closed Guard")
	if cg == nil || cg.Scored != 3 {
		t.Errorf("Closed Guard scored = %v, want 3", cg)
	}
}

func TestListPositions_DrilledDoesNotCountAsLiveEvidence(t *testing.T) {
	/*
		A position you have only ever drilled has told you nothing about a
		round, so it must not outrank one you have actually been beaten in.
		This is the ordering rule, and it is the difference between a map of
		your game and a map of your gym's curriculum.
	*/
	const userID = "test_user_bjj_positions_drill"
	repo, pool := posFixture(t, userID)

	seedPositions(t, pool, userID, "pos_d1", time.Now(), []posTag{
		{"Mount", "drilled", 50},
		{"Back Control", "conceded", 3},
	})

	rows, err := repo.ListPositions(context.Background(), userID)
	if err != nil {
		t.Fatalf("ListPositions: %v", err)
	}
	if len(rows) < 2 {
		t.Fatalf("got %d rows, want both positions", len(rows))
	}
	if rows[0].Position != "Back Control" {
		t.Errorf("first row = %q, want Back Control — 50 drills outranked 3 live concessions",
			rows[0].Position)
	}
	if mount := byPosition(rows, "Mount"); mount == nil || mount.Live() != 0 {
		t.Errorf("Mount Live() = %v, want 0 — drilled is not a live outcome", mount)
	}
}

func TestListPositions_IsScopedToTheCaller(t *testing.T) {
	// The rule every read of a training record follows.
	const mine = "test_user_bjj_positions_mine"
	const theirs = "test_user_bjj_positions_theirs"
	repo, pool := posFixture(t, mine)
	_, _ = posFixture(t, theirs)

	seedPositions(t, pool, mine, "pos_mine", time.Now(), []posTag{{"Side Control", "scored", 1}})
	seedPositions(t, pool, theirs, "pos_theirs", time.Now(), []posTag{{"Side Control", "conceded", 99}})

	rows, err := repo.ListPositions(context.Background(), mine)
	if err != nil {
		t.Fatalf("ListPositions: %v", err)
	}
	sc := byPosition(rows, "Side Control")
	if sc == nil {
		t.Fatal("Side Control missing")
	}
	if sc.Conceded != 0 {
		t.Errorf("conceded = %d, want 0 — another athlete's tags are in this map", sc.Conceded)
	}
	if sc.Scored != 1 {
		t.Errorf("scored = %d, want 1", sc.Scored)
	}
}

func TestListPositions_SkipsUnpositionedTags(t *testing.T) {
	// `position` is nullable-ish in practice (empty string on a tag recorded
	// without one). An empty bucket in a position map is noise, not a finding.
	const userID = "test_user_bjj_positions_blank"
	repo, pool := posFixture(t, userID)

	seedPositions(t, pool, userID, "pos_blank", time.Now(), []posTag{
		{"", "scored", 5},
		{"Guard", "scored", 1},
	})

	rows, err := repo.ListPositions(context.Background(), userID)
	if err != nil {
		t.Fatalf("ListPositions: %v", err)
	}
	for _, r := range rows {
		if r.Position == "" {
			t.Error("an empty position is in the map")
		}
	}
}

func TestListPositions_TiedRowsDoNotScramble(t *testing.T) {
	/*
		**This test cannot fail for the reason it is named, and that is recorded
		rather than hidden.**

		Two versions were tried and both passed with the `t.position` tiebreaker
		DELETED: running the query five times and comparing (which tests
		Postgres's determinism, not ours), and asserting tied rows come back
		alphabetically (which they do anyway at this size — the sort-based
		aggregate happens to emit them in order).

		So the tiebreaker is unprovable defence at any fixture size worth
		writing. It stays in the query because a capped list whose tail depends
		on aggregate order hashes differently between identical requests, which
		makes the ETag on this endpoint a permanent cache miss — the exact
		reasoning the proficiency list records. What this test still earns is
		the weaker claim in its assertions: ties do not scramble, and the row
		count is right.
	*/
	const userID = "test_user_bjj_positions_order"
	repo, pool := posFixture(t, userID)

	// Seeded deliberately out of alphabetical order.
	seedPositions(t, pool, userID, "pos_tie", time.Now(), []posTag{
		{"Turtle", "scored", 2},
		{"Mount", "scored", 2},
		{"Knee Shield", "scored", 2},
	})

	rows, err := repo.ListPositions(context.Background(), userID)
	if err != nil {
		t.Fatalf("ListPositions: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(rows))
	}
	want := []string{"Knee Shield", "Mount", "Turtle"}
	for i, w := range want {
		if rows[i].Position != w {
			got := []string{rows[0].Position, rows[1].Position, rows[2].Position}
			t.Fatalf("tied order = %v, want %v — the ordering is not total", got, want)
		}
	}
}
