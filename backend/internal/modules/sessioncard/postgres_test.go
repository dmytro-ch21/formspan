package sessioncard

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

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
	// Registered FIRST so LIFO runs it LAST — the CLAUDE.md pool gotcha.
	t.Cleanup(func() { pool.Close() })
	return pool
}

// athlete seeds a profile complete enough for the "estimated" calorie path,
// plus a bodyweight, and cleans up everything it touches.
func athlete(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	ctx := context.Background()
	dob := time.Now().UTC().AddDate(-30, 0, -1).Format("2006-01-02")
	if _, err := pool.Exec(ctx, `
		INSERT INTO profiles (user_id, height_cm, date_of_birth, sex)
		VALUES ($1, 180, $2::date, 'male')
		ON CONFLICT (user_id) DO UPDATE
		  SET height_cm = 180, date_of_birth = $2::date, sex = 'male'`, id, dob); err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO body_checkins (user_id, measured_on, weight_kg)
		VALUES ($1, CURRENT_DATE - 1, 80)
		ON CONFLICT (user_id, measured_on) DO UPDATE SET weight_kg = 80`, id); err != nil {
		t.Fatalf("seed checkin: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM body_checkins WHERE user_id = $1`, id)
		_, _ = pool.Exec(ctx, `DELETE FROM profiles WHERE user_id = $1`, id)
	})
	return id
}

// finished inserts a completed session of the given length, ending `daysAgo`
// ago so ordering is deterministic.
func finished(t *testing.T, pool *pgxpool.Pool, user, id, sport string, minutes, daysAgo int) string {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO sessions (id, user_id, sport, name, started_at, ended_at)
		VALUES ($1, $2, $3, 'Test session',
		        now() - make_interval(days => $4, mins => $5),
		        now() - make_interval(days => $4))`,
		id, user, sport, daysAgo, minutes); err != nil {
		t.Fatalf("seed session %s: %v", id, err)
	}
	return id
}

func TestCardIsOwnerScopedAndFinishedOnly(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo := NewPostgresRepository(pool)

	me := athlete(t, pool, "sc_owner")
	other := athlete(t, pool, "sc_other")
	mine := finished(t, pool, me, "sc_s_mine", "strength", 60, 1)
	theirs := finished(t, pool, other, "sc_s_theirs", "strength", 60, 1)

	if _, err := repo.Card(ctx, me, mine); err != nil {
		t.Fatalf("own session: %v", err)
	}

	// Somebody else's session, an id that never existed, and a session still
	// running must all be the SAME miss — anything else says which ids are
	// real.
	if _, err := repo.Card(ctx, me, theirs); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another athlete's session: want ErrNotFound, got %v", err)
	}
	if _, err := repo.Card(ctx, me, "sc_no_such_session"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("absent session: want ErrNotFound, got %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, sport, name, started_at)
		VALUES ('sc_running', $1, 'strength', 'In progress', now())`, me); err != nil {
		t.Fatalf("seed running: %v", err)
	}
	if _, err := repo.Card(ctx, me, "sc_running"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unfinished session: want ErrNotFound, got %v", err)
	}
}

// THE BUG THIS TEST EXISTS FOR: the history query must exclude the session
// being scored. Ranking a session against itself guarantees a tie, which drags
// every percentile toward the middle — and worst for the athlete with the
// least history, where one row of twenty is a whole 5 points.
func TestSessionIsExcludedFromItsOwnHistory(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo := NewPostgresRepository(pool)
	me := athlete(t, pool, "sc_hist")

	// Ten easy prior sessions, then one much longer than all of them.
	for i := 0; i < 10; i++ {
		finished(t, pool, me, fmt.Sprintf("sc_h_%d", i), "strength", 30, i+2)
	}
	big := finished(t, pool, me, "sc_h_big", "strength", 200, 1)

	card, err := repo.Card(ctx, me, big)
	if err != nil {
		t.Fatalf("card: %v", err)
	}
	if card.Score == nil {
		t.Fatal("no score with ten prior sessions")
	}
	// It beat all ten. Including itself would make it tie with one of them and
	// land below 100.
	if card.Score.Value != 100 {
		t.Fatalf("score %d — the session is ranking against itself", card.Score.Value)
	}
	if card.Score.Compared != 10 {
		t.Fatalf("compared against %d, want the 10 priors", card.Score.Compared)
	}
}

