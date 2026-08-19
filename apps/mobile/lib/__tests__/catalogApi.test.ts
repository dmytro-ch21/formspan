/**
 * The catalog search client, and the five different meanings of "nothing".
 *
 * The endpoint returns an `outcome` rather than just an array precisely because
 * an empty list cannot say why it is empty, and only ONE of the reasons is a
 * statement about the food. Flattening them is the absence-reads-as-answer
 * failure the catalog was specified around.
 */

import { ApiError, OfflineError } from '../apiError';
import { emptySearchMessage, searchCatalog, type CatalogSearch } from '../catalogApi';

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const getToken = async () => 'token';

const OATS = {
  id: 'usda-1',
  name: 'Oats, rolled',
  brand: '',
  category: 'grains',
  serving_label: '100 g',
  serving_grams: 100,
  kcal: 389,
  protein_g: 16.9,
  carb_g: 66.3,
  fat_g: 6.9,
  fibre_g: 10.6,
};

function result(over: Partial<CatalogSearch> = {}): CatalogSearch {
  return { foods: [], total: 0, outcome: 'no_match', coverage: null, ...over };
}

beforeEach(() => mockApi.mockReset());

describe('searchCatalog', () => {
  it('asks the catalog route with the query', async () => {
    mockApi.mockResolvedValue({ foods: [OATS], total: 1, outcome: 'ok' });
    await searchCatalog(getToken, { q: 'oats', limit: 20 });
    expect(mockApi).toHaveBeenCalledWith(getToken, '/nutrition/catalog?q=oats&limit=20');
  });

  it('returns the foods, the pre-limit total and the outcome', async () => {
    mockApi.mockResolvedValue({ foods: [OATS], total: 63, outcome: 'ok' });
    const r = await searchCatalog(getToken, { q: 'oats' });
    expect(r.foods).toEqual([OATS]);
    expect(r.total).toBe(63);
    expect(r.outcome).toBe('ok');
  });

  /**
   * The server owns this vocabulary and can add to it. A client union closed
   * over today's five would mislabel the sixth — and the dangerous mislabel is
   * `no_match`, the only value that means "we do not stock this food". This is
   * the same open-at-the-server, closed-at-the-client failure the barcode
   * lookup's `source` had.
   */
  it('reports an unrecognised outcome as unknown, never as no_match', async () => {
    mockApi.mockResolvedValue({ foods: [], total: 0, outcome: 'some_future_outcome' });
    expect((await searchCatalog(getToken, { q: 'x' })).outcome).toBe('unknown');
  });

  it.each(['ok', 'no_match', 'query_unusable', 'catalog_empty', 'market_not_covered'] as const)(
    'passes %s through unchanged',
    async (outcome) => {
      mockApi.mockResolvedValue({ foods: [], total: 0, outcome });
      expect((await searchCatalog(getToken, { q: 'x' })).outcome).toBe(outcome);
    },
  );

  /** A failed request is not entitled to make a claim about the catalog. */
  it('throws rather than returning an empty result', async () => {
    mockApi.mockRejectedValue(new OfflineError());
    await expect(searchCatalog(getToken, { q: 'oats' })).rejects.toBeInstanceOf(OfflineError);
    mockApi.mockRejectedValue(new ApiError('boom', 'internal', 500));
    await expect(searchCatalog(getToken, { q: 'oats' })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('emptySearchMessage', () => {
  /** The ONLY outcome licensed to say the food is missing. */
  it('says the food is missing for no_match, and offers the way out', () => {
    const msg = emptySearchMessage(result({ outcome: 'no_match' }), 'skyr');
    expect(msg).toMatch(/skyr/);
    expect(msg).toMatch(/add it yourself/i);
  });

  it('names how much the catalog holds when it knows', () => {
    const msg = emptySearchMessage(
      result({
        outcome: 'no_match',
        coverage: { foods: 177, markets: ['US'], categories: [], barcode: { enabled: true, provider: 'off' } },
      }),
      'skyr',
    );
    expect(msg).toMatch(/177 foods/);
  });

  /**
   * The four that must NOT claim the food is missing. Each is a different
   * thing being wrong, and only one of them is about the athlete's query.
   */
  it.each([
    ['query_unusable', /word or two/i],
    ['catalog_empty', /not loaded on this server/i],
    ['market_not_covered', /region/i],
    ['unknown', /could not answer/i],
  ] as const)('does not blame the catalog for %s', (outcome, shape) => {
    const msg = emptySearchMessage(result({ outcome }), 'skyr');
    expect(msg).toMatch(shape);
    // None of these may imply the food is absent, which is what sends an
    // athlete off to type it in by hand forever.
    expect(msg).not.toMatch(/add it yourself/i);
    expect(msg).not.toMatch(/No “skyr”/);
  });

  /**
   * `catalog_empty` is OUR failure — a deploy that never seeded — so it has to
   * say so rather than let the athlete think the catalog simply lacks their
   * food. It also has to say what still works.
   */
  it('owns a catalog that never seeded, and says what still works', () => {
    const msg = emptySearchMessage(result({ outcome: 'catalog_empty' }), 'skyr');
    expect(msg).toMatch(/our problem/i);
    expect(msg).toMatch(/saved foods still work/i);
  });
});
