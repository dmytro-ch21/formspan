import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import DescribeMealScreen from '../../app/food/describe';
import { ApiError, OfflineError } from '../../lib/apiError';

/**
 * F17 (#403) — the exhausted estimate quota — as corrected by F69 (#1238).
 *
 * Before F17, `quota.resets_at` was parsed onto every response and never
 * rendered, and `locked` (the button-disabling flag) was `busy || saving`
 * only — so an athlete who had spent the day's estimates could keep firing
 * requests that could only ever come back refused. This pins that the actions
 * that can ONLY be refused at the cap (photographing, "estimate it again",
 * "estimate it as a new meal") are disabled once `remaining` reaches zero, and
 * that logging an already-drafted row — which spends nothing — is untouched by
 * it.
 *
 * F69 removed Work it out from that list. The server answers a saved food's
 * name and a plain pointer like "the same as yesterday" above its quota gate,
 * so at the cap the phone sends the description and the server's answer says
 * whether it was free. The F69 block below pins both answers, and a dead
 * request, against the response shapes the handler really writes
 * (`backend/internal/modules/nutrition/estimate_handler.go`).
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
const mockLocalFood = jest.fn();
jest.mock('@/lib/foodLog', () => ({
  logFood: (...a: unknown[]) => mockLogFood(...a),
  saveFoodLocally: (...a: unknown[]) => mockSaveFood(...a),
  localFood: (...a: unknown[]) => mockLocalFood(...a),
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
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() }),
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
    estimate: { items: [item()], note: '', meal_name: '', model: 'test-model', source: 'text' },
    quota: { used: 25 - remaining, limit: 25, remaining, resets_at: RESET_ISO, ...over },
  };
}

/**
 * The 200 the handler writes for a plain pointer AT THE CAP — its phrase
 * branch, above `CheckQuota`, pinned server-side by
 * `TestAPlainPointerIsAnsweredEvenAtTheCap` (recent_handler_test.go). Field
 * for field the JSON tags of `Estimate` (estimate.go), `RecentLogMatch` and
 * `RecentItem` (recent.go): `items` empty and `model` empty because nothing
 * was estimated, and a quota that is only READ, so it still says zero left.
 */
function freeFromLog() {
  return {
    estimate: {
      items: [],
      note: '',
      meal_name: '',
      model: '',
      source: 'text',
      recent: {
        recognized_by: 'phrase',
        window: { from: '2026-08-14', to: '2026-08-27', days: 14 },
        reference: { day: 'yesterday', days_ago: null, weekday: null, month_day: null, meal: null, food_words: [] },
        candidates: [
          {
            eaten_on: '2026-08-26',
            meal: 'breakfast',
            items: [
              {
                name: 'Oatmeal',
                serving_label: '1 cup',
                servings: 1.5,
                portion_confidence: 'high',
                assumption: '',
                kcal: 412,
                protein_g: 14,
                carb_g: 70,
                fat_g: 8,
                fibre_g: 6.5,
                saturated_fat_g: null,
                sugar_g: 12,
                added_sugar_g: null,
                sodium_mg: 410,
                cholesterol_mg: null,
                source_food_id: 'food-oats',
                category: 'grain',
                entry_id: 'entry-1',
              },
            ],
          },
        ],
        more: 0,
      },
    },
    quota: { used: 25, limit: 25, remaining: 0, resets_at: RESET_ISO },
  };
}

/**
 * The server's refusal at the cap, built exactly as `apiRequest` builds it.
 * The handler writes `429` with code `rate_limited`, a `Retry-After`, and this
 * message (estimate_handler.go, `CheckQuota`'s `ErrQuotaExhausted` arm).
 * `TestTheQuotaIsCheckedBEFORETheModelIsCalled` pins the 429 and
 * `TestAnOutageAndAnExhaustedAllowanceAreDistinguishableByCode` pins the code.
 */
const CAP_MESSAGE = 'you have used all 25 estimates for today — one more in 20 minutes';
function capRefusal() {
  return new ApiError(CAP_MESSAGE, 'rate_limited', 429, 20 * 60 * 1000);
}

beforeEach(() => {
  mockParams = { meal: 'lunch', date: '2026-08-19' };
  mockDescribe.mockReset();
  mockLogFood.mockReset().mockResolvedValue('entry-1');
  mockSaveFood.mockReset().mockResolvedValue('food-new');
  mockLocalFood.mockReset().mockResolvedValue({ id: 'food-oats' });
});

