import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import DescribeMealScreen from '../../app/food/describe';

/**
 * N114 — reusing a saved food instead of generating it again.
 *
 * Two properties, and the ticket names both:
 *
 *   - **"A food entered by AI, photo, or free text is persisted as a reusable
 *     item."** Confirming a draft has to WRITE the food, not just the entry.
 *     Before this, the same meal was re-derived every time, at a fresh cost and
 *     with numbers that need not agree with last time.
 *   - **"The athlete can tell which they got."** A reused draft and an invented
 *     one are different claims and must not render identically. This asserts
 *     the difference on screen, not the field on the response — a `match` that
 *     arrives and is never drawn satisfies the type and not the athlete.
 */

const mockUseEffect = useEffect;

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const mockDescribe = jest.fn();
jest.mock('@/lib/estimateApi', () => {
  const real = jest.requireActual('@/lib/estimateApi');
  return {
    ...real,
    describeMeal: (...a: unknown[]) => mockDescribe(...a),
    photographMeal: jest.fn(),
  };
});

const mockLogFood = jest.fn();
const mockSaveFood = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  logFood: (...a: unknown[]) => mockLogFood(...a),
  saveFoodLocally: (...a: unknown[]) => mockSaveFood(...a),
}));
jest.mock('@/lib/sync', () => ({ request: jest.fn() }));
jest.mock('@/lib/barcodeCache', () => ({ rememberBarcode: jest.fn(), cachedBarcode: jest.fn() }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-image-manipulator', () => ({ SaveFormat: { JPEG: 'jpeg' } }));

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

/** One item, 2 servings — so per-serving is half of what the draft carries. */
function item(over: Record<string, unknown> = {}) {
  return {
    name: 'Pork Shashlik',
    serving_label: '1 skewer',
    servings: 2,
    portion_confidence: 'medium',
    assumption: 'assumed a large skewer',
    kcal: 620,
    protein_g: 56,
    carb_g: 8,
    fat_g: 40,
    fibre_g: 3,
    ...over,
  };
}

function generated(items: unknown[] = [item()]) {
  return {
    estimate: { items, note: '', meal_name: '', model: 'test-model', source: 'text' },
    quota: { used: 1, limit: 25, remaining: 24, resets_at: null },
  };
}

function reused(over: Record<string, unknown> = {}) {
  return {
    estimate: {
      items: [item({ servings: 1, kcal: 310, protein_g: 28, assumption: '', portion_confidence: 'high' })],
      note: '',
      meal_name: '',
      model: '',
      source: 'text',
      match: {
        food_id: 'food-abc',
        name: 'Pork Shashlik',
        rule: 'exact_name',
        normalized: 'pork shashlik',
        food_source: 'ai',
        saved_at: new Date().toISOString(),
        ...over,
      },
    },
    quota: { used: 1, limit: 25, remaining: 24, resets_at: null },
  };
}

async function draft() {
  render(<DescribeMealScreen />);
  fireEvent.changeText(screen.getByTestId('describe-input'), 'Pork Shashlik');
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
}

beforeEach(() => {
  mockParams = { meal: 'lunch', date: '2026-08-19' };
  mockDescribe.mockReset();
  mockLogFood.mockReset().mockResolvedValue('entry-1');
  mockSaveFood.mockReset().mockResolvedValue('food-new');
  mockPush.mockReset();
});

describe('confirming a generated draft', () => {
  it('saves the food AND logs the entry against it', async () => {
    mockDescribe.mockResolvedValue(generated());
    await draft();
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    // THE WRITE N114 WAS REPORTED FOR MISSING.
    await waitFor(() => expect(mockSaveFood).toHaveBeenCalledTimes(1));
    const [, food] = mockSaveFood.mock.calls[0];
    expect(food.name).toBe('Pork Shashlik');
    expect(food.source).toBe('ai');
    // PER SERVING: the draft carried 620 kcal across 2 servings.
    expect(food.kcal).toBe(310);

    // And the entry points at it, which is what makes the reuse discoverable
    // and puts a drafted food into the quick-add recents.
    expect(mockLogFood).toHaveBeenCalledTimes(1);
    expect(mockLogFood.mock.calls[0][1].source_food_id).toBe('food-new');
    // The entry keeps the TOTAL it was logged with, not the per-serving figure.
    expect(mockLogFood.mock.calls[0][1].kcal).toBe(620);
  });

  it('saves one food per item of a multi-item draft', async () => {
    mockDescribe.mockResolvedValue(generated([item(), item({ name: 'Flatbread' })]));
    await draft();
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });
    await waitFor(() => expect(mockSaveFood).toHaveBeenCalledTimes(2));
    expect(mockSaveFood.mock.calls.map((c) => c[1].name)).toEqual(['Pork Shashlik', 'Flatbread']);
  });

  it('does not present itself as reused', async () => {
    mockDescribe.mockResolvedValue(generated());
    await draft();
    expect(screen.queryByTestId('describe-reused')).toBeNull();
    expect(screen.queryByTestId('describe-regenerate')).toBeNull();
    expect(screen.getByText('CHECK THESE BEFORE LOGGING')).toBeTruthy();
  });
});

