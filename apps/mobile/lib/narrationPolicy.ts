import type { DayFact } from './dayPanel';
import type { NarrationSentence } from './dayNarration';
import { fmtAmount } from './nutrition';

/**
 * Algorithm first, AI second (N570, #1131). Decides, from the facts alone,
 * whether a change needs narrating, and whether a model earns the call.
 *
 * The owner, 2026-09-11: *"that shouldnt be always ai we can do something as an
 * algorithm search and see where and how much should ai be involved."* This is
 * that search, written as a rule a test can hold:
 *
 * | What changed since the last generation | Decision |
 * |---|---|
 * | nothing, or only a fact that went away | `none` |
 * | the first event of the day | `model`, `first-of-day`: nothing to diff against, and the day needs ordering |
 * | {@link MODEL_WHEN_CHANGED_AT_LEAST} or more facts | `model`, `many-changes`: several things at once need prioritising, not listing |
 * | a session logged, or a new plan, while a planned session is still owed | `model`, `plan-owed`: "what do I do next" is prioritisation |
 * | a meal or a tracker, while a plan is owed | the plain rows below: a glass of water is not a prioritisation question |
 * | one or two facts, each of a kind with a plain sentence | `deterministic`: say it, no model |
 * | one or two facts, none of a kind with a plain sentence | `none` |
 *
 * **A fact that went away produces no sentence.** An absence is not a fact
 * (`lib/dayPanel.ts`), so "no food logged today" cites nothing and the guard
 * would drop it. And removing a meal must not spend a model call on saying so.
 *
 * **Every deterministic sentence passes `guardNarration`**, and a test asserts
 * it for every scenario below. A plain sentence is still a sentence the athlete
 * reads, and "algorithm" is not an exemption from citing its facts.
 */

export const MODEL_WHEN_CHANGED_AT_LEAST = 3;

/**
 * The kinds whose change makes an owed plan a prioritisation question.
 *
 * **Not "any change while a plan is owed"**, which was the first draft. A plan
 * is commonly owed most of the day, so that rule sent nearly every glass of
 * water and every meal to the model, against the owner's "shouldnt be always
 * ai". Found in review. `session-open` and `plan-done` are absent because
 * neither can coexist with an owed plan: the day's plan status is one kind.
 */
const PLAN_MOVING: ReadonlySet<DayFact['kind']> = new Set(['planned', 'logged']);

export type NarrationDecision =
  | { kind: 'none' }
  | { kind: 'deterministic'; sentences: NarrationSentence[] }
  | { kind: 'model'; reason: 'first-of-day' | 'many-changes' | 'plan-owed'; changed: string[] };

/** The part of a fact whose change is worth narrating. Presence alone for kinds with no figure. */
function fingerprint(fact: DayFact): string {
  switch (fact.kind) {
    case 'food-eaten':
      return `${Math.round(fact.totals.kcal)}|${fact.entries}`;
    case 'nutrition-target':
      // All four: a target edited in place keeps its key and may change only its macro split.
      return [fact.target.kcal, fact.target.protein_g, fact.target.carb_g, fact.target.fat_g]
        .map((n) => Math.round(n))
        .join('|');
    case 'tracker':
      return `${fact.logged}/${fact.target}`;
    case 'plan-done':
      return `${fact.planned}`;
    default:
      return '';
  }
}

/** Facts that are new, or whose figures moved, since `previous`. In `facts` order. */
export function changedFacts(facts: readonly DayFact[], previous: readonly DayFact[]): DayFact[] {
  const before = new Map(previous.map((f) => [f.key, fingerprint(f)]));
  return facts.filter((f) => before.get(f.key) !== fingerprint(f));
}

/** A plain sentence for one changed fact, or null when its kind has none. */
function plainSentence(fact: DayFact, facts: readonly DayFact[]): NarrationSentence | null {
  switch (fact.kind) {
    case 'food-eaten': {
      const target = facts.find((f) => f.kind === 'nutrition-target');
      if (target && target.kind === 'nutrition-target') {
        return {
          text: `${fmtAmount(fact.totals.kcal)} of ${fmtAmount(target.target.kcal)} kcal eaten today.`,
          cites: [fact.key, target.key],
        };
      }
      return { text: `${fmtAmount(fact.totals.kcal)} kcal eaten today.`, cites: [fact.key] };
    }
    case 'nutrition-target': {
      const t = fact.target;
      return {
        text: `Target: ${fmtAmount(t.kcal)} kcal, ${fmtAmount(t.protein_g)} g protein, ${fmtAmount(t.carb_g)} g carbs, ${fmtAmount(t.fat_g)} g fat a day.`,
        cites: [fact.key],
      };
    }
    case 'tracker':
      return { text: `${fact.tracker.name}: ${fact.logged} of ${fact.target}.`, cites: [fact.key] };
    case 'logged':
      return {
        text: fact.session.name ? `${fact.session.name} logged.` : 'A session was logged.',
        cites: [fact.key],
      };
    case 'plan-done':
      return { text: 'Everything planned today is done.', cites: [fact.key] };
    default:
      return null;
  }
}

export function decideNarration(
  facts: readonly DayFact[],
  /** The facts at the last generation, or null when there has been none today. */
  previous: readonly DayFact[] | null,
): NarrationDecision {
  const changed = previous === null ? [...facts] : changedFacts(facts, previous);
  if (changed.length === 0) return { kind: 'none' };
  const keys = changed.map((f) => f.key);

  if (previous === null) return { kind: 'model', reason: 'first-of-day', changed: keys };
  if (changed.length >= MODEL_WHEN_CHANGED_AT_LEAST) return { kind: 'model', reason: 'many-changes', changed: keys };
  if (facts.some((f) => f.kind === 'planned') && changed.some((f) => PLAN_MOVING.has(f.kind))) {
    return { kind: 'model', reason: 'plan-owed', changed: keys };
  }

  const sentences = changed
    .map((f) => plainSentence(f, facts))
    .filter((s): s is NarrationSentence => s !== null);
  return sentences.length > 0 ? { kind: 'deterministic', sentences } : { kind: 'none' };
}
