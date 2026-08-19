import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import AddFoodScreen from '../food/add';

/**
 * The quick-add sheet's catalog half (N51).
 *
 * The bug this covers was not in any function — every function worked. It was
 * that the screen asked the WRONG SOURCE: `localFoods`, the athlete's own saved
 * list, which is empty on a fresh account. So every search returned nothing and
 * the sheet read as broken, and only a real phone with a real new account could
 * show it.
 *
 * What is pinned here is therefore the wiring and the copy, not the search
 * ranking (that is the server's, and N42 measured it).
 */

/** See the note in `identifyScreen.test.tsx`: a `mock`-prefixed binding rather
 *  than a `require` inside the factory, which the lint ratchet will not absorb. */
const mockUseEffect = useEffect;

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockSearchCatalog = jest.fn();
jest.mock('@/lib/catalogApi', () => {
  const real = jest.requireActual('@/lib/catalogApi');
  return { ...real, searchCatalog: (...a: unknown[]) => mockSearchCatalog(...a) };
});

const mockLocalFoods = jest.fn();
const mockLogFood = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  localFoods: (...a: unknown[]) => mockLocalFoods(...a),
  logFood: (...a: unknown[]) => mockLogFood(...a),
  recentsFor: jest.fn(async () => []),
  saveFoodLocally: jest.fn(async () => 'new-id'),
}));

jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

jest.mock('expo-router', () => ({
  __esModule: true,
  // `KeyboardAwareScrollView` uses this.
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => ({ meal: 'lunch', date: '2026-08-19' }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

const CATALOG_OATS = {
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

function answer(over: Record<string, unknown> = {}) {
  return { foods: [], total: 0, outcome: 'no_match', coverage: null, ...over };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockLocalFoods.mockReset().mockResolvedValue([]);
  mockLogFood.mockReset().mockResolvedValue('entry-1');
  mockSearchCatalog.mockReset().mockResolvedValue(answer());
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

/** Type, then let the 250ms debounce fire and the promise settle. */
async function search(text: string) {
  render(<AddFoodScreen />);
  fireEvent.changeText(screen.getByTestId('add-search'), text);
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
}

/**
 * The whole point of N51. On a fresh account the saved list is empty, and
 * before this the screen asked nothing else.
 */
it('searches the catalog, not only the athlete’s saved foods', async () => {
  mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_OATS], total: 1, outcome: 'ok' }));
  await search('oats');
  await waitFor(() => expect(screen.getByTestId('add-catalog-usda-1')).toBeTruthy());
  expect(mockSearchCatalog).toHaveBeenCalledWith(expect.anything(), { q: 'oats', limit: 20 });
});

it('does not search the catalog until something is typed', async () => {
  render(<AddFoodScreen />);
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  expect(mockSearchCatalog).not.toHaveBeenCalled();
});

it('logs a catalog row without claiming it as a saved food', async () => {
  mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_OATS], total: 1, outcome: 'ok' }));
  await search('oats');
  await waitFor(() => expect(screen.getByTestId('add-catalog-usda-1')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByTestId('add-catalog-usda-1'));
  });
  const entry = mockLogFood.mock.calls[0][1];
  expect(entry.kcal).toBe(389);
  expect(entry.meal).toBe('lunch');
  // `source_food_id` is a foreign key into the athlete's OWN saved foods. A
  // catalog id is a different id space; writing it there would dangle.
  expect(entry.source_food_id).toBeNull();
});

/**
 * The athlete's own foods are not replaced, and a food they have saved is not
 * listed twice.
 *
 * **Two catalog rows, one colliding and one not.** Asserting only that the
 * collider disappears cannot tell deduplication from suppressing the whole
 * catalog section whenever the saved list is non-empty — a mutation doing the
 * latter passed the first version of this test. The survivor is what makes it
 * a dedupe test. Raised in review.
 */
it('keeps saved foods and does not list them twice', async () => {
  mockLocalFoods.mockResolvedValue([
    { id: 'mine-1', kind: 'food', name: 'Oats, rolled', brand: '', serving_label: '40 g',
      serving_grams: 40, kcal: 150, protein_g: 5, carb_g: 26, fat_g: 3, fibre_g: 4 },
  ]);
  const other = { ...CATALOG_OATS, id: 'usda-2', name: 'Oat bran' };
  mockSearchCatalog.mockResolvedValue(
    answer({ foods: [CATALOG_OATS, other], total: 2, outcome: 'ok' }),
  );
  await search('oat');
  await waitFor(() => expect(screen.getByTestId('add-food-mine-1')).toBeTruthy());
  // The collider is suppressed...
  expect(screen.queryByTestId('add-catalog-usda-1')).toBeNull();
  // ...and the one that is genuinely different is not.
  expect(screen.getByTestId('add-catalog-usda-2')).toBeTruthy();
  expect(screen.queryByTestId('add-catalog-empty')).toBeNull();
});

/**
 * The blocking finding from review, reproduced.
 *
 * When EVERY catalog row is deduped away, the answer was still `ok` — the
 * catalog had answered — but the empty block was gated on the post-dedupe count
 * and fed the pre-dedupe answer to the message. The result was "The catalog
 * could not answer that one" rendered directly beneath the saved row that had
 * just answered it, and it is the mainline case for anyone who has saved a
 * common food.
 */
