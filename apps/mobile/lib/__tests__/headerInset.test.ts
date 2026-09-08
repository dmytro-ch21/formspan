import { headerTopPadding } from '@/lib/headerInset';

/**
 * N504/#876 — the arithmetic behind the blank band above Today's header.
 *
 * These are the branches no rendered test in this repo can reach: jest runs
 * no Yoga pass and no navigator, so the padding a screen actually receives is
 * unobservable there, and the real defect was invisible until somebody looked
 * at a Simulator. `lib/headerInset.ts` exists to make the DECISION testable
 * even though its effect is not.
 *
 * The numbers are the measured ones: 62 is `insets.top` on a Dynamic Island
 * phone, 14 is `ScreenHeader`'s own padding above the title row, and 76 vs 14
 * is exactly the difference between the two screens that rendered identical
 * trees at different heights.
 */
describe('the default when no layout claims the inset', () => {
  it('adds the inset, because that is the recoverable failure', () => {
    // `PlatformTopInsetContext` defaults to `false`, which is what every
    // pushed route and every screen test in this suite sees. The two failures
    // are NOT symmetrical: a surplus gap is visible and gets reported (it is
    // how this bug was found), a missing one puts the title under the status
    // bar where it cannot be read at all — measured by removing the inset
    // from `library`, which collided with the clock.
    expect(headerTopPadding(false, 62)).toBe(76);
  });
});

describe('headerTopPadding', () => {
  it('adds only its own padding when the platform already applied the inset', () => {
    // The measured fix: Today went from a 62pt band above its header to none.
    expect(headerTopPadding(true, 62)).toBe(14);
  });

  it('adds the inset as well when nothing above it did', () => {
    expect(headerTopPadding(false, 62)).toBe(76);
  });

  it('keeps its own padding when there is no inset to add', () => {
    // A phone with no notch: the base padding is unconditional, so both
    // branches agree here and only the inset term differs.
    expect(headerTopPadding(true, 0)).toBe(14);
    expect(headerTopPadding(false, 0)).toBe(14);
  });

  it('honours a caller-supplied base', () => {
    expect(headerTopPadding(true, 62, 20)).toBe(20);
    expect(headerTopPadding(false, 62, 20)).toBe(82);
  });
});
