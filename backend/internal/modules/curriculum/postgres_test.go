package curriculum

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Gated on TEST_DATABASE_URL and skipping silently without it, like every other
// integration test here. Point it at a DIFFERENT database from DATABASE_URL.
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
	// Registered FIRST so it runs LAST: t.Cleanup is LIFO and strictly after
	// every defer, so a `defer pool.Close()` would shut the pool before the row
	// cleanup below got to use it. This is the gotcha CLAUDE.md calls out.
	t.Cleanup(func() { pool.Close() })
	return pool
}

// seedTechnique returns a library id, creating one if the catalog is empty so
// the suite does not depend on the seed having run.
func seedTechnique(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO techniques (id, name, category, position)
		VALUES ($1, $1, 'sweep', 'Guard - Bottom') ON CONFLICT (id) DO NOTHING`, id)
	if err != nil {
		t.Fatalf("seed technique: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM techniques WHERE id = $1`, id) })
	return id
}

// logEvidence writes one session's worth of tags, dated `daysAgo`.
//
// Real rows in the real tables, because the whole point of the mastery query is
// that it reads the evidence stream the app actually writes.
func logEvidence(t *testing.T, pool *pgxpool.Pool, userID, techID string, daysAgo int, events map[string]int) {
	t.Helper()
	ctx := context.Background()
	sessionID := fmt.Sprintf("%s-s%d", userID, daysAgo)
	_, err := pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, sport, started_at)
		VALUES ($1, $2, 'bjj', now() - make_interval(days => $3))
		ON CONFLICT (id) DO NOTHING`, sessionID, userID, daysAgo)
	if err != nil {
		t.Fatalf("seed session: %v", err)
	}
	for event, count := range events {
		if count == 0 {
			continue
		}
		_, err := pool.Exec(ctx, `
			INSERT INTO bjj_session_tags (session_id, user_id, category, event, technique_id, count)
			VALUES ($1, $2, 'sweep', $3, $4, $5)`, sessionID, userID, event, techID, count)
		if err != nil {
			t.Fatalf("seed tag: %v", err)
		}
	}
}

// backdateEnrollment moves the measurement window back, so a test can log
// evidence "since enrolling" without waiting months.
//
// Needed because the window is real: enrolling today and logging a session
// dated last week correctly counts for nothing, which is the whole point of the
// window and was the first thing these tests got wrong.
func backdateEnrollment(t *testing.T, pool *pgxpool.Pool, userID string, days int) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		UPDATE curriculum_enrollments SET started_on = CURRENT_DATE - make_interval(days => $2)
		WHERE user_id = $1`, userID, days)
	if err != nil {
		t.Fatalf("backdate enrollment: %v", err)
	}
}

func cleanupUser(t *testing.T, pool *pgxpool.Pool, userIDs ...string) {
	t.Cleanup(func() {
		// EVERY user's enrollments before ANY user's curricula. Interleaved per
		// user, deleting the owner's curricula while a follower listed later in
		// the same call was still enrolled hit the RESTRICT and failed -- and
		// the error was discarded, so the rows leaked silently. That left
		// orphaned PUBLIC curricula in the test database which then appeared in
		// every later run's List.
		for _, u := range userIDs {
			mustExec(t, pool, `DELETE FROM bjj_session_tags WHERE user_id = $1`, u)
			mustExec(t, pool, `DELETE FROM sessions WHERE user_id = $1`, u)
			mustExec(t, pool, `DELETE FROM curriculum_enrollments WHERE user_id = $1`, u)
		}
		for _, u := range userIDs {
			mustExec(t, pool, `DELETE FROM curricula WHERE owner_user_id = $1`, u)
		}
	})
}

// mustExec reports a cleanup failure instead of hiding it. A swallowed error
// here does not fail the test that caused it -- it poisons every later run.
func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Errorf("cleanup %q: %v", sql, err)
	}
}

// seedOwnerlessCurriculum writes a VOLA-authored row the way a deploy does.
//
// `repo.Create` cannot produce one: it hard-codes `owner_user_id` to the caller
// and `source` to 'user', which is exactly the property that makes the `vola`
// flag trustworthy — an athlete has no route to an ownerless row. So the seed
// path is reproduced here in SQL rather than faked by nulling a column
// afterwards, which would not exercise `curricula_source_matches_owner`.
//
// Cleans up AFTER ITSELF and by id, since `cleanupUser` deletes by owner and an
// ownerless row has none — one left behind is a public curriculum that shows up
// in every later run's List.
func seedOwnerlessCurriculum(t *testing.T, pool *pgxpool.Pool, name, track, belt string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(), `
		INSERT INTO curricula (owner_user_id, source, name, description, belt, track, visibility)
		VALUES (NULL, 'seed', $1, '', $2, $3, 'public')
		RETURNING id`, name, belt, track).Scan(&id)
	if err != nil {
		t.Fatalf("seed ownerless curriculum: %v", err)
	}
	t.Cleanup(func() {
		mustExec(t, pool, `DELETE FROM curriculum_enrollments WHERE curriculum_id = $1`, id)
		mustExec(t, pool, `DELETE FROM curricula WHERE id = $1`, id)
	})
	return id
}

func intp(v int) *int         { return &v }
func f64p(v float64) *float64 { return &v }
func strp(v string) *string   { return &v }

// ---------------------------------------------------------------------------
// Authorization. First, because the same cross-user read has shipped twice here.
// ---------------------------------------------------------------------------

