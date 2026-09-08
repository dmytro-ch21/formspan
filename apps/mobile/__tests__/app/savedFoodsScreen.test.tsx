import { useEffect } from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import SavedFoodsScreen from '../../app/food/saved/index';
import type { Food } from '@/lib/nutrition';
import { PREF_SAVED_FOODS_SORT } from '@/lib/prefs';

/**
 * N79 — the phone-impossible audit's "saved-food management is web-only" gap,
 * and N532/#963 — "Recently shared", the "from @handle" line, compact rows,
 * and the sort chips.
 *
 * Editing and building are already someone else's screens (`food/saved/[id]`,
 * `food/recipe/[id]`, `food/add.tsx`); what is pinned HERE is that this screen
 * finds the right one for a row's `kind` (N87's split), that deleting goes
 * through `removeFood` — the local-first tombstone `lib/foodLog.ts`'s `push()`
 * owes to the server — behind a confirm, and that the list asks the store for
 * the sort the athlete chose rather than re-sorting in memory.
 */
jest.setTimeout(30_000);

const mockUseEffect = useEffect;

const mockLocalFoods = jest.fn();
const mockRecentlyShared = jest.fn();
const mockRemoveFood = jest.fn();
const mockProblems = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  localFoods: (...a: unknown[]) => mockLocalFoods(...a),
  recentlySharedFoods: (...a: unknown[]) => mockRecentlyShared(...a),
  removeFood: (...a: unknown[]) => mockRemoveFood(...a),
  foodSyncProblems: (...a: unknown[]) => mockProblems(...a),
}));

const mockReadPref = jest.fn();
const mockWritePref = jest.fn();
jest.mock('@/lib/prefs', () => ({
  ...jest.requireActual('@/lib/prefs'),
  readPref: (...a: unknown[]) => mockReadPref(...a),
  writePref: (...a: unknown[]) => mockWritePref(...a),
}));

const mockRequestSync = jest.fn();
jest.mock('@/lib/sync', () => ({ request: (...a: unknown[]) => mockRequestSync(...a) }));

// The swipe gesture has its own suite (`swipeToDelete.test.tsx`); this stands
// in a plain button that fires `onDelete` on press — the same substitution the
// old version of this file made for `HoldToConfirm`. What is pinned here is
// the WIRING: the revealed Delete asks before it deletes.
jest.mock('@/components/SwipeToDelete', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text, View } = require('react-native');
  return {
    SwipeToDelete: ({
      children,
      onDelete,
      testID,
    }: {
      children: React.ReactNode;
      onDelete: () => void;
      testID?: string;
    }) =>
      React.createElement(
        View,
        { testID },
        children,
        React.createElement(
          Pressable,
          { onPress: onDelete, testID: testID ? `${testID}-delete` : undefined },
          React.createElement(Text, null, 'Delete'),
        ),
      ),
  };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

function food(over: Partial<Food> = {}): Food {
  return {
    id: 'f1',
    kind: 'food',
    name: 'Chicken thigh',
    brand: '',
    serving_label: '100 g',
    serving_grams: 100,
    kcal: 250,
    protein_g: 22,
    carb_g: 0,
    fat_g: 18,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    source: 'user',
    yield_servings: null,
    items: [],
    shared_by: null,
    shared_at: null,
    ...over,
  };
}

/**
 * `Alert.alert` has no RNTL query of its own, so a delete is driven by reading
 * its last call and pressing the destructive button — the same way
 * `roadmapScreen.test.tsx` does. Pressing "Cancel" is the negative control.
 */
function lastAlertButton(label: string) {
  const call = jest.mocked(Alert.alert).mock.calls.at(-1);
  if (!call) throw new Error('Alert.alert was not called');
  const button = (call[2] ?? []).find((b) => b.text === label);
  if (!button) throw new Error(`no "${label}" button on the alert`);
  return button;
}

