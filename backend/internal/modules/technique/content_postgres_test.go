package technique

import (
	"context"
	"errors"
	"os"
	"testing"

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

func TestUpdateRefusesASeededRow(t *testing.T) {
	// An edit here would be reverted by the next deploy — silently, and only
	// for the fields the change-detection tuple covers, which is the worst
	// kind of half-applied. Refused outright instead.
	repo, _ := contentFixture(t)
	ctx := context.Background()

	if err := repo.UpsertAll(ctx, []Technique{aTechnique("test-content-ro", "Read Only")}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	edit := aTechnique("test-content-ro", "Edited")
	if _, err := repo.UpdateTechnique(ctx, edit); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update of a seeded row = %v, want ErrNotFound", err)
	}
	got, _ := repo.Get(ctx, "test-content-ro")
	if got.Name != "Read Only" {
		t.Errorf("the seeded row was edited anyway: %q", got.Name)
	}
	// ...and the handler can tell the caller WHY, rather than 404ing at an id
	// the console is displaying.
	source, err := repo.Source(ctx, "test-content-ro")
	if err != nil || source != "seed" {
		t.Errorf("Source = %q, %v; want seed", source, err)
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
	known := []string{"Half Guard - Top", "Guard - Bottom"}

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