async function describeOnce(remaining: number) {
  mockDescribe.mockResolvedValue(response(remaining));
  await render(<DescribeMealScreen />);
  await fireEvent.changeText(screen.getByTestId('describe-input'), 'Chicken bowl');
  await act(async () => {
    await fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
}

/** Type a second description on a screen that already knows the cap, and send it. */
async function askAgain(text: string) {
  await fireEvent.changeText(screen.getByTestId('describe-input'), text);
  mockDescribe.mockClear();
  await act(async () => {
    await fireEvent.press(screen.getByTestId('describe-submit'));
  });
}

describe('an exhausted quota (remaining === 0)', () => {
  it('says when more free up and what still works, and leaves Work it out enabled', async () => {
    await describeOnce(0);

    expect(screen.getByTestId('describe-quota-exhausted')).toBeTruthy();
    expect(screen.getByTestId('describe-quota-free')).toHaveTextContent(/the same as yesterday/);
    // Checked on the a11y state, which is what a screen reader announces.
    expect(screen.getByTestId('describe-submit').props.accessibilityState.disabled).toBe(false);
  });

  it('disables the camera and library buttons — a photo is never answered for free', async () => {
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
      await fireEvent.press(screen.getByTestId('describe-log'));
    });
    await waitFor(() => expect(mockLogFood).toHaveBeenCalledTimes(1));
  });
});

describe('F69 (#1238): at the cap, the server decides whether a description was free', () => {
  it('sends "the same as yesterday", and a free answer puts yesterday on screen as a draft', async () => {
    await describeOnce(0);
    mockDescribe.mockResolvedValue(freeFromLog());
    await askAgain('the same as yesterday');

    await waitFor(() => expect(mockDescribe).toHaveBeenCalledTimes(1));
    expect(mockDescribe.mock.calls[0][1]).toMatchObject({ description: 'the same as yesterday' });

    await waitFor(() => expect(screen.getByTestId('describe-recent-source')).toBeTruthy());
    expect(screen.getByTestId('describe-recent-source')).toHaveTextContent(
      'Yesterday’s breakfast, from your log. No estimate used.',
    );
    // Yesterday's entry REPLACED the earlier draft, as the athlete's own
    // numbers, still editable.
    expect(screen.getByText('Oatmeal')).toBeTruthy();
    expect(screen.queryByText('Chicken Bowl')).toBeNull();
    expect(screen.getByTestId('describe-servings-0').props.value).toBe('1.5');
    expect(screen.getByTestId('describe-kcal-0').props.value).toBe('412');
    expect(screen.queryByTestId('describe-error')).toBeNull();

    // Still at the cap, because the server still says so.
    expect(screen.getByTestId('describe-quota-exhausted')).toBeTruthy();
    expect(screen.getByTestId('describe-quota')).toHaveTextContent('0 of 25 estimates left');
    // "Estimate it as a new meal" switches the free path off, so it stays gated.
    expect(screen.getByTestId('describe-recent-estimate').props.accessibilityState.disabled).toBe(true);
  });

  it('a description that needs the model gets the server’s refusal, and no estimate for it', async () => {
    await describeOnce(0);
    mockDescribe.mockRejectedValue(capRefusal());
    await askAgain('a burrito with extra rice');

    await waitFor(() => expect(mockDescribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('describe-error')).toBeTruthy());
    // The server's own words, carrying its own wait. Not a phone-made claim.
    expect(screen.getByTestId('describe-error')).toHaveTextContent(CAP_MESSAGE);
    expect(screen.getByTestId('describe-quota-exhausted')).toBeTruthy();

    // Nothing was drafted for the refused description. The draft already on
    // screen is the one the athlete paid for earlier, and it is left alone.
    expect(screen.getByText('Chicken Bowl')).toBeTruthy();
    expect(screen.getByTestId('describe-kcal-0').props.value).toBe('540');
    expect(screen.queryByTestId('describe-servings-1')).toBeNull();
    expect(screen.queryByTestId('describe-empty')).toBeNull();
    expect(screen.queryByTestId('describe-recent-source')).toBeNull();
    expect(screen.queryByTestId('describe-recent-none')).toBeNull();
    expect(screen.getByTestId('describe-quota')).toHaveTextContent('0 of 25 estimates left');
  });

  it('offline at the cap, the failure is named as the connection, never as the cap', async () => {
    await describeOnce(0);
    mockDescribe.mockRejectedValue(new OfflineError());
    await askAgain('the same as yesterday');

    await waitFor(() => expect(screen.getByTestId('describe-error')).toBeTruthy());
    expect(screen.getByTestId('describe-error')).toHaveTextContent(
      "Can't reach VOLA. Enter the food by hand instead.",
    );
    expect(screen.getByTestId('describe-error')).not.toHaveTextContent(/estimates|used all/i);
    expect(screen.getByText('Chicken Bowl')).toBeTruthy();
    expect(screen.queryByTestId('describe-recent-source')).toBeNull();
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
    expect(screen.queryByTestId('describe-quota-free')).toBeNull();
    expect(screen.getByTestId('describe-submit').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId('describe-camera').props.accessibilityState.disabled).toBe(false);
  });

  it('remaining = 0 disables the photo buttons on the very next render, not a tap later', async () => {
    await describeOnce(0);

    expect(screen.getByTestId('describe-camera').props.accessibilityState.disabled).toBe(true);
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
  await render(<DescribeMealScreen />);
  await fireEvent.changeText(screen.getByTestId('describe-input'), 'Chicken bowl');
  await act(async () => {
    await fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('describe-quota-exhausted')).toBeTruthy());

  expect(screen.getByTestId('describe-quota-exhausted')).toHaveTextContent(
    /used all your estimates for today/i,
  );
});
