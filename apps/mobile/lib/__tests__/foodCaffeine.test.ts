import {
  FOOD_CAFFEINE_ID_INFIX,
  caffeineMgForFoodEntry,
  caffeineMgForFoodName,
  isFoodCaffeineEntryId,
  pairedFoodCaffeineEntryId,
} from '../foodCaffeine';

/**
 * The name-matching heuristic and the origin-marking id scheme — pure logic,
 * no SQLite. The dual-write mechanics themselves (does the paired entry
 * actually get written/superseded/removed) are `foodLog.test.ts`'s job,
 * against a real fixture database.
 */

describe('caffeineMgForFoodName', () => {
  it('matches the same cited figures coffeeCaffeine.ts already uses, for the same drinks', () => {
    expect(caffeineMgForFoodName('Espresso')).toBe(63);
    expect(caffeineMgForFoodName('Latte')).toBe(95);
    expect(caffeineMgForFoodName('Black Tea')).toBe(47);
  });

  it('recognises energy drinks, energy shots and cola with their own cited figures', () => {
    expect(caffeineMgForFoodName('Red Bull')).toBe(79);
    expect(caffeineMgForFoodName('Monster Energy')).toBe(79);
    expect(caffeineMgForFoodName('5-Hour Energy')).toBe(200);
    expect(caffeineMgForFoodName('Coca-Cola')).toBe(33);
  });

  it('is case-insensitive', () => {
    expect(caffeineMgForFoodName('COFFEE')).toBe(95);
  });

  it('matches a whole word, not a bare substring — "coffee cake" still matches "coffee" (a named false positive)', () => {
    // This IS the false-positive the file's own header names explicitly —
    // pinned here so a future change to the matcher does not accidentally
    // make it worse (a partial-token match like "caf" inside "cafeteria"
    // would be a different and worse failure).
    expect(caffeineMgForFoodName('Coffee Cake')).toBe(95);
  });

  it('does not match a word that merely contains a keyword as a substring', () => {
    expect(caffeineMgForFoodName('Cafeteria Tray')).toBeNull();
    // "chocolate" literally contains the substring "cola" (cho-COLA-te) — the
    // real reason this file matches whole words/phrases rather than a bare
    // `.includes()`, which would have counted a chocolate bar as a cola.
    expect(caffeineMgForFoodName('Chocolate Bar')).toBeNull();
  });

  it('excludes decaf, at any point in the name', () => {
    expect(caffeineMgForFoodName('Decaf Coffee')).toBeNull();
    expect(caffeineMgForFoodName('Decaffeinated Latte')).toBeNull();
  });

  it('is null for an ordinary food this heuristic does not recognise — no invented figure', () => {
    expect(caffeineMgForFoodName('Chicken Thigh')).toBeNull();
    expect(caffeineMgForFoodName('Oats')).toBeNull();
  });

  it('is null for a caffeinated category this file has no cited figure for, rather than guessing', () => {
    // Matcha and dark chocolate are real caffeine sources; this file does
    // not invent an uncited number for either — see its own header.
    expect(caffeineMgForFoodName('Matcha Latte')).toBe(95); // matches the coffee-family "latte" word, not matcha itself
    expect(caffeineMgForFoodName('Dark Chocolate Bar')).toBeNull();
  });

  it('espresso-family drinks outrank the broader coffee figure', () => {
    expect(caffeineMgForFoodName('Espresso Macchiato')).toBe(63);
  });

  it('energy shot outranks the broader energy drink figure', () => {
    expect(caffeineMgForFoodName('Energy Shot')).toBe(200);
  });
});

describe('caffeineMgForFoodEntry', () => {
  it('scales the per-serving figure by servings actually logged', () => {
    expect(caffeineMgForFoodEntry({ name: 'Espresso', servings: 2 })).toBe(126);
    expect(caffeineMgForFoodEntry({ name: 'Latte', servings: 1.5 })).toBe(143); // round(95 * 1.5)
  });

  it('is null for zero or negative servings — nothing was actually logged to scale', () => {
    expect(caffeineMgForFoodEntry({ name: 'Latte', servings: 0 })).toBeNull();
    expect(caffeineMgForFoodEntry({ name: 'Latte', servings: -1 })).toBeNull();
  });

  it('is null when the name is not recognised, regardless of servings', () => {
    expect(caffeineMgForFoodEntry({ name: 'Oats', servings: 3 })).toBeNull();
  });
});

describe('the origin-marking id scheme', () => {
  it('carries the infix, so a caller can find it by LIKE pattern', () => {
    const id = pairedFoodCaffeineEntryId('food-123', 'tail-abc');
    expect(id).toBe(`food-123${FOOD_CAFFEINE_ID_INFIX}tail-abc`);
  });

  it('is recognised as food-caused by isFoodCaffeineEntryId', () => {
    expect(isFoodCaffeineEntryId(pairedFoodCaffeineEntryId('food-123', 'tail-abc'))).toBe(true);
  });

  it('does not misidentify a coffee-tap-caused or manual entry as food-caused', () => {
    expect(isFoodCaffeineEntryId('coffee-entry-1-caf')).toBe(false); // coffeeCaffeine.ts's own suffix
    expect(isFoodCaffeineEntryId('uuid-1')).toBe(false); // an ordinary manual tap
  });
});
