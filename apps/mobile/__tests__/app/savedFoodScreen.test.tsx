import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import EditSavedFoodScreen from '../../app/food/saved/[id]';

/**
 * Correcting a saved food — the half of N114 that makes reuse safe.
 *
 * A stored mistake is worse than a fresh guess: it comes back with the
 * athlete's own authority behind it and stops asking to be checked. So this
 * screen has to be able to fix one, has to say what a fix does and does not
 * touch, and above all must not itself store a number nobody meant.
 */

/**
 * `useEffect`, captured for the `expo-router` mock below.
 *
 * A `mock`-prefixed binding rather than a `require('react')` inside the
 * factory: jest hoists `jest.mock` above the imports, and `mock*` is the prefix
 * babel-plugin-jest-hoist exempts.
 */
const mockUseEffect = useEffect;

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockLocalFood = jest.fn();
const mockSaveFood = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  localFood: (...a: unknown[]) => mockLocalFood(...a),
  saveFoodLocally: (...a: unknown[]) => mockSaveFood(...a),
  // N116/#505: unblocked by default — synced, and nothing owed.
  foodSyncState: jest.fn(async () => ({ unsynced: false, owed: false })),
}));
jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockRedirect = jest.fn();
jest.mock('expo-router', () => ({
  __esModule: true,
  // **Required, and its absence is a silent screen-wide crash.**
  // `KeyboardAwareScrollView` calls `useFocusEffect`, so a router mock without
  // it makes the hook `undefined` and the whole subtree throws — surfacing as
  // "Unable to find node on an unmounted component", which reads as a timing
  // problem and is a missing mock.
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => ({ id: 'food-abc' }),
  useRouter: () => ({ push: jest.fn(), back: mockBack, replace: mockReplace }),
  Stack: { Screen: () => null },
  // Rendered, not called — the screen redirects declaratively so that a
  // fresh `useRouter()` object cannot drive an infinite navigation loop.
  Redirect: (props: { href: unknown }) => {
    mockRedirect(props.href);
    return null;
  },
}));

function saved(over: Record<string, unknown> = {}) {
  return {
    id: 'food-abc',
    kind: 'food',
    name: 'Pork Shashlik',
    brand: '',
    serving_label: '1 skewer',
    serving_grams: null,
    kcal: 310,
    protein_g: 28,
    carb_g: 4,
    fat_g: 20,
    fibre_g: 1.5,
    source: 'ai',
    ...over,
  };
}

