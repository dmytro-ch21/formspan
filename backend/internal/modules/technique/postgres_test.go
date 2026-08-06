package technique

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

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
		// The column has no CHECK, so this validator is the ONLY thing between
		// a typo and a value no client can render. Without a case here,
		// replacing the guard with `case false:` leaves the whole suite green.
		// to_position's guard is likewise the ONLY thing between a typo and an
		// edge that resolves to nothing on every traversal. Replacing it with
		// `case false:` leaves the whole suite green without this case — the
		// exact gap the comment above describes, one column over.
		{"unknown to_position", []Technique{
			{ID: "a", Name: "A", Category: "Sweep", Position: "Guard - Bottom",
				GiNoGi: "Both", ToPosition: "Side Control"},
		}},
		{"unknown function", []Technique{
			{ID: "a", Name: "A", Category: "Sweep", Position: "Guard - Bottom",
				GiNoGi: "Both", Function: "submit"},
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
	// this wrong marks 441 perfectly ordinary techniques as restricted.
	// EXACT counts, not a range. The regression this column exists to prevent —
	// deriving restriction by comparing belt lists, which reads adult no-gi's
	// missing white belt division as a restriction — flags 21 of 25
	// rulesets and 468 techniques. A "0 < n < all" assertion passes that
	// happily, which makes it worse than no test. These move only when the
	// IBJJF rulebook or the library changes, and both are version-controlled.
	// wantRestrictedTechniques was 20 until the 2026-08 curriculum gap-fill
	// added seven rows referencing restricted rulesets: the can-opener neck
	// crank (prohibited), the Suloev stretch, toe hold from 50/50, kneebar
	// from guard top and banana split (brown/black), heel hook defense
	// (brown/black no-gi), and wrist lock from closed guard (blue+).
	const (
		wantRestrictedRulesets   = 8
		wantRestrictedTechniques = 27
	)
	restricted := 0
	for _, rs := range rulesets {
		if rs.IsRestricted {
			restricted++
		}
	}
	if restricted != wantRestrictedRulesets {
		t.Errorf("restricted rulesets = %d, want %d (belt-count derivation would give 21)",
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
	// 368 of the 466 detail screens the library then had.
	// One query over ALL 542 rather than repo.Get in a loop over a sample. A
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
	// invariant, and ~84% is the authored reality rather than a target.
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
	// 161-technique family while open-guard stays at 124, so the two are still
	// unequal and nothing fails. Same lesson, and the same fix, as the pinned
	// wantRestrictedRulesets above.
	//
	// The guard family is 185. The split is 47 closed ("Closed Guard" plus
	// "Rubber Guard") and 138 open (the rest), and 47+138 == 185 is the check
	// that the two partition the family rather than merely differing.
	//
	// It was 187/150 until the leg entanglements were promoted out of it. The
	// 26 ashi garami entries — saddle, 50/50, backside 50/50, single-leg X —
	// used to be filed as "Guard - Bottom" and therefore resolved as open
	// guard, which put a heel hook from the saddle on the same screen as a
	// spider-guard sweep. They are their own position now, so the family they
	// left is smaller by exactly that many. Then 37/124 until the curriculum
	// gap-fill of 2026-08 added 10 closed-guard rows (gogoplata, americana,
	// wrist lock, reverse triangle, bow-and-arrow, kimura sweep, the
	// can-opener, the rubber guard matrix, and the two no-gi overhook-family
	// controls) and 14 open. If this number moves again without a position
	// being added or removed, something has drifted rather than been decided.
	const (
		wantClosedGuard = 47
		wantOpenGuard   = 138
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
	// "Other" is the one genuine orphan in the current library (3 of 542 —
	// the technical stand-up and two solo drills) and is not a position
	// anyone would look up.
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

// Every technique carries a function, and the four that do not are the four
// that should not.
//
// This runs offline against the embedded JSON, because the property is about
// the seed data rather than the database. The count is pinned deliberately:
// an entry added later with no `function` is almost certainly an oversight,
// and the failure should make someone say so out loud rather than let the
// library quietly grow a second population of unclassified rows. If a genuine
// new fundamental is added, update the number and the list together.
func TestEveryTechniqueHasAFunctionExceptTheFundamentals(t *testing.T) {
	techniques, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}

	// Movement fundamentals: library content that is not a technique, so it
	// has no noun and no verb. Asserting one would make the taxonomy lie.
	// The last four are the solo drills added by the 2026-08 curriculum
	// gap-fill; they join this set for the same reason the breakfalls did.
	wantBlank := map[string]bool{
		"Grappling Stance and Motion": true,
		"Backward Breakfall":          true,
		"Side Breakfall":              true,
		"Forward Shoulder Roll":       true,
		"Alligator Walk":              true,
		"Backward Roll":               true,
		"Bridge Drill (Upa)":          true,
		"Penetration Step":            true,
	}

	var blank []string
	for _, tq := range techniques {
		if tq.Function == "" {
			blank = append(blank, tq.Name)
		}
		// Deliberately no "is it one of the five" assertion here: SeedData()
		// runs validate(), which has already failed the test above if any
		// value were invalid. TestValidate_RejectsBadContent covers that
		// property where it can actually fail.
	}

	if len(blank) != len(wantBlank) {
		t.Fatalf("%d techniques have no function, want %d: %v", len(blank), len(wantBlank), blank)
	}
	for _, name := range blank {
		if !wantBlank[name] {
			t.Errorf("%q has no function but is not a known movement fundamental", name)
		}
	}
}

// The leg entanglements are their own noun, not a kind of guard.
//
// A heel hook from the saddle used to be filed under the same position as a
// closed-guard armbar, because the coarse axis only had "Guard - Bottom".
// That is wrong for the position graph every deferred BJJ feature reads: the
// saddle is not closed guard, and "where do I keep getting stuck" cannot
// answer honestly if the two collapse.
//
// The guard against over-reach is the interesting half. "Judo Ashi-waza" is
// foot sweeps and "Single-Leg Defense"/"Single-Leg Finish" are takedown work
// — all three read as leg-adjacent and none is an ashi garami. Matching is
// exact for that reason.
func TestLegEntanglementsAreTheirOwnPosition(t *testing.T) {
	techniques, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}

	entangled := map[string]bool{
		"Leg Entanglement": true, "50/50": true,
		"Backside 50/50": true, "Single-Leg X": true,
	}
	decoy := map[string]bool{
		"Judo Ashi-waza": true, "Single-Leg Defense": true, "Single-Leg Finish": true,
	}

	var n int
	for _, tq := range techniques {
		switch {
		case entangled[tq.PositionDetail]:
			n++
			if tq.Position != "Leg Entanglement" {
				t.Errorf("%q is %q but sits at position %q", tq.ID, tq.PositionDetail, tq.Position)
			}
		case decoy[tq.PositionDetail]:
			if tq.Position == "Leg Entanglement" {
				t.Errorf("%q (%q) was swept into Leg Entanglement; it is not an ashi garami",
					tq.ID, tq.PositionDetail)
			}
		case tq.Position == "Leg Entanglement":
			t.Errorf("%q sits at Leg Entanglement on detail %q, which is not one of the four",
				tq.ID, tq.PositionDetail)
		}
	}
	if n == 0 {
		t.Fatal("no leg entanglements found at all — the detail values must have been renamed")
	}

	// And the glossary has a node for the new noun, or the position screen is
	// a family with no entry and the techniques resolve to nothing.
	positions, err := PositionSeedData()
	if err != nil {
		t.Fatalf("PositionSeedData: %v", err)
	}
	var found bool
	for _, p := range positions {
		if p.Family == "Leg Entanglement" {
			found = true
		}
	}
	if !found {
		t.Error("no position entry claims the Leg Entanglement family")
	}
}

// A function-only change must actually reach the database.
//
// This is the `completed`-flag failure mode, which this project has already
// shipped once: a column written by the upsert but absent from the
// `IS DISTINCT FROM` tuple that decides whether the row updates at all. The
// SET clause looks right, the seed logs "542 upserted", and the value never
// lands — with nothing failing anywhere.
//
// It is not hypothetical here. Removing `function` from the two tuple sides
// (while leaving the SET clause) leaves the entire technique suite green and
// writes zero functions on the upgrade path this simulates. So the test has
// to exercise the upgrade specifically: rows that already exist, with the
// column NULL, which is exactly what a deploy of migration 000028 produces
// against a database seeded before it.
func TestReseedPopulatesFunctionOnRowsThatPredateTheColumn(t *testing.T) {
	repo := newTestRepo(t)
	pool := repo.pool
	ctx := context.Background()

	techniques, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}
	if err := repo.UpsertAll(ctx, techniques); err != nil {
		t.Fatalf("first seed: %v", err)
	}

	// Rewind to the state migration 000028 leaves behind: every row present,
	// every function NULL.
	//
	// NOTE: this and the counts below assume this package owns every row in
	// `techniques`. That holds only because the suite runs with `-p 1` — see
	// ci.yml. Scoping each assertion instead was tried and abandoned: there are
	// seven of them across this file, fixing one left the other six flaking,
	// and every future assertion would have to remember.
	if _, err := pool.Exec(ctx,
		`UPDATE techniques SET function = NULL, updated_at = now() - interval '1 day'`,
	); err != nil {
		t.Fatalf("rewind: %v", err)
	}

	var before time.Time
	if err := pool.QueryRow(ctx,
		`SELECT max(updated_at) FROM techniques`).Scan(&before); err != nil {
		t.Fatalf("read updated_at: %v", err)
	}

	if err := repo.UpsertAll(ctx, techniques); err != nil {
		t.Fatalf("re-seed: %v", err)
	}

	var populated, blank int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE function IS NOT NULL),
		       count(*) FILTER (WHERE function IS NULL)
		FROM techniques`).Scan(&populated, &blank); err != nil {
		t.Fatalf("count: %v", err)
	}

	var want int
	for _, tq := range techniques {
		if tq.Function != "" {
			want++
		}
	}
	if populated != want {
		t.Fatalf("re-seed populated %d functions, want %d — the change-detection "+
			"tuple is not seeing `function`, so the update is a silent no-op",
			populated, want)
	}
	if blank != len(techniques)-want {
		t.Errorf("%d rows left NULL, want %d", blank, len(techniques)-want)
	}

	// And the clients have to be able to notice: a delta sync keyed on
	// updated_at learns nothing from a row whose timestamp did not move.
	var after time.Time
	if err := pool.QueryRow(ctx,
		`SELECT max(updated_at) FROM techniques`).Scan(&after); err != nil {
		t.Fatalf("read updated_at: %v", err)
	}
	if !after.After(before) {
		t.Error("updated_at did not move, so no delta-syncing client would ever refetch")
	}
}

// to_position is sparse on purpose, and every value must name a real position.
//
// The sparseness is the point: it is authored, not derived (see migration
// 000029 for the two measurements), so a NULL means "not recorded" and is
// honest. What must never happen is a value naming a position that does not
// exist — "Side Control" instead of "Side Control - Top" — because that edge
// then resolves to nothing on every traversal and NOTHING reports a fault.
// The seed validator is the only guard; this is the test that it works.
//
// The count is pinned so coverage can only rise. If it falls, authored data
// was lost rather than a decision being made.
func TestToPositionNamesRealPositionsAndOnlyGrows(t *testing.T) {
	techniques, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}

	var populated, selfLoops int
	for _, tq := range techniques {
		if tq.ToPosition == "" {
			continue
		}
		populated++
		// Deliberately NO "is it a real position" assertion here: SeedData()
		// has already run validate() over this same slice, so `positions`
		// below is built from the very data that check would test and can
		// never disagree. TestValidate_RejectsBadContent covers that property
		// where it can actually fail.
		if tq.ToPosition == tq.Position {
			selfLoops++
		}
	}

	// Raised 149 -> 170 with the 2026-08 curriculum gap-fill. This is a
	// ratchet: it only ever goes up, and lowering it to make a red suite green
	// is the failure it exists to catch.
	const wantAtLeast = 170
	if populated < wantAtLeast {
		t.Fatalf("only %d techniques have a destination, want at least %d — authored data was lost",
			populated, wantAtLeast)
	}

	// Self-loops are meaningful, not a bug: a guard BREAK leaves you in
	// guard-top having not yet passed, and a single-leg entry leaves you
	// standing having not yet finished. Recording "stays put" as a fact is
	// what lets NULL mean "not recorded" without ambiguity.
	if selfLoops == 0 {
		t.Error("no self-loops at all — 'stays put' should be recorded, not left NULL")
	}

	// The transitions must actually cross positions, or the column is just a
	// copy of `position` and answers nothing.
	// A ratchet too, same rule as wantAtLeast: 162 today, and it only rises.
	if populated-selfLoops < 162 {
		t.Errorf("only %d real position changes recorded", populated-selfLoops)
	}
}

// A to_position-only change must actually reach the database.
//
// The analogue of TestReseedPopulatesFunctionOnRowsThatPredateTheColumn, and
// added for the same reason: the `IS DISTINCT FROM` tuple decides whether the
// row updates at all, and a column missing from it is written by the SET
// clause that never runs. The seed logs "542 upserted" and nothing lands.
//
// Review proved this is not hypothetical here — removing to_position from the
// two tuple sides leaves the entire technique suite green while writing zero
// destinations on the upgrade path deploying 000029 produces. That is the
// third time this project has met this shape.
func TestReseedPopulatesToPositionOnRowsThatPredateTheColumn(t *testing.T) {
	repo := newTestRepo(t)
	pool := repo.pool
	ctx := context.Background()

	techniques, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}
	if err := repo.UpsertAll(ctx, techniques); err != nil {
		t.Fatalf("first seed: %v", err)
	}

	// Exactly what migration 000029 leaves behind: every row present, every
	// destination NULL.
	if _, err := pool.Exec(ctx,
		`UPDATE techniques SET to_position = NULL, updated_at = now() - interval '1 day'`,
	); err != nil {
		t.Fatalf("rewind: %v", err)
	}
	var before time.Time
	if err := pool.QueryRow(ctx, `SELECT max(updated_at) FROM techniques`).Scan(&before); err != nil {
		t.Fatalf("read updated_at: %v", err)
	}

	if err := repo.UpsertAll(ctx, techniques); err != nil {
		t.Fatalf("re-seed: %v", err)
	}

	var want int
	for _, tq := range techniques {
		if tq.ToPosition != "" {
			want++
		}
	}
	var got int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM techniques WHERE to_position IS NOT NULL`).Scan(&got); err != nil {
		t.Fatalf("count: %v", err)
	}
	if got != want {
		t.Fatalf("re-seed wrote %d destinations, want %d — the change-detection tuple "+
			"is not seeing `to_position`, so the update is a silent no-op", got, want)
	}

	var after time.Time
	if err := pool.QueryRow(ctx, `SELECT max(updated_at) FROM techniques`).Scan(&after); err != nil {
		t.Fatalf("read updated_at: %v", err)
	}
	if !after.After(before) {
		t.Error("updated_at did not move, so no delta-syncing client would ever refetch")
	}
}

