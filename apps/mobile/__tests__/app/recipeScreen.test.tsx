import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import RecipeScreen from '../../app/food/recipe/[id]';

/**
 * N87 — building and correcting a recipe on the phone.
 *
 * What is pinned here is the WIRING and the COPY: which state the screen is in,
 * what it refuses, and what it tells the author about their own history. The
 * arithmetic is `lib/__tests__/recipe.test.ts` and the storage is
 * `recipeStore.test.ts`; neither can see the thing that actually broke the last
 * two screens like this, which is a screen asking the wrong source or
 * collapsing two states into one.
 */

/** See `addFoodCatalog.test.tsx`: a `mock`-prefixed binding rather than a
 *  `require` inside the factory, which the lint ratchet will not absorb. */
const mockUseEffect = useEffect;

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockLocalFood = jest.fn();
const mockSaveFoodLocally = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  localFood: (...a: unknown[]) => mockLocalFood(...a),
  localFoods: jest.fn(async () => []),
  saveFoodLocally: (...a: unknown[]) => mockSaveFoodLocally(...a),
  // N116/#505: unblocked by default — synced, and nothing owed.
  foodSyncState: jest.fn(async () => ({ unsynced: false, owed: false })),
}));

jest.mock('@/lib/catalogApi', () => {
  const real = jest.requireActual('@/lib/catalogApi');
  return {
    ...real,
    searchCatalog: jest.fn(async () => ({
      foods: [], total: 0, outcome: 'no_match', coverage: null,
    })),
    fetchCatalogFood: jest.fn(async () => { throw new Error('offline'); }),
  };
});

jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

const mockBack = jest.fn();
let mockParams: Record<string, string> = { id: 'r1' };
jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn(), back: mockBack, replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

function recipe(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    kind: 'recipe',
    name: 'Chicken and rice traybake',
    brand: '',
    serving_label: '1 portion',
    serving_grams: null,
    kcal: 425,
    protein_g: 50,
    carb_g: 39,
    fat_g: 6,
    fibre_g: 0.7,
    yield_servings: 4,
    items: [
      {
        name: 'Chicken breast', quantity: 1, serving_label: '600 g',
        kcal: 990, protein_g: 186, carb_g: 0, fat_g: 21.6, fibre_g: null,
        source_food_id: null,
      },
      {
        name: 'Basmati rice, dry', quantity: 2, serving_label: '100 g',
        kcal: 356, protein_g: 8.1, carb_g: 79, fat_g: 0.9, fibre_g: 1.4,
        source_food_id: null,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  mockParams = { id: 'r1' };
  mockBack.mockReset();
  mockLocalFood.mockReset().mockResolvedValue(recipe());
  mockSaveFoodLocally.mockReset().mockResolvedValue('r1');
});

describe('which state the screen is in', () => {
  /**
   * The empty-vs-unknown collapse, and the reason this screen has four states
   * rather than three. Before the database answers, the screen knows NOTHING —
   * and "we have not looked yet" must not render as "that recipe is gone",
   * which is the sentence a three-state union produces on every single open.
   *
   * This is the exact failure that shipped twice in this app in one day: a
   * trend card telling an athlete with two years of data to start logging, and
   * a tracker screen telling someone with a month of history they track
   * nothing.
   */
  it('does not claim a recipe is missing before it has looked', async () => {
    let settle: (v: unknown) => void = () => {};
    mockLocalFood.mockReturnValue(new Promise((res) => { settle = res; }));

    render(<RecipeScreen />);

    expect(screen.getByTestId('recipe-loading')).toBeTruthy();
    expect(screen.queryByTestId('recipe-missing')).toBeNull();

    await act(async () => { settle(recipe()); });
    await waitFor(() => expect(screen.getByTestId('recipe-name')).toBeTruthy());
  });

  /**
   * And the other half: an id that genuinely is not here has to SAY so rather
   * than open a blank form. Silently treating "absent" as "new" would have the
   * athlete rebuild a recipe under the id of one that no longer exists, and
   * never learn the first had gone.
   */
  it('says so when the recipe is not on this phone', async () => {
    mockLocalFood.mockResolvedValue(null);
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByTestId('recipe-missing')).toBeTruthy());
    expect(screen.queryByTestId('recipe-name')).toBeNull();
  });

  /**
   * A `fresh` recipe never consults the database at all. If it did, the empty
   * answer would be indistinguishable from the deleted one above — which is
   * how "new" and "missing" collapse into each other.
   */
  it('opens a blank editor for a new recipe without asking the database', async () => {
    mockParams = { id: 'r2', fresh: '1' };
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByTestId('recipe-name')).toBeTruthy());
    expect(mockLocalFood).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recipe-missing')).toBeNull();
  });

  it('refuses a saved food that is not a recipe', async () => {
    // `food/saved/[id]` owns a plain food. Editing one here would offer a yield
    // and an ingredient list for something that has neither, and saving it
    // would turn a food into a recipe by accident.
    mockLocalFood.mockResolvedValue({ ...recipe(), kind: 'food', yield_servings: null, items: [] });
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByTestId('recipe-missing')).toBeTruthy());
  });
});