async function open(food = saved()) {
  mockLocalFood.mockResolvedValue(food);
  render(<EditSavedFoodScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-name')).toBeTruthy());
}

beforeEach(() => {
  mockLocalFood.mockReset();
  mockSaveFood.mockReset().mockResolvedValue('food-abc');
  mockBack.mockReset();
  mockReplace.mockReset();
  mockRedirect.mockReset();
});

/**
 * **A recipe must never be edited by this screen (N87).**
 *
 * This form knows about per-serving macros and nothing about a yield or an
 * ingredient list, so saving a recipe through it writes an empty `items` and a
 * null `yield_servings`. The local upsert REPLACES both rather than COALESCEing
 * them — deliberately, since that is the only way to take an ingredient out of
 * a recipe — so the athlete's ingredient list is wiped without ever being on
 * screen. The push then sends `kind: 'recipe'` with no yield, the server
 * refuses it 400, and a 400 is classified as permanent: `dirty` is cleared and
 * the correction is gone with nothing saying so.
 *
 * The guard lives HERE rather than on each caller because review found a second
 * one: `describe.tsx`'s "fix these numbers for next time" passes whatever the
 * server's saved-food match returned, and that match really does return recipes
 * (`TestReusingARecipeGivesOnePortionOfIt` pins it server-side). A per-caller
 * guard is one somebody forgets to add.
 */
it('sends a recipe to the recipe editor instead of editing it here', async () => {
  mockLocalFood.mockResolvedValue(saved({ kind: 'recipe', yield_servings: 4, items: [] }));
  render(<EditSavedFoodScreen />);

  await waitFor(() =>
    expect(mockRedirect).toHaveBeenCalledWith({
      pathname: '/food/recipe/[id]',
      params: { id: 'food-abc' },
    }),
  );
  // **Once, not once per render.** The first version of this guard called
  // `router.replace()` from an effect that depended on `router` — which
  // `useRouter()` rebuilds every render — so it re-navigated forever and took
  // the test runner out of memory rather than failing an assertion. A count is
  // what tells a working redirect from a loop; a plain "was called" cannot.
  expect(mockRedirect).toHaveBeenCalledTimes(1);
  // And it must not render the form on the way past — a frame of editable macro
  // fields over a recipe invites the very save this prevents.
  expect(screen.queryByTestId('saved-name')).toBeNull();
  expect(mockSaveFood).not.toHaveBeenCalled();
});

/**
 * The other direction, so the guard cannot be satisfied by redirecting
 * everything — which would make this screen unreachable for the plain saved
 * foods it exists to correct.
 */
it('still edits a plain saved food here', async () => {
  mockLocalFood.mockResolvedValue(saved());
  render(<EditSavedFoodScreen />);

  await waitFor(() => expect(screen.getByTestId('saved-name')).toBeTruthy());
  expect(mockRedirect).not.toHaveBeenCalled();
});

it('says what a correction changes and what it leaves alone', async () => {
  await open();
  // The rule the whole nutrition module rests on, stated where the athlete is
  // about to change a number rather than only in a comment. "Does this rewrite
  // last month?" is the first thing this screen raises.
  const scope = screen.getByTestId('saved-scope').props.children;
  expect(String(scope)).toContain('from now on');
  expect(String(scope)).toContain('keep the numbers they were logged with');
});

it('says when the numbers were drafted rather than measured', async () => {
  await open();
  expect(screen.getByTestId('saved-provenance')).toBeTruthy();

  screen.unmount();
  await open(saved({ source: 'user' }));
  expect(screen.queryByTestId('saved-provenance')).toBeNull();
});

it('corrects the stored food in place, keeping its id', async () => {
  await open();
  fireEvent.changeText(screen.getByTestId('saved-kcal'), '415');
  await act(async () => {
    fireEvent.press(screen.getByTestId('saved-save'));
  });

  await waitFor(() => expect(mockSaveFood).toHaveBeenCalledTimes(1));
  const [, food] = mockSaveFood.mock.calls[0];
  expect(food.id).toBe('food-abc');
  expect(food.kcal).toBe(415);
  // **`source` is NOT resent.** A field this screen does not own, restated by a
  // screen that happens to have read it, is the blanking trap with the sign
  // flipped — absent means "keep what is stored", all the way down.
  expect(food).not.toHaveProperty('source');
  expect(mockBack).toHaveBeenCalled();
});

it('refuses a number it cannot read rather than storing a zero', async () => {
  await open();
  fireEvent.changeText(screen.getByTestId('saved-kcal'), '12..5');
  await act(async () => {
    fireEvent.press(screen.getByTestId('saved-save'));
  });

  // A stored 0 kcal comes back with the athlete's authority behind it, on the
  // row every future log is made from. The entry editor next door can afford to
  // coerce; this screen cannot.
  expect(mockSaveFood).not.toHaveBeenCalled();
  expect(screen.getByTestId('saved-problem')).toBeTruthy();
  expect(mockBack).not.toHaveBeenCalled();
});

it('still lets a number be CLEARED, because unrecorded is a real state', async () => {
  await open();
  fireEvent.changeText(screen.getByTestId('saved-fibre_g'), '');
  await act(async () => {
    fireEvent.press(screen.getByTestId('saved-save'));
  });

  await waitFor(() => expect(mockSaveFood).toHaveBeenCalledTimes(1));
  expect(mockSaveFood.mock.calls[0][1].fibre_g).toBeNull();
});

it('refuses an empty name, because the name is what a later entry matches on', async () => {
  await open();
  fireEvent.changeText(screen.getByTestId('saved-name'), '   ');
  await act(async () => {
    fireEvent.press(screen.getByTestId('saved-save'));
  });
  expect(mockSaveFood).not.toHaveBeenCalled();
  expect(screen.getByTestId('saved-problem')).toBeTruthy();
});

it('says so plainly when the food is not on this device', async () => {
  mockLocalFood.mockResolvedValue(null);
  render(<EditSavedFoodScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-missing')).toBeTruthy());
});
