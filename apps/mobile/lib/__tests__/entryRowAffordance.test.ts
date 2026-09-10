import { readFileSync } from 'fs';
import { join } from 'path';

import { vola } from '@/constants/Colors';
import { contrastRatio } from '../macroRings';

/**
 * W23/#1020 — the food entry row's secondary affordance has to RECEDE without
 * disappearing, and both halves of that are numbers rather than taste.
 *
 * The athlete's verdict on the 3-dot: *"it is ugly they better blend into the
 * item somehow."* Measured against the card, `textMuted` sits at 6.85:1 —
 * louder than most of the row's own text, on a control almost nobody taps.
 *
 * The floor is WCAG 1.4.11's 3:1 for a non-text interactive component. A dot
 * quiet enough to stop being ugly and too quiet to find is not an improvement,
 * so this file asserts BOTH bounds. Reusing `contrastRatio` from
 * `macroRings.ts` deliberately: the rings' overtake gradient answers to the
 * same floor, and one implementation means one meaning.
 */

const CARD = vola.surface;
/** WCAG 1.4.11 — non-text UI components that carry meaning. */
const UI_COMPONENT_FLOOR = 3;

const SRC = readFileSync(
  join(__dirname, '..', '..', 'components/food/EntryRow.tsx'),
  'utf8',
);

describe('the entry row’s "more" affordance', () => {
  it('is quiet enough to belong to the row', () => {
    // The bug was `textMuted` at 6.85:1. Anything at or above that is the
    // affordance shouting again.
    expect(contrastRatio(vola.textDim, CARD)).toBeLessThan(
      contrastRatio(vola.textMuted, CARD),
    );
    expect(contrastRatio(vola.textDim, CARD)).toBeLessThan(5);
  });

  it('is still findable — above the floor for an interactive control', () => {
    expect(contrastRatio(vola.textDim, CARD)).toBeGreaterThanOrEqual(UI_COMPONENT_FLOOR);
  });

  it('is drawn in the dim token, not the muted one', () => {
    // Pinned at the source: no component test renders this row, and the whole
    // change is which token the icon is handed.
    const more = SRC.match(/<Icon name="more"[^/]*\/>/);
    expect(more).not.toBeNull();
    expect(more![0]).toContain('vola.textDim');
  });

  it('leaves the edit-mode grip prominent', () => {
    // The grip is the PRIMARY affordance while a meal is being reordered
    // (N553), so it does not recede with the dot. A single sweeping token
    // change would have taken it along.
    const grip = SRC.match(/<Icon name="grip"[^/]*\/>/);
    expect(grip).not.toBeNull();
    expect(grip![0]).toContain('vola.textMuted');
  });

  it('keeps its 44pt target and its screen-reader labels', () => {
    // Receding is visual only. A quieter control that also became harder to
    // hit, or lost the hint naming what the menu does, would trade one
    // accessibility problem for two.
    expect(SRC).toMatch(/hitSlop=\{7\}/);
    expect(SRC).toMatch(/accessibilityLabel=\{`More for \$\{entry\.name\}`\}/);
    expect(SRC).toMatch(/accessibilityHint="Duplicate, remove or share this entry"/);
  });
});
