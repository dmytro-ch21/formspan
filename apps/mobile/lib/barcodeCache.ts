/**
 * Barcodes this device has already resolved.
 *
 * ## Why a scan caches at all
 *
 * The place a barcode gets scanned is a shop, and a shop is where the signal
 * is worst. Logging is offline-first everywhere else in this app — the outbox
 * takes a meal with no network and pushes it later — but a LOOKUP is a
 * genuinely online act: the phone cannot know what is in a packet it has never
 * seen. So the honest position is that the first scan of a product needs
 * signal and every scan after it does not, and the screen says which of those
 * it is rather than showing a spinner and then nothing.
 *
 * That asymmetry is worth stating because it is the one place this feature
 * cannot be as offline-tolerant as the rest of nutrition, and pretending
 * otherwise would mean an empty result that reads as "this food does not
 * exist" when it means "you are in a basement".
 *
 * ## What is NOT cached
 *
 * A miss. If the server said it does not have this barcode, that answer is not
 * written down — a product missing today is exactly the kind of thing that is
 * present next week once somebody adds it, and a cached miss would keep
 * telling the athlete "we do not have this one" long after we did. Caching
 * absence is how absence stops being checkable.
 */

import type { CachedSource, ScannedFood } from './barcodeApi';
import { getDb } from './db';

type CacheRow = {
  name: string;
  brand: string;
  serving_label: string;
  serving_grams: number | null;
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number | null;
  saturated_fat_g: number | null;
  sugar_g: number | null;
  added_sugar_g: number | null;
  sodium_mg: number | null;
  cholesterol_mg: number | null;
  source: string;
};

export type CachedScan = { food: ScannedFood; source: CachedSource };

/**
 * What this device already knows about a barcode, or null.
 *
 * Scoped to `user_id` like every other local table: two athletes sharing a
 * phone is rare, and one reading anything the other's account produced is not
 * a thing to allow by omission.
 */
export async function cachedBarcode(
  userId: string,
  barcode: string,
): Promise<CachedScan | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<CacheRow>(
    `SELECT name, brand, serving_label, serving_grams,
            kcal, protein_g, carb_g, fat_g, fibre_g,
            saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg, source
       FROM barcode_cache
      WHERE user_id = ? AND barcode = ?`,
    userId,
    barcode,
  );
  if (!row) return null;
  return {
    food: {
      name: row.name,
      brand: row.brand,
      serving_label: row.serving_label,
      serving_grams: row.serving_grams,
      kcal: row.kcal,
      protein_g: row.protein_g,
      carb_g: row.carb_g,
      fat_g: row.fat_g,
      fibre_g: row.fibre_g,
      saturated_fat_g: row.saturated_fat_g,
      sugar_g: row.sugar_g,
      added_sugar_g: row.added_sugar_g,
      sodium_mg: row.sodium_mg,
      cholesterol_mg: row.cholesterol_mg,
    },
    // Narrowed rather than asserted: the column is TEXT, so a row written by a
    // future build with a source this one does not know must not silently type
    // as one of these. Anything unrecognised falls to `ai`, which is the most
    // cautious of the three — it is the only value whose copy tells the
    // athlete the numbers were drafted rather than read off a packet, so an
    // unknown provenance being treated as a guess errs the safe way. Claiming
    // `catalog` for an unrecognised row would be the unsafe direction.
    source:
      row.source === 'catalog' || row.source === 'off' || row.source === 'ai' || row.source === 'other'
        ? row.source
        : 'ai',
  };
}

/**
 * Remember what a barcode resolved to.
 *
 * An upsert, because a product's numbers can be corrected upstream and the
 * fresher answer should win — the cache is a copy, never the record. The
 * athlete's own log is unaffected either way: a confirmed entry COPIES these
 * values rather than pointing at this row, so correcting a cached product can
 * never rewrite a meal already logged. That is the same rule
 * `nutrition_recipe_items` follows for a recipe's components.
 */
export async function rememberBarcode(
  userId: string,
  barcode: string,
  food: ScannedFood,
  source: CachedSource,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO barcode_cache
       (user_id, barcode, name, brand, serving_label, serving_grams,
        kcal, protein_g, carb_g, fat_g, fibre_g,
        saturated_fat_g, sugar_g, added_sugar_g, sodium_mg, cholesterol_mg, source, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, barcode) DO UPDATE SET
       name = excluded.name,
       brand = excluded.brand,
       serving_label = excluded.serving_label,
       serving_grams = excluded.serving_grams,
       kcal = excluded.kcal,
       protein_g = excluded.protein_g,
       carb_g = excluded.carb_g,
       fat_g = excluded.fat_g,
       fibre_g = excluded.fibre_g,
       saturated_fat_g = excluded.saturated_fat_g,
       sugar_g = excluded.sugar_g,
       added_sugar_g = excluded.added_sugar_g,
       sodium_mg = excluded.sodium_mg,
       cholesterol_mg = excluded.cholesterol_mg,
       source = excluded.source,
       cached_at = excluded.cached_at`,
    userId,
    barcode,
    food.name,
    food.brand,
    food.serving_label,
    food.serving_grams,
    food.kcal,
    food.protein_g,
    food.carb_g,
    food.fat_g,
    food.fibre_g,
    food.saturated_fat_g,
    food.sugar_g,
    food.added_sugar_g,
    food.sodium_mg,
    food.cholesterol_mg,
    source,
    new Date().toISOString(),
  );
}

/**
 * Drop every ODbL-derived row.
 *
 * Nothing calls this yet, and it is here deliberately: separability from Open
 * Food Facts data is a LICENCE property, not a preference, and the test of it
 * is whether walking away is one statement. Migration `000059` states the
 * obligation "must never reach our own data"; this is the device-side half of
 * being able to prove that. Scoped to `source = 'off'` so curated catalog rows
 * — which we may keep — survive it.
 */
export async function forgetOpenFoodFactsRows(): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync(`DELETE FROM barcode_cache WHERE source = 'off'`);
  return res.changes;
}
