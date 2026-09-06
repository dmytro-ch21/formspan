package accomplishment

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// The whole module is a query, so almost everything worth asserting needs a
// database. What is tested here is the DERIVATION: which row wins a "first",
// what fails to qualify, and which calendar day an award lands on.

func newTestRepo(t *testing.T) (*PostgresRepository, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	pool, err := database.NewPool(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered first so it closes LAST under LIFO — every cleanup below
	// still needs the pool open.
	t.Cleanup(pool.Close)
	return NewPostgresRepository(pool), pool
}

func cleanupUser(t *testing.T, pool *pgxpool.Pool, userIDs ...string) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		for _, u := range userIDs {
			// Contests cascade to their matches, sessions to their tags.
			if _, err := pool.Exec(ctx, `DELETE FROM contests WHERE user_id = $1`, u); err != nil {
				t.Logf("cleanup contests %s: %v", u, err)
			}
			if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, u); err != nil {
				t.Logf("cleanup sessions %s: %v", u, err)
			}
		}
	})
}

// seedTechnique owns the library row this package depends on rather than
// borrowing one a seeder happened to leave behind — CLAUDE.md's rule, enforced
// structurally by `technique`'s own cleanup.
func seedTechnique(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO techniques (id, name, category, position)
		VALUES ($1, $1, 'submission', 'Guard - Bottom') ON CONFLICT (id) DO NOTHING`, id); err != nil {
		t.Fatalf("seed technique: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM techniques WHERE id = $1`, id); err != nil {
			t.Logf("cleanup technique %s: %v", id, err)
		}
	})
	return id
}

func seedSession(t *testing.T, pool *pgxpool.Pool, id, userID, sport, startedAt string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO sessions (id, user_id, sport, name, started_at)
		VALUES ($1, $2, $3, 'Test session', $4)`, id, userID, sport, startedAt); err != nil {
		t.Fatalf("seed session %s: %v", id, err)
	}
}

func seedTag(t *testing.T, pool *pgxpool.Pool, sessionID, userID, event string, techniqueID *string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO bjj_session_tags (session_id, user_id, category, event, position, technique_id)
		VALUES ($1, $2, 'submission', $3, 'Guard - Bottom', $4)`,
		sessionID, userID, event, techniqueID); err != nil {
		t.Fatalf("seed tag: %v", err)
	}
}

func seedContest(t *testing.T, pool *pgxpool.Pool, id, userID, sport, name string, heldOn *string, placement, entrants *int) string {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO contests (id, user_id, sport, name, held_on, placement, entrants)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		id, userID, sport, name, heldOn, placement, entrants); err != nil {
		t.Fatalf("seed contest %s: %v", id, err)
	}
	return id
}

