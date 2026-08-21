import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { IngredientPicker } from '@/components/food/IngredientPicker';

/**
 * N87 — picking one ingredient out of a 12,651-food catalog, on a phone.
 *
 * This is the first authoring surface built on the catalog, and the state model
 * is the whole risk. **An empty answer has five meanings and only one is about
 * the food** — so what is pinned here is that they stay five, and that "nothing
 * typed yet" is not one of them.
 */

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

const mockLocalFoods = jest.fn();
jest.mock('@/lib/foodLog', () => ({ localFoods: (...a: unknown[]) => mockLocalFoods(...a) }));

const CATALOG_RICE = {
  id: 'usda-rice',
  name: 'Rice, white, long-grain, raw',
  brand: '',
  category: 'grain',
  serving_label: '100 g',
  serving_grams: 100,
  kcal: 365,
  protein_g: 7.1,
  carb_g: 80,
  fat_g: 0.7,
  fibre_g: 1.3,
};

function answer(over: Record<string, unknown> = {}) {
  return { foods: [], total: 0, outcome: 'no_match', coverage: null, ...over };
}

let onPick: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  onPick = jest.fn();
  mockLocalFoods.mockReset().mockResolvedValue([]);
  mockSearchCatalog.mockReset().mockResolvedValue(answer());
  mockFetchCatalogFood.mockReset().mockRejectedValue(new Error('offline'));
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

function mount() {
  return render(
    <IngredientPicker
      userId="u1"
      getToken={async () => 'tok'}
      onPick={onPick}
      onCancel={jest.fn()}
    />,
  );
}

async function type(text: string) {
  fireEvent.changeText(screen.getByTestId('ingredient-search'), text);
  await act(async () => { jest.advanceTimersByTime(300); });
}

describe('the five meanings of an empty answer', () => {
  /**
   * The one that matters most, and the one that has shipped wrong twice in this
   * app in a single day. Before anything is typed, NOTHING HAS BEEN ASKED — so
   * the screen must not report a result. "No ingredients found" over an empty
   * search box is a confident answer to a question nobody put.
   */
  it('does not report a result before anything has been asked', async () => {
    mount();
    await act(async () => { jest.advanceTimersByTime(300); });

    expect(screen.getByTestId('ingredient-idle')).toBeTruthy();
    expect(screen.queryByTestId('ingredient-empty')).toBeNull();
    expect(mockSearchCatalog).not.toHaveBeenCalled();
  });

  it('says the catalog does not have it when the catalog says so', async () => {
    mount();
    await type('unobtainium');
    await waitFor(() => expect(screen.getByTestId('ingredient-empty')).toBeTruthy());
    expect(screen.queryByTestId('ingredient-idle')).toBeNull();
  });

  /**
   * `catalog_empty` is OUR failure — a deploy that never seeded — and reporting
   * it as a missing food would send every athlete off to type their whole
   * recipe by hand while nothing ever surfaced the real cause. The two
   * sentences must differ.
   */
  it('distinguishes an unseeded catalog from a food it does not have', async () => {
    mount();
    await type('rice');
    await waitFor(() => expect(screen.getByTestId('ingredient-empty')).toBeTruthy());
    const noMatch = screen.getByTestId('ingredient-empty').props.children;

    mockSearchCatalog.mockResolvedValue(answer({ outcome: 'catalog_empty' }));
    await type('rice again');
    await waitFor(() =>
      expect(screen.getByTestId('ingredient-empty').props.children).not.toEqual(noMatch),
    );
  });

  /**
   * A transport failure is a SIXTH case that sits outside the enum. It throws,
   * so it must never render as an empty catalog — that would tell the athlete we
   * do not stock a food we simply could not ask about. And it has to say that
   * their own saved foods still work, because they do.
   */
  it('does not report a network failure as a food the catalog lacks', async () => {
    mockSearchCatalog.mockRejectedValue(new Error('offline'));
    mount();
    await type('rice');
    await waitFor(() =>
      expect(screen.getByTestId('ingredient-empty')).toHaveTextContent(/Could not reach/),
    );
  });

  /**
   * The dedupe bug this repo has already shipped and fixed once, arriving on a
   * new surface. When every catalog row collides with something the athlete has
   * already saved — the mainline case for anyone with common foods saved — the
   * answer is `ok` and the catalog answered perfectly. Gating the empty state on
   * the POST-dedupe list renders "the catalog could not answer that one"
   * directly beneath the saved row that just answered it.
   */
  it('says nothing at all when every catalog row was already saved', async () => {
    mockLocalFoods.mockResolvedValue([
      {
        id: 'own-1', kind: 'food', name: 'Rice, white, long-grain, raw', brand: '',
        serving_label: '100 g', serving_grams: 100,
        kcal: 365, protein_g: 7.1, carb_g: 80, fat_g: 0.7, fibre_g: 1.3,
        yield_servings: null, items: [],
      },
    ]);
    mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_RICE], total: 1, outcome: 'ok' }));

    mount();
    await type('rice');

    await waitFor(() => expect(screen.getByTestId('ingredient-mine-own-1')).toBeTruthy());
    expect(screen.queryByTestId('ingredient-empty')).toBeNull();
    expect(screen.queryByTestId(`ingredient-catalog-row-${CATALOG_RICE.id}`)).toBeNull();
  });
});

