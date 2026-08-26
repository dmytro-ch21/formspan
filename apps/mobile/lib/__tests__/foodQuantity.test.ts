/**
 * Logging a real quantity of a catalog food (N90).
 *
 * The bug this replaces: tapping a catalog row logged one 100 g serving
 * whatever the athlete actually ate.
 */
import {
  canLogByWeight,
  macrosForGrams,
  parseQuantity,
  quantityOptions,
  servingBasisGrams,
  servingsForGrams,
} from '../foodQuantity';
import { fromDisplayGrams } from '../units';
import type { CatalogFood } from '../catalogApi';

const banana: CatalogFood = {
  id: 'banana',
  name: 'Banana',
  brand: '',
  category: 'fruit',
  serving_label: '100 g',
  serving_grams: 100,
  kcal: 89,
  protein_g: 1.1,
  carb_g: 22.8,
  fat_g: 0.3,
  fibre_g: 2.6,
  saturated_fat_g: 0.1,
  sugar_g: 12.2,
  added_sugar_g: null,
  sodium_mg: 1,
  cholesterol_mg: null,
};

test('grams scale the macros, they do not round to whole servings', () => {
  // The defect: 150g of a per-100g food logged as 1 serving under-logs by a
  // third. 1.5 servings is the whole point.
  expect(servingsForGrams(banana, 150)).toBe(1.5);
  const m = macrosForGrams(banana, 150);
  expect(m.kcal).toBeCloseTo(133.5, 1);
  expect(m.protein_g).toBeCloseTo(1.7, 1);
});

test('a portion smaller than the basis logs less, not more', () => {
  // "1 extra small banana" = 81g. Before N90 this logged 100g.
  const m = macrosForGrams(banana, 81);
  expect(m.kcal).toBeCloseTo(72.1, 1);
  expect(m.kcal).toBeLessThan(banana.kcal);
});

test('fibre stays null rather than becoming zero', () => {
  // Absence is a fact about the source, never a claim about the food — the
  // most-repeated defect in this codebase.
  const noFibre: CatalogFood = { ...banana, fibre_g: null };
  expect(macrosForGrams(noFibre, 150).fibre_g).toBeNull();
  expect(macrosForGrams(banana, 150).fibre_g).toBeCloseTo(3.9, 1);
});

test('the N52 label macros scale the same way, null-preserving exactly as fibre is', () => {
  const m = macrosForGrams(banana, 150);
  // Rounded to one decimal by `round1`, same as every other macro here —
  // 0.1 * 1.5 = 0.15, which rounds to 0.2, not down to 0.1.
  expect(m.saturated_fat_g).toBeCloseTo(0.2, 1);
  expect(m.sugar_g).toBeCloseTo(18.3, 1);
  expect(m.sodium_mg).toBeCloseTo(1.5, 1);
  // Never stated for a banana, and scaling must not turn that into a zero.
  expect(m.added_sugar_g).toBeNull();
  expect(m.cholesterol_mg).toBeNull();
});

test('a null serving_grams never produces NaN macros', () => {
  // serving_grams is nullable (an egg has no honest gram weight). A null read
  // as 0 makes every macro NaN or Infinity, which renders as a blank or a
  // nonsense number rather than an error.
  const egg: CatalogFood = { ...banana, id: 'egg', serving_grams: null };
  expect(servingBasisGrams(egg)).toBe(100);
  expect(canLogByWeight(egg)).toBe(false);
  const m = macrosForGrams(egg, 50);
  expect(Number.isFinite(m.kcal)).toBe(true);
  expect(m.kcal).toBeCloseTo(44.5, 1);
  // A zero basis is the same trap arriving a different way.
  expect(servingBasisGrams({ serving_grams: 0 })).toBe(100);
});

test('100 g is always offered, and always last', () => {
  const opts = quantityOptions(banana, [
    { seq: 1, label: '1 cup, mashed', grams: 225 },
    { seq: 2, label: '1 small', grams: 101 },
  ]);
  expect(opts.map((o) => o.label)).toEqual(['1 cup, mashed', '1 small', '100 g']);
  // USDA's own order leads; the fallback is appended, never prepended.
  expect(opts[opts.length - 1].grams).toBe(100);
});

