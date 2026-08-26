/**
 * The barcode lookup client, and the distinction the whole feature rests on.
 *
 * "The server says it does not have this" and "I could not ask" arrive as the
 * same rejected promise unless something separates them, and rendering the
 * second as the first tells the athlete something false about the catalog
 * because their signal was bad. `apiError.ts`'s own `isNotFound` note is about
 * the same mistake shipping in the profile screen.
 */

import { ApiError, OfflineError } from '../apiError';
import { lookupBarcode, type ScannedFood } from '../barcodeApi';

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({
  apiRequest: (...args: unknown[]) => mockApi(...args),
}));

const getToken = async () => 'token';

const FOOD: ScannedFood = {
  name: 'Rolled oats',
  brand: 'Flahavans',
  serving_label: '40 g',
  serving_grams: 40,
  kcal: 150,
  protein_g: 5.2,
  carb_g: 26.4,
  fat_g: 2.8,
  fibre_g: 3.6,
  saturated_fat_g: 0.5,
  sugar_g: 1.1,
  added_sugar_g: null,
  sodium_mg: 2,
  cholesterol_mg: null,
};

beforeEach(() => mockApi.mockReset());

it('returns the food and its source on a hit', async () => {
  mockApi.mockResolvedValue({ food: FOOD, source: 'off' });
  const res = await lookupBarcode(getToken, '4006381333931');
  expect(res).toEqual({ status: 'found', food: FOOD, source: 'off' });
});

it('asks the catalog endpoint for the code it was given', async () => {
  mockApi.mockResolvedValue({ food: FOOD, source: 'catalog' });
  await lookupBarcode(getToken, '4006381333931');
  expect(mockApi).toHaveBeenCalledWith(getToken, '/nutrition/catalog/barcode/4006381333931');
});

/**
 * A genuine miss is a RETURN, not a throw — so a caller cannot collapse it
 * into the network-failure branch by accident.
 */
it('reads a not_found envelope as a genuine miss', async () => {
  mockApi.mockRejectedValue(new ApiError('No such food.', 'not_found', 404));
  await expect(lookupBarcode(getToken, '4006381333931')).resolves.toEqual({
    status: 'unknown',
    code: '4006381333931',
  });
});

/**
 * The case that makes the previous one non-trivial.
 *
 * An unrouted path also 404s, and `apiRequest` fills `code` with `'unknown'`
 * when there is no error envelope to read. Treating that as a miss would tell
 * every athlete the catalog lacked their food when the truth is the endpoint
 * is not deployed — which is precisely this branch's state until N42 lands.
 * Delete the `err.code === 'not_found'` check and this test goes red while the
 * one above stays green.
 */
it('does NOT read a bare, unrouted 404 as a miss', async () => {
  mockApi.mockRejectedValue(new ApiError('Request failed (404).', 'unknown', 404));
  await expect(lookupBarcode(getToken, '4006381333931')).rejects.toBeInstanceOf(ApiError);
});

it('rethrows an offline failure rather than calling it a miss', async () => {
  mockApi.mockRejectedValue(new OfflineError());
  await expect(lookupBarcode(getToken, '4006381333931')).rejects.toBeInstanceOf(OfflineError);
});

it('rethrows a server error rather than calling it a miss', async () => {
  mockApi.mockRejectedValue(new ApiError('Boom.', 'internal', 500));
  await expect(lookupBarcode(getToken, '4006381333931')).rejects.toBeInstanceOf(ApiError);
});

/**
 * The server's `sourceOf` returns `off`, `catalog`, or **the provider's own
 * name** — so a provider added later arrives as a string this build has never
 * seen. It must not fall through to the catalog copy, which would tell the
 * athlete a third party's row came from VOLA, and it must not be called Open
 * Food Facts either, which would name the wrong company for someone else's
 * data.
 */
describe('an unrecognised provider', () => {
  it('is reported as neither ours nor Open Food Facts', async () => {
    mockApi.mockResolvedValue({ food: FOOD, source: 'usda' });
    const res = await lookupBarcode(getToken, '4006381333931');
    expect(res).toEqual({ status: 'found', food: FOOD, source: 'other' });
  });

  it.each(['catalog', 'off'] as const)('passes %s through unchanged', async (source) => {
    mockApi.mockResolvedValue({ food: FOOD, source });
    const res = await lookupBarcode(getToken, '4006381333931');
    expect(res).toMatchObject({ source });
  });
});

/**
 * The shipped endpoint answers 503 `unavailable` for a transport failure and
 * 404 `not_found` for a genuine miss, and the split is keyed on the CODE rather
 * than the status — a plain 200 from Open Food Facts can mean either found or
 * not-found, so status alone cannot carry it.
 */
it('treats the server\'s 503 unavailable as could-not-ask, not a miss', async () => {
  mockApi.mockRejectedValue(
    new ApiError('could not reach the barcode provider', 'unavailable', 503),
  );
  await expect(lookupBarcode(getToken, '4006381333931')).rejects.toBeInstanceOf(ApiError);
});
