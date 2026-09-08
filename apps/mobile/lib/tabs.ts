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
 * ## What N180 changed, and why it partly reverses N176
 *
 * The bar reads **Today · Food · Progress · Plan · You**. Food is back in slot
 * two and **Train's slot is retired** — decided by the user on 2026-08-26,
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
 * `router.push('/goals')` call site (they read `/goals`, never
 * `/(tabs)/goals`, once N504 lands — see that ticket's diff for the sites
 * that had to be corrected from the older `/(tabs)/goals` spelling).
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
 * changed with N180.** N176 ordered it as a loop to be read left to right;
 * ordering it by frequency is what put Food back in slot two, beside Today,
 * where a thumb reaches it without looking. Either way it is a product decision
 * rather than a layout detail, so `lib/__tests__/tabBar.test.ts` asserts it and
 * a reordering fails there instead of being noticed on a device.
 *
 * The icons come from the brand kit by name; `food` is the kit's own glyph and
 * is the one Food carried before N176 took its slot, so this restores the
 * arrangement rather than inventing a new one.
 */
export const TABS = [
  { name: 'index', title: 'Today', icon: 'dashboard' },
  // Second, not last, and this is the sentence N176 removed and N180 restores.
  // Food is logged three to six times a day against once for a session, and the
  // tab bar is the only fixed-position affordance the phone has. A card on
  // Today costs an extra tap every time, on a screen whose contents move — and
  // measured with Food off the bar, that card was the ONLY way in at all.
  { name: 'food', title: 'Food', icon: 'food' },
  { name: 'progress', title: 'Progress', icon: 'progress' },
  { name: 'workouts', title: 'Plan', icon: 'calendar' },
  { name: 'you', title: 'You', icon: 'profile' },
] as const satisfies readonly TabSpec[];

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
