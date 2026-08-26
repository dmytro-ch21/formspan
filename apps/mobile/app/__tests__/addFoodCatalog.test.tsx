import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { glyphFor } from '@/lib/foodGlyph';

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
const mockFetchCatalogFood = jest.fn();
jest.mock('@/lib/catalogApi', () => {
  const real = jest.requireActual('@/lib/catalogApi');
  return {
    ...real,
    searchCatalog: (...a: unknown[]) => mockSearchCatalog(...a),
    fetchCatalogFood: (...a: unknown[]) => mockFetchCatalogFood(...a),
  };
});

const mockPush = jest.fn();
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
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

const CATALOG_OATS = {
  id: 'usda-1',
  name: 'Oats, rolled',
  brand: '',
  // 'grain', not 'grains' — the seed's vocabulary. The typo made every card
  // in this suite render the NEUTRAL plate, which quietly vacated the
  // screen-reader assertion below: it checked that 🌾 was absent, and 🌾 was
  // never rendered in any form. Caught in review.
  category: 'grain',
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
  mockPush.mockReset();
  mockLocalFoods.mockReset().mockResolvedValue([]);
  mockLogFood.mockReset().mockResolvedValue('entry-1');
  mockSearchCatalog.mockReset().mockResolvedValue(answer());
  // Rejects by default, which is the OFFLINE case — the quantity step must
  // still work without portions, because 100 g is always offered. A test that
  // needs portions overrides this.
  mockFetchCatalogFood.mockReset().mockRejectedValue(new Error('offline'));
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
/**
 * Tap a catalog CARD BODY and log through the quantity step.
 *
 * Two controls live on a card since N58 met N90, and they do different things:
 * `add-catalog-row-<id>` is the body and opens the quantity sheet;
 * `add-catalog-<id>` is the `+`, which logs one reference serving in a single
 * tap. Press the wrong one and the assertion still passes for the wrong reason.
 *
 * The body's press opens the quantity step rather than logging outright, so a
 * log through it is two presses. The default quantity is the
 * first option offered, which for a food with no portions is 100 g — which is
 * what the pre-N90 behaviour logged, so the macro assertions below still mean
 * what they meant.
 */
async function logCatalogRow(testID: string) {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
  await waitFor(() => expect(screen.getByTestId('food-quantity-log')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByTestId('food-quantity-log'));
  });
}

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
  await logCatalogRow('add-catalog-row-usda-1');
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

/**
 * What the card says is what the diary records.
 *
 * The original defect was a row showing the bare name while the log recorded
 * brand-plus-name, so a tap on one thing put another in the diary. N58's card
 * shows the two as SEPARATE elements — name, brand muted beneath — so they are
 * no longer one text node, and the invariant is now that both parts are on the
 * card and the logged name composes exactly them. Asserting the old single
 * string would have failed for the right reason and been "fixed" by weakening
 * it; this is the same claim re-expressed against the new layout.
 */
it('shows both name and brand, and logs their composition', async () => {
  mockSearchCatalog.mockResolvedValue(
    answer({
      foods: [{ ...CATALOG_OATS, id: 'usda-9', name: 'Greek Yogurt', brand: 'Fage' }],
      total: 1,
      outcome: 'ok',
    }),
  );
  await search('greek');
  await waitFor(() => expect(screen.getByTestId('add-catalog-usda-9')).toBeTruthy());
  // Both halves visible, as two elements.
  expect(screen.getByText('Greek Yogurt')).toBeTruthy();
  expect(screen.getByText('Fage')).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByTestId('add-catalog-usda-9'));
  });
  // And the diary gets exactly what the card showed, composed.
  expect(mockLogFood.mock.calls[0][1].name).toBe('Fage Greek Yogurt');
});

/** A generic food has no brand line at all, rather than an empty one. */
it('omits the brand line entirely for a generic food', async () => {
  mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_OATS], total: 1, outcome: 'ok' }));
  await search('oats');
  await waitFor(() => expect(screen.getByTestId('add-catalog-usda-1')).toBeTruthy());
  expect(screen.getByText('Oats, rolled')).toBeTruthy();
  // Every seeded USDA food is generic, so an empty brand line would be the
  // common case rather than the exception.
  expect(screen.queryByText('')).toBeNull();
});