beforeEach(() => {
  mockProblems.mockReset().mockResolvedValue(new Map());
  mockLocalFoods.mockReset().mockResolvedValue([]);
  mockRecentlyShared.mockReset().mockResolvedValue([]);
  mockRemoveFood.mockReset().mockResolvedValue(undefined);
  mockReadPref.mockReset().mockResolvedValue(null);
  mockWritePref.mockReset().mockResolvedValue(undefined);
  mockRequestSync.mockReset();
  mockPush.mockReset();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('lists a saved food with its per-serving macros on one line', async () => {
  mockLocalFoods.mockResolvedValue([food({ name: 'Chicken thigh', kcal: 250, protein_g: 22 })]);
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByText('Chicken thigh')).toBeTruthy());
  expect(screen.getByText(/250 kcal · 22P\/0C\/18F/)).toBeTruthy();
  // No second line for an unbranded, unshared food — the row stays one line.
  expect(screen.queryByTestId('saved-foods-from-f1')).toBeNull();
});

/**
 * N533/#964 — a food the server REFUSED is not allowed to sit in this list
 * looking like every other row. Before this, the only way to learn that a
 * described food had never been saved anywhere but this phone was to
 * reinstall the app and watch it vanish.
 */
it('says when a food was refused by the server, and which way', async () => {
  mockLocalFoods.mockResolvedValue([
    food({ id: 'ghost', name: 'Burrito bowl' }),
    food({ id: 'held', name: 'Chicken thigh' }),
    food({ id: 'fine', name: 'Oats' }),
  ]);
  mockProblems.mockResolvedValue(
    new Map([
      ['ghost', { reason: 'serving_label must be between 1 and 40 characters', onServer: false }],
      ['held', { reason: 'name must be between 1 and 120 characters', onServer: true }],
    ]),
  );
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-foods-problem-ghost')).toBeTruthy());

  const ghost = String(screen.getByTestId('saved-foods-problem-ghost').props.children);
  expect(ghost).toContain('serving_label must be between 1 and 40 characters');
  expect(ghost).toContain('this phone only');
  const held = String(screen.getByTestId('saved-foods-problem-held').props.children);
  expect(held).toContain('name must be between 1 and 120 characters');
  expect(held).toContain('earlier version');
  expect(screen.queryByTestId('saved-foods-problem-fine')).toBeNull();
});

it('marks a recipe distinctly from a plain food', async () => {
  mockLocalFoods.mockResolvedValue([
    food({ id: 'r1', kind: 'recipe', name: 'Sunday traybake', yield_servings: 4, items: [] }),
  ]);
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByText('Sunday traybake')).toBeTruthy());
  expect(screen.getByText('Recipe')).toBeTruthy();
});

it('shows the empty state when nothing is saved, not a spinner forever', async () => {
  mockLocalFoods.mockResolvedValue([]);
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-foods-empty')).toBeTruthy());
});

it('searches by re-reading the local list within the chosen sort, rather than filtering in memory', async () => {
  mockLocalFoods.mockResolvedValue([]);
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(mockLocalFoods).toHaveBeenCalledWith('u1', '', 'recent'));

  mockLocalFoods.mockClear();
  fireEvent.changeText(screen.getByTestId('saved-foods-search'), 'chick');
  await waitFor(() => expect(mockLocalFoods).toHaveBeenCalledWith('u1', 'chick', 'recent'));
});

/**
 * **N87, the same guard `food/add.tsx`'s own Edit button carries.** A recipe
 * opened through the plain-food editor writes an empty `items` and a null
 * `yield_servings` on save, which the server refuses as a permanent 400 — and
 * the athlete's ingredient list is gone with nothing saying so. This screen
 * must route each `kind` to its own editor rather than guessing one for both.
 */
