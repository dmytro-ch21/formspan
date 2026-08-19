package food

import (
	"context"
	"errors"
	"testing"
)

// The availability half of N42.
//
// An empty result must say WHICH kind of empty it is. These tests are the
// specification of that, and each one distinguishes a pair of cases that a
// bare empty list would collapse.

type fakeRepo struct {
	foods    []Food
	total    int
	coverage *Coverage
	// marketCounts answers CountMarket. A market absent from the map has no
	// rows, which is the state OutcomeMarketNotCovered describes.
	marketCounts map[string]int
	cached       map[string]Food
	cacheWrites  int
	cacheErr     error
	searchErr    error
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		coverage:     &Coverage{Foods: 0, Categories: []CategoryCount{}, Markets: []string{}},
		marketCounts: map[string]int{},
		cached:       map[string]Food{},
	}
}

func (f *fakeRepo) Search(context.Context, SearchFilter) ([]Food, int, error) {
	if f.searchErr != nil {
		return nil, 0, f.searchErr
	}
	return f.foods, f.total, nil
}
func (f *fakeRepo) Get(context.Context, string) (*Food, error)  { return nil, ErrNotFound }
func (f *fakeRepo) Coverage(context.Context) (*Coverage, error) { return f.coverage, nil }
func (f *fakeRepo) UpsertAll(context.Context, []Food) error     { return nil }
func (f *fakeRepo) CountMarket(_ context.Context, m string) (int, error) {
	return f.marketCounts[m], nil
}
func (f *fakeRepo) LookupBarcode(_ context.Context, b string) (*Food, error) {
	if food, ok := f.cached[b]; ok {
		return &food, nil
	}
	return nil, ErrNotFound
}
func (f *fakeRepo) CacheBarcode(_ context.Context, b string, food Food, _ string) error {
	if f.cacheErr != nil {
		return f.cacheErr
	}
	f.cacheWrites++
	f.cached[b] = food
	return nil
}

func aFood() Food {
	return Food{ID: "skyr", Name: "Skyr", Category: "dairy", Market: "us", Source: SourceSeed}
}

