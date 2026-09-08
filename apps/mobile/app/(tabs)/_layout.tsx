import { Platform } from 'react-native';
import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { useModules } from '@/lib/ModulesProvider';
import { TABS } from '@/lib/tabs';
import { useRasterizedIcons } from '@/lib/tabIconRaster';
import { tabIconRequests, tabIconRenderingMode, tabIconSource } from '@/lib/tabIconPlan';

/**
 * The tab bar — now the REAL platform one (N504/#876).
 *
 * This used to be a fully custom `<Tabs>` bar: hand-drawn icons, a hand-drawn
 * underline for the active tab, hand-wired accent theming. It is now
 * `NativeTabs` (`expo-router/unstable-native-tabs`), which hands the bar to
 * iOS's and Android's own tab-bar implementations — UIKit's real
 * `UITabBarController` on iOS, giving iOS 26+ its Liquid Glass appearance for
 * free, and Jetpack Compose's Material 3 bottom navigation on Android.
 *
 * **Which five, in what order, are unchanged and still decided in
 * `lib/tabs.ts`** — this file draws the bar; that one says what is in it, and
 * that has not moved. What DID move: `train` and `goals` are no longer
 * declared here at all. See `lib/tabs.ts`'s top-of-file comment for why —
 * short version, a native tab with no button cannot be navigated to, which
 * the old `href: null` mechanism relied on, so both screens moved to the app
 * root as pushed stack screens instead.
 *
 * ## What is genuinely gone, and was a real design decision, not a limitation
 * accepted by accident
 *
 * - **The custom underline.** Native tab bars mark the active tab their own
 *   way (label weight, icon fill, a Material 3 pill) — there is no API to
 *   draw VOLA's own rule under it any more. Traded deliberately for the
 *   platform's own Liquid Glass / Material 3 chrome, per the user's own
 *   choice when this ticket was scoped.
 * - **Identical iOS/Android appearance.** The old bar was pixel-identical on
 *   both platforms; UIKit's tab bar and Jetpack Compose's bottom navigation
 *   do not look like each other, and that is the platform-native feel this
 *   ticket asked for, not a bug.
 *
 * ## The two things this file still has to get right
 *
 * 1. **VOLA's own brand icons, not SF Symbols / Material Symbols.**
 *    `useRasterizedIcons` (`lib/tabIconRaster.tsx`) renders each of the five
 *    off-screen once and captures it — no new build-time asset pipeline,
 *    reusing the `react-native-view-shot` dependency `lib/shareCard.ts`
 *    already needs.
 * 2. **Per-account accent tinting on iOS; a fixed pair on Android.**
 *    `lib/tabIconPlan.ts` (kept pure and platform-parameterised, same
 *    convention as `lib/shareCard.ts`'s `cardCaptureSize`, so both branches
 *    are actually testable) decides which rasters each platform needs and how
 *    to read them back. iOS gets one neutral raster per icon, recoloured at
 *    render time by `iconColor`/`selectedIconColor` below (fed from
 *    `useAccent()`, so it keeps following whatever the athlete chose);
 *    Android bakes a FIXED colour pair into its own rasters instead, since
 *    `renderingMode: 'template'` has no Android equivalent — see
 *    `lib/tabs.ts` for why that is an accepted platform difference rather
 *    than an oversight.
 */

export default function TabLayout() {
  const { ready } = useModules();
  const accent = useAccent();
  // Called on every render, unconditionally — same rule as `useAccent()` and
  // `useModules()` above: a hook cannot sit after the `if (!ready)` return
  // below without breaking React's hook-order contract the moment `ready`
  // flips from false to true.
  const { host, sources } = useRasterizedIcons(tabIconRequests(Platform.OS));

  // Hold the frame until the cached module set has been read.
  //
  // This guards the SCREENS, not the bar's own contents — `(tabs)/index.tsx`
  // reads `useModules()` without reading `ready`, so rendering the tab
  // subtree before the module set is known briefly asserts "nutrition is
  // turned off" in words on an account where it is not. See the fuller
  // account this comment used to carry, preserved in `lib/tabs.ts`'s history
  // and in `docs/decisions/history.md`'s N176/N180 entries.
  if (!ready) return null;

  // Hold the frame a second way: until every tab icon has been rasterised.
  // `host` is the off-screen capture rig while any icon is still pending —
  // rendering it (rather than `null`) is what lets it lay out and finish the
  // capture; see `lib/tabIconRaster.tsx`. Once every icon lands, `sources` is
  // non-null and `host` is `null`.
  if (!sources) return host;

  return (
    <NativeTabs
      minimizeBehavior="onScrollDown"
      backgroundColor={vola.bg}
      tintColor={accent.accent}
      iconColor={{ default: vola.textDim, selected: accent.accent }}
      labelStyle={{
        default: { fontFamily: 'BarlowSemiBold', fontSize: 11, color: vola.textDim },
        selected: { fontFamily: 'BarlowSemiBold', fontSize: 11, color: accent.accent },
      }}
    >
      {TABS.map(({ name, title, icon }) => (
        <NativeTabs.Trigger key={name} name={name}>
          <NativeTabs.Trigger.Icon
            src={tabIconSource(icon, sources, Platform.OS)}
            renderingMode={tabIconRenderingMode(Platform.OS)}
          />
          <NativeTabs.Trigger.Label>{title}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}
