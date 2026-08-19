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
				kcal, protein_g, carb_g, fat_g, fibre_g, market, source,
				external_id, external_source)
			VALUES ($1, $2, '', $3, $4, '100 g', 100, $5, 1, 1, 1, 0, $6, 'seed', NULL, NULL)
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name, brand = EXCLUDED.brand,
				category = EXCLUDED.category, aliases = EXCLUDED.aliases,
				serving_label = EXCLUDED.serving_label, serving_grams = EXCLUDED.serving_grams,
				kcal = EXCLUDED.kcal, protein_g = EXCLUDED.protein_g,
				carb_g = EXCLUDED.carb_g, fat_g = EXCLUDED.fat_g,
				fibre_g = EXCLUDED.fibre_g, market = EXCLUDED.market,
				source = EXCLUDED.source, external_id = EXCLUDED.external_id,
				external_source = EXCLUDED.external_source`,
			f.id, f.name, f.category, aliases, f.kcal, f.market)
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

	if _, err := repo.LookupBarcode(ctx, barcode); err == nil {
		t.Fatal("an unseen barcode was found in the cache")
	}

	fibre := 0.5
	in := Food{
		Name: "Skyr, plain", Brand: "Siggi's", ServingLabel: "100 g",
		KCal: 63, ProteinG: 11, CarbG: 4, FatG: 0.2, FibreG: &fibre,
	}
	if err := repo.CacheBarcode(ctx, barcode, in, OpenFoodFactsProvider); err != nil {
		t.Fatal(err)
	}
	got, err := repo.LookupBarcode(ctx, barcode)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != in.Name || got.KCal != in.KCal {
		t.Fatalf("cached food = %+v, want %+v", got, in)
	}
	if got.ExternalSource == nil || *got.ExternalSource != OpenFoodFactsProvider {
		t.Fatal("cached row lost its provider — ODbL attribution depends on it")
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
