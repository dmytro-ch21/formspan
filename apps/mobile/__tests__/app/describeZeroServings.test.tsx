import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import DescribeMealScreen from '../../app/food/describe';

/**
 * N542/#977 — a draft counted zero times must never reach the outbox.
 *
 * `Entry.Validate` requires `servings > 0` and the `nutrition_entries` CHECK
 * requires it again, so an entry counted zero times is written locally,
 * refused 400 on push, classified permanent, and lives on this one phone
 * until a reinstall removes it — the phantom-row shape N533 closed for names
 * and labels, one field over.
 *
 * Two halves, and they are deliberately not the same:
 *
 *   - a zero the MODEL sent is fitted to one, silently, because nobody chose
 *     it and the macros are the total for the quantity either way;
 *   - a zero the ATHLETE typed is refused, visibly, because it is on their
 *     screen and quietly rewriting it would log a portion they did not ask
 *     for.
 */

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
const mockRequestSync = jest.fn();
jest.mock('@/lib/sync', () => ({ request: (...a: unknown[]) => mockRequestSync(...a) }));
jest.mock('@/lib/barcodeCache', () => ({ rememberBarcode: jest.fn(), cachedBarcode: jest.fn() }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-image-manipulator', () => ({ SaveFormat: { JPEG: 'jpeg' } }));

const mockUseEffect = useEffect;
const mockDismissTo = jest.fn();

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    dismissTo: (...a: unknown[]) => mockDismissTo(...a),
  }),
  Stack: { Screen: () => null },
}));

function item(over: Record<string, unknown> = {}) {
  return {
    name: 'Scrambled eggs',
    serving_label: '1 medium egg',
    servings: 2,
    portion_confidence: 'medium',
    assumption: '',
    kcal: 180,
    protein_g: 13,
    carb_g: 1,
    fat_g: 14,
    fibre_g: 0,
    ...over,
  };
}

function response(items = [item()]) {
  return {
    estimate: { items, note: '', meal_name: '', model: 'test-model', source: 'text' },
    quota: { used: 1, limit: 25, remaining: 24, resets_at: null },
  };
}

beforeEach(() => {
  mockParams = { meal: 'lunch', date: '2026-09-09' };
  mockDescribe.mockReset();
  mockLogFood.mockReset().mockResolvedValue('entry-1');
  mockSaveFood.mockReset().mockResolvedValue('food-new');
  mockRequestSync.mockReset();
  mockDismissTo.mockReset();
});

async function describeOnce(res = response()) {
  mockDescribe.mockResolvedValue(res);
  render(<DescribeMealScreen />);
  fireEvent.changeText(screen.getByTestId('describe-input'), 'two eggs');
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
}

describe('a zero the athlete typed', () => {
  it('says so on the row, and only on that row', async () => {
    await describeOnce(response([item({ name: 'Scrambled eggs' }), item({ name: 'Toast' })]));
    expect(screen.queryByTestId('describe-no-servings-0')).toBeNull();

    fireEvent.changeText(screen.getByTestId('describe-servings-0'), '0');

    expect(screen.getByTestId('describe-no-servings-0')).toHaveTextContent(/more than 0/i);
    expect(screen.queryByTestId('describe-no-servings-1')).toBeNull();
  });

  it('makes the Log button inert rather than letting the push be refused', async () => {
    await describeOnce();
    fireEvent.changeText(screen.getByTestId('describe-servings-0'), '0');

    const log = screen.getByTestId('describe-log');
    // Both props, so VoiceOver never announces an enabled button that
    // ignores taps — and the hint is what carries the reason to a screen
    // reader, which cannot see the red line on the row.
    expect(log.props.accessibilityState?.disabled).toBe(true);
    expect(log.props.accessibilityHint).toMatch(/counted zero times/i);

    await act(async () => {
      fireEvent.press(log);
    });
    expect(mockLogFood).not.toHaveBeenCalled();
    expect(mockSaveFood).not.toHaveBeenCalled();
  });

  it('blocks the COMPILED path too, where the row would have donated its calories to a meal', async () => {
    // Compiling sums every row into one entry carrying its own `servings: 1`,
    // so a zeroed row would push perfectly happily — with its calories in a
    // meal the athlete had said they ate none of. Silently wrong rather than
    // refused, which is why this case is tested separately.
    await describeOnce(response([item({ name: 'Scrambled eggs' }), item({ name: 'Toast', kcal: 90 })]));
    fireEvent.press(screen.getByTestId('describe-compile-toggle'));
    fireEvent.changeText(screen.getByTestId('describe-servings-1'), '0');

    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });
    expect(mockLogFood).not.toHaveBeenCalled();
  });

  it('lets the athlete out of it by correcting the count', async () => {
    // The apparatus check for the three above: if the screen were simply
    // broken they would all pass and mean nothing.
    await describeOnce();
    fireEvent.changeText(screen.getByTestId('describe-servings-0'), '0');
    fireEvent.changeText(screen.getByTestId('describe-servings-0'), '1.5');

    expect(screen.queryByTestId('describe-no-servings-0')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });
    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
    expect(mockLogFood.mock.calls[0][1].servings).toBe(1.5);
  });

  it('and by removing the row instead', async () => {
    await describeOnce(response([item({ name: 'Scrambled eggs' }), item({ name: 'Toast' })]));
    fireEvent.changeText(screen.getByTestId('describe-servings-1'), '0');
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-remove-1'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });
    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
  });
});

describe('a zero the model sent', () => {
  it('arrives counted as one, so nothing is blocked and nothing is lost', async () => {
    // The server fits this itself now. This is the phone talking to a deploy
    // that predates that fit — without it the athlete opens the screen to a
    // `0` they must notice and correct before anything can be logged.
    await describeOnce(response([item({ servings: 0 })]));

    expect(screen.getByTestId('describe-servings-0').props.value).toBe('1');
    expect(screen.queryByTestId('describe-no-servings-0')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });
    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
    const logged = mockLogFood.mock.calls[0][1];
    expect(logged.servings).toBe(1);
    // The macros are the TOTAL for the quantity, so restating the count
    // rewrites nothing about what was eaten.
    expect(logged.kcal).toBe(180);
  });
});
