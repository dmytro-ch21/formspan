import { vola } from '@/constants/Colors';
import type { IconName } from '@/components/ui/Icon';

/**
 * The bottom bar's shape — which destinations it holds, and in what order.
 *
 * Lives here rather than inline in `app/(tabs)/_layout.tsx` so it can be
 * asserted directly: a route file is awkward to import from a test, and the
 * predicate that used to sit inline in that layout was inline, untested and
 * wrong, which are not three unrelated facts.
 *
 * ## Today in the centre, and still the screen the app opens on (N580)
 *
 * The bar reads **Food · Progress · Today · Plan · You**. The owner decided it
 * on 2026-09-14: *"lets move the Today in the middle in the pannel and be the
 * default screen"*. Today takes the centre slot and the other four keep their
 * relative order. Food is now first, two slots from Today rather than beside
 * it, and it keeps a permanent slot, which is the part of N180's reasoning
 * below that still holds.
 *
 * **Moving Today out of slot one could have moved the default with it, and on
 * one path it did.** What picks the opening tab was measured against the
 * installed expo-router (57.0.21), not assumed:
 *
 * - A cold start, the post-sign-in `router.replace('/')` in `app/_layout.tsx`
 *   and `/(tabs)` all resolve through the URL to `(tabs)/index`. Position plays
 *   no part, so all three land on Today with Food first.
 * - When the tab navigator is created with NO tab named, NativeTabs falls back
 *   to the first route here. That is the `(tabs)` anchor the root layout puts
 *   under a cold-started deep link to a pushed screen, which the athlete lands
 *   on by going back. `unstable_settings.initialRouteName` in
 *   `app/(tabs)/_layout.tsx` does not change it: `NativeTabsNavigator` never
 *   hands `initialRouteName` to its router (`build/native-tabs/
 *   NativeBottomTabsNavigator.js`). So the tab layout names Today itself when
 *   nothing else chose a tab. `HOME_TAB` and `tabWasChosen` below are that pin.
 *   **It jumps the tab navigator to Today on the navigation container's first
 *   `state` event after that navigator exists (F70).** N580 set a `screen`
 *   param from the layout's effect instead, and that write was lost whenever
 *   the root stack mounted after the container, which the real root layout
 *   does by returning null until fonts load. Back then landed on Food.
 * - **Back WITHIN the bar, on Android (F68).** NativeTabs' default
 *   `backBehavior` is `'initialRoute'`, which falls back to the first route for
 *   the same reason. So after N580, back from a tab went to Food, and back on
 *   Today itself went to Food instead of leaving the app. An `initialRouteName`
 *   prop on `<NativeTabs>` does not reach the router either: it lands in the
 *   view's props. So on Android the tab layout sets `backBehavior="none"`,
 *   which leaves the tab router nothing to go back to, and its
 *   `hardwareBackPress` handler sends any other tab to Today. `backGoesHome`
 *   below is that handler's decision. iOS has no system back between tabs and
 *   keeps the library default.
 *
 * ## What N180 changed, and why it partly reverses N176
 *
 * N180's bar read **Today · Food · Progress · Plan · You**. Food came back to
 * slot two and **Train's slot is retired** — decided by the user on 2026-08-26,
 * after carrying the N176 bar on their own phone:
 *
 * > "I agree its a little too deep and right now the only way to get there is
 * > via today widget, in fact Train tab which is instead of food is way less
 * > useful not sure what was the purpose"
 *
 * **N176's loop was coherent about the wrong thing.** Its five slots spelled
 * plan · train · understand · progress · plan, which is a real and defensible
 * reading of a training app — and VOLA is training *and nutrition*, where the
 * nutrition half carries by far the higher touch count. An athlete logs food
 * three to five times a day, every day, and starts a session four to six times
 * a week. The loop spent a permanent slot on the lower-frequency action and
 * demoted the higher-frequency one to a link.
 *
 * **And to one link, measured rather than assumed.** With Food off the bar, the
 * only way into food logging was `app/(tabs)/index.tsx` — three `router.push`
 * call sites, all in that one file. Scroll Today past the food widget and the
 * most frequent action in the product had no entry point at all.
 *
 * So the paragraph N176 wrote about Food's slot — earned on frequency, the tab
 * bar being the only fixed-position affordance a phone has — is not merely
 * un-retracted, it is the finding. What N176 got right and this keeps: **the
 * bar is five, and a sixth tab to split the difference is still refused.** Food
 * takes Train's slot rather than being added beside it.
 *
 * **Goals stays off the bar, and that half of N176 is untouched.** The daily
 * target no longer needs a slot of its own because N180 puts it at the TOP OF
 * THE FOOD TAB, next to the thing it constrains — `components/food/TargetRow`,
 * two taps, linking to `/goals` for the derivation and the history. That
 * is the mobile-first rule in `CLAUDE.md` applied to chrome: the reasoning was
 * reachable and the action was three taps behind it.
 *
 * ## Train and Goals moved OUT of `app/(tabs)/` (N504)
 *
 * They used to live inside the tab folder as `href: null` `<Tabs.Screen>`s —
 * declared, buttonless, still resolvable for `router.push` and a
 * `vola://train` deep link. That mechanism does not exist under `NativeTabs`
 * (`expo-router/unstable-native-tabs`): Expo's own docs are explicit —
 * **"Hidden tabs cannot be navigated to!"** — and the same is true of a route
 * file with no `<NativeTabs.Trigger>` at all. There is no native-tabs
 * equivalent of "in the group, no button, still reachable".
 *
 * The fix is `app/train.tsx` and `app/goals.tsx`, at the app root, pushed as
 * ordinary stack screens over the tab navigator — the exact pattern
 * `app/library.tsx` and `app/phase/index.tsx` already used before this ticket
 * existed: `headerShown: false` on the `Stack.Screen` in `app/_layout.tsx`,
 * the screen draws its own `ScreenHeader`, with `leading` for a back button.
 * Because `(tabs)` is a route GROUP, its parentheses were already stripped
 * from the URL — `app/(tabs)/goals.tsx` and `app/goals.tsx` both resolve to
 * `/goals` — so this is a file-location and stack-wiring change only.
 * `vola://train` and `vola://goals` are unaffected, and so is every
 * `router.push('/goals')` call site (they have read `/goals`, never
 * `/(tabs)/goals`, since N504 — see that ticket's diff for the sites that
 * had to be corrected from the older `/(tabs)/goals` spelling).
 *
 * `train.tsx`'s own content (a `<Redirect>` to Today) is untouched by the
 * move — see that file for N180/N182's account of why it exists as a redirect
 * rather than a deleted file or a signpost screen.
 *
 * ## The two platform differences NativeTabs introduced (N504)
 *
 * **iOS renders VOLA's own brand icons, dynamically tinted by the athlete's
 * accent.** `lib/tabIconRaster.tsx` rasterises each icon from the same SVG
 * source of truth (`assets/brand/icons/*.svg`) at runtime, once, into a
 * neutral (colour-irrelevant) PNG; `lib/tabIconPlan.ts` decides which rasters
 * each platform needs and hands each tab its `{default, selected}` image
 * pair; `NativeTabs`' `renderingMode: 'template'` then treats the image as an
 * alpha mask and fills it with `iconColor` / `selectedIconColor`, which
 * `(tabs)/_layout.tsx` feeds from `useAccent()` — so the tab bar keeps
 * following whatever the athlete chose, same as before.
 *
 * **Android renders the same brand icons, in a FIXED colour pair — not the
 * athlete's accent.** `renderingMode: 'template'` is iOS-only; Android always
 * renders a custom icon source with its own baked-in colour. Preserving VOLA's
 * icon shapes on Android's tab bar (rather than falling back to Material
 * Symbols) therefore costs per-account personalisation there specifically:
 * `ANDROID_ACTIVE_ICON_COLOR` below is `vola.accent`, the app's DEFAULT brand
 * accent — the same "before anyone has expressed a preference" value
 * `constants/Colors.ts` already documents `vola.accent` as being for — not
 * whatever accent the signed-in athlete picked. This is a deliberate, accepted
 * platform asymmetry, decided with the user rather than discovered later: see
 * `docs/decisions/history.md`'s N504 entry.
 */