/**
 * The serving line carries its unit. A calorie figure without one is the thing
 * that makes a list of foods unscannable — 182 against 456 means nothing until
 * you know one is per 100 g and the other per bar.
 */
it('states the calories WITH the serving they belong to', async () => {
  mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_OATS], total: 1, outcome: 'ok' }));
  await search('oats');
  await waitFor(() => expect(screen.getByTestId('add-catalog-usda-1')).toBeTruthy());
  expect(screen.getByText('389 cals per 100 g')).toBeTruthy();
});

/**
 * The glyph is derived from the CATEGORY. This pins that the card renders one
 * at all and that it is the category's, not a name-derived guess — the
 * substitution `foodGlyph` exists to prevent.
 */
it('shows the category glyph, not one guessed from the name', async () => {
  mockSearchCatalog.mockResolvedValue(
    answer({
      foods: [{ ...CATALOG_OATS, id: 'usda-7', name: 'Beef-flavoured tofu', category: 'plant_protein' }],
      total: 1,
      outcome: 'ok',
    }),
  );
  await search('tofu');
  await waitFor(() => expect(screen.getByTestId('add-catalog-usda-7')).toBeTruthy());
  // `includeHiddenElements` because the glyph is deliberately hidden from the
  // accessibility tree, and RNTL's queries exclude hidden elements by default.
  // Needing this option IS the evidence that the hiding works.
  const glyph = screen.getByTestId('add-catalog-glyph-usda-7', { includeHiddenElements: true });
  expect(glyph).toHaveTextContent(glyphFor('plant_protein'));
  expect(glyph).not.toHaveTextContent(glyphFor('red_meat'));
});

/**
 * The glyph is decoration and must not be announced. A screen reader reading
 * "seedling, Beef-flavoured tofu" before every row is noise in the one place a
 * list has to be fast to move through — and it is the name that carries the
 * meaning.
 *
 * Asserted via `getByText`, which excludes accessibility-hidden elements by
 * default: the glyph is findable by testID and NOT by text, which is exactly
 * the pair of facts wanted.
 */
it('does not announce the glyph to a screen reader', async () => {
  mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_OATS], total: 1, outcome: 'ok' }));
  await search('oats');
  await waitFor(() => expect(screen.getByTestId('add-catalog-usda-1')).toBeTruthy());
  // Present in the tree...
  expect(
    screen.getByTestId('add-catalog-glyph-usda-1', { includeHiddenElements: true }),
  ).toBeTruthy();
  // ...and absent from every query that respects accessibility, which is what a
  // screen reader walks. Both halves matter: the first alone would pass with
  // the glyph removed, the second alone would pass with it never rendered.
  expect(screen.queryByTestId('add-catalog-glyph-usda-1')).toBeNull();
  expect(screen.queryByText(glyphFor('grain'))).toBeNull();
});

/**
 * The wiring N90 added, which neither the component test nor the logic test can
 * see: that the grams chosen in the sheet reach `logFood` as a scaled entry.
 *
 * Before this, a tap logged one 100 g serving whatever the athlete ate.
 */
it('logs the quantity the athlete chose, scaled', async () => {
  mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_OATS], total: 1, outcome: 'ok' }));
  // The single-food fetch is what carries portions; search never does.
  mockFetchCatalogFood.mockResolvedValue({
    ...CATALOG_OATS,
    portions: [{ seq: 1, label: '1 cup', grams: 81 }],
  });
  await search('oats');
  await waitFor(() => expect(screen.getByTestId('add-catalog-usda-1')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByTestId('add-catalog-row-usda-1'));
  });
  // The portion arrives from the follow-up fetch, so it is not on screen at the
  // moment of the tap.
  await waitFor(() => expect(screen.getByTestId('food-portion-81')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByTestId('food-portion-81'));
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('food-quantity-log'));
  });

  const entry = mockLogFood.mock.calls[0][1];
  // 81g of a per-100g food: 0.81 servings, and the macros scaled to match
  // rather than the full 389 kcal the old code logged.
  expect(entry.servings).toBeCloseTo(0.81, 2);
  expect(entry.kcal).toBeCloseTo(315.1, 1);
  expect(entry.kcal).toBeLessThan(CATALOG_OATS.kcal);
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