// Below the threshold there is no score at all, rather than one computed from
// four data points.
func TestNoScoreWithoutEnoughHistory(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo := NewPostgresRepository(pool)
	me := athlete(t, pool, "sc_thin")

	for i := 0; i < 3; i++ {
		finished(t, pool, me, fmt.Sprintf("sc_t_%d", i), "strength", 40, i+2)
	}
	only := finished(t, pool, me, "sc_t_now", "strength", 60, 1)

	card, err := repo.Card(ctx, me, only)
	if err != nil {
		t.Fatalf("card: %v", err)
	}
	if card.Score != nil {
		t.Fatalf("scored %+v from three prior sessions", card.Score)
	}
	// The calories still arrive — one absent number must not suppress the
	// other.
	if card.Calories == nil {
		t.Fatal("calories should not depend on score history")
	}
}

// Calories come from the bodyweight AS AT THE SESSION, not today's. A card
// opened months later must price the session at the weight it was performed
// at.
func TestCaloriesUseTheWeightAtTheTimeAndRefuseWithout(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo := NewPostgresRepository(pool)
	me := athlete(t, pool, "sc_kcal")
	id := finished(t, pool, me, "sc_k_1", "strength", 60, 1)

	card, err := repo.Card(ctx, me, id)
	if err != nil {
		t.Fatalf("card: %v", err)
	}
	if card.Calories == nil {
		t.Fatal("no estimate for a complete profile")
	}
	// ~185 for an 80 kg athlete's hour of ordinary lifting. Pinned loosely
	// because the MET depends on what was logged, tightly enough to catch a
	// gross-instead-of-net regression (which would roughly double it).
	if card.Calories.Kcal < 120 || card.Calories.Kcal > 260 {
		t.Fatalf("kcal %d is outside the plausible band for 60 min", card.Calories.Kcal)
	}
	if card.Calories.Precision != "estimated" {
		t.Fatalf("precision %q, want estimated", card.Calories.Precision)
	}

	// Remove the bodyweight: the estimate must vanish rather than fall back to
	// an assumed 70 kg.
	if _, err := pool.Exec(ctx, `DELETE FROM body_checkins WHERE user_id = $1`, me); err != nil {
		t.Fatalf("clear weight: %v", err)
	}
	card, err = repo.Card(ctx, me, id)
	if err != nil {
		t.Fatalf("card without weight: %v", err)
	}
	if card.Calories != nil {
		t.Fatalf("estimated %+v with no bodyweight on record", card.Calories)
	}
}

