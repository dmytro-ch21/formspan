/**
 * How much the last fortnight can be trusted to judge a target.
 *
 * ## Why a target needs a window at all
 *
 * A calorie target is a hypothesis about a body, and the only way to find out
 * whether it was right is to compare what was eaten against what the scale did.
 * Both halves need days. Weight noise over two or three days is larger than a
 * week's worth of deficit, so a target read against a short window says
 * whatever the last big meal said — which is the failure the weekly adjustment
 * (N27) already refuses to run into, with the same fourteen-day frame.
 *
 * This module is the READING side of that: it says how much of the window is
 * actually there, and it says it honestly enough to be discouraging.
 *
 * ## Three states, and collapsing any two of them is the bug
 *
 * The N106 reference draws fourteen dots and the acceptance criterion is
 * explicit that a **partial** day must render differently from a **logged** one
 * and from an **empty** one. That distinction is not decoration:
 *
 *  - **`empty`** — nothing logged. An honest gap.
 *  - **`partial`** — something was logged and it plainly is not a day's eating.
 *    Counting it as logged is the dangerous direction: it inflates the
 *    denominator's satisfaction, so the app claims a target is well-evidenced
 *    on the strength of fourteen breakfasts. Counting it as empty is merely
 *    unkind — the athlete did log — so partial is its own state and **does not
 *    count toward the total**.
 *  - **`logged`** — a day that can carry weight.
 *
 * ## What "partial" is measured against, and why it is not a constant
 *
 * A fixed kcal floor cannot work: 900 kcal is most of a day for a small athlete
 * cutting hard and a third of one for a heavyweight in a bulk. So the yardstick
 * is **the target that was in force on that day** — which the Goals screen has
 * already fetched, because it fetches a year of them to answer "what am I
 * eating to". Half of it is the line. Half a day's calories is not a
 * defensible day's log by anyone's arithmetic, and it is far enough below a
 * normal day that ordinary under-logging does not trip it.
 *
 * **With no target in force on a day, there is no yardstick and none is
 * invented.** Such a day is `logged` if it has anything at all. That is the
 * same absence-is-not-an-answer rule the rest of this module runs on: we do not
 * know it was partial, so we do not say it was. It also matters practically —
 * an athlete arrives at this screen precisely because they have no target yet,
 * and marking their whole history partial on the way in would be both wrong and
 * dispiriting.
 */

/** The frame a target is judged over. Matches the weekly adjustment's own. */
export const CONFIDENCE_DAYS = 14;

/**
 * How many of those days have to be real before feedback is worth giving.
 *
 * Ten of fourteen rather than all fourteen: demanding a perfect fortnight from
 * an athlete who trains, travels and occasionally forgets is demanding
 * something nobody produces, and a bar nobody clears stops being a bar.
 */
export const CONFIDENCE_TARGET_DAYS = 10;

/**
 * The share of the day's target below which a log is not a day.
 *
 * Deliberately low. This is a floor for "that cannot have been a whole day",
 * not a judgement about adherence — eating 1,400 against a 2,000 target is a
 * good day's logging and a bad day's eating, and this module has no opinion on
 * the second.
 */
export const PARTIAL_BELOW = 0.5;

export type DayConfidence = 'logged' | 'partial' | 'empty';

export type Confidence = {
  /** Oldest first, so the row of dots reads left to right as time does. */
  days: { day: string; state: DayConfidence }[];
  /** Days that count. Partial days are excluded — see the note above. */
  logged: number;
  /** Always {@link CONFIDENCE_DAYS}; travels with `logged` so a bare count
   *  can never be rendered without what it is out of. N28's rule. */
  considered: number;
  /** Enough to judge a target against. */
  enough: boolean;
};

/**
 * Read the window.
 *
 * `totals` may contain days outside the window and may omit days inside it;
 * both are normal. `targetFor` answers "what was in force on this day", and
 * returning null is a legitimate answer rather than an error — see above.
 *
 * Pure, and separated from the screen for the reason `mealBudgetLine` records:
 * a rule that lives in a component is a rule no test can reach.
 */
export function readConfidence(
  totals: readonly { day: string; kcal: number }[],
  today: string,
  targetFor: (day: string) => number | null,
  days: number = CONFIDENCE_DAYS,
): Confidence {
  const byDay = new Map<string, number>();
  // Last write wins is fine — `localLoggedDayKcal` groups by day, so a repeat
  // key cannot occur from the real caller. Summing instead would silently
  // double a day if that ever changed.
  for (const t of totals) byDay.set(t.day, t.kcal);

  const out: { day: string; state: DayConfidence }[] = [];
  // Counted DOWN from today and reversed, rather than counted up from a
  // computed start: the window's fixed point is today, and deriving the start
  // separately is how an off-by-one puts a fifteenth dot on the row.
  for (let i = days - 1; i >= 0; i--) {
    const day = addDaysISO(today, -i);
    const kcal = byDay.get(day);
    out.push({ day, state: stateFor(kcal, targetFor(day)) });
  }

  const logged = out.filter((d) => d.state === 'logged').length;
  return {
    days: out,
    logged,
    considered: days,
    enough: logged >= Math.min(CONFIDENCE_TARGET_DAYS, days),
  };
}

/** One day's verdict. Exported for the test, and because the three-way rule is
 *  the whole point of this module. */
export function stateFor(kcal: number | undefined, target: number | null): DayConfidence {
  // `undefined` is "no rows", which is the only empty. A day whose entries sum
  // to zero was still logged — a zero-calorie day is a black coffee, not an
  // absence — so `=== undefined` rather than a falsy check, which would fold
  // the two together.
  if (kcal === undefined) return 'empty';
  if (target == null || target <= 0) return 'logged';
  return kcal < target * PARTIAL_BELOW ? 'partial' : 'logged';
}

/** Calendar arithmetic on `YYYY-MM-DD`, in UTC so every day is 24 hours — the
 *  same reasoning `lib/calendar.ts` and `lib/nutrition.ts` both record. */
function addDaysISO(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
}
