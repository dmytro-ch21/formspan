package food

import (
	"context"
	"os"
	"testing"

	"github.com/dmytro-ch21/vola/backend/internal/platform/database"
)

func newTestRepo(t *testing.T) *PostgresRepository {
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
	// Registered before any cleanup that still needs the pool open —
	// t.Cleanup runs LIFO, so this closes last.
	t.Cleanup(pool.Close)

	return NewPostgresRepository(pool)
}

// fixtureIDs are namespaced, and they KEEP the original name as the suffix.
//
// `fd-fx-zucchini`, not `fd_fx_zuc`. Some assertions here depend on the ids'
// relative LEXICAL order — the paging test can only fail if the order it pages
// through is one a sort would change — and that dependency is invisible at the
// call site. `session`'s rename inverted such a pair once and silently
// disarmed two tests; review caught it, the suite did not.
//
// Note the separator swap from `-` to `_` is only order-preserving because
// each suffix is otherwise verbatim: `-` (0x2D) < `0` < `_` (0x5F), so a
// respelling is NOT order-preserving in general.
type fixture struct {
	id, name, category, market string
	aliases                    []string
	kcal                       float64
}

// EVERY shared fixture is seeded at the SAME rank_tier, and that is deliberate
// rather than incidental.
//
// N88 made rank_tier the primary sort key, which means a single tier-0 fixture
// in this list would rank first for its query and the assertions below would
// pass because of the tier instead of because of the signal they were written
// to test. TestSearchRanksThePlainRowAboveTheDecoy would still be green with
// the lead-position rule deleted.
//
// The curated-versus-bulk behaviour is tested in
// TestSearchRanksACuratedRowAboveTheBulkImport, which seeds its own rows.
const sharedFixtureTier = 1

var searchFixtures = []fixture{
	// The word-order case: every typed word is present, in order, and a
	// contiguous match still fails because USDA puts commas between them.
	{"fd-fx-chicken-breast", "Chicken, broiler or fryers, breast, skinless, meat only, raw", "poultry", "us", nil, 120},
	// The decoy — contains "chicken" and "breast" too, but is not what
	// somebody typing "chicken breast" means.
	{"fd-fx-chicken-breast-lunchmeat", "Lunchmeat, chicken breast, sliced, prepackaged", "poultry", "us", nil, 89},
	// The alias case: nobody types "Squash, summer, zucchini".
	{"fd-fx-zucchini", "Squash, summer, zucchini, includes skin, raw", "vegetable", "us", []string{"courgette"}, 17},
	// A second market, so market coverage is a real distinction here and not
	// a constant.
	{"fd-fx-skyr", "Skyr, plain", "dairy", "is", nil, 63},
}

func seedFixtures(t *testing.T, repo *PostgresRepository) context.Context {
	t.Helper()
	ctx := context.Background()

	for _, f := range searchFixtures {
		aliases := f.aliases
		if aliases == nil {
			aliases = []string{}
		}
		// Every column any test reads is set EXPLICITLY, never defaulted, and
		// the ON CONFLICT reconciles all of them so an interrupted run's
		// leftover row is repaired rather than trusted.
		_, err := repo.pool.Exec(ctx, `
			INSERT INTO food_catalog (
				id, name, brand, category, aliases, serving_label, serving_grams,
				kcal, protein_g, carb_g, fat_g, fibre_g, market, rank_tier, source,
				external_id, external_source)
			VALUES ($1, $2, '', $3, $4, '100 g', 100, $5, 1, 1, 1, 0, $6, $7, 'seed', NULL, NULL)
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name, brand = EXCLUDED.brand,
				category = EXCLUDED.category, aliases = EXCLUDED.aliases,
				serving_label = EXCLUDED.serving_label, serving_grams = EXCLUDED.serving_grams,
				kcal = EXCLUDED.kcal, protein_g = EXCLUDED.protein_g,
				carb_g = EXCLUDED.carb_g, fat_g = EXCLUDED.fat_g,
				fibre_g = EXCLUDED.fibre_g, market = EXCLUDED.market,
				rank_tier = EXCLUDED.rank_tier,
				source = EXCLUDED.source, external_id = EXCLUDED.external_id,
				external_source = EXCLUDED.external_source`,
			f.id, f.name, f.category, aliases, f.kcal, f.market, sharedFixtureTier)
		if err != nil {
			t.Fatalf("seed %s: %v", f.id, err)
		}
	}

	t.Cleanup(func() {
		for _, f := range searchFixtures {
			if _, err := repo.pool.Exec(context.Background(),
				`DELETE FROM food_catalog WHERE id = $1`, f.id); err != nil {
				// Errorf, not Logf: a cleanup that silently fails leaves rows
				// behind that other packages' global counts would then include.
				t.Errorf("cleanup %s: %v", f.id, err)
			}
		}
	})
	return ctx
}