// The weight is the one ON OR BEFORE the session, not the latest on record.
//
// Pinned separately because the obvious mutation — deleting the date
// predicate — fails on parameter arity rather than on the wrong answer, so it
// went red without proving anything. This seeds a heavier check-in AFTER the
// session and asserts the estimate ignores it: a card opened months later has
// to price the session at the weight it was performed at, or every old session
// silently re-prices itself every time somebody steps on a scale.
func TestCaloriesIgnoreWeighInsAfterTheSession(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo := NewPostgresRepository(pool)
	me := athlete(t, pool, "sc_when") // seeds 80 kg at CURRENT_DATE - 1

	// The session is a week old; the 80 kg check-in above is more recent than
	// it, so give the session an earlier weight to be found.
	id := finished(t, pool, me, "sc_w_1", "strength", 60, 7)
	if _, err := pool.Exec(ctx, `
		INSERT INTO body_checkins (user_id, measured_on, weight_kg)
		VALUES ($1, CURRENT_DATE - 10, 60)
		ON CONFLICT (user_id, measured_on) DO UPDATE SET weight_kg = 60`, me); err != nil {
		t.Fatalf("seed earlier checkin: %v", err)
	}

	card, err := repo.Card(ctx, me, id)
	if err != nil {
		t.Fatalf("card: %v", err)
	}
	if card.Calories == nil {
		t.Fatal("no estimate")
	}
	atSixty := card.Calories.Kcal

	// Now make the session recent enough that the 80 kg row applies. Same
	// work, heavier athlete, so the estimate must RISE — if the query took
	// "latest on record" both readings would already have been 80.
	if _, err := pool.Exec(ctx,
		`UPDATE sessions SET started_at = now() - interval '60 minutes', ended_at = now() WHERE id = $1`,
		id); err != nil {
		t.Fatalf("move session: %v", err)
	}
	card, err = repo.Card(ctx, me, id)
	if err != nil {
		t.Fatalf("card after move: %v", err)
	}
	atEighty := card.Calories.Kcal

	if atEighty <= atSixty {
		t.Fatalf("80 kg (%d kcal) should cost more than 60 kg (%d) for identical work — "+
			"the weight is not being read as at the session", atEighty, atSixty)
	}
}

// TestTheWeighInDayDoesNotMoveWithTheMachinesTimezone pins the frame the
// bodyweight lookup resolves its day in.
//
// **THIS IS A TIME BOMB TEST, and it exists because it caught one.** The query
// used to compare `measured_on` against `$2::date` — a cast applied to the
// session's timestamp — which resolves through the Go process's local zone on
// the way out and the Postgres server's `TimeZone` on the way back. A session
// ending at 01:38 UTC cast back to the PREVIOUS day, the same-day weigh-in fell
// outside the window, and the card dropped its calorie estimate entirely. It
// failed for the roughly seven hours a day the two zones disagree and passed
// for the other seventeen, so it would have shipped green from CI and broken on
// a laptop, or the reverse.
//
// `time.Local` is forced to a negative offset here rather than trusting the
// machine's, so the test is red on a UTC runner too. That is the whole point:
// a zone bug that only reproduces in one timezone is not covered by a suite
// that runs in another.
func TestTheWeighInDayDoesNotMoveWithTheMachinesTimezone(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo := NewPostgresRepository(pool)

	saved := time.Local
	t.Cleanup(func() { time.Local = saved })
	time.Local = time.FixedZone("PDT-ish", -7*60*60)

	me := athlete(t, pool, "sc_tz")
	// Early on a UTC day, which is still the PREVIOUS day anywhere west of
	// Greenwich — the exact straddle that broke it.
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, sport, name, started_at, ended_at)
		VALUES ($1, $2, 'strength', 'Late session',
		        (CURRENT_DATE - 1 + interval '1 hour 30 minutes') AT TIME ZONE 'UTC',
		        (CURRENT_DATE - 1 + interval '2 hours 30 minutes') AT TIME ZONE 'UTC')`,
		"sc_tz_1", me); err != nil {
		t.Fatalf("seed straddling session: %v", err)
	}
	// The only weigh-in, dated on the session's UTC day. Under the old cast the
	// session resolved to the day BEFORE this and the subquery found nothing.
	if _, err := pool.Exec(ctx, `
		DELETE FROM body_checkins WHERE user_id = $1`, me); err != nil {
		t.Fatalf("clear seeded weight: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO body_checkins (user_id, measured_on, weight_kg)
		VALUES ($1, CURRENT_DATE - 1, 80)`, me); err != nil {
		t.Fatalf("seed weigh-in: %v", err)
	}

	card, err := repo.Card(ctx, me, "sc_tz_1")
	if err != nil {
		t.Fatalf("card: %v", err)
	}
	if card.Calories == nil {
		t.Fatal("the weigh-in on the session's own UTC day was missed — the day is " +
			"being resolved through a machine's local zone again")
	}
}
