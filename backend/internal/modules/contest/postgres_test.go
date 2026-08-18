package contest

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// These exercise what only exists in the database: the `user_id` predicate
// doing authorization on every path, the transaction that stops a half-written
// entry, the ON DELETE CASCADE taking the matches with it, and the index-shaped
// ordering. None of it is observable from the domain types.

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
	// Registered FIRST so it closes LAST under LIFO cleanup — every t.Cleanup
	// below still needs the pool open. See CLAUDE.md; a `defer pool.Close()`
	// here would close it before any of them ran.
	t.Cleanup(pool.Close)
	return NewPostgresRepository(pool), pool
}

// cleanupUser removes an account's entries. The matches go with them by
// cascade, which is the same path Delete relies on.
func cleanupUser(t *testing.T, pool *pgxpool.Pool, userIDs ...string) {
	t.Helper()
	t.Cleanup(func() {
		for _, u := range userIDs {
			if _, err := pool.Exec(context.Background(),
				`DELETE FROM contests WHERE user_id = $1`, u); err != nil {
				t.Logf("cleanup %s: %v", u, err)
			}
		}
	})
}

// seedTechnique owns the library row this package depends on, rather than
// borrowing one the exercise/technique seeders happen to have left behind.
//
// CLAUDE.md's rule, and it is enforced structurally: `technique`'s own tests
// delete the 542-row library after themselves, so a fixture referencing
// `closed-guard-armbar` without seeding it fails in the ordinary `-p 1` run.
// The id is namespaced with the package's own prefix and keeps the original
// name as the suffix, per the `workout` convention.
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

func str(s string) *string { return &s }
func num(i int) *int       { return &i }
func boolean(b bool) *bool { return &b }