func TestAPrivateCurriculumIsInvisibleToEveryoneElse(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "owner1", "stranger1")

	c, err := repo.Create(ctx, "owner1", "", NewCurriculum{Name: "Mine", Visibility: "private"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// NOT ErrForbidden. A 403 on a private row confirms the id exists, which is
	// the enumeration oracle the workout module documents having shipped once.
	if _, err := repo.Get(ctx, "stranger1", c.ID, ""); err != ErrNotFound {
		t.Fatalf("stranger Get: want ErrNotFound, got %v", err)
	}
	list, err := repo.List(ctx, "stranger1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, got := range list {
		if got.ID == c.ID {
			t.Fatal("a stranger's private curriculum appeared in List")
		}
	}
	if _, err := repo.Update(ctx, "stranger1", c.ID, "", Update{Name: strp("Yours")}); err != ErrNotFound {
		t.Fatalf("stranger Update: want ErrNotFound, got %v", err)
	}
	if err := repo.Delete(ctx, "stranger1", c.ID); err != ErrNotFound {
		t.Fatalf("stranger Delete: want ErrNotFound, got %v", err)
	}
}

func TestEnrollingCannotBeUsedToReachAPrivateCurriculum(t *testing.T) {
	// The specific attack: ids are guessable, so if Enroll did not check
	// visibility a stranger could enroll and then read the items through Get,
	// whose own check would pass because they are now enrolled.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "owner2", "stranger2")

	c, err := repo.Create(ctx, "owner2", "", NewCurriculum{Name: "Mine", Visibility: "private"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "stranger2", c.ID, ""); err != ErrNotFound {
		t.Fatalf("stranger Enroll: want ErrNotFound, got %v", err)
	}
	if _, err := repo.Get(ctx, "stranger2", c.ID, ""); err != ErrNotFound {
		t.Fatalf("stranger Get after failed enroll: want ErrNotFound, got %v", err)
	}
}

func TestAPublicCurriculumIsReadableButNotEditable(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "owner3", "stranger3")

	c, err := repo.Create(ctx, "owner3", "", NewCurriculum{Name: "Shared", Visibility: "public"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.Get(ctx, "stranger3", c.ID, "")
	if err != nil {
		t.Fatalf("stranger Get on public: %v", err)
	}
	if got.Editable {
		t.Fatal("a stranger was told they may edit somebody else's curriculum")
	}
	// THE POINT OF F7. `Editable` being false is the same answer a VOLA
	// syllabus gives, so a client filtering on `!editable` shows this row as
	// though VOLA wrote it — and `track`/`belt` are unvalidated hints, so the
	// stranger chooses which section and which belt word it wears.
	if got.Official {
		t.Fatal("another athlete's curriculum was reported as VOLA-authored")
	}
	// ErrForbidden here, not ErrNotFound: they can already see it, so saying
	// "not yours" leaks nothing and is the useful answer.
	if _, err := repo.Update(ctx, "stranger3", c.ID, "", Update{Name: strp("Hijacked")}); err != ErrForbidden {
		t.Fatalf("stranger Update on public: want ErrForbidden, got %v", err)
	}
}

func TestAnOwnerlessCurriculumIsReportedAsOfficial(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "reader7")
	id := seedOwnerlessCurriculum(t, pool, "F7 syllabus", "syllabus", "white")

	got, err := repo.Get(ctx, "reader7", id, "")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !got.Official {
		t.Fatal("a VOLA-authored syllabus was not reported as one")
	}
	// Both halves, in one place: the pair only discriminates if VOLA content
	// and a stranger's content differ on exactly ONE of these two fields.
	if got.Editable {
		t.Fatal("a reader was told they may edit a VOLA syllabus")
	}
}

// TestOfficialAndEditableAreNotTheSameQuestion is the regression guard proper.
//
// A single-row test passes against the F7 bug in both directions: check only a
// VOLA row and `!editable` looks like a sound provenance signal; check only a
// stranger's row and it looks sound too. The defect is only visible when the
// two are compared, because it is precisely that they AGREE where they must
// differ.
func TestOfficialAndEditableAreNotTheSameQuestion(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "owner7", "reader8")

	// A stranger's public curriculum, wearing the syllabus track and a belt
	// word — exactly the payload F7 describes, and nothing refuses it, because
	// both fields are documented as hints rather than gates.
	strangers, err := repo.Create(ctx, "owner7", "", NewCurriculum{
		Name: "Totally official", Visibility: "public",
		Track: strp("syllabus"), Belt: strp("white"),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	volaID := seedOwnerlessCurriculum(t, pool, "White belt basics", "syllabus", "white")

	mine, err := repo.Get(ctx, "reader8", strangers.ID, "")
	if err != nil {
		t.Fatalf("Get stranger's: %v", err)
	}
	theirs, err := repo.Get(ctx, "reader8", volaID, "")
	if err != nil {
		t.Fatalf("Get VOLA's: %v", err)
	}

	// They are indistinguishable on `editable` — which is the bug — and must
	// differ on `vola`, which is the fix.
	if mine.Editable != theirs.Editable {
		t.Fatal("premise broken: these are supposed to look identical on editable")
	}
	if mine.Official == theirs.Official {
		t.Fatalf("official failed to tell them apart: stranger=%v vola=%v", mine.Official, theirs.Official)
	}
	if !theirs.Official {
		t.Fatal("the VOLA row is the one that should be vola=true")
	}
}

// ---------------------------------------------------------------------------
// Mastery. The load-bearing artefact of the whole design.
// ---------------------------------------------------------------------------

// fullCriteria is the shipped default shape.
func fullCriteria() *Criteria {
	return &Criteria{
		TargetScored:   intp(DefaultTargetScored),
		TargetDefended: intp(DefaultTargetDefended),
		TargetSessions: intp(DefaultTargetSessions),
		MinHitRate:     f64p(DefaultMinHitRate),
	}
}

func TestMasteryNeedsVolumeSpreadDefenceAndRate(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete1")
	tech := seedTechnique(t, pool, "test-armdrag")

	c, err := repo.Create(ctx, "athlete1", "", NewCurriculum{
		Name:  "Roadmap",
		Items: []NewItem{{TechniqueID: tech, Criteria: fullCriteria()}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "athlete1", c.ID, ""); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	backdateEnrollment(t, pool, "athlete1", 200)

	// 26 scores over 13 sessions, 40 misses (rate 0.394), 9 defences.
	for i := 1; i <= 13; i++ {
		ev := map[string]int{"scored": 2}
		if i <= 10 {
			ev["attempted"] = 4
		}
		if i <= 3 {
			ev["defended"] = 3
		}
		logEvidence(t, pool, "athlete1", tech, i, ev)
	}

	got, err := repo.Get(ctx, "athlete1", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	p := got.Items[0].Progress
	if p == nil {
		t.Fatal("no progress on an enrolled roadmap item")
	}
	if p.Scored != 26 || p.Defended != 9 || p.Sessions != 13 || p.Attempts != 66 {
		t.Fatalf("counts: got scored=%d defended=%d sessions=%d attempts=%d, want 26/9/13/66",
			p.Scored, p.Defended, p.Sessions, p.Attempts)
	}
	if !p.Mastered {
		t.Fatalf("not mastered with every criterion met: %+v", p)
	}

	// THE CLAIM THAT JUSTIFIES THE WORD. Identical volumes, sprayed attempts:
	// the rate collapses and mastery goes with it. Without this, "mastered"
	// would mean "did it a lot", which the design doc argued against at length.
	for i := 1; i <= 10; i++ {
		logEvidence(t, pool, "athlete1", tech, i+100, map[string]int{"attempted": 20})
	}
	got, err = repo.Get(ctx, "athlete1", c.ID, "")
	if err != nil {
		t.Fatalf("get after spray: %v", err)
	}
	p = got.Items[0].Progress
	if p.Scored != 26 {
		t.Fatalf("volume changed: got %d, want 26", p.Scored)
	}
	if p.Mastered {
		t.Fatalf("still mastered at hit rate %v — the rate criterion does nothing", *p.HitRate)
	}
}

func TestEvidenceBeforeEnrollingDoesNotCount(t *testing.T) {
	// The window, and the reason it exists: over all time the hit rate includes
	// the months during which the athlete could not do the technique, so it
	// measures the learning phase it is meant to exclude. A syllabus is mostly
	// techniques they have been failing at.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete2")
	tech := seedTechnique(t, pool, "test-triangle")

	// A year of fumbling, long before any roadmap: 300 misses, 20 scores.
	for i := 400; i < 410; i++ {
		logEvidence(t, pool, "athlete2", tech, i, map[string]int{"attempted": 30, "scored": 2})
	}

	c, err := repo.Create(ctx, "athlete2", "", NewCurriculum{
		Name:  "Roadmap",
		Items: []NewItem{{TechniqueID: tech, Criteria: fullCriteria()}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "athlete2", c.ID, ""); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	backdateEnrollment(t, pool, "athlete2", 100)

	// Since enrolling: 8 from 10, a 0.8 rate.
	for i := 1; i <= 8; i++ {
		logEvidence(t, pool, "athlete2", tech, i, map[string]int{"scored": 1})
	}
	logEvidence(t, pool, "athlete2", tech, 9, map[string]int{"attempted": 2})

	got, err := repo.Get(ctx, "athlete2", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	p := got.Items[0].Progress
	// Only the post-enrollment evidence. If the old fumbling counted, scored
	// would be 28 and attempts 330 — and the rate would read 0.09 instead of
	// 0.8, so a genuinely competent athlete would look hopeless at the exact
	// technique they had just got good at. That inversion is the reason the
	// window exists.
	if p.Scored != 8 || p.Attempts != 10 {
		t.Fatalf("window not applied: scored=%d attempts=%d, want 8/10", p.Scored, p.Attempts)
	}
	if p.HitRate == nil || *p.HitRate < 0.79 {
		t.Fatalf("hit rate poisoned by pre-enrollment history: %v, want ~0.8", p.HitRate)
	}
}

func TestNoAttemptsMeansNoRateRatherThanZero(t *testing.T) {
	// Zero from zero is not a rate, and rendering it as 0%% would report a
	// failure the athlete has not had.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete14")
	tech := seedTechnique(t, pool, "test-norate")

	c, err := repo.Create(ctx, "athlete14", "", NewCurriculum{
		Name:  "Roadmap",
		Items: []NewItem{{TechniqueID: tech, Criteria: fullCriteria()}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "athlete14", c.ID, ""); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	got, err := repo.Get(ctx, "athlete14", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Items[0].Progress.HitRate != nil {
		t.Fatalf("rate reported with no evidence: %v", *got.Items[0].Progress.HitRate)
	}
	if got.Items[0].Progress.Mastered {
		t.Fatal("mastered with no evidence at all")
	}
}

func TestDrilledNeverSatisfiesTheSpreadRequirement(t *testing.T) {
	// Drilling is practice. A technique that cleared its spread requirement on
	// drilled classes alone would be mastered without ever being used on
	// somebody who was resisting.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete3")
	tech := seedTechnique(t, pool, "test-kimura")

	c, err := repo.Create(ctx, "athlete3", "", NewCurriculum{
		Name: "Roadmap",
		Items: []NewItem{{TechniqueID: tech, Criteria: &Criteria{
			TargetScored:   intp(1),
			TargetSessions: intp(12),
		}}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "athlete3", c.ID, ""); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	backdateEnrollment(t, pool, "athlete3", 200)
	// Twenty drilled classes and one live score, all inside the window.
	for i := 1; i <= 20; i++ {
		logEvidence(t, pool, "athlete3", tech, i, map[string]int{"drilled": 1})
	}
	logEvidence(t, pool, "athlete3", tech, 1, map[string]int{"scored": 1})

	got, err := repo.Get(ctx, "athlete3", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Items[0].Progress.Sessions != 1 {
		t.Fatalf("drilled sessions counted toward spread: got %d, want 1",
			got.Items[0].Progress.Sessions)
	}
	if got.Items[0].Progress.Mastered {
		t.Fatal("mastered on drilling alone")
	}
}

func TestADefenceOnlyCriterionWorks(t *testing.T) {
	// The requirement that justified adding `defended` at all: "not get caught
	// in guard pull N times" has no offensive half.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete4")
	tech := seedTechnique(t, pool, "test-guardpull")

	c, err := repo.Create(ctx, "athlete4", "", NewCurriculum{
		Name:  "Defence",
		Items: []NewItem{{TechniqueID: tech, Criteria: &Criteria{TargetDefended: intp(5)}}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "athlete4", c.ID, ""); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	backdateEnrollment(t, pool, "athlete4", 200)
	for i := 1; i <= 5; i++ {
		logEvidence(t, pool, "athlete4", tech, i, map[string]int{"defended": 1})
	}
	got, err := repo.Get(ctx, "athlete4", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.Items[0].Progress.Mastered {
		t.Fatalf("defence-only criterion never completes: %+v", got.Items[0].Progress)
	}
}

func TestOneAthletesEvidenceNeverReachesAnothersProgress(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete5", "athlete6")
	tech := seedTechnique(t, pool, "test-shared")

	c, err := repo.Create(ctx, "athlete5", "", NewCurriculum{
		Name:       "Shared",
		Visibility: "public",
		Items:      []NewItem{{TechniqueID: tech, Criteria: &Criteria{TargetScored: intp(5)}}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	for _, u := range []string{"athlete5", "athlete6"} {
		if err := repo.Enroll(ctx, u, c.ID, ""); err != nil {
			t.Fatalf("enroll %s: %v", u, err)
		}
		backdateEnrollment(t, pool, u, 200)
	}
	// Only athlete5 trains.
	for i := 1; i <= 5; i++ {
		logEvidence(t, pool, "athlete5", tech, i, map[string]int{"scored": 1})
	}

	five, err := repo.Get(ctx, "athlete5", c.ID, "")
	if err != nil {
		t.Fatalf("get 5: %v", err)
	}
	six, err := repo.Get(ctx, "athlete6", c.ID, "")
	if err != nil {
		t.Fatalf("get 6: %v", err)
	}
	if !five.Items[0].Progress.Mastered {
		t.Fatal("the athlete who trained is not mastered")
	}
	if six.Items[0].Progress.Scored != 0 {
		t.Fatalf("another athlete's evidence leaked: got %d, want 0", six.Items[0].Progress.Scored)
	}
}

func TestBrowsingShowsCriteriaButNoProgress(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete7")
	tech := seedTechnique(t, pool, "test-browse")

	c, err := repo.Create(ctx, "athlete7", "", NewCurriculum{
		Name:  "Unstarted",
		Items: []NewItem{{TechniqueID: tech, Criteria: fullCriteria()}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.Get(ctx, "athlete7", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Items[0].Criteria == nil {
		t.Fatal("criteria hidden from someone deciding whether to take this on")
	}
	if got.Items[0].Progress != nil {
		t.Fatal("progress reported for someone who has not enrolled — there is no window to measure")
	}
}

// ---------------------------------------------------------------------------
// Enrollment lifecycle
// ---------------------------------------------------------------------------

func TestEnrollingIsIdempotentAndKeepsTheOriginalStartDate(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete8")

	c, err := repo.Create(ctx, "athlete8", "", NewCurriculum{Name: "X"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "athlete8", c.ID, ""); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	// Backdate, so a reset would be visible.
	if _, err := pool.Exec(ctx, `
		UPDATE curriculum_enrollments SET started_on = CURRENT_DATE - 100
		WHERE user_id = 'athlete8'`); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	// A retry after a dropped response must converge, not fail.
	if err := repo.Enroll(ctx, "athlete8", c.ID, ""); err != nil {
		t.Fatalf("second enroll: %v", err)
	}
	var started time.Time
	if err := pool.QueryRow(ctx, `
		SELECT started_on FROM curriculum_enrollments WHERE user_id = 'athlete8'`).Scan(&started); err != nil {
		t.Fatalf("read started_on: %v", err)
	}
	if days := int(time.Since(started).Hours() / 24); days < 99 {
		t.Fatalf("re-enrolling reset the clock: started_on is %d days ago, want ~100", days)
	}
}

func TestArchivingKeepsTheRecordAndUnEnrolls(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete9")

	c, err := repo.Create(ctx, "athlete9", "", NewCurriculum{Name: "X"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "athlete9", c.ID, ""); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	if err := repo.Archive(ctx, "athlete9", c.ID); err != nil {
		t.Fatalf("archive: %v", err)
	}
	got, err := repo.Get(ctx, "athlete9", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Enrolled {
		t.Fatal("still enrolled after archiving")
	}
	// The row survives — having worked a syllabus and stopped is a fact about
	// them, and this is what lets the app later say "you did three quarters".
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM curriculum_enrollments WHERE user_id = 'athlete9'`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("archive deleted the enrollment record: got %d rows, want 1", n)
	}
}

func TestACurriculumOthersAreWorkingCannotBeDeleted(t *testing.T) {
	// Their enrollment is their record, not the publisher's. Cascading would
	// let a stranger erase it.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "owner10", "follower10")

	c, err := repo.Create(ctx, "owner10", "", NewCurriculum{Name: "Popular", Visibility: "public"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "follower10", c.ID, ""); err != nil {
		t.Fatalf("follower enroll: %v", err)
	}
	if err := repo.Delete(ctx, "owner10", c.ID); err != ErrInUse {
		t.Fatalf("delete a followed curriculum: want ErrInUse, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

func TestUpdatingWithoutItemsLeavesThemAlone(t *testing.T) {
	// The three-state distinction the handler's *[]itemRequest exists for:
	// absent leaves the list, [] empties it. Collapsed, every metadata edit
	// silently deletes every item.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete11")
	tech := seedTechnique(t, pool, "test-keep")

	c, err := repo.Create(ctx, "athlete11", "", NewCurriculum{
		Name:  "X",
		Items: []NewItem{{TechniqueID: tech}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.Update(ctx, "athlete11", c.ID, "", Update{Name: strp("Renamed")})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(got.Items) != 1 {
		t.Fatalf("a rename deleted the items: got %d, want 1", len(got.Items))
	}
	got, err = repo.Update(ctx, "athlete11", c.ID, "", Update{Items: []NewItem{}})
	if err != nil {
		t.Fatalf("update empty: %v", err)
	}
	if len(got.Items) != 0 {
		t.Fatalf("an explicit empty list did not clear: got %d", len(got.Items))
	}
}

func TestItemOrderSurvivesAReplace(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete12")
	a := seedTechnique(t, pool, "test-a")
	b := seedTechnique(t, pool, "test-b")

	c, err := repo.Create(ctx, "athlete12", "", NewCurriculum{
		Name:  "X",
		Items: []NewItem{{TechniqueID: a}, {TechniqueID: b}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if c.Items[0].TechniqueID != a || c.Items[1].TechniqueID != b {
		t.Fatalf("order not as sent: %v", []string{c.Items[0].TechniqueID, c.Items[1].TechniqueID})
	}
	got, err := repo.Update(ctx, "athlete12", c.ID, "", Update{Items: []NewItem{{TechniqueID: b}, {TechniqueID: a}}})
	if err != nil {
		t.Fatalf("reorder: %v", err)
	}
	if got.Items[0].TechniqueID != b || got.Items[1].TechniqueID != a {
		t.Fatalf("reorder did not take: %v", []string{got.Items[0].TechniqueID, got.Items[1].TechniqueID})
	}
}

func TestAnUnknownTechniqueIsInvalidInputNotAnInternalError(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete13")

	_, err := repo.Create(ctx, "athlete13", "", NewCurriculum{
		Name:  "X",
		Items: []NewItem{{TechniqueID: "no-such-technique"}},
	})
	if err != ErrInvalidInput {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
}

func TestAnOwnerCanDeleteACurriculumTheyAreWorkingThemselves(t *testing.T) {
	// Create a roadmap, start working it, change your mind. The ordinary flow,
	// and it was impossible: RESTRICT counted the owner's OWN enrollment, so
	// the API refused with "other athletes are working this" when nobody else
	// was -- an error that was not merely unhelpful but false.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "owner14")

	c, err := repo.Create(ctx, "owner14", "", NewCurriculum{Name: "Mine"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "owner14", c.ID, ""); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	if err := repo.Delete(ctx, "owner14", c.ID); err != nil {
		t.Fatalf("owner deleting their own self-enrolled curriculum: %v", err)
	}
	if _, err := repo.Get(ctx, "owner14", c.ID, ""); err != ErrNotFound {
		t.Fatalf("still there after delete: %v", err)
	}
}

func TestARefusedDeleteLeavesTheOwnersEnrollmentIntact(t *testing.T) {
	// Delete drops the caller's own enrollment before removing the row, so a
	// refusal has to roll that back -- otherwise asking to delete a followed
	// curriculum would silently un-enroll you from it.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "owner15", "follower15")

	c, err := repo.Create(ctx, "owner15", "", NewCurriculum{Name: "Popular", Visibility: "public"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	for _, u := range []string{"owner15", "follower15"} {
		if err := repo.Enroll(ctx, u, c.ID, ""); err != nil {
			t.Fatalf("enroll %s: %v", u, err)
		}
	}
	if err := repo.Delete(ctx, "owner15", c.ID); err != ErrInUse {
		t.Fatalf("want ErrInUse, got %v", err)
	}
	got, err := repo.Get(ctx, "owner15", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.Enrolled {
		t.Fatal("a refused delete un-enrolled the owner")
	}
}

func TestPickingACurriculumBackUpKeepsTheOriginalClock(t *testing.T) {
	// The ON CONFLICT un-archive branch, which nothing covered.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete16")

	c, err := repo.Create(ctx, "athlete16", "", NewCurriculum{Name: "X"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "athlete16", c.ID, ""); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	backdateEnrollment(t, pool, "athlete16", 100)
	if err := repo.Archive(ctx, "athlete16", c.ID); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if err := repo.Enroll(ctx, "athlete16", c.ID, ""); err != nil {
		t.Fatalf("re-enroll: %v", err)
	}

	got, err := repo.Get(ctx, "athlete16", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.Enrolled {
		t.Fatal("re-enrolling did not un-archive")
	}
	// Deliberate, and it has a consequence worth knowing: the measurement
	// window spans the months they were away.
	if got.StartedOn == nil {
		t.Fatal("no started_on after re-enrolling")
	}
	started, err := time.Parse("2006-01-02", *got.StartedOn)
	if err != nil {
		t.Fatalf("parse started_on: %v", err)
	}
	if days := int(time.Since(started).Hours() / 24); days < 99 {
		t.Fatalf("re-enrolling reset the clock: %d days ago, want ~100", days)
	}
}

func TestTheBeltCanBeClearedAndNotOnlySet(t *testing.T) {
	// `*string` could not tell an absent field from an explicit null, so
	// "leave the belt alone" and "this is not a belt syllabus after all" were
	// the same request and the second was impossible.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete17")

	c, err := repo.Create(ctx, "athlete17", "", NewCurriculum{Name: "X", Belt: strp("blue")})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.Update(ctx, "athlete17", c.ID, "", Update{Name: strp("Renamed")})
	if err != nil {
		t.Fatalf("update without touching belt: %v", err)
	}
	if got.Belt == nil || *got.Belt != "blue" {
		t.Fatalf("an unrelated edit changed the belt: %v", got.Belt)
	}
	got, err = repo.Update(ctx, "athlete17", c.ID, "", Update{SetBelt: true})
	if err != nil {
		t.Fatalf("clear belt: %v", err)
	}
	if got.Belt != nil {
		t.Fatalf("belt not cleared: %v", *got.Belt)
	}
}

func TestProgressCountsOnlyItemsThatCarryCriteria(t *testing.T) {
	// The progress rule, shipped in the response so no client invents its own.
	// Three roadmap steps among ten items is three items' worth of progress,
	// not three tenths.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete18")
	a := seedTechnique(t, pool, "test-mixed-a")
	b := seedTechnique(t, pool, "test-mixed-b")
	c2 := seedTechnique(t, pool, "test-mixed-c")

	c, err := repo.Create(ctx, "athlete18", "", NewCurriculum{
		Name: "Mixed",
		Items: []NewItem{
			{TechniqueID: a, Criteria: &Criteria{TargetScored: intp(3)}},
			{TechniqueID: b, Criteria: &Criteria{TargetScored: intp(3)}},
			{TechniqueID: c2}, // reading, not a roadmap step
		},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "athlete18", c.ID, ""); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	backdateEnrollment(t, pool, "athlete18", 50)
	for i := 1; i <= 3; i++ {
		logEvidence(t, pool, "athlete18", a, i, map[string]int{"scored": 1})
	}

	got, err := repo.Get(ctx, "athlete18", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got.Items) != 3 {
		t.Fatalf("items: got %d, want 3", len(got.Items))
	}
	if got.CountableItems != 2 {
		t.Fatalf("countable: got %d, want 2 — the reading item must not count", got.CountableItems)
	}
	if got.MasteredItems != 1 {
		t.Fatalf("mastered: got %d, want 1", got.MasteredItems)
	}
}

func TestTheListCanTellARoadmapFromAReadingList(t *testing.T) {
	// The bug this pins shipped a whole screen: the list response left
	// CountableItems at zero, so a web card built on it called every roadmap
	// "a reading list" -- the exact property the screen existed to convey,
	// inverted, on every row. A build cannot see it, because zero satisfies the
	// type perfectly.
	//
	// MasteredItems is deliberately NOT asserted here: it stays zero on the
	// list because computing it needs the per-curriculum evidence aggregate,
	// and running that once per row is the wrong trade. If that ever changes,
	// this test should grow an assertion rather than the client growing an
	// assumption.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "athlete19")
	a := seedTechnique(t, pool, "test-list-a")
	b := seedTechnique(t, pool, "test-list-b")
	c3 := seedTechnique(t, pool, "test-list-c")

	road, err := repo.Create(ctx, "athlete19", "", NewCurriculum{
		Name: "Roadmap",
		Items: []NewItem{
			{TechniqueID: a, Criteria: &Criteria{TargetScored: intp(25)}},
			// Defence-only still counts: it is a criterion, and the SQL
			// predicate has to agree with Countable() about that.
			{TechniqueID: b, Criteria: &Criteria{TargetDefended: intp(8)}},
			{TechniqueID: c3},
		},
	})
	if err != nil {
		t.Fatalf("create roadmap: %v", err)
	}
	reading, err := repo.Create(ctx, "athlete19", "", NewCurriculum{
		Name:  "Reading",
		Items: []NewItem{{TechniqueID: a}, {TechniqueID: b}},
	})
	if err != nil {
		t.Fatalf("create reading: %v", err)
	}

	list, err := repo.List(ctx, "athlete19")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	got := map[string]Curriculum{}
	for _, c := range list {
		got[c.ID] = c
	}

	if r := got[road.ID]; r.ItemCount != 3 || r.CountableItems != 2 {
		t.Fatalf("roadmap on the list: items=%d countable=%d, want 3/2",
			r.ItemCount, r.CountableItems)
	}
	if r := got[reading.ID]; r.ItemCount != 2 || r.CountableItems != 0 {
		t.Fatalf("reading list on the list: items=%d countable=%d, want 2/0",
			r.ItemCount, r.CountableItems)
	}

	// And the single read agrees with the list about the same curriculum --
	// two code paths compute this, so they have to be checked against each
	// other rather than each against my expectations.
	one, err := repo.Get(ctx, "athlete19", road.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if one.ItemCount != got[road.ID].ItemCount ||
		one.CountableItems != got[road.ID].CountableItems {
		t.Fatalf("list and get disagree: get=%d/%d list=%d/%d",
			one.ItemCount, one.CountableItems,
			got[road.ID].ItemCount, got[road.ID].CountableItems)
	}
}

func TestEnrollingLateAtNightStampsTheAthletesDateNotTheServers(t *testing.T) {
	/*
	 * The bug, seen on a device rather than reasoned about.
	 *
	 * Enrolling at 22:00 in New York used to stamp TOMORROW, because
	 * `started_on` defaulted to Postgres's CURRENT_DATE and Postgres runs UTC
	 * in every deployed environment. The screen then told the athlete their
	 * progress was "counted from what you have logged since <tomorrow>" — a
	 * date that had not happened — and everything they logged that evening fell
	 * outside the window.
	 *
	 * Backend review had seen the same comparison and judged it harmless over a
	 * months-long window. It is not: the boundary is only ever crossed once,
	 * but it is crossed on the day the athlete is most likely to train.
	 */
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "tz1")

	c, err := repo.Create(ctx, "tz1", "", NewCurriculum{Name: "X"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Skip unless the server's date and New York's actually differ right now —
	// otherwise this passes for the wrong reason for most of the day.
	var serverDate, nyDate string
	if err := pool.QueryRow(ctx, `
		SELECT CURRENT_DATE::text, (now() AT TIME ZONE 'America/New_York')::date::text`,
	).Scan(&serverDate, &nyDate); err != nil {
		t.Fatalf("dates: %v", err)
	}

	if err := repo.Enroll(ctx, "tz1", c.ID, "America/New_York"); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	var got string
	if err := pool.QueryRow(ctx, `
		SELECT started_on::text FROM curriculum_enrollments WHERE user_id = 'tz1'`,
	).Scan(&got); err != nil {
		t.Fatalf("read started_on: %v", err)
	}
	if got != nyDate {
		t.Fatalf("started_on is %s, want New York's %s (server says %s)", got, nyDate, serverDate)
	}
	if serverDate == nyDate {
		t.Logf("note: server and New York agree on the date right now (%s), "+
			"so this run did not exercise the crossing", nyDate)
	}
}

func TestEvidenceOnTheEnrollmentDayCountsInTheAthletesZone(t *testing.T) {
	// The other half. Comparing a bare timestamptz against a date put the
	// boundary at UTC midnight, so a class trained on the evening of the
	// enrollment day fell outside a window meant to start that morning.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "tz2")
	tech := seedTechnique(t, pool, "test-tz")

	c, err := repo.Create(ctx, "tz2", "", NewCurriculum{
		Name:  "Roadmap",
		Items: []NewItem{{TechniqueID: tech, Criteria: &Criteria{TargetScored: intp(1)}}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "tz2", c.ID, "America/New_York"); err != nil {
		t.Fatalf("enroll: %v", err)
	}

	// A session at 23:00 New York time on the enrollment day. In UTC that is
	// already the next day, which is exactly why the naive comparison worked
	// and the naive STORAGE did not — and vice versa across the other boundary.
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (id, user_id, sport, started_at)
		SELECT 'tz2-s', 'tz2', 'bjj',
		       ((now() AT TIME ZONE 'America/New_York')::date + time '23:00')
		           AT TIME ZONE 'America/New_York'`); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO bjj_session_tags (session_id, user_id, category, event, technique_id, count)
		VALUES ('tz2-s', 'tz2', 'sweep', 'scored', $1, 1)`, tech); err != nil {
		t.Fatalf("seed tag: %v", err)
	}

	got, err := repo.Get(ctx, "tz2", c.ID, "America/New_York")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Items[0].Progress.Scored != 1 {
		t.Fatalf("evening session on the enrollment day did not count: scored=%d, want 1",
			got.Items[0].Progress.Scored)
	}
}

func TestWorkingReturnsOnlyActiveEnrollmentsWithProgress(t *testing.T) {
	// What Today and You read. Three properties, and each has a way of being
	// quietly wrong: it must be scoped to the caller, exclude archived
	// enrollments, and carry real mastery rather than the zero the LIST
	// response deliberately sends.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "work1", "work2")
	tech := seedTechnique(t, pool, "test-working")

	mine, err := repo.Create(ctx, "work1", "", NewCurriculum{
		Name:  "Active",
		Items: []NewItem{{TechniqueID: tech, Criteria: &Criteria{TargetScored: intp(2)}}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	dropped, err := repo.Create(ctx, "work1", "", NewCurriculum{Name: "Dropped"})
	if err != nil {
		t.Fatalf("create dropped: %v", err)
	}
	theirs, err := repo.Create(ctx, "work2", "", NewCurriculum{Name: "Theirs", Visibility: "public"})
	if err != nil {
		t.Fatalf("create theirs: %v", err)
	}

	for _, id := range []string{mine.ID, dropped.ID} {
		if err := repo.Enroll(ctx, "work1", id, ""); err != nil {
			t.Fatalf("enroll: %v", err)
		}
	}
	if err := repo.Enroll(ctx, "work2", theirs.ID, ""); err != nil {
		t.Fatalf("enroll theirs: %v", err)
	}
	if err := repo.Archive(ctx, "work1", dropped.ID); err != nil {
		t.Fatalf("archive: %v", err)
	}
	backdateEnrollment(t, pool, "work1", 30)
	for i := 1; i <= 2; i++ {
		logEvidence(t, pool, "work1", tech, i, map[string]int{"scored": 1})
	}

	got, err := repo.Working(ctx, "work1", "")
	if err != nil {
		t.Fatalf("working: %v", err)
	}
	if len(got) != 1 {
		var names []string
		for _, c := range got {
			names = append(names, c.Name)
		}
		t.Fatalf("working returned %v, want just the active one", names)
	}
	if got[0].ID != mine.ID {
		t.Fatalf("wrong curriculum: %s", got[0].Name)
	}
	// The reason this endpoint exists rather than a flag on List: mastery is
	// real here. On the list it is deliberately zero.
	if got[0].CountableItems != 1 || got[0].MasteredItems != 1 {
		t.Fatalf("progress not computed: countable=%d mastered=%d, want 1/1",
			got[0].CountableItems, got[0].MasteredItems)
	}
	if len(got[0].Items) != 1 || got[0].Items[0].Progress == nil {
		t.Fatal("items or progress missing — Today cannot say what to work next without them")
	}
}

// ---------------------------------------------------------------------------
// Phases, concepts and the drilled criterion — the 2026-08-10 redesign.
// ---------------------------------------------------------------------------

func TestPhasesAndConceptsRoundTrip(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "phases1")
	tech := seedTechnique(t, pool, "test-trap-roll")

	c, err := repo.Create(ctx, "phases1", "", NewCurriculum{
		Name:  "White belt",
		Track: strp("belt"),
		Phases: []NewPhase{
			{Title: "Survive", Description: "Get out of the bad places first."},
			{Title: "Attack"},
		},
		Items: []NewItem{
			{Kind: "concept", Title: "Position before submission", Phase: intp(0)},
			{TechniqueID: tech, Phase: intp(0), Criteria: &Criteria{TargetScored: intp(25)}},
		},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if c.Track == nil || *c.Track != "belt" {
		t.Fatalf("track did not survive: %v", c.Track)
	}
	if len(c.Phases) != 2 || c.Phases[0].Title != "Survive" || c.Phases[1].Order != 1 {
		t.Fatalf("phases did not round-trip: %+v", c.Phases)
	}
	if len(c.Items) != 2 {
		t.Fatalf("items: got %d, want 2", len(c.Items))
	}
	concept, technique := c.Items[0], c.Items[1]
	if concept.Kind != "concept" || concept.Title != "Position before submission" ||
		concept.TechniqueID != "" || concept.Phase == nil || *concept.Phase != 0 {
		t.Fatalf("concept did not round-trip: %+v", concept)
	}
	// A concept can never be countable — the progress rule must not see it.
	if concept.Countable() || concept.Criteria != nil {
		t.Fatal("a concept item carries criteria")
	}
	if technique.Kind != "technique" || technique.Name == "" || !technique.Countable() {
		t.Fatalf("technique item wrong: %+v", technique)
	}
	if c.CountableItems != 1 {
		t.Fatalf("countable = %d, want 1 — the concept must not count", c.CountableItems)
	}

	// Replacing content replaces phases and items together.
	upd, err := repo.Update(ctx, "phases1", c.ID, "", Update{
		Phases: []NewPhase{{Title: "Only phase"}},
		Items:  []NewItem{{TechniqueID: tech, Phase: intp(0)}},
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(upd.Phases) != 1 || upd.Phases[0].Title != "Only phase" || len(upd.Items) != 1 {
		t.Fatalf("replace did not take: %+v / %+v", upd.Phases, upd.Items)
	}
}

func TestUpdatingWithoutItemsLeavesPhasesAlone(t *testing.T) {
	// Items nil means "leave the content alone", and phases are content — a
	// metadata rename must not strip a curriculum's structure.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "phases2")
	tech := seedTechnique(t, pool, "test-phase-keep")

	c, err := repo.Create(ctx, "phases2", "", NewCurriculum{
		Name:   "Structured",
		Phases: []NewPhase{{Title: "Survive"}},
		Items:  []NewItem{{TechniqueID: tech, Phase: intp(0)}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	upd, err := repo.Update(ctx, "phases2", c.ID, "", Update{Name: strp("Renamed")})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(upd.Phases) != 1 || len(upd.Items) != 1 || upd.Items[0].Phase == nil {
		t.Fatalf("metadata rename disturbed the content: %+v / %+v", upd.Phases, upd.Items)
	}
}

func TestADrilledCriterionCountsSpreadNotVolume(t *testing.T) {
	// The movement-fundamentals criterion: drilled across N separate classes.
	// Forty reps in one class is one class — volume must not satisfy it.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "drill1")
	tech := seedTechnique(t, pool, "test-breakfall")

	c, err := repo.Create(ctx, "drill1", "", NewCurriculum{
		Name: "Fundamentals",
		Items: []NewItem{{TechniqueID: tech,
			Criteria: &Criteria{TargetDrilledSessions: intp(3)}}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.Enroll(ctx, "drill1", c.ID, ""); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	backdateEnrollment(t, pool, "drill1", 60)

	// One class, forty reps: one session's worth of spread.
	logEvidence(t, pool, "drill1", tech, 5, map[string]int{"drilled": 40})
	got, err := repo.Get(ctx, "drill1", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Items[0].Progress.DrilledSessions != 1 {
		t.Fatalf("drilled_sessions = %d, want 1 — volume is leaking into spread",
			got.Items[0].Progress.DrilledSessions)
	}
	if got.Items[0].Progress.Mastered {
		t.Fatal("mastered on one class")
	}

	// Two more classes clears the spread of three.
	logEvidence(t, pool, "drill1", tech, 4, map[string]int{"drilled": 1})
	logEvidence(t, pool, "drill1", tech, 3, map[string]int{"drilled": 1})
	got, err = repo.Get(ctx, "drill1", c.ID, "")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.Items[0].Progress.Mastered {
		t.Fatalf("three drilled classes should clear a target of three: %+v", got.Items[0].Progress)
	}
	// And drilled spread must not leak the other way, into the LIVE session
	// spread the older criteria read.
	if got.Items[0].Progress.Sessions != 0 {
		t.Fatalf("live sessions = %d, want 0 — drilling counted as live use",
			got.Items[0].Progress.Sessions)
	}
}

func TestTheTrackCanBeClearedAndNotOnlySet(t *testing.T) {
	// Track copies belt's PATCH semantics: explicit null clears, omission
	// leaves alone. Same test as the belt one, same reason.
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "track1")

	c, err := repo.Create(ctx, "track1", "", NewCurriculum{Name: "Mine", Track: strp("foundations")})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// An unrelated update leaves it alone.
	upd, err := repo.Update(ctx, "track1", c.ID, "", Update{Name: strp("Renamed")})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if upd.Track == nil || *upd.Track != "foundations" {
		t.Fatalf("unrelated update disturbed track: %v", upd.Track)
	}
	// An explicit clear clears it.
	upd, err = repo.Update(ctx, "track1", c.ID, "", Update{SetTrack: true})
	if err != nil {
		t.Fatalf("clear: %v", err)
	}
	if upd.Track != nil {
		t.Fatalf("track survived an explicit clear: %v", *upd.Track)
	}
}

// A bookmark is not something you are working.
//
// Enrolment on a criteria-free list is a bookmark — an athlete's own reading
// list has always been one, and the reference syllabuses are 73 items of it.
// Every consumer of Working renders progress from it, and one that forgot to
// guard would draw a FALSE CLAIM rather than a blank: the phone's RoadmapLine
// reads a null next step as "Every technique on this one is done", so a
// bookmarked syllabus announced "0 of 0 mastered. All 0 mastered." on Today.
// Review found it, and it was reachable before the syllabuses existed.
func TestWorkingExcludesCurriculaWithNothingCompletable(t *testing.T) {
	pool := testPool(t)
	repo := NewPostgresRepository(pool)
	ctx := context.Background()
	cleanupUser(t, pool, "bookm1")
	tech := seedTechnique(t, pool, "test-bookmark")

	roadmap, err := repo.Create(ctx, "bookm1", "", NewCurriculum{
		Name:  "A real roadmap",
		Items: []NewItem{{TechniqueID: tech, Criteria: &Criteria{TargetScored: intp(2)}}},
	})
	if err != nil {
		t.Fatalf("create roadmap: %v", err)
	}
	// Same shape, one difference: no criteria on anything.
	reading, err := repo.Create(ctx, "bookm1", "", NewCurriculum{
		Name:  "A reading list",
		Items: []NewItem{{TechniqueID: tech}, {Kind: "concept", Title: "An idea"}},
	})
	if err != nil {
		t.Fatalf("create reading list: %v", err)
	}
	for _, id := range []string{roadmap.ID, reading.ID} {
		if err := repo.Enroll(ctx, "bookm1", id, ""); err != nil {
			t.Fatalf("enroll: %v", err)
		}
	}

	got, err := repo.Working(ctx, "bookm1", "")
	if err != nil {
		t.Fatalf("working: %v", err)
	}
	if len(got) != 1 {
		names := make([]string, 0, len(got))
		for _, c := range got {
			names = append(names, c.Name)
		}
		t.Fatalf("working returned %d curricula (%v); the reading list is enrolled but not workable", len(got), names)
	}
	if got[0].ID != roadmap.ID {
		t.Fatalf("working returned %q; want the roadmap", got[0].Name)
	}
	// And the enrolment itself is untouched — the reading list is still taken
	// on, it simply has no progress to report. Reading it back through Get is
	// what proves the filter is a display rule and not a deletion.
	back, err := repo.Get(ctx, "bookm1", reading.ID, "")
	if err != nil {
		t.Fatalf("get reading list: %v", err)
	}
	if !back.Enrolled {
		t.Error("the reading list lost its enrollment; the filter should hide it from Working, not un-enroll it")
	}
	if back.CountableItems != 0 {
		t.Errorf("reading list reports %d countable items; the fixture is wrong and this test proved nothing", back.CountableItems)
	}
}