func seedMatch(t *testing.T, pool *pgxpool.Pool, contestID, userID string, position int, result, method string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO contest_matches (contest_id, user_id, position, result, method)
		VALUES ($1, $2, $3, $4, $5)`, contestID, userID, position, result, method); err != nil {
		t.Fatalf("seed match: %v", err)
	}
}

func str(s string) *string { return &s }
func num(i int) *int       { return &i }

func byKind(list []Accomplishment) map[Kind]Accomplishment {
	m := make(map[Kind]Accomplishment, len(list))
	for _, a := range list {
		m[a.Kind] = a
	}
	return m
}

func list(t *testing.T, repo *PostgresRepository, userID, tz string) []Accomplishment {
	t.Helper()
	out, err := repo.List(context.Background(), userID, tz)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	return out
}

func TestNoEvidenceIsAnEmptyList(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_empty"
	cleanupUser(t, pool, user)

	got := list(t, repo, user, "UTC")
	if got == nil {
		t.Error("must be a non-nil empty slice, or it marshals as null")
	}
	if len(got) != 0 {
		t.Errorf("a new account has achieved nothing yet, got %d", len(got))
	}
}

// One entry that was a gold medal won by submission earns all five competition
// awards at once — which is correct, and is the case that would break if any
// branch of the union were miswired to another branch's WHERE.
func TestOneGoldMedalEarnsEveryCompetitionAward(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_gold"
	cleanupUser(t, pool, user)

	c := seedContest(t, pool, "acc_c_gold", user, "bjj", "IBJJF Pans", str("2026-03-14"), num(1), num(32))
	seedMatch(t, pool, c, user, 1, "won", "points")
	seedMatch(t, pool, c, user, 2, "won", "submission")

	got := byKind(list(t, repo, user, "UTC"))
	for _, k := range []Kind{FirstCompetition, FirstMatchWon, FirstSubmissionWin, FirstPodium, FirstGold} {
		a, ok := got[k]
		if !ok {
			t.Errorf("%s: not awarded", k)
			continue
		}
		if a.Basis != Measured {
			t.Errorf("%s: a bracket result is measured, got %q", k, a.Basis)
		}
		if a.AchievedOn == nil || *a.AchievedOn != "2026-03-14" {
			t.Errorf("%s: want 2026-03-14, got %v", k, a.AchievedOn)
		}
		if a.ContestName == nil || *a.ContestName != "IBJJF Pans" {
			t.Errorf("%s: evidence should name the contest, got %v", k, a.ContestName)
		}
		// Entrants travels with placement: third of four and third of sixty-four
		// are not the same result.
		if a.Entrants == nil || *a.Entrants != 32 {
			t.Errorf("%s: want the field size alongside, got %v", k, a.Entrants)
		}
	}
}

// `contests` is cross-sport by design — it has to hold a powerlifting meet and
// a 10k — so without the sport filter a road race would award a BJJ podium.
func TestOnlyBjjContestsCount(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_sport"
	cleanupUser(t, pool, user)

	c := seedContest(t, pool, "acc_c_meet", user, "strength", "State Meet", str("2026-02-01"), num(1), num(12))
	seedMatch(t, pool, c, user, 1, "won", "submission")

	if got := list(t, repo, user, "UTC"); len(got) != 0 {
		t.Errorf("a powerlifting meet is not a BJJ accomplishment, got %+v", got)
	}
}

func TestPodiumNeedsARecordedPlacement(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_podium"
	cleanupUser(t, pool, user)

	// A null placement is "not recorded", never "did not place" — so it can
	// neither earn a podium nor be read as having missed one.
	seedContest(t, pool, "acc_c_nullplace", user, "bjj", "Open mat comp", str("2026-01-10"), nil, nil)
	// Fourth is a real placement and not a podium.
	seedContest(t, pool, "acc_c_fourth", user, "bjj", "Winter Open", str("2026-01-20"), num(4), num(16))

	got := byKind(list(t, repo, user, "UTC"))
	if _, ok := got[FirstPodium]; ok {
		t.Error("neither an unrecorded placement nor a fourth is a podium")
	}
	if _, ok := got[FirstGold]; ok {
		t.Error("no gold here")
	}
	// Entering still counts, which is the point of that award existing.
	if _, ok := got[FirstCompetition]; !ok {
		t.Error("entering a competition is itself the first accomplishment")
	}
}

func TestThirdIsAPodiumButNotGold(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_third"
	cleanupUser(t, pool, user)

	seedContest(t, pool, "acc_c_third", user, "bjj", "Spring Open", str("2026-04-01"), num(3), num(8))
	got := byKind(list(t, repo, user, "UTC"))
	if _, ok := got[FirstPodium]; !ok {
		t.Error("third is a podium")
	}
	if _, ok := got[FirstGold]; ok {
		t.Error("third is not gold")
	}
}

// "First" must mean earliest by the date it HAPPENED, not by whichever row was
// entered first — somebody typing up a decade of history enters them in any
// order at all.
func TestFirstMeansEarliestHeldNotEarliestEntered(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_order"
	cleanupUser(t, pool, user)

	// Entered newest-first, deliberately.
	seedContest(t, pool, "acc_c_2026", user, "bjj", "Recent", str("2026-03-14"), num(1), num(32))
	seedContest(t, pool, "acc_c_2019", user, "bjj", "The first one", str("2019-05-05"), num(2), num(6))

	got := byKind(list(t, repo, user, "UTC"))
	first := got[FirstCompetition]
	if first.ContestName == nil || *first.ContestName != "The first one" {
		t.Errorf("want the 2019 entry, got %v", first.ContestName)
	}
	if first.AchievedOn == nil || *first.AchievedOn != "2019-05-05" {
		t.Errorf("want 2019-05-05, got %v", first.AchievedOn)
	}
	// The gold is only on the later entry, so it must date from there rather
	// than inheriting the earliest contest's date.
	gold := got[FirstGold]
	if gold.AchievedOn == nil || *gold.AchievedOn != "2026-03-14" {
		t.Errorf("gold: want 2026-03-14, got %v", gold.AchievedOn)
	}
}

// An undated entry must not be read as the beginning of time. Sorting a NULL
// first would hand "first competition" to whichever row simply lacked a date.
func TestAnUndatedContestDoesNotStealFirst(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_undated"
	cleanupUser(t, pool, user)

	seedContest(t, pool, "acc_c_undated", user, "bjj", "Sometime in 2015", nil, num(2), num(8))
	seedContest(t, pool, "acc_c_dated", user, "bjj", "Dated", str("2020-06-01"), num(2), num(8))

	got := byKind(list(t, repo, user, "UTC"))
	first := got[FirstCompetition]
	if first.ContestName == nil || *first.ContestName != "Dated" {
		t.Errorf("the dated entry must win first; got %v", first.ContestName)
	}
}

func TestFirstScoredComesFromTheTagStream(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_scored"
	tech := seedTechnique(t, pool, "ac_fx_armbar_from_guard")
	cleanupUser(t, pool, user)

	seedSession(t, pool, "acc_s_1", user, "bjj", "2026-02-10T18:00:00Z")
	seedTag(t, pool, "acc_s_1", user, "attempted", &tech)
	seedSession(t, pool, "acc_s_2", user, "bjj", "2026-02-17T18:00:00Z")
	seedTag(t, pool, "acc_s_2", user, "scored", &tech)

	got := byKind(list(t, repo, user, "UTC"))
	a, ok := got[FirstScored]
	if !ok {
		t.Fatal("landing something live is an accomplishment")
	}
	// A tag is the athlete's own account of what happened; nobody checked it.
	// Rendering it as externally verified is the one wrong answer here.
	if a.Basis != Reported {
		t.Errorf("want reported, got %q", a.Basis)
	}
	if a.AchievedOn == nil || *a.AchievedOn != "2026-02-17" {
		t.Errorf("want the scoring session's day, got %v", a.AchievedOn)
	}
	if a.SessionID == nil || *a.SessionID != "acc_s_2" {
		t.Errorf("evidence should point at the session, got %v", a.SessionID)
	}
	if a.TechniqueName == nil || *a.TechniqueName != tech {
		t.Errorf("want the technique resolved from the library, got %v", a.TechniqueName)
	}
	// An `attempted` that never landed earns nothing.
	if _, ok := got[FirstDrilledScored]; ok {
		t.Error("nothing was drilled before, so the funnel has not completed")
	}
}

// A tag naming no technique is real evidence the schema deliberately accepts —
// "got the sweep" without saying which — and must still earn the first score,
// or the fast logging path is quietly punished.
func TestAnUntaggedScoreStillCounts(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_untagged"
	cleanupUser(t, pool, user)

	seedSession(t, pool, "acc_s_untagged", user, "bjj", "2026-02-10T18:00:00Z")
	seedTag(t, pool, "acc_s_untagged", user, "scored", nil)

	got := byKind(list(t, repo, user, "UTC"))
	a, ok := got[FirstScored]
	if !ok {
		t.Fatal("a score with no named technique is still a score")
	}
	if a.TechniqueID != nil || a.TechniqueName != nil {
		t.Errorf("nothing was named, so both must be null: %v / %v", a.TechniqueID, a.TechniqueName)
	}
}

// The funnel award requires a STRICTLY EARLIER session. Drilling and landing
// something inside one class is an ordinary afternoon; the award is for having
// drilled it, gone away, and hit it live later.
func TestGraduationNeedsAnEarlierSession(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_grad"
	tech := seedTechnique(t, pool, "ac_fx_triangle_from_guard")
	cleanupUser(t, pool, user)

	// Same session: drilled and scored together.
	seedSession(t, pool, "acc_g_1", user, "bjj", "2026-02-10T18:00:00Z")
	seedTag(t, pool, "acc_g_1", user, "drilled", &tech)
	seedTag(t, pool, "acc_g_1", user, "scored", &tech)

	if _, ok := byKind(list(t, repo, user, "UTC"))[FirstDrilledScored]; ok {
		t.Fatal("drilling and landing it in one class is not the funnel completing")
	}

	// A later session lands it again — now the drill genuinely came first.
	seedSession(t, pool, "acc_g_2", user, "bjj", "2026-03-03T18:00:00Z")
	seedTag(t, pool, "acc_g_2", user, "scored", &tech)

	got := byKind(list(t, repo, user, "UTC"))
	a, ok := got[FirstDrilledScored]
	if !ok {
		t.Fatal("drilled in February, landed in March — the funnel completed")
	}
	if a.AchievedOn == nil || *a.AchievedOn != "2026-03-03" {
		t.Errorf("want the later session's day, got %v", a.AchievedOn)
	}
	if a.Basis != Reported {
		t.Errorf("want reported, got %q", a.Basis)
	}
}

// A different technique's drill must not graduate this one.
func TestGraduationIsPerTechnique(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_grad_cross"
	drilled := seedTechnique(t, pool, "ac_fx_kimura_from_guard")
	scored := seedTechnique(t, pool, "ac_fx_omoplata_from_guard")
	cleanupUser(t, pool, user)

	seedSession(t, pool, "acc_x_1", user, "bjj", "2026-02-10T18:00:00Z")
	seedTag(t, pool, "acc_x_1", user, "drilled", &drilled)
	seedSession(t, pool, "acc_x_2", user, "bjj", "2026-03-03T18:00:00Z")
	seedTag(t, pool, "acc_x_2", user, "scored", &scored)

	if _, ok := byKind(list(t, repo, user, "UTC"))[FirstDrilledScored]; ok {
		t.Fatal("drilling a kimura does not graduate an omoplata")
	}
}

// Which calendar day an award falls on depends on the athlete's zone, and
// getting it wrong renders the previous day for everyone west of Greenwich —
// the trap the mobile suite pins its whole timezone for.
func TestTheZoneDecidesTheDay(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_tz"
	cleanupUser(t, pool, user)

	// 02:00 UTC on the 15th is 19:00 on the 14th in California.
	seedSession(t, pool, "acc_tz_1", user, "bjj", "2026-03-15T02:00:00Z")
	seedTag(t, pool, "acc_tz_1", user, "scored", nil)

	utc := byKind(list(t, repo, user, "UTC"))[FirstScored]
	if utc.AchievedOn == nil || *utc.AchievedOn != "2026-03-15" {
		t.Errorf("UTC: want 2026-03-15, got %v", utc.AchievedOn)
	}

	la := byKind(list(t, repo, user, "America/Los_Angeles"))[FirstScored]
	if la.AchievedOn == nil || *la.AchievedOn != "2026-03-14" {
		t.Errorf("America/Los_Angeles: want 2026-03-14, got %v", la.AchievedOn)
	}
}

// A tag can only reach this module through a BJJ session, but the join says so
// explicitly rather than trusting every future writer to keep it true.
func TestTagsOnANonBjjSessionAreIgnored(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_wrongsport"
	cleanupUser(t, pool, user)

	seedSession(t, pool, "acc_w_1", user, "strength", "2026-02-10T18:00:00Z")
	seedTag(t, pool, "acc_w_1", user, "scored", nil)

	if got := list(t, repo, user, "UTC"); len(got) != 0 {
		t.Errorf("a tag hanging off a barbell session is not mat evidence, got %+v", got)
	}
}

func TestScopedToTheCaller(t *testing.T) {
	repo, pool := newTestRepo(t)
	const owner, stranger = "user_acc_owner", "user_acc_stranger"
	cleanupUser(t, pool, owner, stranger)

	c := seedContest(t, pool, "acc_c_owned", owner, "bjj", "Pan Ams", str("2026-03-14"), num(1), num(32))
	seedMatch(t, pool, c, owner, 1, "won", "submission")
	seedSession(t, pool, "acc_o_1", owner, "bjj", "2026-02-10T18:00:00Z")
	seedTag(t, pool, "acc_o_1", owner, "scored", nil)

	if got := list(t, repo, stranger, "UTC"); len(got) != 0 {
		t.Errorf("a stranger has achieved nothing here, got %+v", got)
	}
	if got := list(t, repo, owner, "UTC"); len(got) == 0 {
		t.Error("the owner's own awards went missing")
	}
}

// The whole list, in order, on a realistic record: mat first, competition
// later, which is the order almost everybody lives it in.
func TestTheListReadsAsACareer(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_career"
	tech := seedTechnique(t, pool, "ac_fx_bow_and_arrow_choke")
	cleanupUser(t, pool, user)

	seedSession(t, pool, "acc_k_1", user, "bjj", "2025-01-10T18:00:00Z")
	seedTag(t, pool, "acc_k_1", user, "drilled", &tech)
	seedSession(t, pool, "acc_k_2", user, "bjj", "2025-02-20T18:00:00Z")
	seedTag(t, pool, "acc_k_2", user, "scored", &tech)

	c := seedContest(t, pool, "acc_c_career", user, "bjj", "Summer Open", str("2025-07-12"), num(3), num(16))
	seedMatch(t, pool, c, user, 1, "won", "submission")
	seedMatch(t, pool, c, user, 2, "lost", "points")

	got := list(t, repo, user, "UTC")
	want := []Kind{
		FirstScored, FirstDrilledScored, // both on 2025-02-20, display order decides
		FirstCompetition, FirstMatchWon, FirstSubmissionWin, FirstPodium,
	}
	if len(got) != len(want) {
		t.Fatalf("want %d awards, got %d: %+v", len(want), len(got), got)
	}
	for i, k := range want {
		if got[i].Kind != k {
			t.Errorf("position %d: want %s, got %s", i, k, got[i].Kind)
		}
	}
	// No gold: third place.
	for _, a := range got {
		if a.Kind == FirstGold {
			t.Error("third is not gold")
		}
	}
	// Dates ascend, which is what makes the list read as a career.
	var prev string
	for _, a := range got {
		if a.AchievedOn == nil {
			t.Fatal("everything here is dated")
		}
		if *a.AchievedOn < prev {
			t.Errorf("out of order: %s came after %s", *a.AchievedOn, prev)
		}
		prev = *a.AchievedOn
	}
}

// The DRILLED side of the graduation must filter sport too, not just the
// scored side.
//
// Review caught this and demonstrated it against a real database: without the
// predicate, a `drilled` tag hanging off a strength session graduated a later
// BJJ score. Not reachable through any writer today — PutDetail refuses to
// attach a reflection to a session of another sport — which is exactly why it
// needs a test rather than a reader's trust: nothing else in the suite would
// notice the predicate being removed again.
func TestADrillOnANonBjjSessionDoesNotGraduate(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_acc_grad_sport"
	tech := seedTechnique(t, pool, "ac_fx_guillotine_from_guard")
	cleanupUser(t, pool, user)

	// The drill is on a barbell session, which cannot be mat evidence.
	seedSession(t, pool, "acc_gs_1", user, "strength", "2026-02-10T18:00:00Z")
	seedTag(t, pool, "acc_gs_1", user, "drilled", &tech)
	// The score is genuinely on the mat.
	seedSession(t, pool, "acc_gs_2", user, "bjj", "2026-03-03T18:00:00Z")
	seedTag(t, pool, "acc_gs_2", user, "scored", &tech)

	got := byKind(list(t, repo, user, "UTC"))
	if _, ok := got[FirstDrilledScored]; ok {
		t.Error("a drill logged against a strength session cannot complete the mat funnel")
	}
	// The score itself is still real evidence and still earns its own award.
	if _, ok := got[FirstScored]; !ok {
		t.Error("the scored tag is on a BJJ session and still counts")
	}
}
