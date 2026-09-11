import { preMeasureInset } from '@/components/KeyboardAwareScroll';

/**
 * `preMeasureInset` returns null for "there is no geometry-free answer", and
 * that is not the same as zero — N493 part 3 review (#858 item 7).
 *
 * `measure()` applies this synchronously on every `show` AND `changeFrame`,
 * ahead of `measureInWindow`'s callback. While this returned `0` for an
 * unanchored caller, every `changeFrame` drove `setInset(0)` first and the
 * async measurement restored the lift a render later — a visible drop-and-snap
 * on `app/food/add.tsx` and `app/bjj/reflect/[id].tsx`, neither of which this
 * ticket touched. iOS fires `changeFrame` when the QuickType bar changes
 * height mid-typing, so a prose field triggers it in ordinary use.
 *
 * The regression is invisible to a render test under jest, because
 * `measureInWindow`'s callback never fires there, so an unanchored footer's
 * inset is 0 either way and the collapse has nothing to collapse FROM. That is
 * why this pins the decision rather than the rendered padding: it is the layer
 * where the two cases are actually distinguishable.
 */
describe('preMeasureInset', () => {
  it('has NO answer for a caller that is not anchored to the display bottom', () => {
    // Null, never 0 — 0 is an instruction to collapse, and collapsing is the bug.
    expect(
      preMeasureInset({ anchoredToScreenBottom: false, os: 'ios', keyboardHeight: 336 }),
    ).toBeNull();
  });

  it('has no answer for an unanchored caller on Android either', () => {
    expect(
      preMeasureInset({ anchoredToScreenBottom: false, os: 'android', keyboardHeight: 336 }),
    ).toBeNull();
  });

  it('still has no answer when the keyboard is down and the caller is unanchored', () => {
    expect(
      preMeasureInset({ anchoredToScreenBottom: false, os: 'ios', keyboardHeight: null }),
    ).toBeNull();
  });

  it('answers with the keypad height for an anchored caller on iOS', () => {
    expect(
      preMeasureInset({ anchoredToScreenBottom: true, os: 'ios', keyboardHeight: 336 }),
    ).toBe(336);
  });

  it('answers 0 for an anchored caller once the keyboard is down', () => {
    // Zero IS the answer here — the keyboard is gone and the lift should go.
    expect(
      preMeasureInset({ anchoredToScreenBottom: true, os: 'ios', keyboardHeight: null }),
    ).toBe(0);
  });

  it('defers to the measurement on Android, where the screen-bottom rule does not apply', () => {
    // measuredInset is 0 at this point by construction, so Android has nothing
    // to contribute before the callback arrives — but it must say 0, not null,
    // because an anchored Android caller is still anchored.
    expect(
      preMeasureInset({ anchoredToScreenBottom: true, os: 'android', keyboardHeight: 336 }),
    ).toBe(0);
  });
});
