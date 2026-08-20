/**
 * Food quantity units (N90).
 *
 * The rule under test is the one `lib/units.ts` states for every other measure:
 * **grams are stored, ounces are a display and input transform.** These
 * assertions are written so that a wrong conversion constant, or a rounding
 * choice that loses precision, fails rather than merely looking plausible.
 */
import {
  defaultFoodUnit,
  formatFoodQuantity,
  foodUnitLabel,
  fromDisplayGrams,
  toDisplayGrams,
} from '../units';

test('one ounce is 28.35 grams, not a rounded 28', () => {
  // The exact avoirdupois ounce. A "28" would be 1.2% light — invisible on one
  // egg and 30g out over a day's protein.
  expect(fromDisplayGrams(1, 'oz')).toBeCloseTo(28.35, 2);
  expect(toDisplayGrams(28.349523125, 'oz')).toBeCloseTo(1, 2);
});

test('grams pass through untouched', () => {
  expect(fromDisplayGrams(150, 'g')).toBe(150);
  expect(toDisplayGrams(150, 'g')).toBe(150);
});

test('an oz round trip comes back unchanged at the precision offered', () => {
  // Type it in ounces, store grams, redisplay in ounces. This is the sequence
  // an athlete performs every time they reopen an entry, and a lossy round trip
  // shows up as a number that drifts each time they look at it.
  for (const typed of [0.5, 1, 3.5, 5.29, 6, 12.75, 16]) {
    const stored = fromDisplayGrams(typed, 'oz');
    expect(toDisplayGrams(stored, 'oz')).toBeCloseTo(typed, 2);
  }
});

test('a gram round trip is exact', () => {
  for (const typed of [1, 30, 100, 150, 999]) {
    expect(toDisplayGrams(fromDisplayGrams(typed, 'g'), 'g')).toBe(typed);
  }
});

test('switching unit CONVERTS the quantity rather than reinterpreting it', () => {
  // 150g is 5.29oz. The failure this guards against is a toggle that leaves the
  // number alone and just relabels it — turning 150 grams of chicken into 150
  // ounces, a 28x overcount, with no visible change on screen except two
  // letters.
  const grams = 150;
  expect(toDisplayGrams(grams, 'g')).toBe(150);
  expect(toDisplayGrams(grams, 'oz')).toBeCloseTo(5.29, 2);
});

test('the default follows unit_system, and ONLY as a default', () => {
  expect(defaultFoodUnit('imperial')).toBe('oz');
  expect(defaultFoodUnit('metric')).toBe('g');
});

test('formatting labels the unit it actually used', () => {
  expect(formatFoodQuantity(150, 'g')).toBe('150g');
  expect(formatFoodQuantity(150, 'oz')).toBe('5.29oz');
  // Absence is not zero — the same rule the nutrient fields follow.
  expect(formatFoodQuantity(null, 'g')).toBe('—');
  expect(formatFoodQuantity(undefined, 'oz')).toBe('—');
  expect(foodUnitLabel('oz')).toBe('oz');
});