describe('editing an existing recipe', () => {
  it('loads the ingredients that are in it', async () => {
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByText('Chicken breast')).toBeTruthy());
    expect(screen.getByText('Basmati rice, dry')).toBeTruthy();
  });

  it('shows what one portion contains', async () => {
    render(<RecipeScreen />);
    // (990 x 1 + 356 x 2) / 4 = 425.5
    await waitFor(() => expect(screen.getByTestId('recipe-per-kcal')).toHaveTextContent('426 kcal'));
  });

  /**
   * A quantity of 1 reads as the label alone — "600 g", not "1 × 600 g" — and a
   * quantity above 1 shows the multiplication. Rendering `1 ×` everywhere is
   * the kind of small dishonesty that makes an ingredient list read like a
   * spreadsheet.
   */
  it('shows the quantity only when there is one to show', async () => {
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByText('600 g')).toBeTruthy());
    expect(screen.getByText('2 × 100 g')).toBeTruthy();
  });

  /**
   * **The design decision, pinned as copy.** An author who assumes a correction
   * propagates is wrong about their own history, and the only moment that
   * matters is while they are editing. If this sentence goes, the behaviour is
   * unchanged and undiscoverable — which is worse than either alternative.
   */
  it('tells the author that meals already logged keep their numbers', async () => {
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByTestId('recipe-history-note')).toBeTruthy());
    expect(screen.getByTestId('recipe-history-note')).toHaveTextContent(
      /keep the numbers they were\s+logged with/,
    );
  });

  it('saves under the id it was opened with, so a retry is the same row', async () => {
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByTestId('recipe-save')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId('recipe-save')); });

    expect(mockSaveFoodLocally).toHaveBeenCalledTimes(1);
    const [, food] = mockSaveFoodLocally.mock.calls[0];
    expect(food.id).toBe('r1');
    expect(food.kind).toBe('recipe');
    expect(food.yield_servings).toBe(4);
    expect(food.items).toHaveLength(2);
  });

  /**
   * The omission guard, at the screen. `saveFoodLocally` accepts a draft that
   * leaves `items` unsaid — correct for a plain food — so a screen that forgot
   * to pass them would save a recipe with no ingredients, and the server would
   * derive 0 kcal per portion from it. Nothing would throw.
   */
  it('never saves a recipe without the ingredients it is showing', async () => {
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByTestId('recipe-save')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId('recipe-save')); });

    const [, food] = mockSaveFoodLocally.mock.calls[0];
    expect(food.items.map((i: { name: string }) => i.name)).toEqual([
      'Chicken breast',
      'Basmati rice, dry',
    ]);
  });
});

describe('what it refuses to save', () => {
  /**
   * A recipe with nothing in it derives to 0 kcal per portion and saves
   * perfectly happily — so the athlete would own a "meal" that logs as nothing.
   * That is an empty answer wearing the clothes of a real one.
   */
  it('refuses a recipe with no ingredients, and says why', async () => {
    mockParams = { id: 'r2', fresh: '1' };
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByTestId('recipe-name')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('recipe-name'), 'Empty pot');

    expect(screen.getByTestId('recipe-problem')).toHaveTextContent(/at least one ingredient/);
    // **The disabled STATE, asserted separately from the press.**
    //
    // Mutation testing found this: removing the `problem` check from inside
    // `save()` left every test here green, because a disabled `Pressable` never
    // fires `onPress` at all — so pressing it proves the button is disabled and
    // says nothing about the guard behind it. The two are asserted apart now,
    // and a `disabled` prop that stopped tracking `problem` goes red here
    // rather than silently making the refusal cosmetic.
    expect(screen.getByTestId('recipe-save').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    await act(async () => { fireEvent.press(screen.getByTestId('recipe-save')); });
    expect(mockSaveFoodLocally).not.toHaveBeenCalled();
  });

  it('enables the button again once the problem is fixed', async () => {
    // The other half, and it is what stops the assertion above being satisfied
    // by a button that is ALWAYS disabled — which would pass every refusal test
    // in this block while making the screen unusable.
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByTestId('recipe-save')).toBeTruthy());
    expect(screen.getByTestId('recipe-save').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: false }),
    );
  });

  it('refuses a recipe with no name, and blames the name rather than the pot', async () => {
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByTestId('recipe-name')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('recipe-name'), '   ');

    expect(screen.getByTestId('recipe-problem')).toHaveTextContent(/name/i);
    await act(async () => { fireEvent.press(screen.getByTestId('recipe-save')); });
    expect(mockSaveFoodLocally).not.toHaveBeenCalled();
  });

  /**
   * A yield of zero is what an empty field parses to, and it is the one that
   * would divide by zero. The screen must refuse it rather than render
   * "Infinity kcal" over a form somebody is still filling in.
   */
  it('refuses an empty yield rather than dividing by it', async () => {
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByTestId('recipe-yield')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('recipe-yield'), '');

    expect(screen.getByTestId('recipe-problem')).toHaveTextContent(/how many portions/i);
    expect(screen.getByTestId('recipe-per-kcal')).toHaveTextContent('0 kcal');
  });

  it('accepts a complete recipe', async () => {
    render(<RecipeScreen />);
    await waitFor(() => expect(screen.getByTestId('recipe-save')).toBeTruthy());
    expect(screen.queryByTestId('recipe-problem')).toBeNull();
  });
});

describe('fibre', () => {
  /**
   * Not stated is not zero, and the screen has to say which. A recipe whose
   * ingredients never mention fibre is not a fibre-free recipe — nobody said —
   * and rendering `0 fibre` is a claim the data does not support.
   */
  it('says fibre is not stated when no ingredient stated it', async () => {
    mockLocalFood.mockResolvedValue(
      recipe({
        items: [
          {
            name: 'Chicken breast', quantity: 1, serving_label: '600 g',
            kcal: 990, protein_g: 186, carb_g: 0, fat_g: 21.6, fibre_g: null,
            source_food_id: null,
          },
        ],
      }),
    );
    render(<RecipeScreen />);
    await waitFor(() =>
      expect(screen.getByTestId('recipe-per-macros')).toHaveTextContent(/fibre not stated/),
    );
  });

  it('gives the figure when an ingredient did state it', async () => {
    render(<RecipeScreen />);
    await waitFor(() =>
      expect(screen.getByTestId('recipe-per-macros')).toHaveTextContent(/\d+ fibre/),
    );
  });
});
