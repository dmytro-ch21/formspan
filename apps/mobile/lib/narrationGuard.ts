import type { DayFact } from './dayPanel';
import type { NarrationSentence } from './dayNarration';

/**
 * The fabricated-fact guard (N570, #1131). **The model narrates facts; it never
 * introduces them.**
 *
 * Every sentence narration shows has to survive three checks against
 * `panelFacts(panel)`, the only list narration may talk about
 * (`lib/dayNarration.ts`):
 *
 * 1. **It cites something.** A sentence resting on no fact is an opinion, and
 *    "Great consistency this week" is exactly the unbacked assertion the panel
 *    exists to refuse.
 * 2. **Every citation is a real key.** A model that names `logged:ghost-run` has
 *    invented a session. That is the failure the ticket names.
 * 3. **Every number is one the CITED facts state.** "That leaves 860 kcal"
 *    citing only what was eaten is arithmetic the model did on a target it was
 *    not pointed at, and a number the athlete would reasonably believe.
 *
 * A failing sentence is dropped whole, never repaired. Rewriting a number the
 * model got wrong would be this module inventing one instead.
 *
 * ## It is the database-backed invariant, extended, not a second one
 *
 * `unbackedFacts` in `lib/__tests__/support/dayFacts.ts` proves every fact's
 * rows are live rows for this athlete. This proves every sentence rests on
 * those facts. Together: text → fact keys → rows.
 *
 * ## A fact's own name is not a number
 *
 * "5x5 Day logged." quotes the session's name. The digits inside a CITED fact's
 * name (a session's, a tracker's, a plan's workout) are removed before the
 * numbers are read, so a name with a digit in it cannot defeat the guard.
 * The name has to match the cited fact's exactly, so this is not a way to
 * smuggle in a number: "Day 6 logged." citing a session named "5x5 Day" still
 * has an unbacked 6. Found in review: before this, every plain sentence about
 * "5K run" was dropped, and the day's plain narration went silent for a real
 * change.
 *
 * ## Where it is deliberately strict, and fails safe
 *
 * Numbers are matched as the panel prints them. kcal, grams and counts are
 * whole numbers (`fmtAmount`: rounded, commas ignored), because nothing in the
 * app prints them with a decimal. Weights also match to one decimal, because a
 * check-in reads "82.4 kg". Allowing a decimal on kcal too, as a first draft
 * did, would let a model state "1,840.4 kcal", a precision the panel never
 * shows. Found in review. Some true things a model could say are still
 * dropped:
 * - a date or a clock time ("10 Sep", "6:00 PM");
 * - a session's sets or volume, which no fact here states as a number yet;
 * - a weight in pounds, since the cache stores kilograms.
 *
 * Each of those loses a sentence, never keeps a wrong one. When the model path
 * lands and a real one shows up, it is added to {@link backedNumbers} with a
 * test, not loosened in the matcher.
 */

export type DroppedSentence = {
  sentence: NarrationSentence;
  reason: 'no-citation' | 'unknown-key' | 'unbacked-number';
  /** What failed: the unknown keys, or the unbacked numbers. */
  detail: string;
};

export type GuardVerdict = { kept: NarrationSentence[]; dropped: DroppedSentence[] };

/** A number as it can appear in prose: `1,840`, `82.4`, `3`. */
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** `1,840` → `1840`, `82.40` → `82.4`, `09` → `9`: one spelling per value. */
// JavaScript spells a magnitude of 1e21 or more, or below 1e-6, in exponent form
// (`1.2e+21`, `1e-7`); the server's Go `normalise` never does. Neither can be a
// number a fact states, so both are dropped as unbacked on both sides: the verdict
// is identical and only the `detail` string differs. Raised in review.
function normalise(raw: string): string {
  return String(Number(raw.replace(/,/g, '')));
}

