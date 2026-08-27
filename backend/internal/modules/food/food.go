// Package food is the shared, searchable food catalog — the thing a text
// search or a scanned barcode resolves INTO.
//
// # Why this is not nutrition_foods
//
// `nutrition_foods` is an athlete's PERSONAL list: `user_id NOT NULL`, ids
// generated on the phone so an offline outbox can retry without duplicating,
// and private by default. It is a store, not a catalog. This module is the
// other thing — no owner, slug ids, one row per food for everybody, and the
// `seed`/`admin` provenance split the exercise and technique catalogs already
// use so a deploy can correct a food without reverting a human's edit.
//
// Keeping them apart is not tidiness. Folding a shared catalog into
// `nutrition_foods` would mean a nullable `user_id`, and every existing query
// in the nutrition module would have to be re-audited for rows it was never
// written to expect.
//
// # The two halves, and the second is the one that gets skipped
//
// **Search** is the obvious half, and this repo has already got it wrong once:
// see "The library was not missing the techniques, the search was"
// (2026-08-06), where `arm bar` returned nothing while `armbar` returned 21.
// `search.go` is built from what that cost.
//
// **Availability** is the half that matters. An athlete who searches "skyr"
// and gets an empty list cannot tell whether the food is genuinely missing,
// their query was unusable, or the catalog never loaded at all — and those
// need completely different reactions. An empty list answers none of them.
//
// This repo has been bitten by that exact shape repeatedly: CI with no checks
// reading as passing, a skipped test printing `ok`. **Absence is not an
// answer.** So every search returns an Outcome saying WHICH case it is, and
// `catalog_empty` is separated from `no_match` by actually counting the
// table — a catalog that failed to seed must never be reported to an athlete
// as "we do not have that food".
package food

import (
	"context"
	"errors"
	"strings"
	"time"
)

var (
	ErrNotFound     = errors.New("food: not found")
	ErrInvalidInput = errors.New("food: invalid input")
	// ErrUnavailable means we could not ASK — a barcode lookup whose upstream
	// timed out, refused, or returned nonsense.
	//
	// Separate from ErrNotFound on purpose, and this is the single most
	// important distinction in this package. "This barcode is not in the
	// database" and "I could not reach the database" look identical to a
	// phone that only sees an empty result, and they are opposite
	// instructions: the first means offer to enter the food by hand, the
	// second means try again in a minute. Collapsing them would reproduce the
	// absence-reads-as-an-answer bug in the one place it is most expensive.
	ErrUnavailable = errors.New("food: lookup unavailable")
)

// Source is where a catalog row came from.
//
// Deliberately only two values, and NOT the same vocabulary as
// nutrition_foods.source (`user|seed|usda|off|ai`), which answers a different
// question — that one records how an athlete's own row was produced, this one
// records who owns this catalog row's content. A row is either deploy-managed
// or a human's edit, and a deploy must never revert a human.
type Source string

const (
	// SourceSeed is a row the seeder owns. Rewritten on every deploy.
	SourceSeed Source = "seed"
	// SourceAdmin is a row a human edited in the console. The seeder's
	// `WHERE source = 'seed'` skips it forever after.
	SourceAdmin Source = "admin"
)

var Sources = []Source{SourceSeed, SourceAdmin}

func (s Source) valid() bool {
	for _, v := range Sources {
		if v == s {
			return true
		}
	}
	return false
}

