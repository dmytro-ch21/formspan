package bjj

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/modules/technique"
	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The technique funnel read back across sessions. Needs a real Postgres —
// every property here is a property of the SQL (the aggregate pivot, the
// technique-tagged-only rule, the total order under the cap), and none of it
// can be proved by asserting on the query string.
func profFixture(t *testing.T) (*PostgresRepository, *pgxpool.Pool, string) {
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

	userID := "test_user_bjj_proficiency"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID); err != nil {
			t.Logf("cleanup sessions: %v", err)
		}
	})
	return NewPostgresRepository(pool), pool, userID
}

// seedEvidence writes a session (via the package's existing seeder, so the
// owner FK has a real row to reference) plus its tags. A nil techniqueID means
// an untagged live-grid row.
func seedEvidence(
	t *testing.T, pool *pgxpool.Pool, userID, sessionID string,
	startedAt time.Time, tags []tag,
) {
	t.Helper()
	ctx := context.Background()
	seedSession(t, pool, sessionID, userID)
	// The shared seeder stamps time.Now(), so two sessions land microseconds
	// apart and MAX(started_at) is indistinguishable from MIN. Set it here so
	// last_seen has something to be wrong about.
	if _, err := pool.Exec(ctx,
		`UPDATE sessions SET started_at = $2 WHERE id = $1`, sessionID, startedAt); err != nil {
		t.Fatalf("set started_at on %s: %v", sessionID, err)
	}
	for _, tg := range tags {
		if _, err := pool.Exec(ctx, `
			INSERT INTO bjj_session_tags
				(session_id, user_id, category, event, position, technique_id, count)
			VALUES ($1, $2, 'submission', $3, 'Guard', $4, $5)`,
			sessionID, userID, tg.event, tg.techniqueID, tg.count); err != nil {
			t.Fatalf("seed tag %s: %v", tg.event, err)
		}
	}
}

// techID keeps the fixtures readable; `id` is taken by the package.
func techID(s string) *string { return &s }

