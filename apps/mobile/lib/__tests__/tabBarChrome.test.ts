import { fabBottom, nativeTabBarHeight } from '@/lib/tabBarChrome';

/**
 * N504/#876 — clearance for a control floating over the native tab bar.
 *
 * The Android branch is the reason this is parameterised rather than reading
 * `Platform.OS` itself: `jest-expo` reports `ios`, so a helper that read the
 * platform directly would leave the taller Android bar permanently untested —
 * and the review finding this file answers was precisely that iOS's number
 * had been applied to Android by default.
 */
describe('nativeTabBarHeight', () => {
  it('is UIKit’s standard bar on iOS', () => {
    expect(nativeTabBarHeight('ios')).toBe(49);
  });

  it('is Material 3’s taller navigation bar on Android', () => {
    expect(nativeTabBarHeight('android')).toBe(80);
  });

  it('never returns the smaller number for Android', () => {
    // The asymmetry is the whole safety argument: too LARGE floats the pill
    // harmlessly high, too small puts it back under the bar — the bug this
    // helper exists to fix. So Android must never fall back to iOS's 49.
    expect(nativeTabBarHeight('android')).toBeGreaterThan(nativeTabBarHeight('ios'));
  });

  it('falls back to the iOS height on an unknown platform', () => {
    // web, windows, macos — none renders these tabs, and a number is needed.
    expect(nativeTabBarHeight('web')).toBe(49);
  });
});

describe('fabBottom', () => {
  it('clears the bar, the device inset and a gap', () => {
    // A home-indicator phone: 49 + 34 + 12.
    expect(fabBottom('ios', 34)).toBe(95);
    // A button phone has no bottom inset, and must not be given one.
    expect(fabBottom('ios', 0)).toBe(61);
  });

  it('clears Android’s taller bar', () => {
    expect(fabBottom('android', 0)).toBe(92);
    expect(fabBottom('android', 24)).toBe(116);
  });

  it('always leaves the control above the bar, on both platforms', () => {
    // The property that actually matters, stated independently of the
    // arithmetic above: whatever the inset, the result clears the bar.
    for (const platform of ['ios', 'android']) {
      for (const inset of [0, 20, 34, 48]) {
        expect(fabBottom(platform, inset)).toBeGreaterThan(nativeTabBarHeight(platform));
      }
    }
  });

  it('honours a caller-supplied gap', () => {
    expect(fabBottom('ios', 34, 0)).toBe(83);
  });
});
