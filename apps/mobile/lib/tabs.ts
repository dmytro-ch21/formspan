import type { IconName } from '@/components/ui/Icon';

/**
 * The bottom bar's shape — which destinations it holds, in what order, and
 * which routes in `app/(tabs)/` deliberately have no button.
 *
 * Lives here rather than inline in `app/(tabs)/_layout.tsx` so it can be
 * asserted directly: a route file is awkward to import from a test, and the
 * predicate that used to sit inline in that layout was inline, untested and
 * wrong, which are not three unrelated facts.
 *
 * ## What N176 changed, and what it did not
 *
 * The bar reads **Today · Train · Progress · Plan · You**. That is the approved
 * primary navigation for the product, and it supersedes the arrangement below
 * it — Today · Food · Plan · Goals · You — under which Food and Goals each held
 * a permanent slot.
 *
 * **Food's slot was earned on frequency and the argument still stands on its
 * own terms.** Food is logged three to six times a day against once for a
 * session, and the tab bar is the only fixed-position affordance a phone has;
 * Goals sat beside it because the daily target is the number every food
 * decision is measured against. Neither claim is retracted here. What changed is
 * the frame around them: the bar's five slots now spell the athlete's loop —
 * plan, train, understand, progress, plan — and a bar that spends two of five on
 * one module cannot spell it. Nutrition gets a home that suits its frequency in
 * N180 (#585); **this file is not that home, and making Food a sixth tab to
 * split the difference is the specific thing that ticket exists to prevent.**
 *
 * ## What did NOT change: Food and Goals are still reachable
 *
 * They lose a button, not a route. Both stay declared below in
 * `OFF_BAR_ROUTES`, which the layout renders with `href: null` — the button
 * disappears and the route stays resolvable, which is what an in-flight
 * `router.push` and every deep link need. Today links to both while nutrition
 * is on, and says so in words while it is off.
 *
 * ## The gate that used to live here, and why it is gone
 *
 * `tabHidden(name, modules)` hid Food and Goals whenever this DEPLOYMENT had no
 * food-log module — the third state that `serverHasFoodLog` separates from
 * "turned off". It is retired because the two tabs are now unconditionally
 * off-bar, so there is nothing left for it to decide; the question it asked is
 * still the right one for whatever links to food next, and the predicate it
 * asked it with is still in `lib/modules.ts`.
 *
 * **Do not read that retirement as licence to hide a tab again.** The gate it
 * replaced hid Food and Goals whenever nutrition was merely turned OFF — two of
 * five tabs, 40% of the primary navigation, erased with nothing left behind to
 * say why. An athlete with nutrition off did not see a reduced app, they saw a
 * different, smaller one, and they cannot report what they cannot see: the user
 * hit the BJJ equivalent on a real device and told us the features were "not
 * there". They were there. #370's answer, applied to chrome, was that the
 * destinations were never the problem — they already explain themselves — and
 * that nothing LINKED to them while the module was off. Every entry in `TABS`
 * below is therefore unconditional, and a conditional one is a decision to
 * re-argue, not a convenience.
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
 * **Today** orchestrates the day, **Train** executes, **Progress** answers "am I
 * getting better", **Plan** holds future intent, **You** is the athlete. Train
 * and Progress are shells for now and get built out in N177 (#582) and N178
 * (#583); Plan is the existing `workouts` route under its product name, which
 * it has carried since long before this change.
 *
 * Order is load-bearing rather than cosmetic — it is the loop read left to
 * right — so it is asserted rather than assumed. The icons come from the brand
 * kit by name; `workout` is the barbell and `progress` is the kit's own glyph
 * for the idea, so neither needed inventing.
 */
export const TABS = [
  { name: 'index', title: 'Today', icon: 'dashboard' },
  { name: 'train', title: 'Train', icon: 'workout' },
  { name: 'progress', title: 'Progress', icon: 'progress' },
  { name: 'workouts', title: 'Plan', icon: 'calendar' },
  { name: 'you', title: 'You', icon: 'profile' },
] as const satisfies readonly TabSpec[];

/**
 * Routes that live in `app/(tabs)/` and deliberately hold no bar position.
 *
 * They must still be DECLARED — `href: null` rather than omitting the
 * `<Tabs.Screen>`. Omitting one does not hide it: expo-router auto-injects
 * every route file in this folder whether it is declared or not, so an omitted
 * screen comes back as a sixth tab with a filename-derived title ("food"). That
 * is the failure this list exists to make impossible, and it is why
 * `everyTabRouteIsAccountedFor` below reads the directory rather than trusting
 * this array.
 */
export const OFF_BAR_ROUTES: readonly string[] = ['food', 'goals'];

/**
 * Does this route file sit in the tab folder without owning a bar slot?
 *
 * The layout does not need this — it maps `OFF_BAR_ROUTES` directly — but the
 * pair of lists has an invariant that does: every route in `app/(tabs)/` is in
 * exactly one of them. A file in neither is a tab nobody decided to add; a name
 * in both is a bar entry the layout would then null out.
 */
export function offBar(name: string): boolean {
  return OFF_BAR_ROUTES.includes(name);
}

/** Every name the two lists between them claim, for the invariant above. */
export function declaredTabRoutes(): string[] {
  return [...TABS.map((t) => t.name), ...OFF_BAR_ROUTES];
}