it('opens the plain-food editor for a food and the recipe editor for a recipe', async () => {
  mockLocalFoods.mockResolvedValue([
    food({ id: 'plain', name: 'Oats', kind: 'food' }),
    food({ id: 'rec', name: 'Traybake', kind: 'recipe', yield_servings: 4 }),
  ]);
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-foods-edit-plain')).toBeTruthy());

  fireEvent.press(screen.getByTestId('saved-foods-edit-plain'));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/food/saved/[id]', params: { id: 'plain' } });

  fireEvent.press(screen.getByTestId('saved-foods-edit-rec'));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/food/recipe/[id]', params: { id: 'rec' } });
});

describe('deleting', () => {
  it('long-press asks first, and Cancel deletes nothing', async () => {
    mockLocalFoods.mockResolvedValue([food({ id: 'f1', name: 'Chicken thigh' })]);
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(screen.getByTestId('saved-foods-edit-f1')).toBeTruthy());

    fireEvent(screen.getByTestId('saved-foods-edit-f1'), 'longPress');
    expect(Alert.alert).toHaveBeenCalledWith('Delete Chicken thigh?', expect.any(String), expect.any(Array));
    await act(async () => {
      lastAlertButton('Cancel').onPress?.();
    });
    expect(mockRemoveFood).not.toHaveBeenCalled();
    expect(screen.getByText('Chicken thigh')).toBeTruthy();
  });

  it('confirming deletes through removeFood, requests a sync, and reloads the list', async () => {
    mockLocalFoods.mockResolvedValueOnce([food({ id: 'f1', name: 'Chicken thigh' })]);
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(screen.getByTestId('saved-foods-edit-f1')).toBeTruthy());

    mockLocalFoods.mockResolvedValueOnce([]);
    fireEvent(screen.getByTestId('saved-foods-edit-f1'), 'longPress');
    await act(async () => {
      lastAlertButton('Delete').onPress?.();
    });

    expect(mockRemoveFood).toHaveBeenCalledWith('u1', 'f1');
    expect(mockRequestSync).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('saved-foods-empty')).toBeTruthy());
  });

  // A screen-reader user can neither long-press a row nor swipe it, and
  // SwipeToDelete hides its button from assistive tech while closed — the
  // accessibility action is the path that reaches them.
  it('is reachable through the delete accessibility action', async () => {
    mockLocalFoods.mockResolvedValue([food({ id: 'f1', name: 'Chicken thigh' })]);
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(screen.getByTestId('saved-foods-edit-f1')).toBeTruthy());

    fireEvent(screen.getByTestId('saved-foods-edit-f1'), 'accessibilityAction', {
      nativeEvent: { actionName: 'delete' },
    });
    expect(Alert.alert).toHaveBeenCalledWith('Delete Chicken thigh?', expect.any(String), expect.any(Array));
    await act(async () => {
      lastAlertButton('Delete').onPress?.();
    });
    expect(mockRemoveFood).toHaveBeenCalledWith('u1', 'f1');
  });

  it('is reachable from the swiped-open Delete button', async () => {
    mockLocalFoods.mockResolvedValue([food({ id: 'f1', name: 'Chicken thigh' })]);
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(screen.getByTestId('saved-foods-row-f1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('saved-foods-row-f1-delete'));
    expect(Alert.alert).toHaveBeenCalledWith('Delete Chicken thigh?', expect.any(String), expect.any(Array));
    expect(mockRemoveFood).not.toHaveBeenCalled();
    await act(async () => {
      lastAlertButton('Delete').onPress?.();
    });
    expect(mockRemoveFood).toHaveBeenCalledWith('u1', 'f1');
  });

  it('shows an error and keeps the row when the delete fails, rather than pretending it worked', async () => {
    mockLocalFoods.mockResolvedValue([food({ id: 'f1', name: 'Chicken thigh' })]);
    mockRemoveFood.mockRejectedValue(new Error('offline'));
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(screen.getByTestId('saved-foods-edit-f1')).toBeTruthy());

    fireEvent(screen.getByTestId('saved-foods-edit-f1'), 'longPress');
    await act(async () => {
      lastAlertButton('Delete').onPress?.();
    });

    expect(screen.getByTestId('saved-foods-error')).toHaveTextContent('offline');
    expect(screen.getByText('Chicken thigh')).toBeTruthy();
  });
});