it('says nothing when the catalog answered and every row was already saved', async () => {
  mockLocalFoods.mockResolvedValue([
    { id: 'mine-1', kind: 'food', name: 'Oats, rolled', brand: '', serving_label: '40 g',
      serving_grams: 40, kcal: 150, protein_g: 5, carb_g: 26, fat_g: 3, fibre_g: 4 },
  ]);
  mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_OATS], total: 1, outcome: 'ok' }));
  await search('oats');
  await waitFor(() => expect(screen.getByTestId('add-food-mine-1')).toBeTruthy());
  expect(screen.queryByTestId('add-catalog-empty')).toBeNull();
  expect(screen.queryByTestId('add-catalog-usda-1')).toBeNull();
});

/** A brandless saved food must not suppress a branded catalog one. */
it('does not let a brandless saved food suppress every brand', async () => {
  mockLocalFoods.mockResolvedValue([
    { id: 'mine-1', kind: 'food', name: 'Greek Yogurt', brand: '', serving_label: '150 g',
      serving_grams: 150, kcal: 130, protein_g: 11, carb_g: 6, fat_g: 6, fibre_g: null },
  ]);
  mockSearchCatalog.mockResolvedValue(
    answer({
      foods: [{ ...CATALOG_OATS, id: 'usda-9', name: 'Greek Yogurt', brand: 'Fage' }],
      total: 1,
      outcome: 'ok',
    }),
  );
  await search('greek');
  await waitFor(() => expect(screen.getByTestId('add-catalog-usda-9')).toBeTruthy());
});

/** What the row says is what the diary records. */
it('logs the same name it displayed', async () => {
  mockSearchCatalog.mockResolvedValue(
    answer({
      foods: [{ ...CATALOG_OATS, id: 'usda-9', name: 'Greek Yogurt', brand: 'Fage' }],
      total: 1,
      outcome: 'ok',
    }),
  );
  await search('greek');
  await waitFor(() => expect(screen.getByTestId('add-catalog-usda-9')).toBeTruthy());
  expect(screen.getByText('Fage Greek Yogurt')).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByTestId('add-catalog-usda-9'));
  });
  expect(mockLogFood.mock.calls[0][1].name).toBe('Fage Greek Yogurt');
});

describe('an empty result says which kind of empty', () => {
  it('blames the catalog ONLY on no_match', async () => {
    mockSearchCatalog.mockResolvedValue(answer({ outcome: 'no_match' }));
    await search('skyr');
    await waitFor(() => expect(screen.getByTestId('add-catalog-empty')).toBeTruthy());
    expect(screen.getByTestId('add-catalog-empty')).toHaveTextContent(/add it yourself/i);
  });

  /**
   * A deploy that never seeded is OUR failure. Reporting it as "we do not have
   * that food" would send every athlete off to type their whole diet in by
   * hand, and nothing would ever surface the real cause.
   */
  it('owns a catalog that never loaded', async () => {
    mockSearchCatalog.mockResolvedValue(answer({ outcome: 'catalog_empty' }));
    await search('skyr');
    await waitFor(() => expect(screen.getByTestId('add-catalog-empty')).toBeTruthy());
    const text = screen.getByTestId('add-catalog-empty');
    expect(text).toHaveTextContent(/our problem/i);
    expect(text).not.toHaveTextContent(/add it yourself/i);
  });

  /** A failed request is not a statement about the catalog. */
  it('does not claim the food is missing when it could not ask', async () => {
    mockSearchCatalog.mockRejectedValue(new Error('Network request failed'));
    await search('skyr');
    await waitFor(() => expect(screen.getByTestId('add-catalog-empty')).toBeTruthy());
    const text = screen.getByTestId('add-catalog-empty');
    expect(text).toHaveTextContent(/could not reach the food catalog/i);
    expect(text).not.toHaveTextContent(/add it yourself/i);
  });
});

/**
 * A stale answer must not render under a newer query.
 *
 * **The window is the debounce, not the request.** While the 250ms timer is
 * still pending, `searching` is false and no new request has started — so
 * without the query/answer pairing the previous answer is fully rendered
 * beneath text it does not answer, and an athlete typing "chicken" reads "No
 * chick in the food catalog yet".
 *
 * The first version of this test advanced past the debounce into a pending
 * request, where `searching` is true and the empty block is gated off anyway —
 * so it passed with the pairing REMOVED. Caught by checking that the mutation
 * applied and the suite still went green, which is the only way to tell a
 * guard from a decoration.
 */
it('never renders an answer to a query that is no longer typed', async () => {
  mockSearchCatalog.mockResolvedValue(answer({ outcome: 'no_match' }));
  render(<AddFoodScreen />);
  fireEvent.changeText(screen.getByTestId('add-search'), 'chick');
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  await waitFor(() => expect(screen.getByTestId('add-catalog-empty')).toBeTruthy());
  expect(screen.getByTestId('add-catalog-empty')).toHaveTextContent(/chick/);

  // Inside the debounce: nothing has been asked yet, and the old answer must
  // already be gone rather than lingering under the new text.
  fireEvent.changeText(screen.getByTestId('add-search'), 'chicken');
  await act(async () => {
    jest.advanceTimersByTime(100);
  });
  expect(screen.queryByTestId('add-catalog-empty')).toBeNull();
});

/** A capped list must say it is capped rather than imply it is everything. */
it('says how many of the total it is showing', async () => {
  mockSearchCatalog.mockResolvedValue(
    answer({ foods: [CATALOG_OATS], total: 63, outcome: 'ok' }),
  );
  await search('oats');
  await waitFor(() => expect(screen.getByTestId('add-catalog-more')).toBeTruthy());
  expect(screen.getByTestId('add-catalog-more')).toHaveTextContent(/1 of 63/);
});
