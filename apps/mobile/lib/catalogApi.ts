/**
 * The shared food catalog (N42), searched from the phone.
 *
 * ## Why this exists
 *
 * The quick-add sheet searched `foods` — the athlete's OWN saved list, mirrored
 * into local SQLite. On a fresh account that table is empty, so every search
 * returned nothing and the screen read as broken. Reported from a real phone,
 * which is where it was always going to be found: nobody with a populated saved
 * list ever sees it.
 *
 * The catalog is an ADDITIONAL source, not a replacement. An athlete's own
 * recipes and saved foods are still theirs and still searched; this widens the
 * net to the 177 USDA rows N42 seeded.
 *
 * ## An empty answer has five different meanings and they are not
 * interchangeable
 *
 * This is the whole reason the endpoint returns an `outcome` rather than just
 * an array, and the reason this module does not flatten it. "No results" can
 * mean the catalog does not have that food, or that nothing was actually asked,
 * or that the catalog is EMPTY because a deploy never seeded it — which is our
 * failure and must never be reported to an athlete as "we do not have that
 * food". Only one of the five is a statement about the food.
 *
 * A sixth case sits outside the enum entirely: the request FAILED. That throws,
 * exactly as the barcode lookup does, so a network failure cannot be rendered
 * as a fact about the catalog.
 */

import { apiRequest } from './apiRequest';
import type { Macros } from './nutrition';
import type { TokenGetter } from './useAuthToken';

/**
 * What an answer means. Mirrors the server's `Outcome`, plus `unknown`.
 *
 * **`unknown` is not padding.** The server owns this vocabulary and can add to
 * it; a client union that closed over today's five would silently mislabel the
 * sixth. This is the same open-at-the-server, closed-at-the-client failure the
 * barcode lookup's `source` had — there an unrecognised provider claimed to be
 * our own catalog, which is the most confident wrong answer available.
 *
 * Anything unrecognised must NOT collapse to `no_match`: that is the one value
 * meaning "we do not stock this food", and guessing it is how absence starts
 * reading as an answer.
 */
export type CatalogOutcome =
  /** There are results. */
  | 'ok'
  /** The catalog is loaded, covers this market, and nothing matched. The ONLY
   *  value that means "we do not have this food", and the only one where
   *  offering to add it by hand is the right next step. */
  | 'no_match'
  /** The query held no searchable term at all — `%`, `!!!`, ``. Nothing was
   *  asked, so nothing can be concluded. */
  | 'query_unusable'
  /** The catalog holds no rows. OUR failure — a deploy that never seeded. */
  | 'catalog_empty'
  /** A market this catalog holds nothing for. The athlete cannot fix it by
   *  rephrasing, which is what makes it different from `no_match`. */
  | 'market_not_covered'
  /** A value this build does not recognise. Never treated as an answer. */
  | 'unknown';

export type CatalogFood = Macros & {
  id: string;
  name: string;
  brand: string;
  category: string;
  serving_label: string;
  serving_grams: number | null;
};

export type CatalogCoverage = {
  foods: number;
  markets: string[];
  categories: { category: string; foods: number }[];
  barcode: { enabled: boolean; provider: string };
};

export type CatalogSearch = {
  foods: CatalogFood[];
  /** Matches BEFORE the limit, so a client can say "20 of 63" honestly. */
  total: number;
  outcome: CatalogOutcome;
  /** Attached when `foods` is empty — what the catalog actually holds. */
  coverage: CatalogCoverage | null;
};

type SearchResponse = {
  foods?: CatalogFood[];
  total?: number;
  outcome?: string;
  coverage?: CatalogCoverage | null;
};

const KNOWN: CatalogOutcome[] = [
  'ok',
  'no_match',
  'query_unusable',
  'catalog_empty',
  'market_not_covered',
];

function narrowOutcome(raw: string | undefined): CatalogOutcome {
  return KNOWN.includes(raw as CatalogOutcome) ? (raw as CatalogOutcome) : 'unknown';
}

/**
 * Search the catalog.
 *
 * Throws on a transport failure — `OfflineError` or `ApiError` — rather than
 * returning an empty list, because an empty list here is a claim about what the
 * catalog contains and a failed request is not entitled to make one.
 */
export async function searchCatalog(
  getToken: TokenGetter,
  input: { q: string; limit?: number },
): Promise<CatalogSearch> {
  const params = new URLSearchParams({ q: input.q });
  if (input.limit) params.set('limit', String(input.limit));

  const res = await apiRequest<SearchResponse>(getToken, `/nutrition/catalog?${params}`);
  return {
    foods: res.foods ?? [],
    total: res.total ?? 0,
    outcome: narrowOutcome(res.outcome),
    coverage: res.coverage ?? null,
  };
}

/**
 * What to tell the athlete when a search comes back with nothing.
 *
 * Separate from the screen so it can be tested without rendering, and because
 * the distinction it draws is the one most easily lost. Only `no_match` may say
 * the food is missing.
 */
export function emptySearchMessage(result: CatalogSearch, query: string): string {
  switch (result.outcome) {
    case 'no_match': {
      const held = result.coverage?.foods;
      return held
        ? `No “${query}” in the food catalog yet — it holds ${held} foods so far. You can add it yourself.`
        : `No “${query}” in the food catalog yet. You can add it yourself.`;
    }
    case 'query_unusable':
      // Nothing was actually searched for. Saying the food is missing would be
      // a statement about the catalog that nobody made.
      return 'Try a word or two from the food’s name.';
    case 'catalog_empty':
      // OUR failure. An athlete told "we do not have that food" here would be
      // told something false, and would go and type it in by hand forever.
      return 'The food catalog has not loaded on this server yet. This is our problem, not yours — your own saved foods still work.';
    case 'market_not_covered':
      return 'The food catalog does not cover this region yet, so it cannot answer for these foods.';
    default:
      // `unknown`, and `ok` — the latter only reachable if a caller asks for a
      // message about an answer that HAS results, which is a caller bug rather
      // than a server one. `add.tsx` used to do exactly that when every row was
      // deduped away against saved foods, so an `ok` answer rendered as a
      // catalog failure; it now gates on the answer's own emptiness. Neither
      // value is entitled to claim the food is missing.
      return 'The catalog could not answer that one. Your own saved foods still work.';
  }
}
