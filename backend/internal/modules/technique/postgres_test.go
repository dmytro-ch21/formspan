package technique

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
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
	// EXACT counts, not a range. The regression this column exists to prevent —
	// deriving restriction by comparing belt lists, which reads adult no-gi's
	// missing white belt division as a restriction — flags roughly 17 of 25
	// rulesets and ~130 techniques. A "0 < n < all" assertion passes that
	// happily, which makes it worse than no test. These move only when the
	// IBJJF rulebook or the library changes, and both are version-controlled.
	const (
		wantRestrictedRulesets   = 8
		wantRestrictedTechniques = 20
	)
	restricted := 0
	for _, rs := range rulesets {
		if rs.IsRestricted {
			restricted++
		}
	}
	if restricted != wantRestrictedRulesets {
		t.Errorf("restricted rulesets = %d, want %d (belt-count derivation would give ~17)",
			restricted, wantRestrictedRulesets)
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

	restrictedByID := make(map[string]bool, len(rulesets))
	for _, rs := range rulesets {
		restrictedByID[rs.ID] = rs.IsRestricted
	}
	nRestricted := 0
	for _, s := range all {
		if restrictedByID[s.IBJJFRulesetID] {
			nRestricted++
		}
	}
	if nRestricted != wantRestrictedTechniques {
		t.Errorf("techniques under a restricted ruleset = %d, want %d",
			nRestricted, wantRestrictedTechniques)
	}

	// setup_from must name techniques, not carry raw ids. The sheet writes ids;
	// the importer resolves them. Regressing that put snake_case identifiers on
	// 368 of 466 detail screens.
	// One query over ALL 466 rather than repo.Get in a loop over a sample. A
	// sample proves nothing about the rows it skipped, and the property here is
	// meant to be total: NO entry may be a raw id.
	var rawRows int
	if err := repo.pool.QueryRow(ctx, `
		SELECT count(*) FROM techniques
		WHERE EXISTS (SELECT 1 FROM unnest(setup_from) e WHERE e LIKE '%\_%')`,
	).Scan(&rawRows); err != nil {
		t.Fatalf("count raw setup_from: %v", err)
	}
	if rawRows > 0 {
		t.Errorf("%d techniques still carry raw snake_case ids in setup_from; the importer must resolve them", rawRows)
	}

	// Resolution rate stays a sample — it is a data-quality signal, not an
	// invariant, and ~80% is the authored reality rather than a target.
	byName := make(map[string]bool, len(all))
	for _, s := range all {
		byName[strings.ToLower(s.Name)] = true
	}
	resolved, total := 0, 0
	for _, s := range all[:min(80, len(all))] {
		f, err := repo.Get(ctx, s.ID)
		if err != nil {
			t.Fatalf("get %q: %v", s.ID, err)
		}
		for _, e := range f.SetupFrom {
			total++
			if byName[strings.ToLower(e)] {
				resolved++
			}
		}
	}
	if total > 0 && resolved*100/total < 50 {
		t.Errorf("only %d/%d setup_from entries name a technique — the graph is broken", resolved, total)
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

func TestPositionSeedData_IsValid(t *testing.T) {
	positions, err := PositionSeedData()
	if err != nil {
		t.Fatalf("PositionSeedData: %v", err)
	}

	// The glossary exists to cover the positions a beginner meets, so a
	// shrinking set is a content regression rather than a refactor.
	if len(positions) < 10 {
		t.Fatalf("expected the full glossary, got %d entries", len(positions))
	}

	for _, p := range positions {
		if len(p.Description) < 100 || len(p.Priorities) < 100 {
			t.Errorf("position %q has stub prose — the glossary is the feature", p.ID)
		}
	}
}

// The cross-link, checked against the real content and WITHOUT a database.
//
// This is the guard on the one thing that fails silently: `family` is
// prefix-matched against `techniques.position`, so a wrong value seeds fine,
// renders fine, and lists nothing. Three properties of this test matter.
//
// It runs offline. Both sides are embedded JSON, so the property is a pure
// function of two files and needs no Postgres — which means it runs on every
// `go test`, not only where TEST_DATABASE_URL happens to be set. The
// integration test below still covers round-trip fidelity; this covers the
// content, and the content is what changes.
//
// It is not circular. Asserting `validFamilies[p.Family]` would only restate
// what validatePositions already enforces, and could never catch the likelier
// mistake — someone "fixing" the set by adding "Back Control" to BOTH the map
// and the JSON, at which point validator and test agree and the app is broken.
// Matching against the actual technique rows is the only check that survives
// that, and it subsumes the hardcoded back-control assertion this replaced.
func TestPositionsResolveAgainstTheLibrary(t *testing.T) {
	positions, err := PositionSeedData()
	if err != nil {
		t.Fatalf("PositionSeedData: %v", err)
	}
	techniques, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}

	// The clients' own rule, restated here on purpose: if it drifts from
	// apps/mobile/lib/positions.ts, this test should be what notices.
	inFamily := func(position, family string) bool {
		return position == family || strings.HasPrefix(position, family+" - ")
	}

	// The detail filters, applied exactly as the client does.
	inScope := func(p Position, detail string) bool {
		if len(p.DetailIncludes) > 0 && !slices.Contains(p.DetailIncludes, detail) {
			return false
		}
		return !slices.Contains(p.DetailExcludes, detail)
	}

	// Every detail a position names must exist in the library. This is the
	// `family` trap one level down and it fails the same silent way: a typo in
	// detail_includes empties the list rather than erroring, and closed guard —
	// the entry most likely to be opened first — is the one that uses it.
	details := make(map[string]bool, len(techniques))
	for _, tq := range techniques {
		details[tq.PositionDetail] = true
	}

	covered := make(map[string]bool)
	for _, p := range positions {
		for _, d := range slices.Concat(p.DetailIncludes, p.DetailExcludes) {
			if !details[d] {
				t.Errorf("position %q names position_detail %q, which no technique has", p.ID, d)
			}
		}

		matches := 0
		for _, tq := range techniques {
			if inFamily(tq.Position, p.Family) {
				// Coverage is tracked on the FAMILY match, not the narrowed
				// one: a detail deliberately excluded from open guard is still
				// explained by closed guard, so it is not an orphan.
				covered[tq.Position] = true
				if inScope(p, tq.PositionDetail) {
					matches++
				}
			}
		}
		if matches == 0 {
			t.Errorf("position %q (family %q) matches no technique — its cross-link is dead",
				p.ID, p.Family)
		}
	}

	// The whole point of the detail filters. EXACT counts, not "these differ" —
	// the weaker assertion passes on the very regression this guards:
	// deleting closed-guard's detail_includes puts it back on the whole
	// 187-technique family while open-guard stays at 150, so the two are still
	// unequal and nothing fails. Same lesson, and the same fix, as the pinned
	// wantRestrictedRulesets above.
	//
	// The guard family is 187. The split is 37 closed ("Closed Guard" plus
	// "Rubber Guard") and 150 open (the rest), and 37+150 == 187 is the check
	// that the two partition the family rather than merely differing.
	const (
		wantClosedGuard = 37
		wantOpenGuard   = 150
	)
	scoped := func(id string) int {
		n := 0
		for _, p := range positions {
			if p.ID != id {
				continue
			}
			for _, tq := range techniques {
				if inFamily(tq.Position, p.Family) && inScope(p, tq.PositionDetail) {
					n++
				}
			}
		}
		return n
	}
	closed, open := scoped("closed-guard"), scoped("open-guard")
	if closed != wantClosedGuard {
		t.Errorf("closed guard resolves to %d techniques, want %d", closed, wantClosedGuard)
	}
	if open != wantOpenGuard {
		t.Errorf("open guard resolves to %d techniques, want %d", open, wantOpenGuard)
	}

	family := 0
	for _, tq := range techniques {
		if inFamily(tq.Position, "Guard") {
			family++
		}
	}
	if closed+open != family {
		t.Errorf("the two guards cover %d of the family's %d — they must partition it",
			closed+open, family)
	}

	// The reverse direction. A technique position with no glossary entry behind
	// it means the Library offers a filter family the glossary cannot explain.
	// "Other" is the one genuine orphan in the current library (1 of 466) and is
	// not a position anyone would look up.
	for _, tq := range techniques {
		if tq.Position != "Other" && !covered[tq.Position] {
			t.Errorf("technique position %q has no glossary entry behind it", tq.Position)
		}
	}
}

func TestValidatePositions_RejectsBadContent(t *testing.T) {
	ok := Position{ID: "a", Name: "A", Family: "Guard", Description: "d", Priorities: "p"}
	mutate := func(f func(*Position)) []Position {
		p := ok
		f(&p)
		return []Position{p}
	}

	cases := []struct {
		name string
		in   []Position
	}{
		{"duplicate id", []Position{ok, ok}},
		{"missing id", mutate(func(p *Position) { p.ID = "" })},
		{"missing name", mutate(func(p *Position) { p.Name = "" })},
		{"unknown family", mutate(func(p *Position) { p.Family = "Back Control" })},
		{"missing description", mutate(func(p *Position) { p.Description = "" })},
		{"missing priorities", mutate(func(p *Position) { p.Priorities = "" })},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validatePositions(tc.in); err == nil {
				t.Fatal("expected a validation error, got nil")
			}
		})
	}
}