func mustCreate(t *testing.T, repo *PostgresRepository, userID string, in Input) *Contest {
	t.Helper()
	if err := in.Validate(); err != nil {
		t.Fatalf("fixture is invalid: %v", err)
	}
	c, err := repo.Create(context.Background(), userID, in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return c
}

func TestCreateAndGetRoundTrip(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_contest_roundtrip"
	cleanupUser(t, pool, user)
	tech := seedTechnique(t, pool, "ct_fx_closed_guard_armbar")

	created := mustCreate(t, repo, user, Input{
		Sport:          "bjj",
		Name:           "IBJJF Pans",
		Organisation:   "IBJJF",
		HeldOn:         str("2026-03-14"),
		Format:         FormatPoints,
		Gi:             boolean(true),
		DivisionBelt:   "brown",
		DivisionAge:    "master 1",
		DivisionWeight: "middleweight",
		Placement:      num(3),
		Entrants:       num(32),
		Note:           "first Pans",
		Matches: []Match{
			{Result: Won, Method: MethodSubmission, TechniqueID: &tech, Opponent: "R. Silva"},
			{Result: Won, Method: MethodPoints},
			{Result: Lost, Method: MethodAdvantage, Note: "gave up two advantages"},
		},
	})

	got, err := repo.Get(ctx, user, created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}

	// A DATE must come back as a calendar date. Rendered as an RFC3339 instant
	// it shows as the PREVIOUS DAY for anyone west of Greenwich once a client
	// localises midnight — the trap the mobile suite pins its timezone for.
	if got.HeldOn == nil || *got.HeldOn != "2026-03-14" {
		t.Errorf("held_on: want 2026-03-14, got %v", got.HeldOn)
	}
	if got.Gi == nil || !*got.Gi {
		t.Errorf("gi: want true, got %v", got.Gi)
	}
	if got.DivisionBelt != "brown" || got.DivisionAge != "master 1" || got.DivisionWeight != "middleweight" {
		t.Errorf("division round-tripped wrong: %+v", got)
	}
	if got.Placement == nil || *got.Placement != 3 || got.Entrants == nil || *got.Entrants != 32 {
		t.Errorf("placement/entrants: %v of %v", got.Placement, got.Entrants)
	}
	if len(got.Matches) != 3 {
		t.Fatalf("want 3 matches, got %d", len(got.Matches))
	}
	// Bracket order is the whole point of `position`: it is what makes "lost in
	// the final" different from "lost the first match".
	for i, m := range got.Matches {
		if m.Position != i+1 {
			t.Errorf("match %d: want position %d, got %d", i, i+1, m.Position)
		}
	}
	if got.Matches[0].TechniqueID == nil || *got.Matches[0].TechniqueID != tech {
		t.Errorf("technique_id: want %q, got %v", tech, got.Matches[0].TechniqueID)
	}
	if got.Matches[2].Result != Lost || got.Matches[2].Method != MethodAdvantage {
		t.Errorf("last match round-tripped wrong: %+v", got.Matches[2])
	}
}

func TestAnEntryWithNoMatchesGetsAnEmptySliceNotNull(t *testing.T) {
	repo, pool := newTestRepo(t)
	const user = "user_contest_nomatches"
	cleanupUser(t, pool, user)

	// A placement alone is an ordinary entry, not an edge case — most entries
	// logged from memory are exactly this.
	created := mustCreate(t, repo, user, Input{Sport: "bjj", Name: "Local open", Placement: num(1)})
	got, err := repo.Get(context.Background(), user, created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Matches == nil {
		t.Error("matches must be a non-nil empty slice, or it marshals as null")
	}
	if len(got.Matches) != 0 {
		t.Errorf("want no matches, got %d", len(got.Matches))
	}
}

// Every read and write is scoped by user_id. Without that predicate each of
// these is an IDOR — the shape the reviewers have caught twice in this
// codebase — and a test per verb is what stops one of the four being edited
// back.
func TestEveryPathIsScopedToTheOwner(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const owner, stranger = "user_contest_owner", "user_contest_stranger"
	cleanupUser(t, pool, owner, stranger)

	c := mustCreate(t, repo, owner, Input{Sport: "bjj", Name: "Pan Ams", Note: "mine"})

	if _, err := repo.Get(ctx, stranger, c.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("get: want ErrNotFound, got %v", err)
	}

	in := Input{Sport: "bjj", Name: "Hijacked"}
	if err := in.Validate(); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Update(ctx, stranger, c.ID, in); !errors.Is(err, ErrNotFound) {
		t.Errorf("update: want ErrNotFound, got %v", err)
	}

	if err := repo.Delete(ctx, stranger, c.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("delete: want ErrNotFound, got %v", err)
	}

	// The refusals must also be refusals in fact, not just in the return value.
	after, err := repo.Get(ctx, owner, c.ID)
	if err != nil {
		t.Fatalf("the owner's entry should survive: %v", err)
	}
	if after.Name != "Pan Ams" || after.Note != "mine" {
		t.Errorf("a stranger's update changed the row: %+v", after)
	}

	list, err := repo.List(ctx, stranger)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("a stranger's list must be empty, got %d entries", len(list))
	}
}

func TestUpdateReplacesEveryMatch(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_contest_replace"
	cleanupUser(t, pool, user)

	c := mustCreate(t, repo, user, Input{
		Sport: "bjj", Name: "Pan Ams",
		Matches: []Match{{Result: Won}, {Result: Won}, {Result: Lost}},
	})

	// Wholesale replacement, matching curriculum's items and bjj's tags. Three
	// down to one is the case a diff-based writer gets wrong.
	in := Input{Sport: "bjj", Name: "Pan Ams", Matches: []Match{{Result: Lost, Method: MethodDecision}}}
	if err := in.Validate(); err != nil {
		t.Fatal(err)
	}
	updated, err := repo.Update(ctx, user, c.ID, in)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(updated.Matches) != 1 {
		t.Fatalf("want 1 match in the response, got %d", len(updated.Matches))
	}
	// The response is read back through the TRANSACTION rather than echoed from
	// the request — reading through the pool would open a second connection
	// that cannot see the uncommitted rows, and the matches would come back
	// empty.
	if updated.Matches[0].Method != MethodDecision {
		t.Errorf("response did not reflect what was written: %+v", updated.Matches[0])
	}

	got, err := repo.Get(ctx, user, c.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got.Matches) != 1 || got.Matches[0].Position != 1 {
		t.Errorf("after replacement want one match at position 1, got %+v", got.Matches)
	}

	// An entry can also be emptied of matches entirely.
	empty := Input{Sport: "bjj", Name: "Pan Ams"}
	if err := empty.Validate(); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Update(ctx, user, c.ID, empty); err != nil {
		t.Fatalf("clearing matches: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM contest_matches WHERE contest_id = $1`, c.ID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("want no match rows left, got %d", n)
	}
}

func TestDeleteTakesTheMatchesWithIt(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_contest_cascade"
	cleanupUser(t, pool, user)

	c := mustCreate(t, repo, user, Input{
		Sport: "bjj", Name: "Pan Ams",
		Matches: []Match{{Result: Won}, {Result: Lost}},
	})

	if err := repo.Delete(ctx, user, c.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	// Delete issues ONE statement and leans on
	// `contest_matches_contest_owner_fk`'s ON DELETE CASCADE. If that clause
	// were ever weakened the matches would be orphaned with nothing pointing at
	// them, and only this assertion would notice.
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM contest_matches WHERE contest_id = $1`, c.ID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("want the matches cascaded away, got %d rows", n)
	}
	if _, err := repo.Get(ctx, user, c.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("want ErrNotFound after delete, got %v", err)
	}
	if err := repo.Delete(ctx, user, c.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("a second delete should be ErrNotFound, got %v", err)
	}
}

// An unknown technique is the caller's problem, not the server's: it must be a
// 400 naming the field rather than an unmapped internal error. This is the FK
// arm of translatePgError, and it is only reachable from the database.
func TestAnUnknownTechniqueIsInvalidInput(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_contest_badtech"
	cleanupUser(t, pool, user)

	in := Input{
		Sport: "bjj", Name: "Pan Ams",
		Matches: []Match{{Result: Won, Method: MethodSubmission, TechniqueID: str("ct-no-such-technique")}},
	}
	if err := in.Validate(); err != nil {
		t.Fatalf("the fixture must pass validation so the DATABASE is what refuses it: %v", err)
	}
	_, err := repo.Create(ctx, user, in)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}

	// And the entry must not survive the failed write. The insert is in one
	// transaction precisely so a contest whose matches failed cannot be left
	// behind reading as "turned up, never fought" — permanently, with nothing
	// flagging the loss.
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM contests WHERE user_id = $1`, user).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("the failed create left %d contest rows behind", n)
	}
}

func TestListOrdersNewestFirstAndSinksUndatedEntries(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_contest_order"
	cleanupUser(t, pool, user)

	mustCreate(t, repo, user, Input{Sport: "bjj", Name: "older", HeldOn: str("2025-01-10")})
	mustCreate(t, repo, user, Input{Sport: "bjj", Name: "undated"})
	mustCreate(t, repo, user, Input{Sport: "bjj", Name: "newer", HeldOn: str("2026-03-14")})

	list, err := repo.List(ctx, user)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("want 3 entries, got %d", len(list))
	}
	// NULLS LAST is in the index declaration as well as the query, so an
	// undated entry sinks without the planner abandoning the index. An entry
	// nobody dated is still a real entry — it simply cannot sit on a timeline.
	want := []string{"newer", "older", "undated"}
	for i, name := range want {
		if list[i].Name != name {
			t.Errorf("position %d: want %q, got %q", i, name, list[i].Name)
		}
	}
}

