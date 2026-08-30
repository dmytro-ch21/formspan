/**
 * `servingLine` (N448) — the exact line the ticket was reported against:
 * searching "Red Bull" showed "cals per 100 g" instead of "cals per 1 can".
 *
 * Pure-function coverage, no render: `servingLine` takes a `CatalogFood` and
 * returns a string, so exercising it directly is both faster and a stronger
 * guard than asserting the same text inside a rendered card — a rendering
 * bug and a math bug would otherwise be indistinguishable failures.
 */
import { servingLine } from '../CatalogCard';
import type { CatalogFood } from '@/lib/catalogApi';

function food(over: Partial<CatalogFood> = {}): CatalogFood {
  return {
    id: 'usda-173210',
    name: 'Beverages, Energy drink, RED BULL',
    brand: '',
    category: 'beverages',
    serving_label: '100 g',
    serving_grams: 100,
    natural_serving_label: null,
    natural_serving_grams: null,
    kcal: 43,
    protein_g: 0.5,
    carb_g: 11,
    fat_g: 0,
    fibre_g: null,
    saturated_fat_g: null,
    sugar_g: null,
    added_sugar_g: null,
    sodium_mg: null,
    cholesterol_mg: null,
    ...over,
  };
}

test('a food with a natural serving shows cals against IT, not 100 g', () => {
  const redBull = food({ natural_serving_label: '1 can 8.4 fl oz', natural_serving_grams: 258 });
  // 43 kcal/100g * 258g = 110.94, rounds to 111 — matches the reported figure
  // ("110 [kcal]") to within rounding of the real USDA number.
  expect(servingLine(redBull)).toBe('111 cals per 1 can 8.4 fl oz');
});

test('a food with NO natural serving still shows 100 g honestly, never a fabricated one', () => {
  // 268 of 12,651 catalog rows are in this state — the ticket's own third
  // acceptance criterion.
  expect(servingLine(food())).toBe('43 cals per 100 g');
});

test('a null label with a non-null grams (should never happen server-side) still falls back safely', () => {
  // Defensive: the pair is always both-null or both-present server-side (see
  // Food.NaturalServingLabel's doc), but this function must not crash or show
  // a half-formed line if that pairing were ever violated.
  expect(servingLine(food({ natural_serving_grams: 258, natural_serving_label: null }))).toBe(
    '43 cals per 100 g',
  );
});
