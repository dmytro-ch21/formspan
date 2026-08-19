package food

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The three-outcome rule, tested from every side.
//
// "The provider does not have this barcode" and "we could not reach the
// provider" are opposite instructions to a phone, and every one of these tests
// exists because a plausible implementation collapses one pair.

func offServer(t *testing.T, status int, body string) *OpenFoodFacts {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	off := NewOpenFoodFacts("VOLA-test")
	off.baseURL = srv.URL
	return off
}

const goodProduct = `{"status":1,"product":{"product_name":"Skyr, plain","brands":"Siggi's, Icelandic",
	"nutriments":{"energy-kcal_100g":63,"proteins_100g":11,"carbohydrates_100g":4,"fat_100g":0.2,"fiber_100g":0}}}`

func TestResolveHappyPath(t *testing.T) {
	off := offServer(t, 200, goodProduct)
	got, err := off.Resolve(context.Background(), "5690550000001")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Skyr, plain" {
		t.Fatalf("name = %q", got.Name)
	}
	// Brands is a comma-separated list upstream; the first is the one on the
	// packet.
	if got.Brand != "Siggi's" {
		t.Fatalf("brand = %q, want the first of the comma-separated list", got.Brand)
	}
	if got.KCal != 63 || got.ProteinG != 11 {
		t.Fatalf("macros = %+v", got)
	}
	if got.ExternalID == nil || *got.ExternalID != "5690550000001" {
		t.Fatal("resolved food lost its upstream identifier")
	}
}

// **A well-formed barcode the database does not hold comes back HTTP 404 with
// the provider's envelope** — measured against the live API, and it is the
// ordinary unknown-packet case rather than an exotic one.
//
// This test is the regression guard for a real shipped bug: the resolver
// accepted only 200, because the original measurement was taken with a
// MALFORMED code that Open Food Facts normalised away and answered 200 for. So
// every genuinely unknown product returned ErrUnavailable, the endpoint served
// 503, and a phone told the athlete to retry something that could never
// succeed. The unit tests all passed, because they stubbed 200 — a stub built
// from an assumption cannot falsify it.
func TestResolveTreatsA404WithTheProvidersEnvelopeAsNotFound(t *testing.T) {
	off := offServer(t, 404, `{"code":"5690550000001","status":0,"status_verbose":"product not found"}`)
	_, err := off.Resolve(context.Background(), "5690550000001")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound — a 404 carrying status 0 is the provider saying it has no such product, and it is how almost every unknown scan arrives", err)
	}
	if errors.Is(err, ErrUnavailable) {
		t.Fatal("an unknown product was reported as an outage — the phone would retry forever")
	}
}