it('shows the load error rather than a silently empty list', async () => {
  mockLocalFoods.mockRejectedValue(new Error('could not read the database'));
  render(<SavedFoodsScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-foods-error')).toBeTruthy());
});

describe('Recently shared', () => {
  const shared = food({
    id: 's1',
    name: 'Ana’s açaí bowl',
    shared_by: 'ana_bjj',
    shared_at: '2026-09-05T10:00:00Z',
  });

  it('is not rendered at all when nothing was shared recently', async () => {
    mockLocalFoods.mockResolvedValue([food()]);
    mockRecentlyShared.mockResolvedValue([]);
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(screen.getByText('Chicken thigh')).toBeTruthy());
    expect(screen.queryByTestId('saved-foods-recently-shared')).toBeNull();
    expect(screen.queryByText('Recently shared')).toBeNull();
  });

  it('spotlights a recent share with the sender’s handle, above the full list', async () => {
    mockLocalFoods.mockResolvedValue([food(), shared]);
    mockRecentlyShared.mockResolvedValue([shared]);
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(screen.getByTestId('saved-foods-recently-shared')).toBeTruthy());
    expect(screen.getByText('Recently shared')).toBeTruthy();
    // In the spotlight AND in the full list, each with the from-line.
    expect(screen.getByTestId('recent-saved-foods-from-s1')).toHaveTextContent('from @ana_bjj · 5 Sep');
    expect(screen.getByTestId('saved-foods-from-s1')).toHaveTextContent('from @ana_bjj · 5 Sep');
    // The spotlight's row edits the same food.
    fireEvent.press(screen.getByTestId('recent-saved-foods-edit-s1'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/food/saved/[id]', params: { id: 's1' } });
  });

  it('says "Shared with you" when the sender has no handle any more', async () => {
    const anon = food({ id: 'a1', name: 'Bowl', shared_by: null, shared_at: '2026-09-05T10:00:00Z' });
    mockLocalFoods.mockResolvedValue([anon]);
    mockRecentlyShared.mockResolvedValue([anon]);
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(screen.getByTestId('saved-foods-from-a1')).toHaveTextContent('Shared with you · 5 Sep'));
  });

  it('is hidden while searching, and the search result still says who sent it', async () => {
    mockLocalFoods.mockResolvedValue([food(), shared]);
    mockRecentlyShared.mockResolvedValue([shared]);
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(screen.getByTestId('saved-foods-recently-shared')).toBeTruthy());

    mockLocalFoods.mockResolvedValue([shared]);
    mockRecentlyShared.mockClear();
    fireEvent.changeText(screen.getByTestId('saved-foods-search'), 'açaí');
    await waitFor(() => expect(screen.queryByTestId('saved-foods-recently-shared')).toBeNull());
    expect(screen.getByTestId('saved-foods-from-s1')).toHaveTextContent(/from @ana_bjj/);
    // And the spotlight was not even read for a search.
    expect(mockRecentlyShared).not.toHaveBeenCalled();

    // Clearing the search brings it back.
    mockLocalFoods.mockResolvedValue([food(), shared]);
    fireEvent.changeText(screen.getByTestId('saved-foods-search'), '');
    await waitFor(() => expect(screen.getByTestId('saved-foods-recently-shared')).toBeTruthy());
  });
});