describe('the scope row', () => {
  const SAVED_FOOD = {
    id: 'mine-food', kind: 'food', name: 'Porridge', brand: '', serving_label: '40 g',
    serving_grams: 40, kcal: 150, protein_g: 5, carb_g: 26, fat_g: 3, fibre_g: 4,
  };
  const SAVED_RECIPE = {
    id: 'mine-recipe', kind: 'recipe', name: 'Chilli', brand: '', serving_label: '1 portion',
    serving_grams: 350, kcal: 520, protein_g: 38, carb_g: 44, fat_g: 18, fibre_g: 9,
  };

  beforeEach(() => {
    mockLocalFoods.mockResolvedValue([SAVED_FOOD, SAVED_RECIPE]);
    mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_OATS], total: 1, outcome: 'ok' }));
  });

  it('shows both sources under All', async () => {
    await search('o');
    await waitFor(() => expect(screen.getByTestId('add-catalog-usda-1')).toBeTruthy());
    expect(screen.getByTestId('add-food-mine-food')).toBeTruthy();
  });

  /** The catalog is an additional source; My Foods is the athlete's own. */
  it('hides the catalog under My Foods', async () => {
    await search('o');
    await waitFor(() => expect(screen.getByTestId('add-catalog-usda-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-scope-mine'));
    });
    expect(screen.queryByTestId('add-catalog-usda-1')).toBeNull();
    expect(screen.getByTestId('add-food-mine-food')).toBeTruthy();
  });

  /**
   * **A recipe's Edit must not open the saved-food editor (N87).**
   *
   * That screen edits per-serving macros and knows nothing about a yield or an
   * ingredient list, so saving a recipe through it pushed `kind: 'recipe'` with
   * no `yield_servings` — which the server refuses with a 400, which the outbox
   * classifies as a PERMANENT rejection. The row left the queue, the edit lived
   * only on the phone, and nothing anywhere said so.
   *
   * The pair of assertions is the guard: routing everything to the recipe
   * editor would satisfy the first half and break every plain saved food.
   */
  it('sends a recipe to the recipe editor and a food to the food editor', async () => {
    await search('o');
    await waitFor(() => expect(screen.getByTestId('add-food-edit-mine-recipe')).toBeTruthy());

    fireEvent.press(screen.getByTestId('add-food-edit-mine-recipe'));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/food/recipe/[id]',
      params: { id: 'mine-recipe' },
    });

    fireEvent.press(screen.getByTestId('add-food-edit-mine-food'));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/food/saved/[id]',
      params: { id: 'mine-food' },
    });
  });

  /**
   * Recipe authoring has to be REACHABLE, which is the acceptance criterion the
   * whole ticket turns on. It sits under `Recipes`, where somebody looking for
   * one already is, and nowhere else — an entry point on every scope would put
   * "build a recipe" under a search for yoghurt.
   */
  it('offers a way to build one, under Recipes', async () => {
    await search('o');
    await waitFor(() => expect(screen.getByTestId('add-food-mine-food')).toBeTruthy());
    expect(screen.queryByTestId('add-new-recipe')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('add-scope-recipes'));
    });
    expect(screen.getByTestId('add-new-recipe')).toBeTruthy();

    fireEvent.press(screen.getByTestId('add-new-recipe'));
    const [target] = mockPush.mock.calls[mockPush.mock.calls.length - 1];
    expect(target.pathname).toBe('/food/recipe/[id]');
    // `fresh` is explicit rather than inferred from "not found", which is how a
    // deleted recipe reopens as a blank form under its own id.
    expect(target.params.fresh).toBe('1');
    // A client-generated id is what makes the save idempotent.
    expect(target.params.id).toEqual(expect.any(String));
    expect(target.params.id.length).toBeGreaterThan(0);
  });

  /** Recipes reads the STORED kind rather than guessing from the name. */
  it('shows only recipes under Recipes', async () => {
    await search('o');
    await waitFor(() => expect(screen.getByTestId('add-food-mine-food')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-scope-recipes'));
    });
    expect(screen.getByTestId('add-food-mine-recipe')).toBeTruthy();
    expect(screen.queryByTestId('add-food-mine-food')).toBeNull();
    expect(screen.queryByTestId('add-catalog-usda-1')).toBeNull();
  });

  /**
   * The two chips the design asked for that are NOT built.
   *
   * `Meals` has no backing — a food's kind is `food | recipe` and nothing
   * models a meal — and a `verified-only` filter would filter on a field that
   * exists nowhere. A chip that filters nothing is an affordance that lies, and
   * an athlete cannot tell it from a filter that found nothing. Asserted so
   * that adding one later is a deliberate act with data behind it rather than
   * a quiet completion of the mockup.
   */
  it('offers no chip that nothing backs', async () => {
    render(<AddFoodScreen />);
    expect(screen.queryByTestId('add-scope-meals')).toBeNull();
    expect(screen.queryByTestId('add-scope-verified')).toBeNull();
  });
});