// `setup_from` must be on the SUMMARY, not just the detail row.
//
// It is what makes the library a traversable graph: the client inverts it
// once over the cached list to answer "what follows from here". Detail-only,
// that costs one request per technique to walk a single hop, and
// `lib/techniqueGraph.ts` could not exist.
//
// Added post-merge, because a review found that deleting `t.setup_from` from
// `summaryColumns` and `&s.SetupFrom` from `scanSummary` — reverting the
// whole change that put it there — left this entire suite GREEN. Every other
// SetupFrom assertion in this file reaches it through `Get` (the detail path)
// or a direct pool query. None read it off a Summary.
//
// The nil check is the sharp half. `SetupFrom` has no `omitempty`, so a nil
// slice marshals to `"setup_from": null` — which violates the `required` +
// `type: array` contract, and reaches the client as a null where it expects
// an array. Silent server-side, loud in the app.
func TestSummaryCarriesTheGraphEdge(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	seed, err := SeedData()
	if err != nil {
		t.Fatalf("SeedData: %v", err)
	}
	if err := repo.UpsertAll(ctx, seed); err != nil {
		t.Fatalf("seed: %v", err)
	}

	list, err := repo.List(ctx, Filter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) < 400 {
		t.Fatalf("listed %d techniques, expected the whole library", len(list))
	}

	var withEdges int
	for _, s := range list {
		// Never nil, even for the entries that genuinely have no edges: the
		// column is NOT NULL DEFAULT '{}', and pgx decodes that to an empty
		// non-nil slice. A nil here means the column left the summary.
		if s.SetupFrom == nil {
			t.Fatalf("%q has a nil setup_from on the summary — it marshals to "+
				"null, violating the contract's required array", s.ID)
		}
		if len(s.SetupFrom) > 0 {
			withEdges++
		}
	}

	// Pinned low against ordinary library growth, high enough that a summary
	// silently losing the column cannot pass.
	if withEdges < 300 {
		t.Errorf("only %d of %d summaries carry graph edges", withEdges, len(list))
	}
}
