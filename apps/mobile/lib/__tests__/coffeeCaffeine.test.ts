import {
  COFFEE_ADD_CHOICES,
  COFFEE_DRINK_OPTIONS,
  caffeineMgFor,
  coffeeDrinkAccessibilityLabel,
  pairedCaffeineEntryId,
} from '../coffeeCaffeine';

/**
 * N432's reference figures and the pairing derivation — pure logic, no
 * SQLite. The dual-write mechanics themselves (does the insert actually
 * happen, does removal actually undo both rows) are `trackers.test.ts`'s
 * job, against a real fixture database.
 */

describe('the cited mg figures', () => {
  it('carries a real figure for every drink but "other"', () => {
    // Never an invented number for the one type this app cannot know the
    // strength of — see the file's own doc for why.
    for (const o of COFFEE_DRINK_OPTIONS) {
      if (o.key === 'other') expect(o.caffeineMg).toBeNull();
      else expect(o.caffeineMg).toBeGreaterThan(0);
    }
  });

  it('matches the cited Mayo Clinic reference figures exactly', () => {
    expect(caffeineMgFor('espresso')).toBe(63);
    expect(caffeineMgFor('drip')).toBe(95);
    expect(caffeineMgFor('tea')).toBe(47);
    expect(caffeineMgFor('other')).toBeNull();
  });

  it('returns null for a key that is not one of the shipped drinks', () => {
    // Defensive against `TrackerCard`'s generic `string` choice key — a
    // caller passing something malformed must not silently invent a number.
    expect(caffeineMgFor('venti-quad-shot')).toBeNull();
  });
});

describe('the chip row', () => {
  it('offers one chip per drink, each labelled with what it posts', () => {
    expect(COFFEE_ADD_CHOICES.map((c) => c.key)).toEqual(['espresso', 'drip', 'tea', 'other']);
    expect(coffeeDrinkAccessibilityLabel(COFFEE_DRINK_OPTIONS[0])).toBe(
      'Espresso — about 63 mg caffeine',
    );
  });

  it('states plainly that "other" logs no caffeine estimate, rather than a number', () => {
    const other = COFFEE_DRINK_OPTIONS.find((o) => o.key === 'other')!;
    expect(coffeeDrinkAccessibilityLabel(other)).toBe('Other — no caffeine estimate logged');
  });
});

describe('pairedCaffeineEntryId', () => {
  it('is a pure function of the coffee entry id — the same input, always the same pairing', () => {
    expect(pairedCaffeineEntryId('abc-123')).toBe(pairedCaffeineEntryId('abc-123'));
  });

  it('differs for different coffee entries, so two taps never collide', () => {
    expect(pairedCaffeineEntryId('abc-123')).not.toBe(pairedCaffeineEntryId('abc-124'));
  });

  it('stays comfortably under the backend\'s 64-character entry id limit for a UUID-length id', () => {
    // `NewEntry.Validate` in `tracker.go` refuses an id over 64 characters.
    // `randomUUID()` is 36 — this is the derivation's whole size budget.
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(uuid).toHaveLength(36);
    expect(pairedCaffeineEntryId(uuid).length).toBeLessThanOrEqual(64);
  });
});