// The malformed-code case, which is the one that really does answer 200. Kept
// alongside the 404 above so the two are visibly different situations rather
// than one remembered fact.
func TestResolveTreatsA200WithStatusZeroAsNotFound(t *testing.T) {
	off := offServer(t, 200, `{"status":0,"status_verbose":"no code or invalid code"}`)
	_, err := off.Resolve(context.Background(), "5690550000001")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// **The discriminator between the two kinds of 404, and the only thing keeping
// the widened status from swallowing a real outage.**
//
// A 404 from a proxy, a WAF or a wrong route carries HTML, not the provider's
// envelope. It must stay ErrUnavailable — otherwise "the route is broken"
// becomes "your food does not exist", which is the failure this whole endpoint
// is built to prevent, just re-entering through the fix for it.
func TestResolveTreatsAnUnroutedHTML404AsUnavailable(t *testing.T) {
	for name, body := range map[string]string{
		"proxy error page": `<html><head><title>404 Not Found</title></head><body>nginx</body></html>`,
		"empty body":       ``,
		"WAF block":        `Access denied`,
	} {
		t.Run(name, func(t *testing.T) {
			off := offServer(t, 404, body)
			_, err := off.Resolve(context.Background(), "5690550000001")
			if !errors.Is(err, ErrUnavailable) {
				t.Fatalf("err = %v, want ErrUnavailable — a 404 that is not the provider's envelope is an outage, not an answer", err)
			}
			if errors.Is(err, ErrNotFound) {
				t.Fatal("a broken route was reported as a missing food")
			}
		})
	}
}

// Everything that is neither 200 nor 404 is "we could not ask".
func TestResolveTreatsHTTPFailuresAsUnavailable(t *testing.T) {
	for _, status := range []int{429, 500, 502, 503, 504} {
		off := offServer(t, status, `{"status":0}`)
		_, err := off.Resolve(context.Background(), "5690550000001")
		if !errors.Is(err, ErrUnavailable) {
			t.Errorf("HTTP %d gave %v, want ErrUnavailable", status, err)
		}
		if errors.Is(err, ErrNotFound) {
			t.Errorf("HTTP %d was reported as a missing food — an outage would tell an athlete their food does not exist", status)
		}
	}
}

// A cold answer and a warm one must be the same number. The cache column is
// NUMERIC(_, 2), so an unrounded fetch answers differently from the row it
// wrote — the same barcode giving two figures depending on whether somebody
// scanned it before.
func TestResolveRoundsToTheCachedScale(t *testing.T) {
	off := offServer(t, 200, `{"status":1,"product":{"product_name":"X","nutriments":{
		"energy-kcal_100g":99.99999999999999,"proteins_100g":11.005,"fiber_100g":0.12345}}}`)
	got, err := off.Resolve(context.Background(), "5690550000001")
	if err != nil {
		t.Fatal(err)
	}
	if got.KCal != 100 {
		t.Errorf("kcal = %v, want 100 — an unrounded value differs from what the cache would return", got.KCal)
	}
	if got.ProteinG != 11.01 {
		t.Errorf("protein = %v, want 11.01", got.ProteinG)
	}
	if got.FibreG == nil || *got.FibreG != 0.12 {
		t.Errorf("fibre = %v, want 0.12", got.FibreG)
	}
}

// A 200 carrying an error page or a truncated body is an outage wearing a
// success, not an answer about the product.
func TestResolveTreatsUnparseableBodyAsUnavailable(t *testing.T) {
	off := offServer(t, 200, `<html>captive portal</html>`)
	_, err := off.Resolve(context.Background(), "5690550000001")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}

// Open Food Facts is crowd-sourced and carries placeholder entries. Mapping
// one to a food would write a nameless zero-kcal meal into an athlete's day as
// a measured fact — worse than nothing, because a confident zero prompts no
// correction.
func TestResolveRejectsAProductWithNoUsableNumbers(t *testing.T) {
	cases := map[string]string{
		"no name":              `{"status":1,"product":{"product_name":"","nutriments":{"energy-kcal_100g":63}}}`,
		"no energy value":      `{"status":1,"product":{"product_name":"Mystery bar","nutriments":{"proteins_100g":9}}}`,
		"no nutriments at all": `{"status":1,"product":{"product_name":"Mystery bar"}}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			off := offServer(t, 200, body)
			got, err := off.Resolve(context.Background(), "5690550000001")
			if !errors.Is(err, ErrNotFound) {
				t.Fatalf("err = %v (food %+v), want ErrNotFound", err, got)
			}
		})
	}
}

func TestValidBarcode(t *testing.T) {
	for _, ok := range []string{"012345", "5690550000001", "01234567890123"} {
		if !ValidBarcode(ok) {
			t.Errorf("ValidBarcode(%q) = false", ok)
		}
	}
	// Leading zeros are significant, so these are strings — but the shape
	// still has to be digits, and a malformed input is invalid_input rather
	// than not_found.
	for _, bad := range []string{"", "abc", "12345", "012345678901234", "56905-50000001", "٥٦٩٠"} {
		if ValidBarcode(bad) {
			t.Errorf("ValidBarcode(%q) = true", bad)
		}
	}
}

// --- Lookup orchestration ---

func TestLookupServesFromCacheWithoutCallingTheProvider(t *testing.T) {
	repo := newFakeRepo()
	repo.cached["5690550000001"] = BarcodeFood{Name: "Skyr", KCal: 63}
	// A resolver pointed at a server that would fail if it were ever called.
	off := offServer(t, 500, `{}`)
	svc := NewService(repo, off, nil)

	got, err := svc.Lookup(context.Background(), "5690550000001")
	if err != nil {
		t.Fatalf("cached lookup failed, so the provider was called: %v", err)
	}
	if !got.Cached {
		t.Fatal("result not marked cached — nothing else can prove the cache does anything")
	}
}

func TestLookupCachesAResolvedProduct(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, offServer(t, 200, goodProduct), nil)

	got, err := svc.Lookup(context.Background(), "5690550000001")
	if err != nil {
		t.Fatal(err)
	}
	if got.Cached {
		t.Fatal("a freshly fetched product claimed to be cached")
	}
	if repo.cacheWrites != 1 {
		t.Fatalf("cache writes = %d, want 1", repo.cacheWrites)
	}
}

// **No negative cache.** A barcode the provider did not know last week may be
// known today; caching the miss would turn "not added upstream yet" into a
// permanent "does not exist".
func TestLookupDoesNotCacheAMiss(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, offServer(t, 200, `{"status":0}`), nil)

	_, err := svc.Lookup(context.Background(), "5690550000001")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if repo.cacheWrites != 0 {
		t.Fatalf("a miss was cached (%d writes) — the food would stay 'missing' after it is added upstream", repo.cacheWrites)
	}
}

// Losing the cache entry costs one refetch. Failing the lookup costs the
// athlete the answer we already have.
func TestLookupSurvivesACacheWriteFailure(t *testing.T) {
	repo := newFakeRepo()
	repo.cacheErr = errors.New("disk full")
	svc := NewService(repo, offServer(t, 200, goodProduct), nil)

	got, err := svc.Lookup(context.Background(), "5690550000001")
	if err != nil {
		t.Fatalf("a cache write failure lost an answer we already had: %v", err)
	}
	if got.Food.Name != "Skyr, plain" {
		t.Fatalf("name = %q", got.Food.Name)
	}
}

// No provider configured is emphatically not "this food does not exist" —
// nothing was asked.
func TestLookupWithNoResolverIsUnavailableNotNotFound(t *testing.T) {
	svc := NewService(newFakeRepo(), nil, nil)
	_, err := svc.Lookup(context.Background(), "5690550000001")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if errors.Is(err, ErrNotFound) {
		t.Fatal("an unconfigured deploy reported the food as missing")
	}
}

func TestLookupRejectsAMalformedBarcodeBeforeAsking(t *testing.T) {
	repo := newFakeRepo()
	svc := NewService(repo, offServer(t, 200, goodProduct), nil)
	_, err := svc.Lookup(context.Background(), "not-a-barcode")
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput — 'we do not have that product' is the wrong answer to 'abc'", err)
	}
	if repo.cacheWrites != 0 {
		t.Fatal("a malformed barcode reached the cache")
	}
}

// A BarcodeFood carries no `source` and no `market`, and that is structural
// rather than an omission: the enum's values (`seed`, `admin`) both mean
// "content we own", so an Open Food Facts row shipped as `seed` would assert on
// the wire that ODbL data is deploy-authored. A client copying that into
// nutrition_foods.source — whose vocabulary also has `seed` — would mislabel it
// permanently. A type that never had the field cannot leak it. Raised in review.
func TestBarcodeFoodCannotClaimToBeOurContent(t *testing.T) {
	off := offServer(t, 200, goodProduct)
	got, err := off.Resolve(context.Background(), "5690550000001")
	if err != nil {
		t.Fatal(err)
	}
	blob, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{`"source"`, `"market"`} {
		if strings.Contains(string(blob), forbidden) {
			t.Errorf("barcode response carries %s: %s", forbidden, blob)
		}
	}
}

// Crowd-sourced numbers get the same treatment as a missing name. Without this
// the absurd value still reaches the athlete and merely fails to cache, because
// a cache-write failure is deliberately non-fatal. Raised in review.
func TestResolveRejectsImplausibleNumbers(t *testing.T) {
	cases := map[string]string{
		"absurd energy":    `{"status":1,"product":{"product_name":"X","nutriments":{"energy-kcal_100g":900000}}}`,
		"negative protein": `{"status":1,"product":{"product_name":"X","nutriments":{"energy-kcal_100g":100,"proteins_100g":-5}}}`,
		"impossible fat":   `{"status":1,"product":{"product_name":"X","nutriments":{"energy-kcal_100g":100,"fat_100g":5000}}}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			off := offServer(t, 200, body)
			got, err := off.Resolve(context.Background(), "5690550000001")
			if !errors.Is(err, ErrNotFound) {
				t.Fatalf("err = %v (food %+v), want ErrNotFound", err, got)
			}
		})
	}
}
