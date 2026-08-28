import { formFor, readDraft } from '@/components/TrackerForm';
import type { Tracker } from '@/lib/trackerModel';

/**
 * The form's pure half — filling it from a tracker, and reading it back.
 *
 * The property worth pinning down is **a round trip that changes nothing**.
 * Opening the edit screen and pressing Save is the most ordinary thing an
 * athlete can do on it, and it must not write a different number than the one
 * that was there.
 */

const water: Tracker = {
  id: 't_water',
  preset: 'water',
  name: 'Water',
  icon: '💧',
  color_key: 'water',
  unit: 'ml',
  increment: 250,
  target: 2000,
  render_style: 'glyphs',
  sort_order: 10,
  count_noun: 'cup',
  provisioned: true,
  cutoff_minutes: null,
};

const draftOf = (r: ReturnType<typeof readDraft>) => {
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  return r.draft;
};

describe('opening the edit screen and saving with no edits', () => {
  it('changes nothing in metric', () => {
    const d = draftOf(readDraft(formFor(water, 'metric'), 'metric', water));
    expect(d.increment).toBe(250);
    expect(d.target).toBe(2000);
  });

  /*
   * **The imperial case is the one that was broken.**
   *
   * `toDisplayFluid` rounds to 0.1 fl oz, so 250 ml renders as "8.5" and
   * converts back to 251.37 — and the target, recomputed as count × increment,
   * turned water's 2000 into 2010.98. A no-op save that marks the row dirty and
   * pushes a patch is the kind of drift that later reads as sync corruption,
   * and it converged only after the athlete had already been shown the wrong
   * number.
   *
   * `toBe`, not `toBeCloseTo`: the point is that the stored number is written
   * back UNCHANGED, and a tolerance would pass against the bug.
   */
  it('changes nothing in imperial either', () => {
    const d = draftOf(readDraft(formFor(water, 'imperial'), 'imperial', water));
    expect(d.increment).toBe(250);
    expect(d.target).toBe(2000);
  });

  it('preserves a target that is not a whole multiple of the increment', () => {
    // `formFor` rounds the count UP to display it (7 of 300 for a 2000 target),
    // so recomputing target as count × increment bakes that rounding in.
    const odd: Tracker = { ...water, increment: 300, target: 2000 };
    const d = draftOf(readDraft(formFor(odd, 'metric'), 'metric', odd));
    expect(d.target).toBe(2000);
  });
});

describe('reading an edited form', () => {
  it('does convert a genuinely retyped increment', () => {
    // The other half: the preservation must not swallow a real edit.
    const form = { ...formFor(water, 'imperial'), incrementText: '16.9' };
    const d = draftOf(readDraft(form, 'imperial', water));
    expect(d.increment).toBeGreaterThan(495);
    expect(d.increment).toBeLessThan(505);
  });

  it('recomputes the target when the count changes', () => {
    const form = { ...formFor(water, 'metric'), countText: '10' };
    expect(draftOf(readDraft(form, 'metric', water)).target).toBe(2500);
  });

  it('refuses half a glass', () => {
    // `number-pad` does not stop a paste, and 2.5 cups is not a thing anybody
    // means by a daily target.
    const form = { ...formFor(water, 'metric'), countText: '2.5' };
    const r = readDraft(form, 'metric', water);
    expect('error' in r && r.error).toMatch(/whole number/);
  });

  it('an empty target means no ceiling, not zero', () => {
    const form = { ...formFor(water, 'metric'), countText: '' };
    expect(draftOf(readDraft(form, 'metric', water)).target).toBeNull();
  });

  it('trims the noun rather than rejecting it', () => {
    // The SERVER refuses a surrounding space, because a validator that silently
    // repairs its input lies about what it stored. The CLIENT trims, at the
    // point the athlete's intent is still legible — a trailing space is a
    // typing artefact, not a decision.
    const form = { ...formFor(water, 'metric'), noun: '  scoop ' };
    expect(draftOf(readDraft(form, 'metric', water)).count_noun).toBe('scoop');
  });

  it('will not save a tracker with no name', () => {
    const form = { ...formFor(water, 'metric'), name: '   ' };
    expect('error' in readDraft(form, 'metric', water)).toBe(true);
  });
});

describe('creating, where there is nothing to preserve', () => {
  it('converts the typed increment out of the display unit', () => {
    const form = {
      ...formFor(water, 'imperial'),
      incrementText: '8.5',
    };
    // No `original` — the create screen has none — so 8.5 fl oz converts.
    const d = draftOf(readDraft(form, 'imperial'));
    expect(d.increment).toBeGreaterThan(250);
    expect(d.increment).toBeLessThan(253);
  });
});