// The reported-missing case, in the food catalog's own vocabulary. Every word
// is present and in order, and a contiguous ILIKE still finds nothing.
func TestSearchFindsAFoodByWordsOutOfContiguousOrder(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedFixtures(t, repo)

	got, _, err := repo.Search(ctx, SearchFilter{Query: "chicken breast", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 {
		t.Fatal("'chicken breast' returned NOTHING — the food is in the catalog")
	}
	// Ranking, not just matching: the decoy contains both words too, and the
	// plain row has to come first.
	if got[0].ID != "fd-fx-chicken-breast" {
		t.Errorf("'chicken breast' ranked %q first, want the plain breast row", got[0].ID)
	}
}

// A synonym must reach BOTH the WHERE and the ORDER. Nobody outside North
// America types "zucchini".
func TestSearchFindsAFoodThroughAGeneralSynonym(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedFixtures(t, repo)

	got, _, err := repo.Search(ctx, SearchFilter{Query: "courgette", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 {
		t.Fatal("'courgette' returned nothing — no fuzzy matching bridges courgette and zucchini, only a synonym does")
	}
	if got[0].ID != "fd-fx-zucchini" {
		t.Errorf("'courgette' found %q", got[0].ID)
	}
}

// The per-row alias column, as distinct from the general synonym list.
func TestSearchMatchesARowAlias(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedFixtures(t, repo)

	got, _, err := repo.Search(ctx, SearchFilter{Query: "courgette", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range got {
		if f.ID == "fd-fx-zucchini" {
			found = true
		}
	}
	if !found {
		t.Fatal("alias column did not match")
	}
}

// A single stray "%" must not return the catalog. The exercise search
// regressed exactly this way and handed back all 762 rows.
func TestSearchRefusesATokenlessQuery(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedFixtures(t, repo)

	got, total, err := repo.Search(ctx, SearchFilter{Query: "%", Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 || total != 0 {
		t.Fatalf("a one-character punctuation query returned %d rows (total %d) — it must return none, not everything", len(got), total)
	}
}

// **The provenance rule.** A console edit takes ownership; a deploy must never
// revert it. This is the guard that, if dropped, silently reverts every
// human's edit on the next deploy.
func TestSeedUpsertDoesNotRevertAnAdminEdit(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	const id = "fd-fx-provenance"
	t.Cleanup(func() {
		if _, err := repo.pool.Exec(context.Background(),
			`DELETE FROM food_catalog WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	})

	seeded := Food{
		ID: id, Name: "Seeded name", Category: "dairy", Market: "us",
		ServingLabel: "100 g", KCal: 100, Source: SourceSeed, Aliases: []string{},
	}
	if err := repo.UpsertAll(ctx, []Food{seeded}); err != nil {
		t.Fatal(err)
	}

	// A human edits it in the console, which sets source='admin'.
	if _, err := repo.pool.Exec(ctx,
		`UPDATE food_catalog SET name = 'Human name', source = 'admin' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}

	// The next deploy runs the same upsert with the seed content.
	seeded.Name = "Seeded name v2"
	if err := repo.UpsertAll(ctx, []Food{seeded}); err != nil {
		t.Fatal(err)
	}

	got, err := repo.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Human name" {
		t.Fatalf("name = %q, want %q — the deploy reverted a console edit", got.Name, "Human name")
	}
	if got.Source != SourceAdmin {
		t.Fatalf("source = %q, want admin — the deploy took ownership back", got.Source)
	}
}

// The other half: a row nobody has touched MUST still receive deploy
// corrections, or the guard above would be indistinguishable from a broken
// upsert.
func TestSeedUpsertStillUpdatesASeededRow(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	const id = "fd-fx-seeded-update"
	t.Cleanup(func() {
		if _, err := repo.pool.Exec(context.Background(),
			`DELETE FROM food_catalog WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	})

	f := Food{
		ID: id, Name: "Before", Category: "dairy", Market: "us",
		ServingLabel: "100 g", KCal: 100, Source: SourceSeed, Aliases: []string{},
	}
	if err := repo.UpsertAll(ctx, []Food{f}); err != nil {
		t.Fatal(err)
	}
	f.Name = "After"
	f.KCal = 111
	if err := repo.UpsertAll(ctx, []Food{f}); err != nil {
		t.Fatal(err)
	}
	got, err := repo.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "After" || got.KCal != 111 {
		t.Fatalf("seeded row not updated: name=%q kcal=%v", got.Name, got.KCal)
	}
}

// Paging over a non-deterministic sort repeats rows on one page and skips them
// on the next. similarity() ties constantly across similar names, so the id
// tie-break is what makes this hold.
func TestSearchPagesWithoutRepeatingOrSkipping(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedFixtures(t, repo)

	seen := map[string]bool{}
	for offset := 0; offset < 4; offset++ {
		page, _, err := repo.Search(ctx, SearchFilter{
			Query: "raw", Limit: 1, Offset: offset,
		})
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range page {
			if seen[f.ID] {
				t.Fatalf("row %q appeared on two pages — the sort is not total", f.ID)
			}
			seen[f.ID] = true
		}
	}
}

// Total is what lets a client say "showing 1 of 3" instead of implying it has
// everything.
func TestSearchReportsTotalBeyondThePage(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedFixtures(t, repo)

	page, total, err := repo.Search(ctx, SearchFilter{Query: "raw", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 1 {
		t.Fatalf("page size = %d, want 1", len(page))
	}
	if total < 2 {
		t.Fatalf("total = %d, want the full match count, not the page size", total)
	}
}

func TestCountMarketSeparatesCoveredFromUncovered(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedFixtures(t, repo)

	us, err := repo.CountMarket(ctx, "us")
	if err != nil {
		t.Fatal(err)
	}
	if us == 0 {
		t.Fatal("no rows for market 'us', which the fixtures seed")
	}
	none, err := repo.CountMarket(ctx, "zz")
	if err != nil {
		t.Fatal(err)
	}
	if none != 0 {
		t.Fatalf("market 'zz' has %d rows, want 0", none)
	}
}

func TestCoverageCountsWhatIsActuallyThere(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedFixtures(t, repo)

	cov, err := repo.Coverage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cov.Foods < len(searchFixtures) {
		t.Fatalf("coverage counted %d foods, fewer than the %d fixtures seeded", cov.Foods, len(searchFixtures))
	}
	// The category breakdown is what lets an empty result say "we hold 24
	// vegetables" rather than leaving the shape of the catalog to be guessed.
	if len(cov.Categories) == 0 {
		t.Fatal("coverage reported no categories")
	}
	sum := 0
	for _, c := range cov.Categories {
		sum += c.Foods
	}
	if sum != cov.Foods {
		t.Fatalf("category counts sum to %d but total is %d", sum, cov.Foods)
	}
	if len(cov.Markets) == 0 {
		t.Fatal("coverage reported no markets — the region answer would be unanswerable")
	}
}

func TestBarcodeCacheRoundTrips(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	const barcode = "5690550000001"
	t.Cleanup(func() {
		if _, err := repo.pool.Exec(context.Background(),
			`DELETE FROM food_barcode_cache WHERE barcode = $1`, barcode); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	})

	if _, _, err := repo.LookupBarcode(ctx, barcode); err == nil {
		t.Fatal("an unseen barcode was found in the cache")
	}

	fibre := 0.5
	// N117: PacketServingLabel/PacketServingGrams set too, alongside the
	// unchanged ServingLabel/ServingGrams, so the round trip proves BOTH
	// pairs survive the real schema — not just the four columns this test
	// already covered before this ticket.
	packetLabel := "2 pieces (25 g)"
	packetGrams := 25.0
	in := BarcodeFood{
		Name: "Skyr, plain", Brand: "Siggi's", ServingLabel: "100 g",
		PacketServingLabel: &packetLabel, PacketServingGrams: &packetGrams,
		KCal: 63, ProteinG: 11, CarbG: 4, FatG: 0.2, FibreG: &fibre,
	}
	if err := repo.CacheBarcode(ctx, barcode, in, OpenFoodFactsProvider); err != nil {
		t.Fatal(err)
	}
	got, provider, err := repo.LookupBarcode(ctx, barcode)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != in.Name || got.KCal != in.KCal {
		t.Fatalf("cached food = %+v, want %+v", got, in)
	}
	if got.PacketServingLabel == nil || *got.PacketServingLabel != packetLabel {
		t.Fatalf("packet serving label = %v, want %q", got.PacketServingLabel, packetLabel)
	}
	if got.PacketServingGrams == nil || *got.PacketServingGrams != packetGrams {
		t.Fatalf("packet serving grams = %v, want %v", got.PacketServingGrams, packetGrams)
	}
	if provider != OpenFoodFactsProvider {
		t.Fatalf("provider = %q — ODbL attribution depends on it", provider)
	}
}

// The real seed file, against the real schema. Catches a value that passes
// Go-side validation and still violates a CHECK — the class of failure that
// otherwise appears first in a deploy.
//
// **Cleans up after itself**, per the rule the exercise package learned the
// hard way: leaving 173 rows behind would make every later package's global
// count include them.
func TestSeedWritesTheRealCatalog(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	foods, err := SeedData()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ids := make([]string, 0, len(foods))
		for _, f := range foods {
			ids = append(ids, f.ID)
		}
		if _, err := repo.pool.Exec(context.Background(),
			`DELETE FROM food_catalog WHERE id = ANY($1)`, ids); err != nil {
			t.Errorf("cleanup: %v", err)
			return
		}
		// VERIFIED, not assumed. A cleanup that quietly failed would restore
		// the crutch this rule exists to remove, and nothing would go red.
		var left int
		if err := repo.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM food_catalog WHERE id = ANY($1)`, ids).Scan(&left); err != nil {
			t.Errorf("cleanup verify: %v", err)
			return
		}
		if left != 0 {
			t.Errorf("%d seeded rows survived cleanup", left)
		}
	})

	n, err := Seed(ctx, repo)
	if err != nil {
		t.Fatalf("seeding the real catalog failed: %v", err)
	}
	if n != len(foods) {
		t.Fatalf("seeded %d, want %d", n, len(foods))
	}

	// Idempotent — a deploy runs this every time.
	if _, err := Seed(ctx, repo); err != nil {
		t.Fatalf("re-seeding failed, so this is not safe to run on every deploy: %v", err)
	}

	got, err := repo.Get(ctx, "chicken-breast")
	if err != nil {
		t.Fatalf("chicken-breast not in the seeded catalog: %v", err)
	}
	if got.KCal <= 0 {
		t.Fatalf("chicken-breast has kcal %v", got.KCal)
	}
	if got.ExternalID == nil || *got.ExternalID == "" {
		t.Fatal("seeded row carries no external_id — its numbers cannot be checked against USDA")
	}
}

// The browse path (no `q`) sorts by name, and `name` carries no uniqueness
// constraint — two brands of the same yogurt is the expected state once the
// console authors rows. Without the id tie-break this pages
// non-deterministically. Raised in review; the query path's equivalent lives in
// SearchRank and does not cover this one.
//
// **This test does NOT currently prove the tie-break, and saying so matters
// more than the test does.** Mutation-checked: removing `f.id ASC` leaves it
// green, because PostgreSQL returns three rows from a sequential scan in a
// stable order regardless. The unspecified order only becomes an observable
// one at a size where the planner changes strategy or parallelises.
//
// It is kept because it pins the paging CONTRACT — every row seen once, none
// skipped — which is what a future change would break loudly. But the id
// tie-break itself is guarded by review and by the comment in `Search`, not by
// this assertion, and treating it as covered would be exactly the "passes for
// the wrong reason" this repo keeps getting bitten by.
func TestBrowseWithoutAQueryPagesDeterministically(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	ids := []string{"fd-fx-dup-a", "fd-fx-dup-b", "fd-fx-dup-c"}
	t.Cleanup(func() {
		if _, err := repo.pool.Exec(context.Background(),
			`DELETE FROM food_catalog WHERE id = ANY($1)`, ids); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	})
	for _, id := range ids {
		// IDENTICAL names on purpose — that is the state the tie-break exists
		// for, and the one a unique seed catalog never produces.
		if _, err := repo.pool.Exec(ctx, `
			INSERT INTO food_catalog (id, name, category, serving_label, kcal, protein_g, carb_g, fat_g, market, source)
			VALUES ($1, 'Duplicate Name', 'fd-fx-dupcat', '100 g', 1, 1, 1, 1, 'us', 'seed')
			ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`, id); err != nil {
			t.Fatal(err)
		}
	}

	seen := map[string]bool{}
	for offset := 0; offset < len(ids); offset++ {
		page, _, err := repo.Search(ctx, SearchFilter{Category: "fd-fx-dupcat", Limit: 1, Offset: offset})
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range page {
			if seen[f.ID] {
				t.Fatalf("row %q appeared on two pages — the browse sort is not total", f.ID)
			}
			seen[f.ID] = true
		}
	}
	if len(seen) != len(ids) {
		t.Fatalf("paged %d distinct rows of %d — the browse sort skipped one", len(seen), len(ids))
	}
}

// The label macros round-trip through Postgres (N52), and an absent one stays
// absent.
//
// This covers what the barcode tests structurally cannot: they exercise the
// provider boundary against a fake HTTP server and never touch SQL, so dropping
// a column from `upsertSQL`'s INSERT list, its SET clause or its
// change-detection tuple leaves every one of them green while the value
// silently never persists.
func TestLabelMacrosRoundTripThroughTheCatalog(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	id := "test-label-macros"
	t.Cleanup(func() {
		if _, err := repo.pool.Exec(ctx, `DELETE FROM food_catalog WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	})
	if _, err := repo.pool.Exec(ctx, `DELETE FROM food_catalog WHERE id = $1`, id); err != nil {
		t.Fatalf("pre-clean: %v", err)
	}

	f := func(v float64) *float64 { return &v }
	grams := 100.0
	in := Food{
		ID: id, Name: "Test Crisps", Category: "snack", Aliases: []string{},
		ServingLabel: SeedServingLabel, ServingGrams: &grams, Market: "US",
		KCal: 536, ProteinG: 3.5, CarbG: 57, FatG: 32, FibreG: f(4),
		SaturatedFatG: f(9), SugarG: f(1), AddedSugarG: f(0),
		SodiumMG: f(536),
		// Deliberately NOT set — the ordinary case for a scanned product.
		CholesterolMG: nil,
	}
	if err := repo.UpsertAll(ctx, []Food{in}); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	got, err := repo.Get(ctx, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	for _, c := range []struct {
		name string
		got  *float64
		want *float64
	}{
		{"saturated_fat_g", got.SaturatedFatG, f(9)},
		{"sugar_g", got.SugarG, f(1)},
		{"added_sugar_g", got.AddedSugarG, f(0)},
		{"sodium_mg", got.SodiumMG, f(536)},
	} {
		if c.got == nil {
			t.Errorf("%s came back nil — the column is missing from the write or the read", c.name)
			continue
		}
		if *c.got != *c.want {
			t.Errorf("%s = %v, want %v", c.name, *c.got, *c.want)
		}
	}
	// The half that matters most: a value nobody stated must survive the round
	// trip as NULL, not as 0. A zero here is a claim that the food contains no
	// cholesterol, which is the absence-reads-as-an-answer failure this whole
	// change is written against.
	if got.CholesterolMG != nil {
		t.Errorf("cholesterol came back %v for a food that never stated it — "+
			"NULL became a claim", *got.CholesterolMG)
	}
	// A stated ZERO is not an absence and must not have collapsed to NULL.
	if got.AddedSugarG == nil {
		t.Error("a stated zero for added sugar became NULL — that turns a fact into an absence")
	}

	// And a re-seed CORRECTS them: the change-detection tuple has to include
	// the new columns, or a deploy whose only change is a sodium figure matches
	// nothing and the row keeps a stale number forever while every other field
	// tracks the deploy.
	in.SodiumMG = f(410)
	if err := repo.UpsertAll(ctx, []Food{in}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	again, err := repo.Get(ctx, id)
	if err != nil {
		t.Fatalf("get again: %v", err)
	}
	if again.SodiumMG == nil || *again.SodiumMG != 410 {
		t.Errorf("a sodium-only re-seed changed nothing (%v) — the column is "+
			"missing from the change-detection tuple", again.SodiumMG)
	}
}

// tierFixture is a row seeded with an explicit rank_tier, for the N88 tests.
type tierFixture struct {
	id, name, category string
	tier               int
}

func seedTierFixtures(t *testing.T, repo *PostgresRepository, rows []tierFixture) context.Context {
	t.Helper()
	ctx := context.Background()
	for _, f := range rows {
		_, err := repo.pool.Exec(ctx, `
			INSERT INTO food_catalog (
				id, name, brand, category, aliases, serving_label, serving_grams,
				kcal, protein_g, carb_g, fat_g, fibre_g, market, rank_tier, source,
				external_id, external_source)
			VALUES ($1, $2, '', $3, '{}', '100 g', 100, 120, 1, 1, 1, 0, 'us', $4, 'seed', NULL, NULL)
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name, rank_tier = EXCLUDED.rank_tier,
				category = EXCLUDED.category, market = EXCLUDED.market,
				source = EXCLUDED.source`,
			f.id, f.name, f.category, f.tier)
		if err != nil {
			t.Fatalf("seed %s: %v", f.id, err)
		}
	}
	t.Cleanup(func() {
		for _, f := range rows {
			if _, err := repo.pool.Exec(context.Background(),
				`DELETE FROM food_catalog WHERE id = $1`, f.id); err != nil {
				t.Errorf("cleanup %s: %v", f.id, err)
			}
		}
	})
	return ctx
}

// The case N88 exists for, with the REAL rows and a REAL measured failure.
//
// The catalog went from 177 curated foods to 12,651. Ten realistic queries were
// run against the built catalog with and without `rank_tier` in the ORDER BY;
// two changed answer, and both changed from wrong to right:
//
//	query           without rank_tier             with rank_tier
//	"greek yogurt"  Yogurt, Greek, with oats      Greek yogurt, plain, nonfat
//	"salmon"        Salmon salad                  Salmon, sockeye
//
// **The pair below is the "greek yogurt" case verbatim, and it is chosen
// precisely because the curated row LOSES without the tier.** An earlier
// version of this test used "chicken breast", where the curated row is also the
// shortest string and therefore wins on similarity anyway — it passed with
// `rank_tier` deleted from the ORDER BY, which made it decoration. Both signals
// tie on lead position here (each name contains a typed word at position 1), and
// similarity then prefers the shorter bulk row.
//
// If you change these fixtures, delete `f.rank_tier ASC` from SearchRank and
// confirm this test goes red. It is the only thing proving the column does
// anything.
func TestSearchRanksACuratedRowAboveTheBulkImport(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedTierFixtures(t, repo, []tierFixture{
		{"fd-n88-curated-greek", "Greek yogurt, plain, nonfat", "dairy", 0},
		// Verbatim from FNDDS 2024-10, and the row that wins without the tier.
		{"fd-n88-bulk-greek-oats", "Yogurt, Greek, with oats", "dairy", 1},
	})

	got, _, err := repo.Search(ctx, SearchFilter{Query: "greek yogurt", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) < 2 {
		t.Fatalf("expected BOTH rows to match, got %d — this test is about ranking and is vacuous if the WHERE already excluded the competition", len(got))
	}
	if got[0].ID != "fd-n88-curated-greek" {
		t.Errorf("'greek yogurt' ranked %q first, want the curated row — measured, the bulk row wins this query on similarity and rank_tier is the only thing that overrides it", got[0].ID)
	}
	if got[0].RankTier != 0 {
		t.Errorf("curated row came back with rank_tier %d, want 0 — the column is not being read back", got[0].RankTier)
	}
}

// The other half, and the one that would rot silently: rank_tier must NOT
// flatten the ranking among rows that share a tier.
//
// 12,474 of the catalog's 12,651 rows are tier 1, so for any query with no
// curated match — "lobster gumbo", "pad thai" — every ordering decision is made
// entirely by lead position and similarity. A change that sorted on rank_tier
// ALONE would pass the test above and make the whole bulk catalog unordered.
func TestRankTierDoesNotFlattenOrderingWithinATier(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedTierFixtures(t, repo, []tierFixture{
		{"fd-n88-same-plain", "Chicken, broilers or fryers, breast, meat only, raw", "poultry", 1},
		{"fd-n88-same-decoy", "Lunchmeat, chicken breast, sliced, prepackaged", "poultry", 1},
	})

	got, _, err := repo.Search(ctx, SearchFilter{Query: "chicken breast", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) < 2 {
		t.Fatalf("both rows must match for this to test anything, got %d", len(got))
	}
	if got[0].ID != "fd-n88-same-plain" {
		t.Errorf("within one tier the decoy ranked first (%q) — lead position is no longer doing its job", got[0].ID)
	}
}

// Portions come back in USDA's own sequence order, from Get only (N89).
func TestGetReturnsPortionsInSequenceOrder(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedTierFixtures(t, repo, []tierFixture{
		{"fd-n89-egg", "Egg, whole, raw, fresh", "egg", 0},
	})
	// Inserted OUT of order deliberately: if the query lost its ORDER BY, a
	// test that inserted them in order could still pass on insertion order.
	for _, p := range []struct {
		seq   int
		label string
		grams float64
	}{
		{3, "1 jumbo", 63},
		{1, "1 large", 50},
		{2, "1 extra large", 56},
	} {
		if _, err := repo.pool.Exec(ctx,
			`INSERT INTO food_catalog_portions (food_id, seq, label, grams) VALUES ($1,$2,$3,$4)`,
			"fd-n89-egg", p.seq, p.label, p.grams); err != nil {
			t.Fatal(err)
		}
	}

	got, err := repo.Get(ctx, "fd-n89-egg")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"1 large", "1 extra large", "1 jumbo"}
	if len(got.Portions) != len(want) {
		t.Fatalf("got %d portions, want %d", len(got.Portions), len(want))
	}
	for i, w := range want {
		if got.Portions[i].Label != w {
			t.Errorf("portion %d = %q, want %q — USDA lists the most representative first and that order is the product decision", i, got.Portions[i].Label, w)
		}
	}
	if got.Portions[0].Grams != 50 {
		t.Errorf("'1 large' = %v g, want 50", got.Portions[0].Grams)
	}
}

// Search must NOT carry portions. A 25-row page would haul ~60 of them for a
// choice the athlete has not made yet.
func TestSearchDoesNotCarryPortions(t *testing.T) {
	repo := newTestRepo(t)
	ctx := seedTierFixtures(t, repo, []tierFixture{
		{"fd-n89-search-egg", "Egg, whole, raw, fresh", "egg", 0},
	})
	if _, err := repo.pool.Exec(ctx,
		`INSERT INTO food_catalog_portions (food_id, seq, label, grams) VALUES ($1,1,'1 large',50)`,
		"fd-n89-search-egg"); err != nil {
		t.Fatal(err)
	}

	got, _, err := repo.Search(ctx, SearchFilter{Query: "egg", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, f := range got {
		if f.ID == "fd-n89-search-egg" {
			found = true
			if len(f.Portions) != 0 {
				t.Errorf("search returned %d portions; the list must not carry them", len(f.Portions))
			}
		}
	}
	if !found {
		t.Fatal("fixture did not match — the assertion above never ran")
	}
}

// **The guard that silently loses console work if it is dropped.**
//
// A deploy replaces portions wholesale rather than diffing them, and both the
// DELETE and the INSERT are scoped to `source = 'seed'`. Without that scoping a
// reseed wipes the portions of a food the console has taken ownership of — and
// it does so invisibly, because the food row itself is left correct by the
// upsert's own ownership rule. This is the same shape as the exercise module's
// `updateWithin` blanking, which has shipped three times.
func TestSeedDoesNotTouchPortionsOfAnAdminOwnedFood(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	if _, err := repo.pool.Exec(ctx, `
		INSERT INTO food_catalog (
			id, name, brand, category, aliases, serving_label, serving_grams,
			kcal, protein_g, carb_g, fat_g, fibre_g, market, rank_tier, source,
			external_id, external_source)
		VALUES ('fd-n89-admin', 'Console food', '', 'dairy', '{}', '100 g', 100,
		        100, 1, 1, 1, 0, 'us', 1, 'admin', NULL, NULL)
		ON CONFLICT (id) DO UPDATE SET source = 'admin'`); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.pool.Exec(ctx,
		`INSERT INTO food_catalog_portions (food_id, seq, label, grams)
		 VALUES ('fd-n89-admin', 1, '1 hand-authored scoop', 31)
		 ON CONFLICT (food_id, seq) DO UPDATE SET label = EXCLUDED.label`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := repo.pool.Exec(context.Background(),
			`DELETE FROM food_catalog WHERE id = 'fd-n89-admin'`); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	})

	// A deploy runs. It carries a row with the same id and different portions,
	// which is exactly what would overwrite the console's work.
	if err := repo.UpsertAll(ctx, []Food{{
		ID: "fd-n89-admin", Name: "Deploy food", Category: "dairy",
		Aliases: []string{}, ServingLabel: "100 g", Market: "us",
		KCal: 1, Source: SourceSeed,
		Portions: []Portion{{Seq: 1, Label: "1 deploy portion", Grams: 999}},
	}}); err != nil {
		t.Fatal(err)
	}

	got, err := repo.Get(ctx, "fd-n89-admin")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Portions) != 1 {
		t.Fatalf("admin-owned food has %d portions after a deploy, want 1 — the deploy wiped console-authored data", len(got.Portions))
	}
	if got.Portions[0].Label != "1 hand-authored scoop" || got.Portions[0].Grams != 31 {
		t.Errorf("deploy overwrote an admin-owned food's portion: got %q = %v g", got.Portions[0].Label, got.Portions[0].Grams)
	}
}
