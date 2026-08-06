package technique

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

func contentFixture(t *testing.T) (*PostgresRepository, *pgxpool.Pool) {
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
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM techniques WHERE id LIKE 'test-content-%'`); err != nil {
			t.Logf("cleanup: %v", err)
		}
	})
	return NewPostgresRepository(pool), pool
}

func aTechnique(id, name string) Technique {
	return Technique{
		ID: id, Name: name, Category: "Pass", Position: "Half Guard - Top",
		GiNoGi: "Both", Aliases: []string{}, SetupFrom: []string{},
		CommonCounters: []string{}, CommonNextMoves: []string{},
	}
}

func TestSlugIsDerivedFromTheNameAndFoldsAccents(t *testing.T) {
	// The id outlives every other field — it is a foreign key in
	// bjj_session_tags — so it is generated once and frozen. "São Paulo"
	// folding to "s-o-paulo" would be a permanently ugly id nobody can fix.
	for name, want := range map[string]string{
		"São Paulo Pass":     "sao-paulo-pass",
		"Knee Cut":           "knee-cut",
		"  Spaced  Out  ":    "spaced-out",
		"Berimbolo / Crab":   "berimbolo-crab",
		"Kimura (Americana)": "kimura-americana",
		"Ude-Garami":         "ude-garami",
		"!!!":                "",
	} {
		if got := Slug(name); got != want {
			t.Errorf("Slug(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestCreateWritesAnAdminRowThatSeedingCannotTouch(t *testing.T) {
	// THE property this whole feature rests on. `cmd/seed` runs on every
	// deploy and upserts by id with a change-detection tuple, so without the
	// `source = 'seed'` guard a deploy would silently revert admin content —
	// routinely, not rarely.
	repo, pool := contentFixture(t)
	ctx := context.Background()

	created, err := repo.CreateTechnique(ctx, aTechnique("test-content-sao-paulo", "São Paulo Pass"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Source != "admin" {
		t.Fatalf("source = %q, want admin", created.Source)
	}
	// The projection omitted created_at/updated_at, so every write returned
	// 0001-01-01T00:00:00Z — well-formed enough to satisfy a schema validator
	// and to render as "Created 1 Jan 0001". Only an integration test can see
	// this: the handler's fake repository supplies its own timestamps, so the
	// handler-level test stays green with the SQL broken.
	if created.CreatedAt.IsZero() || created.UpdatedAt.IsZero() {
		t.Errorf("zero timestamps from the write projection: %v / %v",
			created.CreatedAt, created.UpdatedAt)
	}

	// A seed that happens to carry the same id, with different content.
	clash := aTechnique("test-content-sao-paulo", "Something The Seed Thinks")
	clash.Description = "seeded description"
	if err := repo.UpsertAll(ctx, []Technique{clash}); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	after, err := repo.Get(ctx, "test-content-sao-paulo")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if after.Name != "São Paulo Pass" || after.Description != "" {
		t.Errorf("a re-seed overwrote admin content: name=%q description=%q",
			after.Name, after.Description)
	}
	var source string
	if err := pool.QueryRow(ctx,
		`SELECT source FROM techniques WHERE id = 'test-content-sao-paulo'`).Scan(&source); err != nil {
		t.Fatalf("read source: %v", err)
	}
	if source != "admin" {
		t.Errorf("source became %q — the row was adopted by the seed", source)
	}
}

func TestSeedingStillUpdatesItsOwnRows(t *testing.T) {
	// The guard must not be so broad that the seed stops working — that would
	// be a silent content freeze on every deploy, which is worse than the
	// problem it fixes and would look identical to "nothing changed".
	repo, pool := contentFixture(t)
	ctx := context.Background()

	seeded := aTechnique("test-content-seeded", "Original")
	if err := repo.UpsertAll(ctx, []Technique{seeded}); err != nil {
		t.Fatalf("first seed: %v", err)
	}
	var source string
	_ = pool.QueryRow(ctx, `SELECT source FROM techniques WHERE id = 'test-content-seeded'`).Scan(&source)
	if source != "seed" {
		t.Fatalf("a seeded row got source %q, want seed", source)
	}

	seeded.Name = "Renamed By The Seed"
	if err := repo.UpsertAll(ctx, []Technique{seeded}); err != nil {
		t.Fatalf("re-seed: %v", err)
	}
	got, _ := repo.Get(ctx, "test-content-seeded")
	if got.Name != "Renamed By The Seed" {
		t.Errorf("name = %q — the guard blocked the seed from its own row", got.Name)
	}
}

func TestCreateRefusesAnIDThatAlreadyExists(t *testing.T) {
	// Not an upsert. The id may already be referenced by somebody's training
	// record, so silently rewriting the technique behind it changes what their
	// history says they did.
	repo, _ := contentFixture(t)
	ctx := context.Background()

	if _, err := repo.CreateTechnique(ctx, aTechnique("test-content-dup", "Dup")); err != nil {
		t.Fatalf("create: %v", err)
	}
	_, err := repo.CreateTechnique(ctx, aTechnique("test-content-dup", "Dup"))
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second create = %v, want ErrAlreadyExists", err)
	}
}

// Editing a seeded row is allowed now, and the write TAKES OWNERSHIP.
//
// This test is the inverse of the one it replaced. The old rule refused the
// edit because the next deploy's re-seed would silently revert it; with the
// authoring spreadsheet retired there is no other route to change the row, so
// the write flips `source` to 'admin' instead and the seeder's own
// `WHERE source = 'seed'` leaves it alone from then on.
//
// The re-seed at the end is the load-bearing half. Take `source = 'admin'` out
// of the UPDATE's SET clause and the edit still succeeds — every assertion
// before the re-seed still passes — and the deploy quietly undoes it. That is
// the exact failure the old refusal existed to prevent, so it is what this has
// to cover.
func TestUpdatingASeededRowTakesOwnershipOfIt(t *testing.T) {
	repo, _ := contentFixture(t)
	ctx := context.Background()

	if err := repo.UpsertAll(ctx, []Technique{aTechnique("test-content-ro", "Seeded Name")}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := repo.UpdateTechnique(ctx, aTechnique("test-content-ro", "Edited In The Console")); err != nil {
		t.Fatalf("update of a seeded row = %v, want it to succeed now", err)
	}
	got, _ := repo.Get(ctx, "test-content-ro")
	if got.Name != "Edited In The Console" {
		t.Fatalf("the edit did not land: %q", got.Name)
	}
	source, err := repo.Source(ctx, "test-content-ro")
	if err != nil || source != "admin" {
		t.Fatalf("Source = %q, %v; want admin — the edit must take ownership, "+
			"or the next deploy reverts it", source, err)
	}

	// The deploy runs on every release. It must now skip this row.
	if err := repo.UpsertAll(ctx, []Technique{aTechnique("test-content-ro", "Seeded Name")}); err != nil {
		t.Fatalf("re-seed: %v", err)
	}
	after, _ := repo.Get(ctx, "test-content-ro")
	if after.Name != "Edited In The Console" {
		t.Errorf("the re-seed reverted the console edit to %q — the UPDATE is not "+
			"taking ownership, so every edit made here dies at the next release", after.Name)
	}
}

// SearchAll reaches the WHOLE catalog, aliases included, and escapes LIKE
// metacharacters.
//
// Nothing covered this branch when it was written: deleting the entire `?q=`
// path from the handler left the suite green, which is the shape this repo's
// testing notes warn about. The alias arm matters most — it is a subquery over
// `unnest`, so it is the part a rewrite silently drops — and the metacharacter
// case is a real defect this caught: without database.LikeTerm a `_` matches
// any character and a trailing backslash escapes the pattern's own closing `%`.
func TestSearchAllReachesSeededRowsAndAliases(t *testing.T) {
	repo, _ := contentFixture(t)
	ctx := context.Background()

	seeded := aTechnique("test-content-search-seeded", "Kesa Gatame Control")
	seeded.Aliases = []string{"scarf hold"}
	if err := repo.UpsertAll(ctx, []Technique{seeded}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	ids := func(q string) map[string]bool {
		t.Helper()
		out, err := repo.SearchAll(ctx, q)
		if err != nil {
			t.Fatalf("search %q: %v", q, err)
		}
		got := map[string]bool{}
		for _, x := range out {
			got[x.ID] = true
		}
		return got
	}

	// A SEEDED row, which the console could not previously list at all.
	if !ids("Kesa Gatame")["test-content-search-seeded"] {
		t.Error("search by name missed a seeded row — the whole point of the branch")
	}
	if !ids("test-content-search-se")["test-content-search-seeded"] {
		t.Error("search by id missed it")
	}
	// The alias arm. Half this library is known by a second name.
	if !ids("scarf hold")["test-content-search-seeded"] {
		t.Error("search by alias missed it — the unnest subquery is not doing anything")
	}

	// Metacharacters are literal. `_` is LIKE's any-character wildcard, so
	// unescaped this matches "Kesa Gatame" and the assertion inverts.
	if ids("Kesa_Gatame")["test-content-search-seeded"] {
		t.Error("`_` behaved as a wildcard — LikeTerm is not being applied")
	}
	if len(ids("%")) != 0 {
		t.Error("`%` behaved as a wildcard and matched the catalog")
	}
	// A trailing backslash must not escape the pattern's own closing `%`.
	if len(ids(`Kesa\`)) != 0 {
		t.Error("a trailing backslash was not escaped")
	}
}

func TestUpdateEditsAnAdminRow(t *testing.T) {
	repo, _ := contentFixture(t)
	ctx := context.Background()

	if _, err := repo.CreateTechnique(ctx, aTechnique("test-content-edit", "Before")); err != nil {
		t.Fatalf("create: %v", err)
	}
	edit := aTechnique("test-content-edit", "After")
	edit.Description = "now with detail"
	out, err := repo.UpdateTechnique(ctx, edit)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if out.Name != "After" || out.Description != "now with detail" {
		t.Errorf("update did not apply: %+v", out)
	}
	if out.Source != "admin" {
		t.Errorf("source = %q after update, want admin", out.Source)
	}
}

func TestValidateForWriteRejectsAVocabularyTheClientsCannotRender(t *testing.T) {
	// The worst data this catalog can hold: it writes, it renders, and it
	// returns an empty list forever with nothing reporting a fault. The admin
	// path must apply the SAME rules the seeder does, from the same place.
	// "Leg Entanglement" is here so the entanglement cases below are rejected by
	// the RULE rather than by the unknown-position check. Without it the second
	// one passes for the wrong reason — verified by mutation: delete the
	// biconditional and only the first case goes red.
	known := []string{"Half Guard - Top", "Guard - Bottom", "Leg Entanglement"}

	base := aTechnique("x", "X")
	if err := ValidateForWrite(base, known); err != nil {
		t.Fatalf("a valid technique was rejected: %v", err)
	}
	for name, mutate := range map[string]func(Technique) Technique{
		"unknown position": func(t Technique) Technique { t.Position = "Sideways"; return t },
		"unknown function": func(t Technique) Technique { t.Function = "wiggle"; return t },
		"unknown gi_no_gi": func(t Technique) Technique { t.GiNoGi = "Sometimes"; return t },
		"missing name":     func(t Technique) Technique { t.Name = ""; return t },
		"missing category": func(t Technique) Technique { t.Category = ""; return t },
		"bad to_position":  func(t Technique) Technique { t.ToPosition = "Nowhere"; return t },
		// Both halves of the entanglement biconditional. It lives in
		// ValidateFields precisely so the CONSOLE write path enforces it, and
		// this is the test that says so — validate()'s own cases cover the
		// seeder, and a rule that only ran there would let the console author a
		// row that goes live in that environment immediately.
		"entanglement detail under another position": func(t Technique) Technique {
			t.PositionDetail = "Single-Leg X"
			return t
		},
		"leg entanglement with an unrelated detail": func(t Technique) Technique {
			t.Position = "Leg Entanglement"
			t.PositionDetail = "Closed Guard"
			return t
		},
	} {
		if err := ValidateForWrite(mutate(base), known); err == nil {
			t.Errorf("%s was accepted", name)
		} else if !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%s gave %v, want ErrInvalidInput so the handler can 400 it", name, err)
		}
	}
}

func TestKnownPositionsComesFromTheCatalog(t *testing.T) {
	// Derived, not hardcoded — the same choice validate() makes for
	// to_position. A second list to maintain is a second list to forget, and
	// this one has already grown twice (leg entanglement, North-South).
	repo, _ := contentFixture(t)
	ctx := context.Background()

	if _, err := repo.CreateTechnique(ctx, aTechnique("test-content-pos", "Pos")); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.KnownPositions(ctx)
	if err != nil {
		t.Fatalf("known positions: %v", err)
	}
	found := false
	for _, p := range got {
		if p == "Half Guard - Top" {
			found = true
		}
		if p == "" {
			t.Error("empty position offered as a choice")
		}
	}
	if !found {
		t.Errorf("the catalog's own position was not offered: %v", got)
	}
}

func TestAdoptHandsRowsToTheDeployAndOnlyAdminOnes(t *testing.T) {
	// Adoption is the last step of promotion: once the exported JSON is
	// committed AND deployed, the file owns the content and the seeder must be
	// able to update it. Before that the row is the only copy, which is why
	// this is a separate command from the export.
	repo, pool := contentFixture(t)
	ctx := context.Background()

	if _, err := repo.CreateTechnique(ctx, aTechnique("test-content-adopt", "Adopt Me")); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := repo.UpsertAll(ctx, []Technique{aTechnique("test-content-notmine", "Seeded")}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	authored, err := repo.AdminAuthored(ctx)
	if err != nil {
		t.Fatalf("admin authored: %v", err)
	}
	var sawAdmin, sawSeeded bool
	for _, a := range authored {
		if a.ID == "test-content-adopt" {
			sawAdmin = true
		}
		if a.ID == "test-content-notmine" {
			sawSeeded = true
		}
	}
	if !sawAdmin {
		t.Error("the admin row was not offered for export")
	}
	if sawSeeded {
		t.Error("a seeded row was offered for export — it is already in the JSON")
	}

	// Adopt the admin row, and name the seeded one too: re-running adoption
	// must not disturb rows the deploy already owns.
	//
	// Asserted on updated_at, not on source — setting source='seed' on a row
	// that is already 'seed' is invisible in the value, so the earlier version
	// of this test could not tell the scoped query from the unscoped one. The
	// observable difference is the timestamp, and it matters: clients delta-sync
	// on updated_at, so an unscoped adoption makes every named seeded technique
	// look changed to every device.
	var before time.Time
	if err := pool.QueryRow(ctx,
		`SELECT updated_at FROM techniques WHERE id = 'test-content-notmine'`).Scan(&before); err != nil {
		t.Fatalf("read updated_at: %v", err)
	}
	if err := repo.AdoptAsSeeded(ctx, []string{"test-content-adopt", "test-content-notmine"}); err != nil {
		t.Fatalf("adopt: %v", err)
	}
	var after time.Time
	if err := pool.QueryRow(ctx,
		`SELECT updated_at FROM techniques WHERE id = 'test-content-notmine'`).Scan(&after); err != nil {
		t.Fatalf("read updated_at: %v", err)
	}
	if !after.Equal(before) {
		t.Errorf("adoption touched a row the deploy already owns: updated_at moved %s -> %s — "+
			"every client delta-syncing on this now re-fetches it", before, after)
	}

	var adopted, untouched string
	_ = pool.QueryRow(ctx, `SELECT source FROM techniques WHERE id = 'test-content-adopt'`).Scan(&adopted)
	_ = pool.QueryRow(ctx, `SELECT source FROM techniques WHERE id = 'test-content-notmine'`).Scan(&untouched)
	if adopted != "seed" {
		t.Errorf("adopted row source = %q, want seed", adopted)
	}
	if untouched != "seed" {
		t.Errorf("already-seeded row source = %q", untouched)
	}

	// ...and the seeder can now update what it owns, which is the whole point.
	renamed := aTechnique("test-content-adopt", "Renamed By The Deploy")
	if err := repo.UpsertAll(ctx, []Technique{renamed}); err != nil {
		t.Fatalf("re-seed: %v", err)
	}
	got, _ := repo.Get(ctx, "test-content-adopt")
	if got.Name != "Renamed By The Deploy" {
		t.Errorf("name = %q — adoption did not hand the row over", got.Name)
	}

	// The console can still edit it — that is the point of step 2 — but doing so
	// takes it straight back off the deploy, which is what keeps the two
	// writers from fighting over the row.
	if _, err := repo.UpdateTechnique(ctx, aTechnique("test-content-adopt", "Edited Again")); err != nil {
		t.Errorf("an adopted row should be editable again: %v", err)
	}
	var back string
	_ = pool.QueryRow(ctx, `SELECT source FROM techniques WHERE id = 'test-content-adopt'`).Scan(&back)
	if back != "admin" {
		t.Errorf("editing an adopted row left source = %q — adoption is one-way "+
			"only until the console touches it again", back)
	}
}