describe('a reused draft', () => {
  it('says so, and says it cost nothing', async () => {
    mockDescribe.mockResolvedValue(reused());
    await draft();

    const banner = screen.getByTestId('describe-reused');
    // The exact copy is not the assertion — that it NAMES the stored food and
    // states the cost is. Both are what stop a reuse reading as a fresh guess.
    expect(banner.props.children.join('')).toContain('Pork Shashlik');
    expect(banner.props.children.join('')).toContain('No estimate used');
    // The heading changes too: "check these" is the right instruction for a
    // guess and the wrong one for numbers the athlete saved themselves.
    // `SectionHeader` upper-cases its own label, so the assertion has to be on
    // what is DRAWN — matching the source string would pass vacuously against a
    // component that renders nothing at all.
    expect(screen.queryByText('CHECK THESE BEFORE LOGGING')).toBeNull();
    expect(screen.getByText('FROM YOUR SAVED FOODS')).toBeTruthy();
  });

  it('does not mint a second food for the one it came from', async () => {
    mockDescribe.mockResolvedValue(reused());
    await draft();
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
    // A duplicate per log would leave the athlete with a pile of rows under one
    // name and make the next lookup a choice between them.
    expect(mockSaveFood).not.toHaveBeenCalled();
    expect(mockLogFood.mock.calls[0][1].source_food_id).toBe('food-abc');
  });

  it('offers a fresh reading, and asks for one when tapped', async () => {
    mockDescribe.mockResolvedValue(reused());
    await draft();
    expect(mockDescribe.mock.calls[0][1].reuse).toBe(true);

    mockDescribe.mockResolvedValue(generated());
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-regenerate'));
    });

    // Without this the athlete can never escape a saved food whose numbers are
    // wrong — the feature would have replaced one complaint with a worse one.
    await waitFor(() => expect(mockDescribe).toHaveBeenCalledTimes(2));
    expect(mockDescribe.mock.calls[1][1].reuse).toBe(false);
  });

  it('offers to correct the stored numbers for next time', async () => {
    mockDescribe.mockResolvedValue(reused());
    await draft();
    fireEvent.press(screen.getByTestId('describe-edit-saved'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/food/saved/[id]',
      params: { id: 'food-abc' },
    });
  });

  // The escape hatch must not recreate the pile it exists to escape. Asking for
  // a fresh reading of a food you have saved is a request to REPLACE it, so the
  // confirm writes back over the same id.
  it('replaces the stored food rather than saving a second one under the same name', async () => {
    mockDescribe.mockResolvedValue(reused());
    await draft();

    mockDescribe.mockResolvedValue(generated());
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-regenerate'));
    });
    await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockSaveFood).toHaveBeenCalledTimes(1));
    expect(mockSaveFood.mock.calls[0][1].id).toBe('food-abc');
  });

  // …and an UNRELATED description afterwards must not overwrite it. The id is
  // carried by the regenerate, not held until something happens to use it.
  it('does not carry the replaced id into a later unrelated draft', async () => {
    mockDescribe.mockResolvedValue(reused());
    await draft();

    mockDescribe.mockResolvedValue(generated());
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-regenerate'));
    });
    // A fresh, ordinary description — reuse on, nothing being replaced.
    fireEvent.changeText(screen.getByTestId('describe-input'), 'Flatbread');
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-submit'));
    });
    await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockSaveFood).toHaveBeenCalledTimes(1));
    expect(mockSaveFood.mock.calls[0][1].id).toBeUndefined();
  });

  // The client must not trust an undocumented single-item invariant. If a
  // `match` ever arrives beside several items, keying on its presence alone
  // would point every entry at one food and save none of the others.
  it('only reuses the matched id for the row that actually is that food', async () => {
    mockDescribe.mockResolvedValue({
      estimate: {
        ...reused().estimate,
        items: [item({ name: 'Pork Shashlik', servings: 1 }), item({ name: 'Flatbread' })],
      },
      quota: { used: 1, limit: 25, remaining: 24, resets_at: null },
    });
    await draft();
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });

    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(2));
    expect(mockLogFood.mock.calls[0][1].source_food_id).toBe('food-abc');
    // The second item is a different food and gets saved on its own.
    expect(mockSaveFood).toHaveBeenCalledTimes(1);
    expect(mockSaveFood.mock.calls[0][1].name).toBe('Flatbread');
  });

  it('says whether the stored numbers were drafted or measured', async () => {
    mockDescribe.mockResolvedValue(reused({ food_source: 'user' }));
    await draft();
    expect(screen.getByTestId('describe-reused').props.children.join('')).toContain('saved by you');
  });
});

// The mirror of the race the screen's own `locked` docstring describes, which
// that guard did not close: Log stayed tappable while a regenerate was in
// flight, so the STALE draft was logged and the fresh estimate — already paid
// for — landed on a screen that had been popped.
it('cannot log a stale draft while a fresh estimate is in flight', async () => {
  mockDescribe.mockResolvedValue(reused());
  await draft();

  let release: (v: unknown) => void = () => {};
  mockDescribe.mockReturnValue(new Promise((r) => { release = r; }));
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-regenerate'));
  });

  const log = screen.getByTestId('describe-log');
  expect(log.props.accessibilityState).toEqual({ disabled: true });
  await act(async () => {
    fireEvent.press(log);
  });
  expect(mockLogFood).not.toHaveBeenCalled();

  await act(async () => {
    release(generated());
  });
});