// seedTechnique inserts a library row for the FK to satisfy.
//
// These tests originally used real catalog ids and passed locally while
// failing in CI: `cmd/seed` had been run against the local `vola_test` by hand
// and CI only runs `cmd/migrate up`. The dependency was on ambient database
// state, not on anything the test was asserting — so it is gone. A fixture
// that needs a technique now brings its own.
func seedTechnique(t *testing.T, pool *pgxpool.Pool, id, name, category, position string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO techniques (id, name, category, position)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
			category = EXCLUDED.category, position = EXCLUDED.position`,
		id, name, category, position); err != nil {
		t.Fatalf("seed technique %s: %v", id, err)
	}
	t.Cleanup(func() {
		// After the tag cleanup (LIFO), or the FK blocks the delete.
		if _, err := pool.Exec(ctx, `DELETE FROM techniques WHERE id = $1`, id); err != nil {
			t.Logf("cleanup technique %s: %v", id, err)
		}
	})
}

type tag = struct {
	event       string
	techniqueID *string
	count       int
}

func TestListProficiencyFoldsTheFunnelAcrossSessions(t *testing.T) {
	repo, pool, userID := profFixture(t)
	ctx := context.Background()

	// Two catalog techniques that certainly exist (the seed runs in CI).
	const armbar = "test-fixture-armbar"
	const triangle = "test-fixture-triangle"
	older := time.Now().Add(-72 * time.Hour).Truncate(time.Second).UTC()
	newer := time.Now().Add(-24 * time.Hour).Truncate(time.Second).UTC()
	seedTechnique(t, pool, armbar, "Americana from Mount", "Submission", "Mount - Top")
	seedTechnique(t, pool, triangle, "Triangle from Guard", "Submission", "Guard - Bottom")

	seedEvidence(t, pool, userID, "prof-s1", older, []tag{
		{"drilled", techID(armbar), 1},
		{"attempted", techID(armbar), 2},
		{"scored", techID(armbar), 1},
		// Technique-tagged conceded. No client authors one, the API accepts
		// one, and it drives the web "Used on you" bucket — so the pivot for
		// it needs an assertion or it can be replaced with 0 and nothing
		// notices.
		{"conceded", techID(armbar), 4},
		// An untagged live-grid row for the SAME category. It must not be
		// counted here: the same real armbar can be recorded twice, once
		// technique-tagged and once as the category catch-all, and summing
		// both is how one submission becomes two.
		{"scored", nil, 5},
	})
	seedEvidence(t, pool, userID, "prof-s2", newer, []tag{
		{"drilled", techID(armbar), 3},
		{"drilled", techID(triangle), 4},
	})

	rows, err := repo.ListProficiency(ctx, userID)
	if err != nil {
		t.Fatalf("list proficiency: %v", err)
	}
	byID := map[string]Proficiency{}
	for _, p := range rows {
		byID[p.TechniqueID] = p
	}
	if len(rows) != 2 {
		t.Fatalf("got %d techniques, want 2: %+v", len(rows), rows)
	}

	a := byID[armbar]
	if a.Drilled != 4 || a.Attempted != 2 || a.Scored != 1 {
		t.Errorf("armbar funnel = drilled %d, attempted %d, scored %d; want 4/2/1",
			a.Drilled, a.Attempted, a.Scored)
	}
	// The untagged scored:5 must be nowhere in this number.
	if a.Scored == 6 {
		t.Error("the untagged live-grid row was summed into the technique's scored count")
	}
	if a.Conceded != 4 {
		t.Errorf("armbar conceded = %d, want 4", a.Conceded)
	}
	// The Scan is positional over ten columns, so two same-typed neighbours
	// swapped in the SELECT list would be invisible without this.
	if a.Position != "Mount - Top" || a.Category != "Submission" {
		t.Errorf("position/category = %q/%q, want \"Mount - Top\"/\"Submission\" — "+
			"a positional Scan makes a swapped SELECT list silent", a.Position, a.Category)
	}
	// MAX(started_at), not MIN: "last seen" is the recency signal the UI leans
	// on, and MIN passes every other assertion in this file.
	if !a.LastSeen.After(older.Add(time.Hour)) {
		t.Errorf("last_seen = %s, want the NEWER session (~%s), not the older (%s)",
			a.LastSeen, newer, older)
	}
	if a.Sessions != 2 {
		t.Errorf("armbar sessions = %d, want 2 — counts are worth less from one class", a.Sessions)
	}
	if a.Name != "Americana from Mount" {
		t.Errorf("armbar name = %q — expected the library's name, so the join is doing something", a.Name)
	}
	// Note the id fallback for a missing name is NOT covered, and cannot be:
	// technique_id has an FK to techniques, so a non-null id always resolves.
	// It and the LEFT JOIN are both defence against the FK being dropped in
	// some future migration, not against anything reachable today.
	if got := byID[triangle].Drilled; got != 4 {
		t.Errorf("triangle drilled = %d, want 4", got)
	}
	// Drilled but never taken live: the drop-off the whole feature exists for.
	if tri := byID[triangle]; tri.Tried() != 0 {
		t.Errorf("triangle tried = %d, want 0", tri.Tried())
	}
}

func TestListProficiencyIsScopedToTheCaller(t *testing.T) {
	repo, pool, userID := profFixture(t)
	ctx := context.Background()

	const other = "test_user_bjj_proficiency_other"
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, other); err != nil {
			t.Logf("cleanup other: %v", err)
		}
	})

	seedTechnique(t, pool, "test-fixture-armbar", "Americana from Mount", "Submission", "Mount - Top")
	seedTechnique(t, pool, "test-fixture-triangle", "Triangle from Guard", "Submission", "Guard - Bottom")
	seedEvidence(t, pool, other, "prof-other", time.Now(), []tag{
		{"drilled", techID("test-fixture-armbar"), 9},
	})
	seedEvidence(t, pool, userID, "prof-mine", time.Now(), []tag{
		{"drilled", techID("test-fixture-triangle"), 1},
	})

	rows, err := repo.ListProficiency(ctx, userID)
	if err != nil {
		t.Fatalf("list proficiency: %v", err)
	}
	for _, p := range rows {
		if p.TechniqueID == "test-fixture-armbar" {
			t.Fatalf("another user's evidence leaked into this athlete's funnel: %+v", p)
		}
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want only this athlete's 1", len(rows))
	}
}

func TestListProficiencyOrderIsTotalAndStable(t *testing.T) {
	repo, pool, userID := profFixture(t)
	ctx := context.Background()

	// Both techniques get the SAME total evidence, so `SUM(count) DESC` alone
	// cannot order them and the technique_id tiebreak is the only thing making
	// the result deterministic. Postgres gives no stable order for equal sort
	// keys, and an unstable order here would re-hash the response on every
	// request, turning this endpoint's ETag into a permanent cache miss.
	seedTechnique(t, pool, "test-fixture-armbar", "Americana from Mount", "Submission", "Mount - Top")
	seedTechnique(t, pool, "test-fixture-triangle", "Triangle from Guard", "Submission", "Guard - Bottom")
	seedEvidence(t, pool, userID, "prof-tie", time.Now(), []tag{
		{"drilled", techID("test-fixture-triangle"), 7},
		{"drilled", techID("test-fixture-armbar"), 7},
	})

	order := func(rows []Proficiency) string {
		out := ""
		for _, p := range rows {
			out += p.TechniqueID + ","
		}
		return out
	}
	first, err := repo.ListProficiency(ctx, userID)
	if err != nil {
		t.Fatalf("list proficiency: %v", err)
	}
	if len(first) != 2 {
		t.Fatalf("got %d rows, want 2", len(first))
	}
	// Tied on evidence, so id ascending decides — inserted triangle-first, so
	// this also proves the order is not simply insertion order.
	if got := order(first); got != "test-fixture-armbar,test-fixture-triangle," {
		t.Errorf("tie not broken by technique_id ascending: %s", got)
	}
	for i := 0; i < 5; i++ {
		again, err := repo.ListProficiency(ctx, userID)
		if err != nil {
			t.Fatalf("repeat %d: %v", i, err)
		}
		if order(again) != order(first) {
			t.Fatalf("order changed between identical requests:\n %s\n %s",
				order(first), order(again))
		}
	}

	// Two things this test does NOT cover, stated rather than implied.
	//
	// The LIMIT never binds here and cannot bind in production either:
	// maxProficiencyRows is 500 and the shared library holds 466 techniques, so
	// only a client inventing ids could reach it. It is a memory backstop (see
	// the const), not a page size — nothing truncates a real athlete's funnel.
	//
	// And deleting `, t.technique_id` from the ORDER BY does not turn this red —
	// but NOT for the reason first written here, which claimed a HashAggregate.
	// Verified with EXPLAIN at two scales, the plan is:
	//
	//	Limit -> Sort(sum DESC, technique_id) -> GroupAggregate -> Sort(technique_id, ...)
	//
	// `COUNT(DISTINCT t.session_id)` is what forces that inner sort, and it
	// leads with `technique_id` — so the aggregate hands the outer sort a
	// technique_id-ordered stream and Postgres preserves it for equal keys.
	//
	// That names the actual fragility, which the wrong explanation hid: the
	// tiebreak is redundant ONLY while `COUNT(DISTINCT session_id)` keeps the
	// aggregate sorted. Drop that column and the planner picks a HashAggregate,
	// whose group output is bucket order — measured on 466 tied techniques,
	// 459 of 466 positions moved between plans. So the tiebreak is load-bearing
	// and currently invisible, which is the worst combination to leave
	// undocumented.
}

func TestListProficiencyIgnoresUntaggedRowsEntirely(t *testing.T) {
	repo, pool, userID := profFixture(t)
	ctx := context.Background()

	// A session with nothing BUT live-grid rows. This athlete has evidence,
	// but none of it names a technique, so the funnel is honestly empty
	// rather than showing a phantom row.
	seedEvidence(t, pool, userID, "prof-untagged", time.Now(), []tag{
		{"scored", nil, 3},
		{"conceded", nil, 2},
		{"drilled", nil, 1},
	})

	rows, err := repo.ListProficiency(ctx, userID)
	if err != nil {
		t.Fatalf("list proficiency: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("untagged rows produced %d proficiency rows: %+v", len(rows), rows)
	}
	if rows == nil {
		t.Error("nil slice marshals to null; clients iterate this without a null check")
	}
}

func TestSummariseProficiencyCountsTechniquesNotReps(t *testing.T) {
	// Pure function, no database — and the distinction it encodes is the whole
	// point of the headline. "You have drilled 34 techniques and taken 6 into
	// a roll" is a finding. "You have done 210 reps" is a statistic.
	got := SummariseProficiency([]Proficiency{
		{TechniqueID: "a", Drilled: 40, Attempted: 0, Scored: 0},
		{TechniqueID: "b", Drilled: 1, Attempted: 3, Scored: 0},
		{TechniqueID: "c", Drilled: 1, Attempted: 1, Scored: 2},
		{TechniqueID: "d", Drilled: 0, Attempted: 0, Scored: 0, Conceded: 5},
	})
	want := ProficiencySummary{Techniques: 4, Drilled: 3, TriedLive: 2, Landed: 1}
	if got != want {
		t.Errorf("summary = %+v, want %+v", got, want)
	}
}

func TestSummaryIsFoldedFromTheSameRowsTheClientSees(t *testing.T) {
	// If the headline were a second aggregate query it could disagree with the
	// list under it — most obviously once the cap binds, where the list is
	// truncated and a COUNT(*) would not be.
	rows := make([]Proficiency, 0, maxProficiencyRows+10)
	for i := 0; i < maxProficiencyRows+10; i++ {
		rows = append(rows, Proficiency{TechniqueID: fmt.Sprint(i), Drilled: 1})
	}
	if got := SummariseProficiency(rows).Techniques; got != len(rows) {
		t.Errorf("summary counted %d of %d rows it was given", got, len(rows))
	}
}

func TestTheShippedLibraryStaysUnderTheProficiencyCap(t *testing.T) {
	// Reads the EMBEDDED catalog, not the database, so it runs everywhere —
	// including CI, which only migrates and never seeds. The first version
	// queried `techniques` and skipped when empty, which meant it skipped in
	// exactly the place it most needed to run.
	//
	// maxProficiencyRows cannot bind while the catalog is smaller than it: the
	// GROUP BY is on technique_id and the FK caps the distinct count at the
	// library size. Grow the library past the cap without raising it and the
	// funnel truncates silently — no error, no pagination, and the summary
	// folds from the truncated rows so it under-reports in step.
	catalog, err := technique.SeedData()
	if err != nil {
		t.Fatalf("read embedded catalog: %v", err)
	}
	if len(catalog) >= maxProficiencyRows {
		t.Fatalf("the shipped library holds %d techniques and maxProficiencyRows is %d — "+
			"the funnel now truncates silently. Raise the cap.", len(catalog), maxProficiencyRows)
	}
}
