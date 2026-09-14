import { useEffect, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';
import { useNavigation, useNavigationContainerRef, useRoute, useSegments } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { PlatformTopInsetContext } from '@/lib/headerInset';
import { useModules } from '@/lib/ModulesProvider';
import { backGoesHome, HOME_TAB, nestedStateOf, TABS, tabWasChosen } from '@/lib/tabs';
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

type JumpToHome = { type: 'JUMP_TO'; target: string; payload: { name: string } };

/**
 * Today, for the tab navigator keyed `tabsKey`: the same action a tap on Today's
 * own tab dispatches (`NativeBottomTabsNavigator.js`, `onTabChange`).
 */
function jumpToHome(tabsKey: string): JumpToHome {
  return { type: 'JUMP_TO', target: tabsKey, payload: { name: HOME_TAB } };
}

/** The `(tabs)` route's navigation in the root stack, typed to the calls made on it. */
type TabRouteNavigation = {
  isFocused: () => boolean;
  dispatch: (action: JumpToHome) => void;
};

export default function TabLayout() {
  const { ready } = useModules();
  const accent = useAccent();
  // Called on every render, unconditionally — same rule as `useAccent()` and
  // `useModules()` above: a hook cannot sit after the `if (!ready)` return
  // below without breaking React's hook-order contract the moment `ready`
  // flips from false to true.
  const { host, sources } = useRasterizedIcons(tabIconRequests(Platform.OS));

  // **Today is the tab the app opens on, by name, not by being first (N580).**
  //
  // Today sits in the centre of the bar now, so `TABS[0]` is Food. For most
  // ways into the tabs that makes no difference: a cold start, the post-sign-in
  // `router.replace('/')` and a deep link to a tab all name their tab through
  // the URL. One way in names none. The root layout's `unstable_settings`
  // anchor puts `(tabs)` under a cold-started deep link to a pushed screen,
  // and going back from that screen reveals whatever NativeTabs picked on its
  // own, which is its first route.
  //
  // `unstable_settings.initialRouteName` in this file would not change that,
  // and it was measured rather than assumed: `NativeTabsNavigator` (expo-router
  // 57.0.21, `build/native-tabs/NativeBottomTabsNavigator.js`) never hands
  // `initialRouteName` to its router, and `getStateFromPath` puts `(tabs)` under
  // `/goals` with no nested state (F70). So the layout names Today itself, ONCE,
  // and only when nothing chose a tab.
  //
  // **How, and when (F70).** It dispatches the `JUMP_TO` a tap on Today
  // dispatches, targeted at the tab navigator's key. A targeted jump does not
  // focus the tabs, so the athlete still sees the screen they opened until they
  // go back. An untargeted navigate to Today popped that screen at once.
  //
  // It waits for the navigation container's `state` event, because this effect
  // is too early on a phone. N580 set a `screen` param here, and the param only
  // survived when the root stack mounted in the container's own commit. The
  // real root layout returns null until fonts load, so the stack mounts a
  // commit later and publishes the state it rendered with after this effect,
  // and the param was gone. A jump from this effect has nothing to target yet:
  // the tab navigator is not in the container's state in either order. By the
  // `state` event it is, including when the icons rasterise a commit later.
  // `__tests__/app/tabDefault.test.tsx` runs every cold start under both orders
  // and under the real root layout; F70's history entry has the options not
  // taken.
  //
  // Above the frame-holds below for the same hook-order reason as the three
  // hooks above it.
  // Typed to the calls made on it.
  const navigation = useNavigation<TabRouteNavigation>();
  const navigationContainer = useNavigationContainerRef();
  const route = useRoute();
  const segments = useSegments();
  const homeTab = useRef<'undecided' | 'pending' | 'done'>('undecided');
  useEffect(() => {
    if (homeTab.current === 'undecided') {
      homeTab.current = tabWasChosen(segments, route.params) ? 'done' : 'pending';
    }
    if (homeTab.current !== 'pending') return;
    return navigationContainer.addListener('state', () => {
      if (homeTab.current !== 'pending') return;
      const tabs = nestedStateOf(navigationContainer.getRootState(), route.key);
      if (!tabs?.key) return;
      homeTab.current = 'done';
      navigation.dispatch(jumpToHome(tabs.key));
    });
  }, [navigation, navigationContainer, route.key, route.params, segments]);

  // **On Android, back from any other tab goes to Today (F68).**
  //
  // Paired with `backBehavior="none"` on the bar below. The pair has to work in
  // either listener order, because both happen. Android calls the newest
  // `hardwareBackPress` subscriber first, and React Navigation's own handler is
  // subscribed by the navigation container. On a phone, the root layout returns
  // null until fonts load, so this layout mounts later and its handler is called
  // first. When both mount in one commit, the container's effect runs after this
  // one and the router's handler is called first. Both orders are measured in
  // `__tests__/app/tabDefault.test.tsx`.
  //
  // - This handler first: a pushed screen, or Today, makes `backGoesHome`
  //   refuse, and the router pops the screen or has nothing to do.
  // - The router first: with `"none"` it has nothing to do at a tab root and
  //   returns false, so this handler gets the press. A pushed screen is popped
  //   before this handler is asked.
  //
  // On Today both return false, and Android's default leaves the app.
  //
  // Subscribed for the layout's lifetime, not per focus. Re-subscribing on
  // focus would move this handler above any a tab screen registers itself.
  // Everything it decides on is read at press time, so nothing goes stale.
  //
  // The tab state comes from the container, not `navigation.getState()`: after
  // a cold start at a tab's URL, the root stack's copy is still the state parsed
  // from that URL, with no Today in it (`nestedStateOf` in `lib/tabs.ts`).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const tabs = nestedStateOf(navigationContainer.getRootState(), route.key);
      if (!tabs?.key || !backGoesHome(navigation.isFocused(), tabs)) return false;
      // The same action a tap on Today's own tab dispatches
      // (`NativeBottomTabsNavigator.js`, `onTabChange`).
      navigation.dispatch({ type: 'JUMP_TO', target: tabs.key, payload: { name: HOME_TAB } });
      return true;
    });
    return () => subscription.remove();
  }, [navigation, navigationContainer, route.key]);

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
    // iOS ONLY, and the platform check is the whole point of this line.
    //
    // On iOS `NativeTabs` is a real `UITabBarController` and expo-router sets
    // `overrideScrollViewContentInsetAdjustmentBehavior`, so the tab screens'
    // scrollers genuinely take UIKit's top inset and `ScreenHeader` must not
    // add a second copy — that is the blank band this ticket fixed.
    //
    // **Android does NOT do this, and shipping `value` unconditionally would
    // have been a worse bug than the one being fixed.** Read from the
    // installed library rather than assumed: `NativeTabsView.android.js`
    // wraps its content in `<SafeAreaView edges={{ bottom: true }}>` — top is
    // deliberately excluded — and `contentInsetAdjustmentBehavior` is an
    // iOS-only prop (declared in RN 0.86.3's `ScrollViewPropsIOS`), so the
    // five scrollers' `"automatic"` does nothing there either. Claiming the
    // platform had supplied the inset would therefore have removed the ONLY
    // thing supplying it and put every Android tab screen's title under the
    // status bar — unreadable, where the iOS bug was merely an ugly gap.
    // Caught in review; the first version of this line was unconditional.
    //
    // See `lib/headerInset.ts` for the full measured account, including why
    // this is declared once here rather than passed by each screen.
    <PlatformTopInsetContext.Provider value={Platform.OS === 'ios'}>
      <NativeTabs
        // Android only (F68). The default, `'initialRoute'`, falls back to
        // route 0, which is Food since N580, because NativeTabs never gives
        // its router an `initialRouteName`. `"none"` records no tab to go back
        // to, and the `hardwareBackPress` handler above sends other tabs to
        // Today. `undefined` leaves iOS on the library default.
        backBehavior={Platform.OS === 'android' ? 'none' : undefined}
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
    </PlatformTopInsetContext.Provider>
  );
}