func TestPostgresRepository_SeedPositionsAndGet(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	n, err := SeedPositions(ctx, repo)
	if err != nil {
		t.Fatalf("seed positions: %v", err)
	}

	all, err := repo.Positions(ctx)
	if err != nil {
		t.Fatalf("positions: %v", err)
	}
	if len(all) != n {
		t.Errorf("seeded %d but listed %d", n, len(all))
	}

	// The reading order is the product decision — alphabetical would open the
	// glossary on Back Control, which is the last thing a beginner needs.
	for i := 1; i < len(all); i++ {
		if all[i].OrderIndex < all[i-1].OrderIndex {
			t.Fatalf("positions came back out of order: %q(%d) after %q(%d)",
				all[i].ID, all[i].OrderIndex, all[i-1].ID, all[i-1].OrderIndex)
		}
	}

	// Seeding runs on every deploy, so an unchanged entry must be a true no-op.
	before, err := repo.GetPosition(ctx, all[0].ID)
	if err != nil {
		t.Fatalf("get before: %v", err)
	}
	if _, err := SeedPositions(ctx, repo); err != nil {
		t.Fatalf("re-seed: %v", err)
	}
	after, err := repo.GetPosition(ctx, before.ID)
	if err != nil {
		t.Fatalf("get after: %v", err)
	}
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Error("updated_at moved on a no-op re-seed")
	}

	missing, err := repo.GetPosition(ctx, "no-such-position")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
	if missing != nil {
		t.Errorf("expected nil alongside the error, got %+v", missing)
	}
}
