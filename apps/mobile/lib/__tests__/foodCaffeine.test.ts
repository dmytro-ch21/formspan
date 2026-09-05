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

  /**
   * N501/#872: "no caffeine" / "without caffeine" / "caffeine-free" got the
   * same treatment `decaf` already had, and this is the reported gap —
   * "Beverages, carbonated, lemon-lime soda, no caffeine" and USDA's own
   * "Cola, without caffeine" phrasing matched their keyword group at FULL
   * strength before this fix, because nothing here read past the keyword to
   * the negation sitting right next to it.
   */
  it('excludes "no caffeine" / "without caffeine" / "caffeine-free" phrasing, the same way decaf is excluded', () => {
    expect(caffeineMgForFoodName('Cola, without caffeine')).toBeNull();
    expect(caffeineMgForFoodName('Pepsi, caffeine-free')).toBeNull();
    expect(caffeineMgForFoodName('Beverages, carbonated, lemon-lime soda, no caffeine')).toBeNull();
    expect(caffeineMgForFoodName('Tea, herbal, no caffeine')).toBeNull();
    expect(caffeineMgForFoodName('Coffee, caffeine free')).toBeNull();
  });

  it('still matches an ordinary caffeinated drink that merely mentions caffeine positively', () => {
    // The negation guard must not become a bare "contains the word caffeine"
    // exclusion — that would blank out a name that cites its OWN caffeine
    // content rather than denying it.
    expect(caffeineMgForFoodName('Cola, with caffeine')).toBe(33);
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

  it('falls back to drink-count scaling when servingLabel is a non-gram label', () => {
    expect(caffeineMgForFoodEntry({ name: 'Latte', servings: 2, servingLabel: '1 cup' })).toBe(190);
  });

  /**
   * The grams-basis bug this ticket fixes — N501/#872, reported directly:
   * "Coffee, if i drink one cup it should automatically add to the tracker
   * of coffee." A catalog/barcode row is logged on a per-100g basis (every
   * USDA-imported row's `serving_label` is the literal "100 g" —
   * `scripts/import_usda_foods.py`), so 240 g of "Coffee" — one real cup —
   * used to compute `servings = 2.4` against that 100 g basis and report
   * round(95 * 2.4) = 228 mg. It should report ~95 mg, the cited figure for
   * one actual cup.
   */
  describe('a catalog/barcode entry logged by weight (a gram-basis servingLabel)', () => {
    it('computes mg from the actual grams logged against the reference serving weight, not servings × mgPerServing', () => {
      // 240 g at a 100 g basis is servings=2.4 — the exact shape of the bug.
      expect(
        caffeineMgForFoodEntry({ name: 'Coffee', servings: 2.4, servingLabel: '100 g' }),
      ).toBe(95); // NOT round(95 * 2.4) = 228
    });

    it('scales linearly below one reference serving', () => {
      // 30 g at a 100 g basis is servings=0.3 — 30/240 of a cup.
      expect(
        caffeineMgForFoodEntry({ name: 'Coffee', servings: 0.3, servingLabel: '100 g' }),
      ).toBe(12); // round(95 * 30/240)
    });

    it("uses the matched group's OWN reference weight — an espresso shot is not scaled like a cup", () => {
      // 30 g at a 100 g basis is servings=0.3, and 30 g IS one real espresso
      // shot — so this should read as exactly one shot's 63 mg, not a
      // fraction of it the way the coffee-family case above does.
      expect(
        caffeineMgForFoodEntry({ name: 'Espresso', servings: 0.3, servingLabel: '100 g' }),
      ).toBe(63);
    });

    it('is null when the grams-basis servingLabel is honoured but the name is unrecognised', () => {
      expect(
        caffeineMgForFoodEntry({ name: 'Oats', servings: 2.4, servingLabel: '100 g' }),
      ).toBeNull();
    });
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

  /**
   * frontend-reviewer, N468 review: this used to accept a whole
   * `randomUUID()` as the tail (36 chars), producing a 78-character id
   * against the backend's 64-character `NewEntry.Validate` limit
   * (`tracker.go`) — every food-caused caffeine entry was rejected
   * PERMANENTLY and silently, never reaching the server or a second
   * device. Pinned here the same way `coffeeCaffeine.test.ts` already pins
   * its own sibling id scheme against the identical limit.
   */
  it("stays comfortably under the backend's 64-character entry id limit for a UUID-length id and tail", () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(uuid).toHaveLength(36);
    expect(pairedFoodCaffeineEntryId(uuid, uuid).length).toBeLessThanOrEqual(64);
  });

  it('truncates a long tail rather than trusting the caller to have shortened it', () => {
    const id = pairedFoodCaffeineEntryId('food-1', 'abcdefghijklmnop');
    expect(id).toBe(`food-1${FOOD_CAFFEINE_ID_INFIX}abcdefgh`);
  });
});