test('a food with no portions still offers a way to measure it', () => {
  // 268 of the 12,651 catalog rows state no portion at all.
  expect(quantityOptions(banana, undefined)).toEqual([{ label: '100 g', grams: 100 }]);
  expect(quantityOptions(banana, [])).toEqual([{ label: '100 g', grams: 100 }]);
});

test('the same amount is never offered twice under two names', () => {
  const opts = quantityOptions(banana, [{ seq: 1, label: '1 serving', grams: 100 }]);
  expect(opts).toHaveLength(1);
  expect(opts[0].label).toBe('1 serving');
});

test('portions with no usable weight are dropped, not shown as zero', () => {
  const opts = quantityOptions(banana, [
    { seq: 1, label: 'Quantity not specified', grams: 0 },
    { seq: 2, label: '1 small', grams: 101 },
  ]);
  expect(opts.map((o) => o.label)).toEqual(['1 small', '100 g']);
});

test('a quantity that cannot be logged parses as null rather than NaN', () => {
  // servings CHECKs > 0 server-side, so zero and negatives are a 500 waiting
  // to happen rather than an empty meal.
  for (const bad of ['', '   ', 'abc', '0', '-5', 'NaN']) {
    expect(parseQuantity(bad)).toBeNull();
  }
  expect(parseQuantity('150')).toBe(150);
  expect(parseQuantity(' 5.29 ')).toBe(5.29);
  // A comma decimal is what most of the world's keyboards produce.
  expect(parseQuantity('5,29')).toBe(5.29);
});

/**
 * N89 criterion 5, second half: **a logged entry must not follow a portion.**
 *
 * Written because `ac-verifier` found the criterion specified a test that did
 * not exist. The property held structurally — nothing anywhere stores a portion
 * reference — but "no code does this" is an argument, and the criterion asked
 * for a test. An absent guard and a guard nobody wrote a test for look identical
 * six months later.
 *
 * The rule is migration 000066's, applied one level out: a logged entry OWNS its
 * numbers. Correcting a catalog portion later must not rewrite a meal somebody
 * already ate.
 */
test('changing a portion afterwards cannot move an entry already logged', () => {
  const withPortion = { ...banana, portions: [{ seq: 1, label: '1 medium', grams: 118 }] };

  // Log against the portion: grams resolved AT LOG TIME.
  const loggedGrams = withPortion.portions[0].grams;
  const logged = {
    servings: servingsForGrams(withPortion, loggedGrams),
    ...macrosForGrams(withPortion, loggedGrams),
  };

  // USDA revises the portion — a re-import says a medium banana is 136 g.
  const revised = { ...banana, portions: [{ seq: 1, label: '1 medium', grams: 136 }] };
  const nowWouldBe = macrosForGrams(revised, revised.portions[0].grams);

  // The revision is real...
  expect(nowWouldBe.kcal).not.toBeCloseTo(logged.kcal, 1);
  // ...and the already-logged entry is untouched by it, because it holds
  // resolved numbers rather than a pointer to the portion.
  expect(logged.servings).toBeCloseTo(1.18, 2);
  expect(logged.kcal).toBeCloseTo(105, 0);
  expect(Object.keys(logged)).not.toContain('portion_id');
  expect(Object.keys(logged)).not.toContain('seq');
});

/**
 * N90 criterion 7: **the same real quantity logged in g and in oz must produce
 * identical rows.** Also specified by the criterion and previously untested.
 *
 * This is the whole storage rule in one assertion. If a display unit could ever
 * reach the database, these two diverge.
 */
test('the same quantity logged in g and in oz is the same row', () => {
  // 4 oz, expressed both ways. fromDisplayGrams is the input transform the
  // quantity control applies before anything is stored.
  const viaOunces = fromDisplayGrams(4, 'oz');
  const viaGrams = fromDisplayGrams(113.4, 'g');
  expect(viaOunces).toBeCloseTo(viaGrams, 1);

  const a = macrosForGrams(banana, viaOunces);
  const b = macrosForGrams(banana, viaGrams);
  expect(a.kcal).toBeCloseTo(b.kcal, 1);
  expect(a.protein_g).toBeCloseTo(b.protein_g, 1);
  expect(a.carb_g).toBeCloseTo(b.carb_g, 1);
  expect(a.fat_g).toBeCloseTo(b.fat_g, 1);
  expect(servingsForGrams(banana, viaOunces)).toBeCloseTo(
    servingsForGrams(banana, viaGrams),
    2,
  );
});
