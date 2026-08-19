package food

import (
	"context"
	"log/slog"
)

// Service is the catalog's behaviour: search with an honest answer for an
// empty result, and barcode lookup.
//
// It exists as a layer above Repository because the interesting logic here is
// not any single query — it is deciding WHICH question a set of zero rows is
// the answer to, and that needs more than one query to establish.
type Service struct {
	repo     Repository
	resolver Resolver
	logger   *slog.Logger
}

func NewService(repo Repository, resolver Resolver, logger *slog.Logger) *Service {
	return &Service{repo: repo, resolver: resolver, logger: logger}
}

// warn logs a non-fatal problem. Nil-tolerant so tests can build a Service
// without wiring a logger, which is the common case for the ones that only
// exercise outcome selection.
func (s *Service) warn(msg string, args ...any) {
	if s.logger != nil {
		s.logger.Warn(msg, args...)
	}
}

// Search runs a catalog query and, when it returns nothing, works out WHY.
//
// This is the half of N42 that gets skipped. An athlete who searches "skyr"
// and sees an empty list cannot tell whether the food is missing, their query
// was unusable, or the catalog never loaded — and those need different
// reactions. An empty list answers none of them, and this repo has been bitten
// by that shape repeatedly: CI with no checks reading as passing, a skipped
// test printing `ok`.
//
// So the empty case costs one or two extra queries, and they are worth it
// because they are only ever run when there is nothing to show anyway.
//
// The order of the checks is deliberate — most fundamental first, so the most
// actionable true statement wins:
//
//  1. query unusable — nothing was actually asked
//  2. catalog empty — OUR failure, never the athlete's
//  3. market not covered — real, and not fixable by rephrasing
//  4. no match — the only one that means "we do not have this food"
func (s *Service) Search(ctx context.Context, f SearchFilter) (*SearchResult, error) {
	f.Normalize()

	// Checked BEFORE the query, not inferred from its result. "%" and "!!!"
	// match nothing, and reporting that as "we do not have that food" would be
	// a confident answer to a question nobody asked.
	if f.Query != "" && !HasSearchableTerm(f.Query) {
		cov, err := s.repo.Coverage(ctx)
		if err != nil {
			return nil, err
		}
		s.decorate(cov)
		return &SearchResult{
			Foods:    []Food{},
			Outcome:  OutcomeQueryUnusable,
			Coverage: cov,
		}, nil
	}

	foods, total, err := s.repo.Search(ctx, f)
	if err != nil {
		return nil, err
	}
	if len(foods) > 0 {
		return &SearchResult{Foods: foods, Total: total, Outcome: OutcomeOK}, nil
	}

	// **An empty PAGE is not an empty RESULT**, and conflating them puts
	// `no_match` on a food the catalog demonstrably has.
	//
	// `total` comes from `count(*) OVER ()`, which is computed per returned
	// row — so a page past the end of a real result set returns no rows and
	// therefore no count at all, and arrives here looking exactly like "we have
	// nothing". A client paging to offset 75 of 63 matches would be told the
	// food does not exist.
	//
	// Re-asking with offset 0 costs one query and only ever runs on an empty
	// page. If there really were matches, this is `ok` with the true total —
	// the client has simply run off the end. Raised in review.
	if f.Offset > 0 {
		probe := f
		probe.Offset = 0
		probe.Limit = 1
		_, realTotal, err := s.repo.Search(ctx, probe)
		if err != nil {
			return nil, err
		}
		if realTotal > 0 {
			return &SearchResult{Foods: []Food{}, Total: realTotal, Outcome: OutcomeOK}, nil
		}
	}

	// Nothing matched. Establish which kind of nothing it is.
	cov, err := s.repo.Coverage(ctx)
	if err != nil {
		return nil, err
	}
	s.decorate(cov)

	result := &SearchResult{Foods: []Food{}, Total: 0, Coverage: cov}

	switch {
	case cov.Foods == 0:
		// The catalog holds nothing at all. A deploy that never seeded, and
		// telling an athlete "we do not have that food" would be blaming them
		// for our broken deploy. This is the single case this whole mechanism
		// was built for.
		result.Outcome = OutcomeCatalogEmpty
	default:
		if f.Market != "" {
			n, err := s.repo.CountMarket(ctx, f.Market)
			if err != nil {
				return nil, err
			}
			if n == 0 {
				// We stock nothing for the market asked for. Not fixable by
				// rephrasing, so it must not be reported as no_match.
				result.Outcome = OutcomeMarketNotCovered
				return result, nil
			}
		}
		// The catalog is loaded, covers the market asked for, and does not
		// have this. The ONLY outcome that means "we do not have this food",
		// and the only one where offering to add it by hand is right.
		result.Outcome = OutcomeNoMatch
	}
	return result, nil
}

// decorate fills in the parts of Coverage the repository cannot know, because
// they are properties of how this process was configured rather than of the
// data.
//
// A client that scans needs to distinguish "this packet is unknown" from "this
// build cannot look packets up at all", and only the process knows which.
func (s *Service) decorate(cov *Coverage) {
	if s.resolver == nil {
		cov.Barcode.Enabled = false
		cov.Barcode.Provider = ""
		return
	}
	cov.Barcode.Enabled = true
	cov.Barcode.Provider = s.resolver.Provider()
}

// Coverage answers "what is in this catalog" on its own, for the endpoint that
// serves it directly.
func (s *Service) Coverage(ctx context.Context) (*Coverage, error) {
	cov, err := s.repo.Coverage(ctx)
	if err != nil {
		return nil, err
	}
	s.decorate(cov)
	return cov, nil
}

func (s *Service) Get(ctx context.Context, id string) (*Food, error) {
	return s.repo.Get(ctx, id)
}
