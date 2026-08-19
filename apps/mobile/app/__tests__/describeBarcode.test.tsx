import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import DescribeMealScreen from '../food/describe';

/**
 * The third rung of the scan ladder: catalog, then Open Food Facts, then
 * describe it yourself.
 *
 * This file covers ONLY what N41 added to the describe screen — teaching this
 * phone a packet the catalog did not have. The estimate/confirm behaviour
 * itself is N26's and is not re-asserted here; two tests with opinions about
 * one rule is how they end up disagreeing.
 *
 * Three properties, each of which fails silently:
 *
 *   - a barcode is only learned when the draft is a SINGLE row. A barcode
 *     names one product; caching a three-item draft against it would resolve
 *     that packet to whichever item sorted first, forever.
 *   - it is cached as `ai`, never as `catalog` or `off`. N40 measured the
 *     estimator doubling a quantity and reporting `medium` with no hedge, so a
 *     drafted figure wearing a catalog row's provenance is a guess with a
 *     fact's credibility.
 *   - the figures are stored PER SERVING, because that is what the scan screen
 *     scales next time. A draft carries the item's total.
 */

/**
 * `useEffect`, captured for the `expo-router` mock below.
 *
 * A `mock`-prefixed binding rather than a `require('react')` inside the
 * factory: jest hoists `jest.mock` above the imports, so a factory may only
 * close over names it can prove are safe, and `mock*` is the prefix
 * babel-plugin-jest-hoist exempts. `require()` in a factory works but trips
 * `@typescript-eslint/no-require-imports`, and this app's lint gate is a
 * warning RATCHET — a new warning fails the build rather than being absorbed.
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

const mockRemember = jest.fn();
jest.mock('@/lib/barcodeCache', () => ({
  rememberBarcode: (...a: unknown[]) => mockRemember(...a),
  cachedBarcode: jest.fn(),
}));

const mockLogFood = jest.fn();
jest.mock('@/lib/foodLog', () => ({ logFood: (...a: unknown[]) => mockLogFood(...a) }));
jest.mock('@/lib/sync', () => ({ request: jest.fn() }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-image-manipulator', () => ({ SaveFormat: { JPEG: 'jpeg' } }));

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  __esModule: true,
  // Keyed on the callback, matching the shared setup's mock — something in
  // this screen's tree uses it, and a `[]`-keyed version renders a screen that
  // can never reload.
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  Stack: { Screen: () => null },
}));

/** One item, 2 servings — so per-serving is half of what the draft carries. */
function item(over: Record<string, unknown> = {}) {
  return {
    name: 'Protein bar',
    serving_label: '1 bar',
    servings: 2,
    portion_confidence: 'high',
    assumption: '',
    kcal: 400,
    protein_g: 40,
    carb_g: 30,
    fat_g: 12,
    fibre_g: 6,
    ...over,
  };
}

function estimate(items: unknown[]) {
  return {
    estimate: { items, note: '', model: 'test', source: 'text' },
    quota: { source: 'text', used: 1, limit: 10, remaining: 9, resets_at: null },
  };
}

async function draftAndLog() {
  render(<DescribeMealScreen />);
  fireEvent.changeText(screen.getByTestId('describe-input'), 'a protein bar');
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-log'));
  });
}

beforeEach(() => {
  mockParams = { meal: 'lunch', date: '2026-08-19' };
  mockDescribe.mockReset();
  mockRemember.mockReset().mockResolvedValue(undefined);
  mockLogFood.mockReset().mockResolvedValue('entry-1');
});

it('learns the packet when the draft is a single item', async () => {
  mockParams.barcode = '4006381333931';
  mockDescribe.mockResolvedValue(estimate([item()]));

  await draftAndLog();

  await waitFor(() => expect(mockRemember).toHaveBeenCalledTimes(1));
  const [userId, code, food, source] = mockRemember.mock.calls[0];
  expect(userId).toBe('u1');
  expect(code).toBe('4006381333931');
  expect(source).toBe('ai');
  expect(food.name).toBe('Protein bar');
  expect(food.serving_label).toBe('1 bar');
  // PER SERVING: the draft carried 400 kcal across 2 servings.
  expect(food.kcal).toBe(200);
  expect(food.protein_g).toBe(20);
  expect(food.fibre_g).toBe(3);
});