/** Every number a fact states, spelled as {@link normalise} spells it. */
export function backedNumbers(fact: DayFact): Set<string> {
  const out = new Set<string>();
  const whole = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return;
    out.add(String(Math.round(n)));
  };
  const weight = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return;
    out.add(String(Math.round(n)));
    out.add(String(Math.round(n * 10) / 10));
  };
  switch (fact.kind) {
    case 'food-eaten':
      whole(fact.totals.kcal);
      whole(fact.totals.protein_g);
      whole(fact.totals.carb_g);
      whole(fact.totals.fat_g);
      whole(fact.entries);
      break;
    case 'nutrition-target':
      whole(fact.target.kcal);
      whole(fact.target.protein_g);
      whole(fact.target.carb_g);
      whole(fact.target.fat_g);
      break;
    case 'tracker':
      whole(fact.logged);
      whole(fact.target);
      break;
    case 'plan-done':
      whole(fact.planned);
      break;
    case 'last-checkin':
      weight(fact.checkin.weight_kg);
      break;
    case 'phase-goal':
      weight(fact.phase.target_weight_kg);
      break;
    case 'session-open':
    case 'planned':
    case 'logged':
    case 'next-planned':
      // States no number yet. See "fails safe" above.
      break;
  }
  return out;
}

/** The names a fact quotes verbatim, which are not numbers however many digits they hold. */
export function namesOf(fact: DayFact): string[] {
  switch (fact.kind) {
    case 'session-open':
    case 'logged':
      return fact.session.name ? [fact.session.name] : [];
    case 'tracker':
      return fact.tracker.name ? [fact.tracker.name] : [];
    case 'planned':
    case 'next-planned':
      return fact.plan.workoutName ? [fact.plan.workoutName] : [];
    default:
      return [];
  }
}

/**
 * A fact as the guard reads it, and as the phone sends it to the server in N570
 * part 2: its key, every number it states and every name it quotes.
 * `backend/internal/modules/narration`'s `Fact` carries the same three fields,
 * and both guards answer the cases in `evals/day-narration/guard_vectors.json`.
 */
export type BackedFact = { key: string; numbers: string[]; names: string[] };

/** A day fact reduced to what the guard reads. */
export function backedFactOf(fact: DayFact): BackedFact {
  return { key: fact.key, numbers: [...backedNumbers(fact)], names: namesOf(fact) };
}

/**
 * The guard's core, over {@link BackedFact}s. {@link guardNarration} is this over
 * the day's facts, and the server runs the same rules over the facts it was sent.
 */
export function guardSentences(
  sentences: readonly NarrationSentence[],
  facts: readonly BackedFact[],
): GuardVerdict {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const kept: NarrationSentence[] = [];
  const dropped: DroppedSentence[] = [];

  for (const sentence of sentences) {
    if (sentence.cites.length === 0) {
      dropped.push({ sentence, reason: 'no-citation', detail: 'cites no fact' });
      continue;
    }
    const unknown = sentence.cites.filter((key) => !byKey.has(key));
    if (unknown.length > 0) {
      dropped.push({ sentence, reason: 'unknown-key', detail: unknown.join(', ') });
      continue;
    }
    const backed = new Set<string>();
    const names: string[] = [];
    for (const key of sentence.cites) {
      const fact = byKey.get(key);
      if (!fact) continue;
      for (const n of fact.numbers) backed.add(normalise(n));
      names.push(...fact.names);
    }
    // Longest first, so "5x5 Day 2" is removed whole before "5x5 Day" could split
    // it. Counted in code points, not `.length`'s UTF-16 units, so ties sort the
    // way the server's rune count sorts them.
    let prose = sentence.text;
    for (const name of [...names].sort((a, b) => [...b].length - [...a].length)) {
      if (name) prose = prose.split(name).join(' ');
    }
    const unbacked = (prose.match(NUMBER) ?? []).map(normalise).filter((n) => !backed.has(n));
    if (unbacked.length > 0) {
      dropped.push({ sentence, reason: 'unbacked-number', detail: unbacked.join(', ') });
      continue;
    }
    kept.push(sentence);
  }
  return { kept, dropped };
}

export function guardNarration(
  sentences: readonly NarrationSentence[],
  facts: readonly DayFact[],
): GuardVerdict {
  return guardSentences(sentences, facts.map(backedFactOf));
}
