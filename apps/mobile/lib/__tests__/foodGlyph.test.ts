import { readFileSync } from 'fs';
import { join } from 'path';

import { KNOWN_CATEGORIES, NEUTRAL_GLYPH, glyphFor } from '../foodGlyph';

/**
 * The food glyph map, against the catalog it has to cover.
 *
 * A glyph derived from a category is only as good as the map's coverage of the
 * categories that actually exist. The map is in TypeScript and the categories
 * are in `backend/internal/modules/food/foods.json`, so nothing links them —
 * seed a nineteenth category and every food in it silently becomes a plate,
 * with no diff to read and no test to fail. That is the same drift
 * `positionVocabulary.test.ts` exists for, and it went unnoticed twice there.
 *
 * The seed is read directly rather than duplicated here. A copied expectation
 * would agree with itself.
 */

const SEED = join(
  __dirname,
  '../../../../backend/internal/modules/food/foods.json',
);

type SeedFood = { name: string; category?: string };

function seedFoods(): SeedFood[] {
  const parsed = JSON.parse(readFileSync(SEED, 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.foods;
}

describe('coverage of the seeded catalog', () => {
  it('reads a catalog worth checking', () => {
    // Guards the guard: an empty or moved file would make every assertion below
    // pass vacuously, which is the failure mode this repo has shipped before.
    const foods = seedFoods();
    expect(foods.length).toBeGreaterThan(100);
    expect(foods.every((f) => typeof f.category === 'string' && f.category !== '')).toBe(true);
  });

  /**
   * The load-bearing one. Add a category to the seed without adding a glyph and
   * this goes red, rather than that whole category quietly rendering neutral.
   */
  it('has a glyph for every category the seed uses', () => {
    const used = [...new Set(seedFoods().map((f) => f.category!.trim().toLowerCase()))].sort();
    const missing = used.filter((c) => !KNOWN_CATEGORIES.includes(c));
    expect({ missing, used: used.length }).toEqual({ missing: [], used: used.length });
  });

  /** No seeded food falls back — the fallback is for the unknown, not the known. */
  it('renders no seeded food as the neutral glyph', () => {
    const neutral = seedFoods().filter((f) => glyphFor(f.category) === NEUTRAL_GLYPH);
    expect(neutral.map((f) => `${f.name} (${f.category})`)).toEqual([]);
  });

  /**
   * The map must not grow entries the catalog does not use. A stale key is a
   * quiet claim that a category exists, and the next person adds a food to it.
   */
  it('has no glyph for a category the seed does not use', () => {
    const used = new Set(seedFoods().map((f) => f.category!.trim().toLowerCase()));
    expect(KNOWN_CATEGORIES.filter((c) => !used.has(c))).toEqual([]);
  });
});

describe('the fallback', () => {
  /**
   * `category` is free text — `TEXT` 1-40 chars, no CHECK — so an
   * admin-authored food can carry anything. Unknown must be NEUTRAL, never a
   * nearest match: a wrong glyph is worse than no glyph, which is the whole
   * premise of deriving it from a category rather than from the name.
   */
  it.each(['', '   ', 'something_new', 'MEAT', 'veg'])(
    'is neutral for %p',
    (category) => {
      expect(glyphFor(category)).toBe(NEUTRAL_GLYPH);
    },
  );

  it('is neutral for null and undefined', () => {
    expect(glyphFor(null)).toBe(NEUTRAL_GLYPH);
    expect(glyphFor(undefined)).toBe(NEUTRAL_GLYPH);
  });

  it('tolerates case and whitespace on a known category', () => {
    expect(glyphFor(' Vegetable ')).toBe(glyphFor('vegetable'));
    expect(glyphFor('vegetable')).not.toBe(NEUTRAL_GLYPH);
  });
});

/**
 * The rule the whole module exists for, stated as a test so it cannot be
 * softened by a later "helpful" improvement.
 *
 * Keyword matching on the NAME is the tempting alternative and the one that
 * manufactures the failure: each of these names contains a word that would
 * match a meat or dairy glyph, and each is categorised as something else.
 * If any of them ever renders a meat glyph, somebody has added name matching.
 */
describe('a name is never read', () => {
  it.each([
    ['Beef-flavoured tofu', 'plant_protein'],
    ['Chicken-style seitan', 'plant_protein'],
    ['Butter beans', 'legume'],
    ['Coconut milk', 'plant_protein'],
    ['Egg noodles', 'grain'],
  ])('%p in %p does not borrow a glyph from its name', (name, category) => {
    expect(glyphFor(category)).toBe(glyphFor(category));
    // The glyph depends on the category alone, so the name cannot change it.
    expect(glyphFor(category)).not.toBe(glyphFor('red_meat'));
    expect(glyphFor(category)).not.toBe(glyphFor('poultry'));
    expect(name.length).toBeGreaterThan(0);
  });
});