// The list loads every entry's matches in ONE query. An N+1 here is 200 round
// trips to draw one screen, and it is invisible from the returned data — so
// this asserts the data is right and the comment on attachMatches is what
// states the intent. What this does prove is that matches are attached to the
// correct entry, which a batched loader keyed on the wrong id gets wrong.
func TestListAttachesEachEntrysOwnMatches(t *testing.T) {
	repo, pool := newTestRepo(t)
	ctx := context.Background()
	const user = "user_contest_attach"
	cleanupUser(t, pool, user)

	mustCreate(t, repo, user, Input{
		Sport: "bjj", Name: "gi", HeldOn: str("2026-03-14"),
		Matches: []Match{{Result: Won, Opponent: "gi-1"}, {Result: Lost, Opponent: "gi-2"}},
	})
	mustCreate(t, repo, user, Input{
		Sport: "bjj", Name: "no-gi", HeldOn: str("2026-03-15"),
		Matches: []Match{{Result: Won, Opponent: "nogi-1"}},
	})

	list, err := repo.List(ctx, user)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("want 2 entries, got %d", len(list))
	}
	// Newest first: no-gi was held a day later.
	if list[0].Name != "no-gi" || len(list[0].Matches) != 1 || list[0].Matches[0].Opponent != "nogi-1" {
		t.Errorf("first entry's matches are wrong: %+v", list[0])
	}
	if list[1].Name != "gi" || len(list[1].Matches) != 2 || list[1].Matches[0].Opponent != "gi-1" {
		t.Errorf("second entry's matches are wrong: %+v", list[1])
	}
}
