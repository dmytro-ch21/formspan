/**
 * How far a floating control must sit above the bottom of the screen to clear
 * the native tab bar (N504/#876).
 *
 * **This exists because the tab bar stopped being in normal flow.** The old
 * custom bar was a laid-out view, so `bottom: 16` on an absolutely-positioned
 * pill measured from above it. `NativeTabs` renders the platform's own bar,
 * which on iOS 26 FLOATS OVER the content — that is what makes the Liquid
 * Glass translucency mean anything — so the same `bottom: 16` puts the pill
 * underneath it. Measured on the iOS 26.5 Simulator: Today's "New log" landed
 * on top of the You tab and its label.
 *
 * **Shared by Today and Plan deliberately, and that is the fix as much as the
 * arithmetic is.** The first version of this lived as a private helper in
 * `app/(tabs)/index.tsx`, so Today's pill was corrected and Plan's identical
 * one was left on `bottom: 16` — still under the bar — while `workouts.tsx`'s
 * own style comment went on claiming the two matched ("same radius, same
 * padding, same `bottom`"). Caught in review, not by any test. The two screens
 * genuinely should NOT share their clearance constants (that is a per-screen
 * design choice about content padding, and the comments on each say so), but
 * the height of the platform's bar is a fact about the platform, not a
 * decision either screen gets to make.
 *
 * ## The heights, and how confident each one is
 *
 * `ios` is 49pt, the standard UIKit tab-bar height, and is the one actually
 * measured here.
 *
 * `android` is 80dp, Material 3's default `NavigationBar` height — which
 * Jetpack Compose's bottom navigation is, and which `NativeTabs` renders
 * there. **This number is taken from the Material 3 spec, NOT measured on a
 * device**, and it is stated that way rather than quietly rounded to iOS's
 * 49. The error direction is what makes it safe to ship unmeasured: too LARGE
 * floats the pill harmlessly high, too small puts it back under the bar,
 * which is the bug this file exists to fix. 80 > 49, so an Android build that
 * used iOS's number would have been wrong in the dangerous direction — which
 * is exactly what the private helper did before this was split out.
 * `docs/testing/functional-scenarios.md` carries this as an explicit Android
 * device check.
 *
 * ## Known imprecision, stated rather than hidden
 *
 * With `minimizeBehavior="onScrollDown"` the iOS bar SHRINKS as you scroll,
 * so once minimized the pill sits higher above it than it strictly needs to.
 * Floating slightly high is the harmless direction — the alternative is
 * tracking a native bar's animated height from JS every frame, which is a lot
 * of machinery to buy back a few points of spacing. Landscape on a
 * compact-height iPhone is the same story (the bar is ~32pt there).
 *
 * Pure and platform-parameterised rather than reading `Platform.OS` itself,
 * following `lib/tabIconPlan.ts` and `lib/shareCard.ts`'s `cardCaptureSize`:
 * `jest-expo` reports `ios`, so a branch that read the platform directly
 * would leave the Android half permanently untested.
 */

/** The gap between the bar and the control floating above it. */
const FAB_GAP = 12;

/** The platform's own bottom tab-bar height, in points/dp. See the file comment. */
export function nativeTabBarHeight(platform: string): number {
  return platform === 'android' ? 80 : 49;
}

/**
 * `bottom` for a control floating above the native tab bar.
 *
 * `bottomInset` is the device's own bottom safe-area inset — taken as an
 * argument rather than baked in because a home-indicator phone and a button
 * phone differ by ~34pt and hardcoding either is wrong on the other.
 */
export function fabBottom(platform: string, bottomInset: number, gap = FAB_GAP): number {
  return nativeTabBarHeight(platform) + bottomInset + gap;
}
