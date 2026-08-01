package technique

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

// Postgres integration tests, gated on TEST_DATABASE_URL and skipping
// gracefully without it.

func newTestRepo(t *testing.T) *PostgresRepository {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping Postgres integration test")
	}
	pool, err := database.NewPool(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	// Registered first so it closes last under LIFO cleanup.
	t.Cleanup(pool.Close)
	return NewPostgresRepository(pool)
}

// The library IS the product here, so a malformed entry is a real defect.
func TestSeedData_IsValid(t *testing.T) {
	techs, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}
	if len(techs) < 100 {
		t.Fatalf("expected a substantial library, got %d", len(techs))
	}

	// The graph is the reason this module exists rather than being rows in
	// the exercise catalog. If the edges ever stop arriving, the split has
	// lost its justification and we should know immediately.
	withEdges := 0
	for _, tt := range techs {
		if len(tt.SetupFrom) > 0 || len(tt.CommonCounters) > 0 {
			withEdges++
		}
	}
	if withEdges*10 < len(techs)*9 {
		t.Errorf("only %d/%d techniques carry graph edges — the library has gone flat",
			withEdges, len(techs))
	}
}

func TestValidate_RejectsBadContent(t *testing.T) {
	cases := []struct {
		name string
		in   []Technique
	}{
		{"duplicate id", []Technique{
			{ID: "a", Name: "A", Category: "Sweep", Position: "Guard - Bottom", GiNoGi: "Both"},
			{ID: "a", Name: "B", Category: "Sweep", Position: "Guard - Bottom", GiNoGi: "Both"},
		}},
		{"unknown gi_no_gi", []Technique{
			{ID: "a", Name: "A", Category: "Sweep", Position: "Guard - Bottom", GiNoGi: "Gi"},
		}},
		{"missing position", []Technique{
			{ID: "a", Name: "A", Category: "Sweep", GiNoGi: "Both"},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validate(tc.in); err == nil {
				t.Fatal("expected a validation error, got nil")
			}
		})
	}
}

func TestPostgresRepository_SeedAndFilter(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	n, err := Seed(ctx, repo)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Re-seeding runs on every deploy, so it must be value-idempotent, not
	// just row-count idempotent.
	all, err := repo.List(ctx, Filter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != n {
		t.Errorf("seeded %d but listed %d", n, len(all))
	}
	// List returns summaries now, which carry no timestamps — fetch the full
	// row so the no-op check still compares what it claims to.
	before, err := repo.Get(ctx, all[0].ID)
	if err != nil {
		t.Fatalf("get before: %v", err)
	}
	if _, err := Seed(ctx, repo); err != nil {
		t.Fatalf("re-seed: %v", err)
	}
	after, err := repo.Get(ctx, before.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Error("updated_at moved on a no-op re-seed")
	}

	subs, err := repo.List(ctx, Filter{Category: "Submission"})
	if err != nil {
		t.Fatalf("filter by category: %v", err)
	}
	if len(subs) == 0 {
		t.Fatal("expected submissions in the library")
	}
	for _, tt := range subs {
		if tt.Category != "Submission" {
			t.Errorf("category filter leaked %q", tt.Category)
		}
	}

	// Asking for gi must include "Both" — otherwise the filter hides most of
	// the library rather than narrowing it.
	gi, err := repo.List(ctx, Filter{GiNoGi: "Gi Only"})
	if err != nil {
		t.Fatalf("filter by gi: %v", err)
	}
	sawBoth := false
	for _, tt := range gi {
		if tt.GiNoGi == "Both" {
			sawBoth = true
		}
		if tt.GiNoGi == "No-Gi Only" {
			t.Error(`"Gi Only" filter returned a No-Gi-only technique`)
		}
	}
	if !sawBoth {
		t.Error(`"Gi Only" filter excluded every "Both" technique`)
	}

	// LIKE metacharacters must be literal, not wildcards.
	meta, err := repo.List(ctx, Filter{Query: "%"})
	if err != nil {
		t.Fatalf("metachar search: %v", err)
	}
	if len(meta) != 0 {
		t.Errorf(`"%%" behaved as a wildcard: matched %d`, len(meta))
	}
}

func TestPostgresRepository_GetNotFound(t *testing.T) {
	repo := newTestRepo(t)
	tq, err := repo.Get(context.Background(), "no-such-technique")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
	if tq != nil {
		t.Errorf("expected nil alongside the error, got %+v", tq)
	}
}

// The enrichment's load-bearing claims, each of which would fail silently.
func TestTechniqueEnrichment(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	if _, err := Seed(ctx, repo); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rulesets, err := repo.Rulesets(ctx)
	if err != nil {
		t.Fatalf("rulesets: %v", err)
	}
	if len(rulesets) == 0 {
		t.Fatal("no rulesets seeded")
	}

	// is_restricted must mean "narrower than this division's baseline", not
	// "lists fewer than five belts". Adult no-gi has no white belt division,
	// so a no-gi ruleset of Blue/Purple/Brown/Black is the baseline. Getting
	// this wrong marks ~130 ordinary techniques as restricted.
	restricted := 0
	for _, rs := range rulesets {
		if rs.IsRestricted {
			restricted++
		}
	}
	if restricted == 0 || restricted == len(rulesets) {
		t.Errorf("is_restricted looks wrong: %d of %d flagged", restricted, len(rulesets))
	}

	all, err := repo.List(ctx, Filter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}

	// Every technique's ruleset reference must resolve, or a detail view
	// silently loses its legality panel.
	known := make(map[string]bool, len(rulesets))
	for _, rs := range rulesets {
		known[rs.ID] = true
	}
	for _, s := range all {
		if s.IBJJFRulesetID != "" && !known[s.IBJJFRulesetID] {
			t.Fatalf("technique %q references unknown ruleset %q", s.ID, s.IBJJFRulesetID)
		}
	}

	// Get resolves the ruleset so a detail view is one request, and carries
	// the prose the list deliberately omits.
	full, err := repo.Get(ctx, all[0].ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if full.IBJJFRulesetID != "" && full.IBJJF == nil {
		t.Error("Get did not resolve the ruleset")
	}

	withProse := 0
	for _, s := range all[:min(50, len(all))] {
		f, err := repo.Get(ctx, s.ID)
		if err != nil {
			t.Fatalf("get %q: %v", s.ID, err)
		}
		if f.WhenToUse != "" {
			withProse++
		}
	}
	if withProse == 0 {
		t.Error("when_to_use is empty across the sample — the enrichment did not land")
	}

	// Searching must find a technique by an alias, not only by its name.
	// "Kesa-Gatame Escape" is known to most people as "scarf hold".
	byAlias, err := repo.List(ctx, Filter{Query: "scarf hold"})
	if err != nil {
		t.Fatalf("alias search: %v", err)
	}
	if len(byAlias) == 0 {
		t.Error("alias search found nothing; search is name-only again")
	}
}
