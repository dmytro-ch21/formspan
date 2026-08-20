import { serverHasFoodLog, type Module } from './modules';

/**
 * Which tab buttons the bar leaves out, and why it now leaves out almost none.
 *
 * ## The defect this replaces
 *
 * `(tabs)/_layout.tsx` used to hide Food and Goals whenever the nutrition
 * module was off, on `!hasFoodLog(modules)`. That erased two of five tabs —
 * 40% of the primary navigation — with nothing left behind to say why. An
 * athlete with nutrition switched off did not see a reduced app; they saw a
 * different, smaller one. **A surface that hides itself with no explanation is
 * indistinguishable from a surface that does not exist**, and it cannot even be
 * reported accurately, because the person reporting it does not know there is
 * anything to report. The user hit exactly that on a device with BJJ and told
 * us the features were "not there". They were there.
 *
 * ## The answer, which is #370's answer applied to chrome
 *
 * #370 fixed the same defect across the BJJ surfaces and found that **the
 * destinations were never the problem** — `bjj/log`, `bjj/index`,
 * `bjj/positions` and `PromotionForm` already said "BJJ tracking is off, turn
 * it back on under Sports in your profile". What was missing was that *nothing
 * linked to them* while the module was off, so the athlete never reached the
 * screen that would explain itself. The fix was to restore the links.
 *
 * **A tab IS the link.** So it stays, and `(tabs)/food.tsx` and
 * `(tabs)/goals.tsx` gained the same off-state their BJJ counterparts already
 * had (`components/ModuleOffNotice.tsx`). One answer to "is this off or does it
 * not exist", given in one place, on every surface.
 *
 * That is also why #468's placeholder rule — dashed where content would stand,
 * a card beside content — decides nothing here. Nothing is standing in for
 * anything: the tab is the real tab and leads to the real route. The rule
 * applies one level down, inside a populated screen, which is exactly where
 * #468 applied it.
 *
 * ## The one case where hiding is still right
 *
 * Three states, not two — the invariant every gate in `modules.ts` encodes. A
 * deployment with **no food-log module at all** has nothing to turn on, so a
 * tab leading to an offer to turn it on would promise a feature the server does
 * not have: the same lie as hiding one it does, pointing the other way. That,
 * and only that, is what `serverHasFoodLog` asks.
 */

/**
 * The tabs that exist only to reach the food log.
 *
 * Goals is here with Food because today it holds one thing — the daily intake
 * target. On a deployment with no food log it could only ever be empty, and the
 * Food tab beside it would be absent for exactly that reason, so listing one
 * and not the other would be the inconsistency rather than the gate.
 */
export const FOOD_LOG_TABS: readonly string[] = ['food', 'goals'];

/**
 * Should this tab's button be left out of the bar entirely?
 *
 * Lives here rather than inline in the layout so it can be tested against a
 * module set directly. It was inline, untested, and wrong; the two facts are
 * not unrelated.
 *
 * Gated on the CAPABILITY, never on a module key. `key === 'nutrition'` is the
 * pattern this codebase bans — a discipline gaining or losing a surface should
 * be one row on the server rather than an edit in three apps.
 */
export function tabHidden(name: string, modules: Module[]): boolean {
  return FOOD_LOG_TABS.includes(name) && !serverHasFoodLog(modules);
}