export type TabSpec = {
  /** The route file's name in `app/(tabs)/`, without the extension. */
  name: string;
  /** What the bar says under the icon. */
  title: string;
  icon: IconName;
};

/**
 * The five, in bar order.
 *
 * **Today** orchestrates the day, **Food** is the thing done most often,
 * **Progress** answers "am I getting better", **Plan** holds future intent,
 * **You** is the athlete. Plan is the existing `workouts` route under its
 * product name, which it has carried since long before any of this.
 *
 * **Order is load-bearing rather than cosmetic, and what it is ordered BY
 * has changed twice.** N176 ordered it as a loop to be read left to right. N180
 * ordered it by frequency, which put Food beside Today, where a thumb reaches it
 * without looking. N580 puts Today in the centre by owner decision; Food keeps
 * its slot, now the first. Each time it was a product decision rather than a layout
 * detail, so `lib/__tests__/tabBar.test.ts` asserts it and a reordering fails
 * there instead of being noticed on a device.
 *
 * The icons come from the brand kit by name; `food` is the kit's own glyph and
 * is the one Food carried before N176 took its slot, so this restores the
 * arrangement rather than inventing a new one.
 */
export const TABS = [
  // Still on the bar: N180's point, which N580 does not undo. N580 put Today in
  // the centre, so Food is first and no longer beside it, but its slot is
  // permanent, and that was the finding.
  // Food is logged three to six times a day against once for a session, and the
  // tab bar is the only fixed-position affordance the phone has. A card on
  // Today costs an extra tap every time, on a screen whose contents move — and
  // measured with Food off the bar, that card was the ONLY way in at all.
  { name: 'food', title: 'Food', icon: 'food' },
  { name: 'progress', title: 'Progress', icon: 'progress' },
  // The centre slot (N580). Not first, and deliberately NOT the default by
  // being first — see this file's top-of-file comment for what actually makes
  // Today the screen the app opens on.
  { name: 'index', title: 'Today', icon: 'dashboard' },
  { name: 'workouts', title: 'Plan', icon: 'calendar' },
  { name: 'you', title: 'You', icon: 'profile' },
] as const satisfies readonly TabSpec[];

