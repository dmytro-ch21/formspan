package food

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Resolving a scanned barcode to a food.
//
// # The distinction this file exists to preserve
//
// There are THREE outcomes, not two, and collapsing any pair of them
// reproduces this repo's most repeated bug in its most expensive location:
//
//	the provider does not know this barcode  -> ErrNotFound   (offer manual entry)
//	the provider is unreachable              -> ErrUnavailable (try again shortly)
//	the provider knows it and has no numbers -> ErrNotFound, see below
//
// A phone that only sees "empty" cannot tell the first from the second, and
// they are opposite instructions. So a transport failure must NEVER surface as
// "not in the database".
//
// # HTTP status is not the signal, and assuming it is gets this backwards
//
// Measured against the live API: **Open Food Facts returns HTTP 200 with
// `"status": 0` for a barcode it does not have.** A resolver that treated
// non-200 as "unknown" and 200 as "found" would report every unknown packet as
// a success and every outage as a missing product — exactly inverted. The JSON
// body is the signal; the HTTP status only tells us whether we got an answer at
// all.
//
// # A found product can still be unusable, and that must not become 0 kcal
//
// Open Food Facts is crowd-sourced and carries placeholder entries: a real
// barcode with no name, or with no energy value, is a normal state there.
// Measured on live products, `nutriments` may simply lack `energy-kcal_100g`.
//
// Mapping that to a food with `kcal: 0` would write "this meal was zero
// calories" into an athlete's day as a FACT — worse than returning nothing,
// because nothing prompts a correction and a confident zero does not. So an
// incomplete product is ErrNotFound: we genuinely cannot resolve it, and the
// athlete's next step is the same one they would take for an unknown packet.
const (
	// OpenFoodFactsProvider is recorded on every cached row. ODbL requires
	// attribution, so who answered is stored rather than assumed.
	OpenFoodFactsProvider = "openfoodfacts"

	// defaultBarcodeTimeout bounds a lookup. Short on purpose: this sits
	// between an athlete and a camera, and a slow answer is worse than a
	// prompt "try again" — they are standing in a shop.
	defaultBarcodeTimeout = 6 * time.Second
)

// validBarcode matches the column's CHECK. A barcode is a STRING of digits,
// not a number — leading zeros are significant, and 13 digits overflows int32.
var validBarcode = regexp.MustCompile(`^[0-9]{6,14}$`)

// ValidBarcode reports whether this is even a barcode.
//
// Checked before any network call, because a malformed input is
// `invalid_input` and not `not_found`. Telling an athlete "we do not have that
// product" when they sent "abc" is a third way of answering the wrong
// question.
func ValidBarcode(s string) bool { return validBarcode.MatchString(s) }

// Resolver looks a barcode up somewhere that is not our database.
//
// An interface so the orchestration below can be tested against every failure
// mode without a network — including the ones that are hard to provoke against
// a live provider, which is most of them.
type Resolver interface {
	Resolve(ctx context.Context, barcode string) (*Food, error)
	// Provider names who answers, for attribution and for the coverage
	// endpoint's report of whether lookup is configured at all.
	Provider() string
}

// OpenFoodFacts resolves barcodes against the Open Food Facts API.
//
// Used for barcodes ONLY, never bulk-imported, and its results are cached in
// their own table. Open Food Facts is ODbL, and migration 000059 records the
// rule this obeys: the share-alike obligation must never reach data we
// authored.
type OpenFoodFacts struct {
	client  *http.Client
	baseURL string
	// userAgent identifies this app. Open Food Facts asks API clients to send
	// a real one and rate-limits anonymous traffic harder; a default Go
	// user-agent is how a lookup starts failing in production only.
	userAgent string
}

// NewOpenFoodFacts builds the default resolver.
func NewOpenFoodFacts(userAgent string) *OpenFoodFacts {
	if strings.TrimSpace(userAgent) == "" {
		userAgent = "VOLA/1.0 (https://github.com/dmytro-ch21/formspan)"
	}
	return &OpenFoodFacts{
		client:    &http.Client{Timeout: defaultBarcodeTimeout},
		baseURL:   "https://world.openfoodfacts.org",
		userAgent: userAgent,
	}
}

func (o *OpenFoodFacts) Provider() string { return OpenFoodFactsProvider }

// offResponse is only the fields we read. Open Food Facts returns ~174 keys
// per product; naming the five we use keeps an upstream schema change from
// being a parse error.
type offResponse struct {
	Status  int `json:"status"`
	Product struct {
		ProductName string `json:"product_name"`
		Brands      string `json:"brands"`
		Nutriments  struct {
			KCal    *float64 `json:"energy-kcal_100g"`
			Protein *float64 `json:"proteins_100g"`
			Carbs   *float64 `json:"carbohydrates_100g"`
			Fat     *float64 `json:"fat_100g"`
			Fibre   *float64 `json:"fiber_100g"`
		} `json:"nutriments"`
	} `json:"product"`
}