// Food is one catalog row.
//
// Macros are per serving, and every seeded row's serving is 100 g because
// that is the unit USDA states — see scripts/import_usda_foods.py. The client
// scales; the server never multiplies, exactly as `nutrition_foods` already
// works.
type Food struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Brand    string   `json:"brand"`
	Category string   `json:"category"`
	Aliases  []string `json:"aliases"`

	// ServingLabel is what one serving IS, as a person would say it.
	ServingLabel string `json:"serving_label"`
	// ServingGrams is nullable for the same reason it is on nutrition_foods:
	// an egg has no honest gram weight and inventing one would make every
	// gram-based total quietly fictional.
	ServingGrams *float64 `json:"serving_grams"`

	KCal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbG    float64 `json:"carb_g"`
	FatG     float64 `json:"fat_g"`
	// FibreG is nullable and that is NOT the same statement as zero: a source
	// that does not state fibre is not claiming there is none, and averaging
	// unstated as zero drags every fibre figure down.
	FibreG *float64 `json:"fibre_g"`

	// The label macros (N52), all nullable for the reason FibreG is — absence
	// is a fact about the source, not about the food, and a zero would be a
	// claim nobody made. Two are nil by nature rather than by accident:
	// `AddedSugarG` is nil for every USDA-seeded row (SR Legacy does not carry
	// it) and `CholesterolMG` is nil for most scanned products (Open Food Facts
	// carried it on neither product measured).
	//
	// **SodiumMG is MILLIGRAMS**, the US label and USDA convention. Open Food
	// Facts sends grams and is converted at that boundary.
	SaturatedFatG *float64 `json:"saturated_fat_g"`
	SugarG        *float64 `json:"sugar_g"`
	AddedSugarG   *float64 `json:"added_sugar_g"`
	SodiumMG      *float64 `json:"sodium_mg"`
	CholesterolMG *float64 `json:"cholesterol_mg"`

	// Market is which region's food supply this row describes. A column
	// rather than a global assumption so that "we do not stock this food" and
	// "we do not cover your region" can stay different answers without a
	// migration — see Outcome below.
	Market string `json:"market"`

	// RankTier is search precedence, lowest first: 0 is the hand-curated set,
	// 1 is the bulk USDA import. It is the PRIMARY sort key of a catalog
	// search — see SearchRank — and it exists because 803 catalog rows contain
	// the word "chicken" and neither lead position nor trigram similarity can
	// tell the curated "Chicken breast" from FNDDS's "Chicken breast, fried,
	// coated, skin / coating eaten, from pre-cooked".
	//
	// Served on the wire so a client can say WHY a row is where it is, and so
	// that a future "generic foods only" filter needs no new field. Clients
	// must treat unseen values as bulk rather than curated — the server owns
	// this vocabulary and may extend it, and guessing in the confident
	// direction is the trap N41 and N51 both hit.
	RankTier int `json:"rank_tier"`

	// Portions are the household ways this food is measured — "1 large" = 50 g
	// on an egg, "1 cup" = 158 g on cooked rice. From USDA `foodPortions`;
	// 98% of the catalog has at least one, 2.4 on average.
	//
	// **Populated by Get and left nil by Search, deliberately.** A search page
	// of 25 foods would carry ~60 portions nobody has asked for yet, and a
	// portion is only picked once a specific food has been chosen. `omitempty`
	// so a list response does not carry 25 nulls.
	//
	// 100 g is NOT in here and never will be: it is always available from
	// ServingGrams, so a client always has at least one way to measure a food
	// even when this is empty.
	Portions []Portion `json:"portions,omitempty"`

	Source Source `json:"source"`
	// ExternalID and ExternalSource record which upstream row the numbers came
	// from, so any figure in this catalog can be checked against its origin.
	ExternalID     *string `json:"external_id"`
	ExternalSource *string `json:"external_source"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Outcome explains a result set — above all an empty one.
//
// This is the availability half of N42 made concrete. The client renders
// different copy and offers different actions for each value, and none of
// them is "no results found".
type Outcome string

const (
	// OutcomeOK — there are results.
	OutcomeOK Outcome = "ok"
	// OutcomeNoMatch — the catalog is loaded and covers this market, and
	// nothing matched. This is the only value that means "we do not have this
	// food", and it is the only one where offering to add it by hand is the
	// right next step.
	OutcomeNoMatch Outcome = "no_match"
	// OutcomeQueryUnusable — the query contained no searchable term at all
	// ("%", "!!!", ""). The athlete's food may well be here; nothing was
	// actually asked. Telling them it is missing would be a lie.
	OutcomeQueryUnusable Outcome = "query_unusable"
	// OutcomeCatalogEmpty — the catalog holds no rows. This is OUR failure, a
	// deploy that never seeded, and it must never be reported as "we do not
	// have that food". It is the whole reason the count is taken.
	OutcomeCatalogEmpty Outcome = "catalog_empty"
	// OutcomeMarketNotCovered — a market was asked for that this catalog
	// holds nothing for. Distinct from no_match because the athlete cannot fix
	// it by rephrasing, and it is the honest answer to "why is no European
	// yoghurt in here".
	OutcomeMarketNotCovered Outcome = "market_not_covered"
)

// SearchResult is what a search returns, results or not.
type SearchResult struct {
	Foods []Food `json:"foods"`
	// Total is how many rows matched before Limit was applied, so a client can
	// say "showing 20 of 63" rather than implying it has everything.
	Total   int     `json:"total"`
	Outcome Outcome `json:"outcome"`
	// Coverage is attached whenever Foods is empty, because that is exactly
	// when an athlete needs to know what this catalog actually contains in
	// order to interpret the nothing they just got.
	Coverage *Coverage `json:"coverage,omitempty"`
}

// Coverage is the answer to "what is actually in here".
//
// N42 asks for a coverage answer BEFORE this ships rather than after, because
// an empty result is uninterpretable without one. Served from live counts, not
// a hand-written number that would rot.
type Coverage struct {
	Foods      int             `json:"foods"`
	Markets    []string        `json:"markets"`
	Categories []CategoryCount `json:"categories"`
	// Barcode says whether barcode lookup is configured on this deploy. A
	// client that scans needs to know the difference between "this packet is
	// unknown" and "this build cannot look packets up at all".
	Barcode BarcodeCoverage `json:"barcode"`
}

type CategoryCount struct {
	Category string `json:"category"`
	Foods    int    `json:"foods"`
}

type BarcodeCoverage struct {
	// Enabled is false when no barcode provider is wired up.
	Enabled bool `json:"enabled"`
	// Provider names who answers a barcode lookup, for support and for the
	// attribution an ODbL source requires. Empty when disabled.
	Provider string `json:"provider"`
	// Cached is how many barcodes this deploy has already resolved.
	Cached int `json:"cached"`
}

// SearchFilter bounds a catalog query.
type SearchFilter struct {
	Query    string
	Category string
	// Market is optional. Empty means "any market this catalog holds", which
	// is the right default while only one is stocked.
	Market string
	Limit  int
	Offset int
}

// Limits on the list endpoint. A catalog is exactly where an unbounded list
// bites, so the page size is capped in the domain rather than left to whatever
// a caller passes.
const (
	DefaultLimit = 25
	MaxLimit     = 100
)

// Normalize clamps paging into range instead of rejecting it. A client asking
// for 5,000 rows gets 100 and a Total telling it there are more, which is more
// useful than a 400 and cannot be turned into a denial-of-service by a typo.
func (f *SearchFilter) Normalize() {
	// Market is matched exactly in SQL, so a client sending "US" would get
	// market_not_covered for a market we stock — an honest-looking answer that
	// is simply wrong. Lowercased here rather than in the query so the stored
	// value and the filter agree on one spelling. Raised in review.
	f.Market = strings.ToLower(strings.TrimSpace(f.Market))
	if f.Limit <= 0 {
		f.Limit = DefaultLimit
	}
	if f.Limit > MaxLimit {
		f.Limit = MaxLimit
	}
	if f.Offset < 0 {
		f.Offset = 0
	}
}

// BarcodeFood is one resolved packet, and it is a SEPARATE type from Food on
// purpose.
//
// Reusing Food here meant a barcode response carried `source` and `market`,
// and neither has an honest value for an Open Food Facts row: the enum is
// `seed|admin`, which both mean "content we own". It shipped as `seed`, so the
// wire asserted that ODbL data was deploy-authored — one client copying that
// field into `nutrition_foods.source` (whose vocabulary also contains `seed`)
// would have mislabelled it permanently, and the licence separation the third
// table exists for would have been undone in the one place nobody was looking.
//
// A type that never had the fields cannot mislabel them. Same argument as
// `profile.PublicProfile`, for the same reason: the leak is one refactor away
// otherwise. Raised in review.
type BarcodeFood struct {
	Name  string `json:"name"`
	Brand string `json:"brand"`

	ServingLabel string   `json:"serving_label"`
	ServingGrams *float64 `json:"serving_grams"`

	// PacketServingLabel/PacketServingGrams are the packet's OWN printed
	// serving — "2 pieces (25 g)" for a Kinder bar — additive to and
	// deliberately separate from ServingLabel/ServingGrams above (N117).
	//
	// ServingLabel/ServingGrams mean "the amount every macro on this struct
	// represents" everywhere they are read, and that is always 100 g here —
	// redefining them to the packet's serving while the macros stayed
	// per-100g would be the exact two-serving-bases mixup this file's history
	// already warns against, just moved into the wire contract.
	//
	// These two exist ONLY so a client can pick a better STARTING amount than
	// "100 g" — a Kinder bar opens to "2 Pieces (25 g)" / 140 kcal instead of
	// "100 g" / 560 kcal — while still computing every amount, including that
	// starting one, as `perHundredG * (grams/100)` against the fields above.
	// Both nil when Open Food Facts states no serving in grams; never a
	// fabricated number standing in for an absent one.
	PacketServingLabel *string  `json:"packet_serving_label"`
	PacketServingGrams *float64 `json:"packet_serving_grams"`

	KCal     float64  `json:"kcal"`
	ProteinG float64  `json:"protein_g"`
	CarbG    float64  `json:"carb_g"`
	FatG     float64  `json:"fat_g"`
	FibreG   *float64 `json:"fibre_g"`

	// The label macros (N52). Pointers because absence is a fact about what the
	// provider stated, never about the product — nil renders `n/a`, and 0 would
	// be a claim nobody made.
	SaturatedFatG *float64 `json:"saturated_fat_g"`
	SugarG        *float64 `json:"sugar_g"`
	AddedSugarG   *float64 `json:"added_sugar_g"`
	// SodiumMG is MILLIGRAMS, converted from Open Food Facts' GRAMS at the
	// boundary. See `sodiumMGFromGrams`.
	SodiumMG *float64 `json:"sodium_mg"`
	// CholesterolMG is usually nil: Open Food Facts carried it on NEITHER
	// product measured while building this. Expected, not a gap.
	CholesterolMG *float64 `json:"cholesterol_mg"`

	ExternalID *string `json:"external_id"`
}

// plausible reports whether these numbers are worth showing an athlete.
//
// The bounds are the ones `food_barcode_cache` enforces, checked HERE so a
// violation becomes ErrNotFound rather than a warn. Without this, an upstream
// row with `energy-kcal_100g: 900000` or a negative protein reaches the athlete
// as a measured fact and merely fails to cache — the cache write is a logged
// warning by design, so nothing stops the number.
//
// Same reasoning as rejecting a nameless product: an implausible figure
// presented confidently is worse than no answer, because it prompts no
// correction. Raised in review.
func (b *BarcodeFood) plausible() bool {
	inRange := func(v float64, max float64) bool { return v >= 0 && v < max }
	if !inRange(b.KCal, 20000) || !inRange(b.ProteinG, 2000) ||
		!inRange(b.CarbG, 2000) || !inRange(b.FatG, 2000) {
		return false
	}
	if b.FibreG != nil && !inRange(*b.FibreG, 500) {
		return false
	}
	// The label macros, against migration 000066's own CHECKs. The milligram
	// pair matters most: a sodium figure that failed the bound is very likely a
	// missed unit conversion rather than bad crowd data, and letting it through
	// would show a 1000x number as measured fact.
	for _, p := range []struct {
		v   *float64
		max float64
	}{
		{b.SaturatedFatG, 2000}, {b.SugarG, 2000}, {b.AddedSugarG, 2000},
		{b.SodiumMG, 100000}, {b.CholesterolMG, 100000},
	} {
		if p.v != nil && !inRange(*p.v, p.max) {
			return false
		}
	}
	if b.ServingGrams != nil && *b.ServingGrams <= 0 {
		return false
	}
	// PacketServingGrams (N117) is a suggested amount, not a macro — but a
	// non-positive one is exactly as wrong to show as a non-positive
	// ServingGrams above, for the same reason.
	if b.PacketServingGrams != nil && *b.PacketServingGrams <= 0 {
		return false
	}
	return true
}

// BarcodeResult is one resolved packet.
//
// Provider is carried so a client can attribute the data — Open Food Facts is
// ODbL and attribution is not optional — and so support can tell where a wrong
// number came from.
type BarcodeResult struct {
	Food     BarcodeFood `json:"food"`
	Provider string      `json:"provider"`
	// Cached reports whether this answer came from our store rather than a
	// live upstream call. Useful in support ("is this stale?") and it is the
	// only way a test can prove the cache is doing anything.
	Cached bool `json:"cached"`
}

type Repository interface {
	Search(ctx context.Context, f SearchFilter) ([]Food, int, error)
	Get(ctx context.Context, id string) (*Food, error)
	// Coverage answers "what is in here". Separate from Search so an empty
	// search can attach it without a second round trip through the handler.
	Coverage(ctx context.Context) (*Coverage, error)
	// CountMarket reports how many rows this catalog holds for a market, so
	// market_not_covered can be told apart from no_match.
	CountMarket(ctx context.Context, market string) (int, error)
	// UpsertAll writes the seeded catalog in one transaction, skipping rows a
	// human has taken ownership of.
	UpsertAll(ctx context.Context, foods []Food) error
	// LookupBarcode returns a cached barcode resolution and the provider that
	// answered it, or ErrNotFound.
	LookupBarcode(ctx context.Context, barcode string) (*BarcodeFood, string, error)
	// CacheBarcode stores a resolution. Its table is deliberately separate
	// from this catalog — see barcode.go.
	CacheBarcode(ctx context.Context, barcode string, f BarcodeFood, provider string) error
}

// Validate guards the content rules the database cannot express well, and is
// what makes a typo in the seed JSON fail loudly at deploy rather than
// silently seeding a row no filter can return.
func (f *Food) Validate() error {
	switch {
	case f.ID == "":
		return errors.New("food: id is required")
	case f.Name == "":
		return errors.New("food: name is required")
	case f.Category == "":
		return errors.New("food: category is required")
	case f.Market == "":
		return errors.New("food: market is required")
	case !f.Source.valid():
		return errors.New("food: unknown source " + string(f.Source))
	}
	if f.KCal < 0 || f.ProteinG < 0 || f.CarbG < 0 || f.FatG < 0 {
		return errors.New("food: macros must not be negative")
	}
	if f.FibreG != nil && *f.FibreG < 0 {
		return errors.New("food: fibre must not be negative")
	}
	return nil
}

// Portion is one household measure of a catalog food.
//
// A struct rather than a map because the ORDER matters: Seq is USDA's own
// `sequenceNumber`, which lists the most representative portion first, and any
// ordering we invented would be a guess dressed as editorial judgement.
//
// Grams is NOT nullable, unlike almost every other quantity in this package. A
// portion whose weight is unknown cannot be logged against a calorie target, so
// it is not a portion this catalog can carry — the importer drops those rather
// than storing a null. That is the opposite of the rule for nutrients, where
// absence is a fact worth recording, and the difference is that a null nutrient
// still leaves a loggable food while a null gram weight does not.
type Portion struct {
	Seq   int     `json:"seq"`
	Label string  `json:"label"`
	Grams float64 `json:"grams"`
}