/**
 * The tab the app opens on, named rather than inherited from `TABS[0]` (N580).
 *
 * Today is in the centre, so the first slot and the default are no longer the
 * same tab. See this file's top-of-file comment for what reads this and why an
 * `unstable_settings` pin could not do the job.
 */
export const HOME_TAB = 'index' satisfies (typeof TABS)[number]['name'];

/**
 * Whether something already chose which tab the tab navigator should show.
 *
 * `true` when the URL is inside the tab group (`segments[0] === '(tabs)'`, as on
 * a cold start at `/` or a deep link to `/food`), or when the navigation that
 * created the tab route named a tab (`params.screen`) or carried nested state
 * (`params.state`), as `router.replace('/')` after sign-in does. Anything else
 * is the root layout's `(tabs)` anchor sitting under a pushed screen, and there
 * NativeTabs would pick `TABS[0]`.
 *
 * Measured in `__tests__/app/tabDefault.test.tsx` against the real router, which
 * is also where the cases that must NOT be overridden are held: a deep link to
 * another tab still lands on that tab.
 */
export function tabWasChosen(segments: readonly string[], params: unknown): boolean {
  if (segments[0] === '(tabs)') return true;
  if (params !== null && typeof params === 'object') {
    const { screen, state } = params as { screen?: unknown; state?: unknown };
    if (typeof screen === 'string' || state != null) return true;
  }
  return false;
}

/** A navigator's state, as far as the tab layout's back handler reads it. */
export type NavStateNode = {
  key?: string;
  index?: number;
  routes: readonly { key?: string; name: string; state?: NavStateNode }[];
};

/**
 * The state of the navigator nested in the route keyed `routeKey`, found
 * anywhere in `root` (F68).
 *
 * The tab layout's handler reads it from the container's root state. The root
 * stack's own copy (`navigation.getState()`) is not enough: after a cold start
 * at `/progress` the `(tabs)` route there still holds the state parsed from the
 * URL, one tab and no Today, and a jump to Today dispatched against it is
 * refused. Measured in `__tests__/app/tabDefault.test.tsx`.
 */
export function nestedStateOf(root: NavStateNode | undefined, routeKey: string): NavStateNode | undefined {
  for (const route of root?.routes ?? []) {
    if (route.key === routeKey) return route.state;
    const found = nestedStateOf(route.state, routeKey);
    if (found) return found;
  }
  return undefined;
}

/**
 * Whether Android's back button should take the athlete to Today (F68).
 *
 * The owner's decision, 2026-09-14: *"make back go to Today on Android"*. True
 * only when the tab bar is what the athlete is looking at and a tab other than
 * `HOME_TAB` is showing:
 *
 * - `tabsFocused` is false when a screen is pushed over the tabs. Back pops that
 *   screen first, so this leaves it to React Navigation.
 * - On Today, back keeps the platform default and leaves the app.
 * - A focused tab holding a nested navigator with a screen to pop pops first.
 *   No tab has one today. This stops a future nested stack from jumping home
 *   past its own screens.
 *
 * Measured against the real router in `__tests__/app/tabDefault.test.tsx`.
 */
export function backGoesHome(tabsFocused: boolean, tabs: NavStateNode): boolean {
  if (!tabsFocused) return false;
  const focused = tabs.routes[tabs.index ?? 0];
  if (!focused || focused.name === HOME_TAB) return false;
  return (focused.state?.index ?? 0) === 0;
}

/**
 * Android's fixed, non-personalised active-tab-icon colour (N504).
 *
 * `vola.accent` — read its own doc comment in `constants/Colors.ts`: it is
 * explicitly the value "someone gets before they have expressed [an accent]
 * preference", which is exactly the role it plays here. Not `useAccent()`'s
 * resolved value: see this file's top-of-file comment for why Android's tab
 * icons cannot follow the athlete's own chosen accent the way iOS's do.
 */
export const ANDROID_ACTIVE_ICON_COLOR = vola.accent;

/** Android's fixed inactive-tab-icon colour — the same token every inactive icon elsewhere in the app uses. */
export const ANDROID_INACTIVE_ICON_COLOR = vola.textDim;
