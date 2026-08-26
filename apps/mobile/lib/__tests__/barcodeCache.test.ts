/**
 * The device-side barcode cache, against a real SQLite database.
 *
 * A fixture rather than a mock, for the reason `support/sqlite.ts` records: an
 * array mock can silently SUPPLY the behaviour under test, and the upsert and
 * the user scoping here are both properties of the SQL rather than of the
 * TypeScript around it. Running the app's own `migrate()` also means the
 * `barcode_cache` table under test is the one that ships.
 */

import { cachedBarcode, forgetOpenFoodFactsRows, rememberBarcode } from '../barcodeCache';
import type { ScannedFood } from '../barcodeApi';
import { migratedFixture, type FixtureDb } from './support/sqlite';

let mockFixture: FixtureDb;

jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const OATS: ScannedFood = {
  name: 'Rolled oats',
  brand: 'Flahavans',
  serving_label: '40 g',
  serving_grams: 40,
  kcal: 150,
  protein_g: 5.2,
  carb_g: 26.4,
  fat_g: 2.8,
  fibre_g: 3.6,
  // Real values, not null, deliberately: "round-trips a scanned food" below
  // does a deep `toEqual` against the read-back row, so these are what
  // actually exercises the N59 migration's new `barcode_cache` columns rather
  // than merely typechecking against them.
  saturated_fat_g: 0.5,
  sugar_g: 1.1,
  added_sugar_g: null,
  sodium_mg: 2,
  cholesterol_mg: null,
};

beforeEach(async () => {
  mockFixture = await migratedFixture();
});

it('round-trips a scanned food', async () => {
  await rememberBarcode('u1', '4006381333931', OATS, 'off');
  const hit = await cachedBarcode('u1', '4006381333931');
  expect(hit).not.toBeNull();
  expect(hit!.food).toEqual(OATS);
  expect(hit!.source).toBe('off');
});

it('returns null for a barcode never scanned', async () => {
  expect(await cachedBarcode('u1', '4006381333931')).toBeNull();
});

/**
 * Two athletes on one phone is rare, and one reading anything the other's
 * account produced is not a thing to allow by omission.
 */
it('does not leak one user’s cache to another', async () => {
  await rememberBarcode('u1', '4006381333931', OATS, 'off');
  expect(await cachedBarcode('u2', '4006381333931')).toBeNull();
});

/**
 * The upsert. A product whose numbers are corrected upstream must overwrite,
 * not duplicate — the primary key is what enforces that, and a test that only
 * inserted once would pass with the `ON CONFLICT` clause deleted.
 */
it('overwrites an existing row rather than duplicating it', async () => {
  await rememberBarcode('u1', '4006381333931', OATS, 'off');
  await rememberBarcode('u1', '4006381333931', { ...OATS, kcal: 158 }, 'catalog');

  const rows = await mockFixture.getAllAsync<{ n: number }>(
    `SELECT count(*) AS n FROM barcode_cache WHERE user_id = 'u1'`,
  );
  expect(rows[0].n).toBe(1);
  const hit = await cachedBarcode('u1', '4006381333931');
  expect(hit!.food.kcal).toBe(158);
  expect(hit!.source).toBe('catalog');
});

it('keeps a null fibre null rather than turning it into zero', async () => {
  await rememberBarcode('u1', '4006381333931', { ...OATS, fibre_g: null }, 'off');
  expect((await cachedBarcode('u1', '4006381333931'))!.food.fibre_g).toBeNull();
});

describe('provenance', () => {
  it.each(['catalog', 'off', 'ai'] as const)('preserves a %s source', async (source) => {
    await rememberBarcode('u1', '4006381333931', OATS, source);
    expect((await cachedBarcode('u1', '4006381333931'))!.source).toBe(source);
  });

  /**
   * An unrecognised source falls to `ai`, the most cautious of the three —
   * `ai` is the only value whose copy tells the athlete the numbers were
   * drafted rather than read off a packet. Falling to `catalog` would be the
   * unsafe direction: it would hand a row of unknown origin the credibility of
   * a curated one.
   */
  it('reports an unrecognised source as the cautious one', async () => {
    await mockFixture.runAsync(
      `INSERT INTO barcode_cache
         (user_id, barcode, name, brand, serving_label, serving_grams,
          kcal, protein_g, carb_g, fat_g, fibre_g, source, cached_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      'u1', '4006381333931', 'Mystery', '', '100 g', 100, 1, 0, 0, 0, null,
      'some-future-source', '2026-08-19T00:00:00.000Z',
    );
    expect((await cachedBarcode('u1', '4006381333931'))!.source).toBe('ai');
  });
});

/**
 * Separability from Open Food Facts is a LICENCE property, not a preference.
 * Migration `000059` says the ODbL share-alike obligation "must never reach
 * our own data", and the test of that is whether walking away is one
 * statement that leaves everything else standing.
 */
describe('forgetOpenFoodFactsRows', () => {
  it('removes every ODbL row and nothing else', async () => {
    await rememberBarcode('u1', '4006381333931', OATS, 'off');
    await rememberBarcode('u1', '0036000291452', OATS, 'catalog');
    await rememberBarcode('u2', '5000112637922', OATS, 'off');
    await rememberBarcode('u1', '0000096385074', OATS, 'ai');

    expect(await forgetOpenFoodFactsRows()).toBe(2);

    expect(await cachedBarcode('u1', '4006381333931')).toBeNull();
    expect(await cachedBarcode('u2', '5000112637922')).toBeNull();
    // Ours survive.
    expect(await cachedBarcode('u1', '0036000291452')).not.toBeNull();
    expect(await cachedBarcode('u1', '0000096385074')).not.toBeNull();
  });
});
