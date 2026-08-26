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
 * two taps, linking to `(tabs)/goals` for the derivation and the history. That
 * is the mobile-first rule in `CLAUDE.md` applied to chrome: the reasoning was
 * reachable and the action was three taps behind it.
 *
 * ## What did NOT change: Train and Goals are still reachable
 *
 * They lose a button, not a route. Both stay declared below in
 * `OFF_BAR_ROUTES`, which the layout renders with `href: null` — the button
 * disappears and the route stays resolvable, which is what an in-flight
 * `router.push` and every deep link need.
 *
 * **`train.tsx` is deliberately NOT deleted**, and N182 (#587) settled what it
 * is for. N180 left an honest gap on the record — nothing in the app linked to
 * `(tabs)/train` any more, its tab having been its only entry point — and #587
 * audited the screen rather than re-homing it on faith. All four of its blocks
 * were already drawn elsewhere by a screen that has a button (`Resume`,
 * `Today`, `Quick start` and `Recent` by Today; `Later` by Plan's
 * `WeekPlanner`), so the file is now a `<Redirect>` to Today and the route
 * stays resolvable for `vola://train` and any in-flight `router.push`. The
 * audit table is in that file's docstring.
 *
 * **So the gap is closed by a ruling, not by a link.** Train is not
 * unreachable-and-undecided; it is retired, and the one thing Plan genuinely
 * lacked — a planned day beyond the week `WeekPlanner` is showing — is now a
 * block on Plan reading the same `lib/useTrainBoard.ts` Train read.
 *
 * ## The gate that used to live here, and why it is gone
 *
 * `tabHidden(name, modules)` hid Food and Goals whenever this DEPLOYMENT had no
 * food-log module — the third state that `serverHasFoodLog` separates from
 * "turned off". N176 retired it because both tabs went unconditionally off-bar,
 * so there was nothing left for it to decide; the predicate it asked with is
 * still in `lib/modules.ts`.
 *
 * **N180 puts Food back on the bar and does NOT bring the gate back with it.**
 * That is the deliberate choice, not an omission. The screen behind the tab
 * already answers the question in words — `app/(tabs)/food.tsx` reads
 * `foodLogGate(modules, ready)` and renders `ModuleOffNotice` — so an athlete
 * whose deployment or account has nutrition off arrives somewhere that explains
 * itself, which is exactly what #370 concluded the fix was. A conditional slot
 * would instead make 20% of the primary navigation appear and disappear
 * depending on a server response, and reintroduce the cold-start flash the
 * layout holds a frame to prevent.
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
 * Routes that live in `app/(tabs)/` and deliberately hold no bar position.
 *
 * They must still be DECLARED — `href: null` rather than omitting the
 * `<Tabs.Screen>`. Omitting one does not hide it: expo-router auto-injects
 * every route file in this folder whether it is declared or not, so an omitted
 * screen comes back as a sixth tab with a filename-derived title ("train").
 * That is the failure this list exists to make impossible, and it is why
 * `lib/__tests__/tabBar.test.ts`'s "is either a tab or deliberately off the
 * bar, and never neither" READS THE DIRECTORY rather than trusting this array.
 *
 * **`train` is here rather than deleted.** N180 retired its BUTTON; N182
 * retired its CONTENTS, having measured that every block was already drawn by a
 * screen with a button. What is left is a `<Redirect>` to Today, which is
 * exactly what this list is for: deleting the file would break every
 * `vola://train` link in flight, and omitting it from this array would put the
 * route back on the bar as a sixth tab titled "train".
 */
export const OFF_BAR_ROUTES: readonly string[] = ['train', 'goals'];

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