describe('sort', () => {
  it('defaults to Recent and reads the list in that order', async () => {
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(mockLocalFoods).toHaveBeenCalledWith('u1', '', 'recent'));
    expect(screen.getByTestId('saved-foods-sort-recent').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('saved-foods-sort-name').props.accessibilityState.selected).toBe(false);
  });

  it('opens on the remembered sort, and re-reads the list in it', async () => {
    mockReadPref.mockResolvedValue('name');
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(mockLocalFoods).toHaveBeenCalledWith('u1', '', 'name'));
    expect(mockReadPref).toHaveBeenCalledWith('u1', PREF_SAVED_FOODS_SORT);
    await waitFor(() =>
      expect(screen.getByTestId('saved-foods-sort-name').props.accessibilityState.selected).toBe(true),
    );
  });

  it('falls back to Recent on a stored value it does not know', async () => {
    mockReadPref.mockResolvedValue('alphabetical');
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(mockLocalFoods).toHaveBeenCalledWith('u1', '', 'recent'));
    expect(mockLocalFoods).not.toHaveBeenCalledWith('u1', '', 'alphabetical');
  });

  it('tapping a chip remembers it and re-reads the list, keeping the search', async () => {
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(mockLocalFoods).toHaveBeenCalledWith('u1', '', 'recent'));
    fireEvent.changeText(screen.getByTestId('saved-foods-search'), 'rice');
    await waitFor(() => expect(mockLocalFoods).toHaveBeenCalledWith('u1', 'rice', 'recent'));

    fireEvent.press(screen.getByTestId('saved-foods-sort-used'));
    await waitFor(() => expect(mockLocalFoods).toHaveBeenCalledWith('u1', 'rice', 'used'));
    expect(mockWritePref).toHaveBeenCalledWith('u1', PREF_SAVED_FOODS_SORT, 'used');
    expect(screen.getByTestId('saved-foods-sort-used').props.accessibilityState.selected).toBe(true);
  });

  /**
   * The stored-sort read and the focus effect BOTH load on mount, and nothing
   * orders their two reads. Resolved out of order — the remembered sort's
   * answer first, the default's second — the screen used to keep the LAST
   * answer to arrive, so the chips said "Name" while the rows were still the
   * "Recent" list. A sort control that lies about the list under it is the
   * one thing this ticket cannot ship.
   *
   * Found by review, reproduced before it was fixed. The guard is a
   * generation counter in `load`; remove it and this test goes red.
   */
  it('ignores a stale load that lands after a newer one, so the chips never lie about the order', async () => {
    mockReadPref.mockResolvedValue('name');

    // Hold both reads open so their resolution order is ours to choose.
    const pending: { order: string; resolve: (v: Food[]) => void }[] = [];
    mockLocalFoods.mockImplementation(
      (_u: string, _q: string, order: string) =>
        new Promise<Food[]>((resolve) => pending.push({ order, resolve })),
    );

    render(<SavedFoodsScreen />);

    // The focus effect's default-sort read, then the remembered-sort read.
    await waitFor(() => expect(pending.length).toBe(2));
    const stale = pending.find((c) => c.order === 'recent')!;
    const fresh = pending.find((c) => c.order === 'name')!;
    expect(stale).toBeDefined();
    expect(fresh).toBeDefined();

    // The NEWER read answers first...
    await act(async () => {
      fresh.resolve([food({ id: 'fresh', name: 'Name-sorted food' })]);
    });
    // ...and the older one answers second. Its answer is last time's.
    await act(async () => {
      stale.resolve([food({ id: 'stale', name: 'Recent-sorted food' })]);
    });

    expect(screen.getByTestId('saved-foods-sort-name').props.accessibilityState.selected).toBe(true);
    expect(screen.getByText('Name-sorted food')).toBeTruthy();
    expect(screen.queryByText('Recent-sorted food')).toBeNull();
  });

  it('tapping the chip already selected does nothing', async () => {
    render(<SavedFoodsScreen />);
    await waitFor(() => expect(mockLocalFoods).toHaveBeenCalledWith('u1', '', 'recent'));
    mockLocalFoods.mockClear();
    fireEvent.press(screen.getByTestId('saved-foods-sort-recent'));
    expect(mockWritePref).not.toHaveBeenCalled();
    expect(mockLocalFoods).not.toHaveBeenCalled();
  });
});