/**
 * A barcode names ONE product. Caching a multi-item draft against it would
 * pick a winner arbitrarily and be wrong forever, with nothing on screen to
 * say it had happened. The meal is still logged; the barcode simply stays
 * unknown, which is the honest outcome.
 */
it('does not learn the packet from a multi-item draft', async () => {
  mockParams.barcode = '4006381333931';
  mockDescribe.mockResolvedValue(estimate([item(), item({ name: 'Banana' })]));

  await draftAndLog();

  expect(mockLogFood).toHaveBeenCalledTimes(2);
  expect(mockRemember).not.toHaveBeenCalled();
});

/** Arriving without a barcode must not invent one to cache against. */
it('caches nothing when there was no barcode', async () => {
  mockDescribe.mockResolvedValue(estimate([item()]));

  await draftAndLog();

  expect(mockLogFood).toHaveBeenCalledTimes(1);
  expect(mockRemember).not.toHaveBeenCalled();
});

/**
 * A draft whose servings are zero cannot be divided by. Without the guard the
 * per-serving figures become Infinity and reach the cache, and from there a
 * future log entry.
 */
it('survives a zero-serving draft rather than caching Infinity', async () => {
  mockParams.barcode = '4006381333931';
  mockDescribe.mockResolvedValue(estimate([item({ servings: 0 })]));

  await draftAndLog();

  await waitFor(() => expect(mockRemember).toHaveBeenCalled());
  expect(Number.isFinite(mockRemember.mock.calls[0][2].kcal)).toBe(true);
});

/**
 * The guard has to be about the DRAFT, not about the attempt.
 *
 * `logAll` drops each row as it lands, so a two-item draft whose first item
 * logs and second fails leaves exactly one row on screen. A retry then looks
 * like a single-item save — and caching that lone remainder against the packet
 * is the same "whichever item happened to be first, forever" outcome the guard
 * forbids, just with the last one instead. Found in review; the per-attempt
 * version of this guard shipped in the first draft.
 */
it('does not learn the packet from the remainder of a failed multi-item save', async () => {
  mockParams.barcode = '4006381333931';
  mockDescribe.mockResolvedValue(estimate([item(), item({ name: 'Banana' })]));
  mockLogFood.mockResolvedValueOnce('entry-1').mockRejectedValueOnce(new Error('offline'));

  render(<DescribeMealScreen />);
  fireEvent.changeText(screen.getByTestId('describe-input'), 'a bar and a banana');
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());

  // First attempt: one lands, one fails and stays on screen.
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-log'));
  });
  expect(mockRemember).not.toHaveBeenCalled();

  // The retry now sees a single row. It must still refuse to teach the packet.
  mockLogFood.mockResolvedValue('entry-2');
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-log'));
  });
  expect(mockLogFood).toHaveBeenCalledTimes(3);
  expect(mockRemember).not.toHaveBeenCalled();
});

/**
 * The athlete can retype the description entirely, so the screen has to say
 * what confirming will attach to the packet.
 */
it('says which barcode a confirm will be remembered for', async () => {
  mockParams.barcode = '4006381333931';
  mockDescribe.mockResolvedValue(estimate([item()]));

  render(<DescribeMealScreen />);
  fireEvent.changeText(screen.getByTestId('describe-input'), 'a protein bar');
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('describe-barcode-note')).toBeTruthy());
  expect(screen.getByTestId('describe-barcode-note')).toHaveTextContent(/4006381333931/);
});

/** No barcode, no promise about one. */
it('shows no barcode note when there was no barcode', async () => {
  mockDescribe.mockResolvedValue(estimate([item()]));

  render(<DescribeMealScreen />);
  fireEvent.changeText(screen.getByTestId('describe-input'), 'a protein bar');
  await act(async () => {
    fireEvent.press(screen.getByTestId('describe-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('describe-log')).toBeTruthy());
  expect(screen.queryByTestId('describe-barcode-note')).toBeNull();
});