describe('picking from the catalog', () => {
  beforeEach(() => {
    mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_RICE], total: 1, outcome: 'ok' }));
  });

  it('offers the catalog row as a card', async () => {
    mount();
    await type('rice');
    await waitFor(() =>
      expect(screen.getByTestId(`ingredient-catalog-row-${CATALOG_RICE.id}`)).toBeTruthy(),
    );
  });

  /**
   * **No `+` circle on an ingredient card, and that is the decision rather than
   * an omission.** On the quick-add sheet the circle logs one reference serving
   * — a sensible default for a meal. There is no such default for an
   * ingredient: "some rice" is not a recipe, so the circle would either guess
   * 100 g silently or do nothing at all. This repo already refuses "a chip that
   * filters nothing"; this is the same rule.
   */
  it('offers no one-tap add, because there is no honest default amount', async () => {
    mount();
    await type('rice');
    await waitFor(() =>
      expect(screen.getByTestId(`ingredient-catalog-row-${CATALOG_RICE.id}`)).toBeTruthy(),
    );
    expect(screen.queryByTestId(`ingredient-catalog-${CATALOG_RICE.id}`)).toBeNull();
  });

  it('asks how much, and hands back what was weighed', async () => {
    mount();
    await type('rice');
    await waitFor(() =>
      expect(screen.getByTestId(`ingredient-catalog-row-${CATALOG_RICE.id}`)).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId(`ingredient-catalog-row-${CATALOG_RICE.id}`));
    });
    await waitFor(() => expect(screen.getByTestId('food-quantity-log')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId('food-quantity-log')); });

    expect(onPick).toHaveBeenCalledTimes(1);
    const item = onPick.mock.calls[0][0];
    expect(item.serving_label).toBe('100 g');
    expect(item.quantity).toBe(1);
    expect(item.kcal).toBeCloseTo(365);
    // A catalog slug is not a foreign key into the athlete's own foods.
    expect(item.source_food_id).toBeNull();
  });

  /**
   * The button on the quantity step says what it DOES. Reusing the log sheet
   * verbatim would tell the athlete a meal had been recorded when nothing had —
   * which is the same class as a card that says "Log X" and opens a sheet.
   */
  it('does not claim to have logged a meal', async () => {
    mount();
    await type('rice');
    await waitFor(() =>
      expect(screen.getByTestId(`ingredient-catalog-row-${CATALOG_RICE.id}`)).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId(`ingredient-catalog-row-${CATALOG_RICE.id}`));
    });
    await waitFor(() => expect(screen.getByTestId('food-quantity-log')).toBeTruthy());
    expect(screen.getByTestId('food-quantity-log')).toHaveTextContent(/Add to recipe/);
  });
});

