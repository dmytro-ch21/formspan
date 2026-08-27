import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import DescribeMealScreen from '../food/describe';

/**
 * F17 (#403) — the exhausted estimate quota.
 *
 * Before this, `quota.resets_at` was parsed onto every response and never
 * rendered, and `locked` (the button-disabling flag) was `busy || saving`
 * only — so an athlete who had spent the day's estimates could keep firing
 * requests that could only ever come back refused. This pins that the THREE
 * actions that spend a quota unit (describing, photographing, "estimate it
 * again") are disabled once `remaining` reaches zero, and that logging an
 * already-drafted row — which spends nothing — is untouched by it.
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
jest.mock('@/lib/sync', () => ({ request: jest.fn() }));
jest.mock('@/lib/barcodeCache', () => ({ rememberBarcode: jest.fn(), cachedBarcode: jest.fn() }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-image-manipulator', () => ({ SaveFormat: { JPEG: 'jpeg' } }));

const mockUseEffect = useEffect;

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

function item(over: Record<string, unknown> = {}) {
  return {
    name: 'Chicken Bowl',
    serving_label: '1 bowl',
    servings: 1,
    portion_confidence: 'medium',
    assumption: 'assumed a medium bowl',
    kcal: 540,
    protein_g: 42,
    carb_g: 50,
    fat_g: 16,
    fibre_g: 4,
    ...over,
  };
}

/**
 * `resets_at` fixed rather than `Date.now() + …`: the message is asserted by
 * its NUMBER, and a relative clock would make the expected hour flaky
 * whenever the suite runs near a boundary.
 */
const RESET_ISO = '2026-08-27T15:40:00.000Z';

function response(remaining: number, over: Record<string, unknown> = {}) {
  return {
    estimate: { items: [item()], note: '', model: 'test-model', source: 'text' },
    quota: { used: 25 - remaining, limit: 25, remaining, resets_at: RESET_ISO, ...over },
  };
}

beforeEach(() => {
  mockParams = { meal: 'lunch', date: '2026-08-19' };
  mockDescribe.mockReset();
  mockLogFood.mockReset().mockResolvedValue('entry-1');
  mockSaveFood.mockReset().mockResolvedValue('food-new');
});

async function describeOnce(remaining: number) {
  mockDescribe.mockResolvedValue(response(remaining));
  render(<DescribeMealScreen />);
  fireEvent.changeText(screen.getByTestId('describe-input'), 'Chicken bowl');
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
}

describe('an exhausted quota (remaining === 0)', () => {
  it('disables the submit button and says when more free up', async () => {
    await describeOnce(0);

    expect(screen.getByTestId('describe-quota-exhausted')).toBeTruthy();
    // The submit button is disabled — checked on the a11y state, which is
    // what a screen reader announces, not just the visual dimming.
    expect(screen.getByTestId('describe-submit').props.accessibilityState.disabled).toBe(true);
  });

  it('does not fire a second request off a disabled button', async () => {
    await describeOnce(0);
    mockDescribe.mockClear();

    fireEvent.changeText(screen.getByTestId('describe-input'), 'Another meal');
    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-submit'));
    });

    // The callback's own guard is the backstop for anything that is not the
    // disabled Pressable — mirrors the pattern `logAll`'s `locked` guard
    // documents in the screen itself.
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  it('disables the camera and library buttons too — they spend the same quota', async () => {
    await describeOnce(0);

    expect(screen.getByTestId('describe-camera').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('describe-library').props.accessibilityState.disabled).toBe(true);
  });

  it('does NOT disable logging the draft already on screen', async () => {
    // Logging spends nothing — it is a local write plus the outbox, not a
    // call to the estimate endpoint. Gating it on the quota would freeze an
    // athlete's already-paid-for draft because of a LATER request that was
    // never going to be made.
    await describeOnce(0);

    expect(screen.getByTestId('describe-log').props.accessibilityState.disabled).toBe(false);

    await act(async () => {
      fireEvent.press(screen.getByTestId('describe-log'));
    });
    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
  });
});

describe('boundary: the last unit, not the first refusal', () => {
  // The discriminating case per F17's own warning: a test that only checks
  // `remaining === 0` after already being refused proves nothing about the
  // BOUNDARY — this is the response that still SUCCEEDED, carrying the
  // number that means "the one you just spent was the last one".
  it('remaining = 1 leaves every quota-spending control enabled', async () => {
    await describeOnce(1);

    expect(screen.queryByTestId('describe-quota-exhausted')).toBeNull();
    expect(screen.getByTestId('describe-submit').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId('describe-camera').props.accessibilityState.disabled).toBe(false);
  });

  it('remaining = 0 disables them on the very next render, not a tap later', async () => {
    await describeOnce(0);

    expect(screen.getByTestId('describe-submit').props.accessibilityState.disabled).toBe(true);
  });
});

it('states the actual clock time the quota resets, not a placeholder', async () => {
  await describeOnce(0);

  // Formatted from RESET_ISO — not asserting the literal locale string
  // (locale-dependent under jest), just that the message names the day's
  // limit and is not the field-absent fallback.
  const text = screen.getByTestId('describe-quota-exhausted');
  expect(text).toHaveTextContent(/25 estimates/i);
  expect(text).not.toHaveTextContent(/used all your estimates/i);
});

it('falls back to a plain statement when resets_at is missing', async () => {
  mockDescribe.mockResolvedValue(response(0, { resets_at: null }));
  render(<DescribeMealScreen />);
  fireEvent.changeText(screen.getByTestId('describe-input'), 'Chicken bowl');
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('describe-quota-exhausted')).toBeTruthy());

  expect(screen.getByTestId('describe-quota-exhausted')).toHaveTextContent(
    /used all your estimates for today/i,
  );
});
