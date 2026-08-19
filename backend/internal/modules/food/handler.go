package food

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/dmytro-ch21/vola/backend/internal/platform/apihttp"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// Search serves GET /v1/nutrition/catalog.
//
// Returns 200 with an empty list and an `outcome` even when nothing matched —
// never a 404. A search that found nothing is a successful search, and the
// interesting part of the response is the outcome telling the client WHICH
// kind of nothing it got.
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := SearchFilter{
		Query:    q.Get("q"),
		Category: q.Get("category"),
		Market:   q.Get("market"),
		Limit:    atoiOr(q.Get("limit"), 0),
		Offset:   atoiOr(q.Get("offset"), 0),
	}
	// Clamped rather than rejected — see SearchFilter.Normalize. A catalog is
	// exactly where an unbounded list bites, so this cannot be talked into
	// returning everything.
	f.Normalize()

	result, err := h.svc.Search(r.Context(), f)
	if err != nil {
		apihttp.WriteInternal(w, r, "food", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, result)
}

// Coverage serves GET /v1/nutrition/catalog/coverage — "what is actually in
// here".
//
// A first-class endpoint rather than only a field on an empty search, because
// the question is asked in two different situations: by a client rendering an
// empty state, and by a human wanting to know whether a deploy seeded
// correctly. The second is the one that makes it worth its own route.
func (h *Handler) Coverage(w http.ResponseWriter, r *http.Request) {
	cov, err := h.svc.Coverage(r.Context())
	if err != nil {
		apihttp.WriteInternal(w, r, "food", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, cov)
}

// Get serves GET /v1/nutrition/catalog/{id}.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	food, err := h.svc.Get(r.Context(), r.PathValue("id"))
	if errors.Is(err, ErrNotFound) {
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound, "no such food")
		return
	}
	if err != nil {
		apihttp.WriteInternal(w, r, "food", err)
		return
	}
	apihttp.WriteJSON(w, http.StatusOK, food)
}

// barcodeResponse is the barcode lookup's wire shape.
//
// `source` is what the scanning client keys on: whose data this is. `provider`
// and `cached` are additional, and `cached` is the only way to tell a live
// answer from a stored one in support — or in a test that needs to prove the
// cache does anything.
type barcodeResponse struct {
	Food     BarcodeFood `json:"food"`
	Source   string      `json:"source"`
	Provider string      `json:"provider"`
	Cached   bool        `json:"cached"`
}

// Barcode serves GET /v1/nutrition/catalog/barcode/{barcode}.
//
// **THREE outcomes, and keeping them apart is the whole job of this handler:**
//
//	400 invalid_input  the input is not a barcode      — fix the input
//	404 not_found      the provider does not have it   — offer manual entry
//	503 unavailable    we could not ask                — try again shortly
//
// A scanning client shows different screens for each, and it can only do that
// if the server never collapses the last two. A network failure surfacing as
// "not in the database" would tell an athlete their food does not exist
// because our DNS blinked.
func (h *Handler) Barcode(w http.ResponseWriter, r *http.Request) {
	barcode := r.PathValue("barcode")

	result, err := h.svc.Lookup(r.Context(), barcode)
	switch {
	case err == nil:
		apihttp.WriteJSON(w, http.StatusOK, barcodeResponse{
			Food:     result.Food,
			Source:   sourceOf(result),
			Provider: result.Provider,
			Cached:   result.Cached,
		})
	case errors.Is(err, ErrInvalidInput):
		apihttp.WriteError(w, http.StatusBadRequest, apihttp.CodeInvalidInput,
			"that is not a barcode — expected 6 to 14 digits")
	case errors.Is(err, ErrNotFound):
		apihttp.WriteError(w, http.StatusNotFound, apihttp.CodeNotFound,
			"no food is known for that barcode")
	case errors.Is(err, ErrUnavailable):
		// 503, NOT 404. The message says which so a human reading a log can
		// tell them apart too, but the CODE is what a client may act on.
		apihttp.WriteError(w, http.StatusServiceUnavailable, apihttp.CodeUnavailable,
			"could not reach the barcode provider — this is not the same as the food being unknown")
	default:
		apihttp.WriteInternal(w, r, "food", err)
	}
}

// sourceOf reports whose data this is, which is a different question from
// whether it was cached. A cached Open Food Facts row is still Open Food Facts
// data — that matters for ODbL attribution, so it must not become "catalog"
// merely by having been stored.
func sourceOf(res *BarcodeResult) string {
	if res.Provider == OpenFoodFactsProvider || res.Provider == "off" {
		return "off"
	}
	if res.Provider == "" {
		return "catalog"
	}
	return res.Provider
}

func atoiOr(s string, fallback int) int {
	if s == "" {
		return fallback
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		// A non-numeric limit falls back rather than 400ing. Normalize clamps
		// it into range anyway, so there is nothing a bad value can do here
		// except be ignored.
		return fallback
	}
	return n
}