/**
 * N59 — photograph, describe and scan used to be two unrelated rows below the
 * results; this is the one place all three are presented together.
 */
describe('the grouped add-food choice', () => {
  it('offers all three ways in, together', async () => {
    render(<AddFoodScreen />);
    expect(screen.getByTestId('add-scan')).toBeTruthy();
    expect(screen.getByTestId('add-photograph')).toBeTruthy();
    expect(screen.getByTestId('add-describe')).toBeTruthy();
  });

  it('sends scan to the barcode screen', async () => {
    render(<AddFoodScreen />);
    fireEvent.press(screen.getByTestId('add-scan'));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/food/scan'));
  });

  it('sends photograph to the describe screen with photo=1, so the camera opens immediately', async () => {
    render(<AddFoodScreen />);
    fireEvent.press(screen.getByTestId('add-photograph'));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/food/describe?photo=1'));
  });

  it('sends describe to the describe screen WITHOUT photo=1', async () => {
    render(<AddFoodScreen />);
    fireEvent.press(screen.getByTestId('add-describe'));
    const dest = mockPush.mock.calls[0][0] as string;
    expect(dest).toContain('/food/describe?meal=');
    expect(dest).not.toContain('photo=1');
  });
});

/**
 * N59 — the picking view's own nutrition panel and meal picker, and the
 * sticky confirm bar that survives them both.
 */
describe('the picking view', () => {
  it('shows the nutrition panel, recalculated at the chosen portion', async () => {
    mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_OATS], total: 1, outcome: 'ok' }));
    await search('oats');
    await waitFor(() => expect(screen.getByTestId('add-catalog-usda-1')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('add-catalog-row-usda-1'));
    });

    // Default quantity for a food with no portions loaded yet is 100 g — the
    // panel should show CATALOG_OATS' own per-100g calories.
    await waitFor(() =>
      expect(screen.getByTestId('nutrition-panel-kcal').props.children).toBe(CATALOG_OATS.kcal),
    );
  });

  it('offers the meal picker, so the athlete can change it without leaving the sheet', async () => {
    mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_OATS], total: 1, outcome: 'ok' }));
    await search('oats');
    await waitFor(() => expect(screen.getByTestId('add-catalog-usda-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-catalog-row-usda-1'));
    });
    await waitFor(() => expect(screen.getByTestId('food-quantity-meal-breakfast')).toBeTruthy());
    expect(screen.getByTestId('food-quantity-meal-dinner')).toBeTruthy();
  });

  it('keeps the confirm button reachable — it lives in the sticky footer, not the scroll content', async () => {
    mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_OATS], total: 1, outcome: 'ok' }));
    await search('oats');
    await waitFor(() => expect(screen.getByTestId('add-catalog-usda-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('add-catalog-row-usda-1'));
    });
    // `FoodQuantity`'s own inline Log button is suppressed (`hideBuiltInFooter`)
    // — there must be exactly one confirm button, the sticky one.
    await waitFor(() => expect(screen.getByTestId('food-quantity-log')).toBeTruthy());
    expect(screen.queryAllByTestId('food-quantity-log')).toHaveLength(1);
  });
});