describe('picking from your own saved foods', () => {
  const saved = {
    id: 'own-2', kind: 'food' as const, name: 'Skyr', brand: 'Arla',
    serving_label: '100 g', serving_grams: 100,
    kcal: 63, protein_g: 11, carb_g: 4, fat_g: 0.2, fibre_g: null,
    yield_servings: null, items: [],
  };

  it('keeps the provenance, unlike a catalog row', async () => {
    mockLocalFoods.mockResolvedValue([saved]);
    mount();
    await waitFor(() => expect(screen.getByTestId('ingredient-mine-own-2')).toBeTruthy());

    await act(async () => { fireEvent.press(screen.getByTestId('ingredient-mine-own-2')); });
    await waitFor(() => expect(screen.getByTestId('ingredient-saved-add')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('ingredient-saved-quantity'), '2');
    await act(async () => { fireEvent.press(screen.getByTestId('ingredient-saved-add')); });

    const item = onPick.mock.calls[0][0];
    expect(item.source_food_id).toBe('own-2');
    expect(item.quantity).toBe(2);
    // Per-label macros, NOT pre-multiplied — `perServing` applies the quantity,
    // and doing it in both places doubles the ingredient silently.
    expect(item.kcal).toBe(63);
  });

  /**
   * A recipe inside a recipe would need the server to derive one set of figures
   * from another's already-derived ones, and nothing models that. Offering it
   * and then failing on save is worse than not offering it.
   */
  it('does not offer a recipe as an ingredient', async () => {
    mockLocalFoods.mockResolvedValue([
      saved,
      { ...saved, id: 'own-3', kind: 'recipe' as const, name: 'Traybake', yield_servings: 4 },
    ]);
    mount();
    await waitFor(() => expect(screen.getByTestId('ingredient-mine-own-2')).toBeTruthy());
    expect(screen.queryByTestId('ingredient-mine-own-3')).toBeNull();
  });

  it('refuses a quantity of zero rather than adding nothing', async () => {
    mockLocalFoods.mockResolvedValue([saved]);
    mount();
    await waitFor(() => expect(screen.getByTestId('ingredient-mine-own-2')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId('ingredient-mine-own-2')); });
    await waitFor(() => expect(screen.getByTestId('ingredient-saved-add')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('ingredient-saved-quantity'), '0');
    await act(async () => { fireEvent.press(screen.getByTestId('ingredient-saved-add')); });
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('the search itself', () => {
  /**
   * Without this the results for "chi" flash under "chicken breast" as requests
   * land out of order — and the athlete adds the wrong ingredient to a recipe
   * they will cook for weeks.
   */
  it('never renders an answer to a query that is no longer typed', async () => {
    mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_RICE], total: 1, outcome: 'ok' }));
    mount();
    await type('rice');
    await waitFor(() =>
      expect(screen.getByTestId(`ingredient-catalog-row-${CATALOG_RICE.id}`)).toBeTruthy(),
    );

    // Retype without letting the new answer land.
    fireEvent.changeText(screen.getByTestId('ingredient-search'), 'chicken');
    expect(screen.queryByTestId(`ingredient-catalog-row-${CATALOG_RICE.id}`)).toBeNull();
  });

  it('is honest about the cap, counting what is actually on screen', async () => {
    mockSearchCatalog.mockResolvedValue(answer({ foods: [CATALOG_RICE], total: 63, outcome: 'ok' }));
    mount();
    await type('rice');
    await waitFor(() =>
      expect(screen.getByTestId('ingredient-catalog-more')).toHaveTextContent(/Showing 1 of 63/),
    );
  });
});