// The case this whole mechanism exists for. A catalog that never seeded returns
// zero rows for every query, exactly like a food that is genuinely absent — and
// reporting our broken deploy as "we do not have that food" blames the athlete
// for it.
func TestSearchDistinguishesAnUnseededCatalogFromAMissingFood(t *testing.T) {
	repo := newFakeRepo()
	repo.coverage.Foods = 0 // never seeded
	svc := NewService(repo, nil, nil)

	got, err := svc.Search(context.Background(), SearchFilter{Query: "skyr"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Outcome != OutcomeCatalogEmpty {
		t.Fatalf("outcome = %q, want %q — an empty catalog must never be reported as a missing food",
			got.Outcome, OutcomeCatalogEmpty)
	}

	// Same query, same zero rows, catalog populated: now it really is missing.
	repo.coverage.Foods = 173
	got, err = svc.Search(context.Background(), SearchFilter{Query: "skyr"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Outcome != OutcomeNoMatch {
		t.Fatalf("outcome = %q, want %q", got.Outcome, OutcomeNoMatch)
	}
}

// "%" matches nothing, but nothing was asked. Telling an athlete their food is
// missing would be a confident answer to a question nobody put.
func TestSearchReportsAnUnusableQueryRatherThanAMissingFood(t *testing.T) {
	repo := newFakeRepo()
	repo.coverage.Foods = 173
	svc := NewService(repo, nil, nil)

	got, err := svc.Search(context.Background(), SearchFilter{Query: "%%%"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Outcome != OutcomeQueryUnusable {
		t.Fatalf("outcome = %q, want %q", got.Outcome, OutcomeQueryUnusable)
	}
	// Decided BEFORE the query ran — the repo must not even have been asked.
	if repo.searchErr == nil && got.Total != 0 {
		t.Fatalf("total = %d, want 0", got.Total)
	}
}

// A market we hold nothing for is not the athlete's to fix by rephrasing, so
// it must not arrive as no_match.
func TestSearchReportsAnUncoveredMarketSeparatelyFromNoMatch(t *testing.T) {
	repo := newFakeRepo()
	repo.coverage.Foods = 173
	repo.marketCounts = map[string]int{"us": 173} // nothing for "is"
	svc := NewService(repo, nil, nil)

	got, err := svc.Search(context.Background(), SearchFilter{Query: "skyr", Market: "is"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Outcome != OutcomeMarketNotCovered {
		t.Fatalf("outcome = %q, want %q", got.Outcome, OutcomeMarketNotCovered)
	}

	// A market we DO cover, with no match, is an ordinary no_match.
	got, err = svc.Search(context.Background(), SearchFilter{Query: "skyr", Market: "us"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Outcome != OutcomeNoMatch {
		t.Fatalf("outcome = %q, want %q", got.Outcome, OutcomeNoMatch)
	}
}

// Coverage is attached exactly when it is needed to interpret a nothing, and
// omitted when there is something to show.
func TestSearchAttachesCoverageOnlyWhenEmpty(t *testing.T) {
	repo := newFakeRepo()
	repo.coverage.Foods = 173
	svc := NewService(repo, nil, nil)

	empty, err := svc.Search(context.Background(), SearchFilter{Query: "skyr"})
	if err != nil {
		t.Fatal(err)
	}
	if empty.Coverage == nil {
		t.Fatal("no coverage on an empty result — the athlete cannot interpret the nothing they got")
	}

	repo.foods = []Food{aFood()}
	repo.total = 1
	hit, err := svc.Search(context.Background(), SearchFilter{Query: "skyr"})
	if err != nil {
		t.Fatal(err)
	}
	if hit.Outcome != OutcomeOK {
		t.Fatalf("outcome = %q, want %q", hit.Outcome, OutcomeOK)
	}
	if hit.Coverage != nil {
		t.Fatal("coverage attached to a non-empty result — it is payload nobody reads there")
	}
}

// A client that scans needs "this build cannot look packets up" to be
// different from "this packet is unknown".
func TestCoverageReportsWhetherBarcodeLookupIsConfigured(t *testing.T) {
	repo := newFakeRepo()

	off := NewService(repo, nil, nil)
	cov, err := off.Coverage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cov.Barcode.Enabled {
		t.Fatal("barcode reported as enabled with no resolver wired")
	}

	on := NewService(repo, NewOpenFoodFacts(""), nil)
	cov, err = on.Coverage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !cov.Barcode.Enabled || cov.Barcode.Provider != OpenFoodFactsProvider {
		t.Fatalf("barcode coverage = %+v, want enabled with a named provider", cov.Barcode)
	}
}

// An empty list must never be produced by a failure. A search error is an
// error, not "we do not have that food".
func TestSearchPropagatesAnErrorRatherThanReportingNoMatch(t *testing.T) {
	repo := newFakeRepo()
	repo.searchErr = errors.New("connection refused")
	svc := NewService(repo, nil, nil)

	if _, err := svc.Search(context.Background(), SearchFilter{Query: "skyr"}); err == nil {
		t.Fatal("a failed search returned no error — a database outage would render as 'no results'")
	}
}

// Paging is clamped, never rejected, and never unbounded. A catalog is exactly
// where an unbounded list bites.
func TestSearchFilterNormalizeBoundsPaging(t *testing.T) {
	cases := []struct{ in, want int }{
		{0, DefaultLimit},
		{-5, DefaultLimit},
		{10, 10},
		{5000, MaxLimit},
	}
	for _, tc := range cases {
		f := SearchFilter{Limit: tc.in}
		f.Normalize()
		if f.Limit != tc.want {
			t.Errorf("Normalize(limit=%d) = %d, want %d", tc.in, f.Limit, tc.want)
		}
	}
	f := SearchFilter{Offset: -3}
	f.Normalize()
	if f.Offset != 0 {
		t.Errorf("negative offset survived normalisation: %d", f.Offset)
	}
}