func (o *OpenFoodFacts) Resolve(ctx context.Context, barcode string) (*Food, error) {
	if !ValidBarcode(barcode) {
		return nil, fmt.Errorf("%w: not a barcode", ErrInvalidInput)
	}
	url := fmt.Sprintf("%s/api/v2/product/%s.json", o.baseURL, barcode)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	req.Header.Set("User-Agent", o.userAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := o.client.Do(req)
	if err != nil {
		// Transport failure — DNS, timeout, refused. We could not ask.
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close() //nolint:errcheck // read-only

	// 404 from the API itself means the ROUTE is wrong, not that the product
	// is missing — an unknown barcode comes back 200 with status 0. Every
	// non-200 is therefore "we could not ask", never "no such food".
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: provider returned %d", ErrUnavailable, resp.StatusCode)
	}

	// Bounded read. An unbounded io.ReadAll on a remote body is a memory
	// exhaustion the provider gets to trigger; 1 MB is far above any product
	// document and far below anything that hurts.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}

	var parsed offResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		// Unparseable is an outage wearing a 200 — a captive portal, an error
		// page, a truncated body. Not an answer about the product.
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}

	// THE signal. status 0 means the provider does not have this barcode.
	if parsed.Status != 1 {
		return nil, ErrNotFound
	}

	name := strings.TrimSpace(parsed.Product.ProductName)
	n := parsed.Product.Nutriments
	// A product with no name or no energy value is a placeholder somebody
	// scanned and never filled in. Returning it would put a nameless zero-kcal
	// food in front of an athlete as though it were measured.
	if name == "" || n.KCal == nil {
		return nil, ErrNotFound
	}

	brand := strings.TrimSpace(parsed.Product.Brands)
	if i := strings.Index(brand, ","); i >= 0 {
		// Open Food Facts stores brands as a comma-separated list; the first
		// is the one on the front of the packet.
		brand = strings.TrimSpace(brand[:i])
	}
	brand = truncate(brand, 80)

	grams := 100.0
	id := barcode
	return &Food{
		ID:    id,
		Name:  truncate(name, 120),
		Brand: brand,
		// Everything from a barcode is packaged by definition. A real category
		// would have to be inferred, and an inferred category on a screen that
		// also shows measured numbers reads as measured.
		Category: "packaged",
		Aliases:  []string{},
		// Per 100 g, matching the catalog, because that is the basis Open Food
		// Facts states these values on. The packet's own serving size is
		// available upstream and deliberately not used yet — mixing two
		// serving bases in one response is how a doubled quantity happens.
		ServingLabel:   SeedServingLabel,
		ServingGrams:   &grams,
		KCal:           *n.KCal,
		ProteinG:       deref(n.Protein),
		CarbG:          deref(n.Carbs),
		FatG:           deref(n.Fat),
		FibreG:         n.Fibre,
		Source:         SourceSeed,
		ExternalID:     &id,
		ExternalSource: strPtr("off"),
	}, nil
}

func deref(f *float64) float64 {
	if f == nil {
		return 0
	}
	return *f
}

func strPtr(s string) *string { return &s }

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Rune-aware, so a multi-byte name cannot be cut mid-character and become
	// invalid UTF-8 that Postgres then rejects.
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// Lookup resolves a barcode: cache first, then the provider, caching a hit.
//
// A method on Service rather than on the repository, because a repository that
// could make a network call would make "did this come from our database"
// unanswerable at the call site.
func (s *Service) Lookup(ctx context.Context, barcode string) (*BarcodeResult, error) {
	if !ValidBarcode(barcode) {
		return nil, fmt.Errorf("%w: not a barcode", ErrInvalidInput)
	}

	cached, err := s.repo.LookupBarcode(ctx, barcode)
	switch {
	case err == nil:
		return &BarcodeResult{Food: *cached, Provider: derefStr(cached.ExternalSource), Cached: true}, nil
	case errors.Is(err, ErrNotFound):
		// Fall through to the provider. Note there is no NEGATIVE cache: a
		// barcode the provider did not know last week may be known today, and
		// caching the miss would turn "not added upstream yet" into a
		// permanent "does not exist".
	default:
		return nil, err
	}

	if s.resolver == nil {
		// No provider configured on this deploy. That is emphatically not
		// "this food does not exist" — nothing was asked.
		return nil, fmt.Errorf("%w: no barcode provider is configured", ErrUnavailable)
	}

	found, err := s.resolver.Resolve(ctx, barcode)
	if err != nil {
		// Passed through unchanged, ErrNotFound and ErrUnavailable alike. The
		// handler maps them to different statuses and that is the entire
		// point of this function.
		return nil, err
	}

	// A cache write failure must not fail the lookup: we have the answer the
	// athlete asked for, and losing the cache entry only costs one refetch.
	if err := s.repo.CacheBarcode(ctx, barcode, *found, s.resolver.Provider()); err != nil {
		s.warn("food: caching barcode failed", "barcode", barcode, "err", err)
	}
	return &BarcodeResult{Food: *found, Provider: s.resolver.Provider(), Cached: false}, nil
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
