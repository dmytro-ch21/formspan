/**
 * The rungs a weekly streak passes, and the one moment each is worth saying.
 *
 * `weekStreak` has counted consecutive training weeks for a long time and the
 * Progress tab has always shown the number. What nothing did was **mark the
 * moment it crossed something** — an athlete who trained every week for a year
 * got the same quiet "52 weeks in a row" line they got in week 51, on a screen
 * they had to go and open.
 *
 * ## Why this does not add a counter anywhere new
 *
 * `WeekReview` records a design decision — *no score, no grade, no streak* —
 * and this deliberately does not overturn it. The distinction it turns on is
 * that a **running number can visibly break** and a **congratulation cannot**.
 * A "12 weeks" figure on the home screen is a thing to protect, and protecting
 * it is what makes an athlete train on a week their body wanted off, then feel
 * they lost something when they did not. That is the shame-based framing the
 * project rules out.
 *
 * So this returns a milestone **only in the week one is newly reached**, and
 * nothing at all otherwise. There is no number that ticks, nothing to watch,
 * and nothing to break — a week off simply means the next congratulation comes
 * later. The Progress tab keeps the honest running count for anyone who wants
 * to go and look at it, which is a different act from being shown it.
 *
 * ## Weeks, not days
 *
 * Inherited from `weekStreak`, and the reason is worth repeating because it is
 * the whole ethics of the feature: a *daily* streak in a training app punishes
 * rest days, which are training. A weekly one rewards showing up regularly and
 * says nothing about which days — so it cannot be protected by training hurt.
 *
 * ## The ladder
 *
 * Four rungs, widening. A month is close enough to feel reachable from a
 * standing start; a year is rare enough that the top rung means something. The
 * gap between 4 and 26 gets one rung at 13 rather than staying silent for five
 * months, which is long enough that the ladder would stop existing for most
 * people between their first milestone and their second.
 */

/*
  From `history`, NOT from `calendar`. Both modules export `startOfWeek`,
  `addDays` and `today` under the same names, and they are different functions:
  `calendar`'s take and return `Date`, `history`'s take and return the
  `YYYY-MM-DD` key a `HistoryDay` is stored under. Everything here works on
  those keys, and the wrong import typechecks against nothing useful while
  quietly comparing a Date to a string.
*/
import { startOfWeek, today, weekStreak, type HistoryDay } from './history';

export type Milestone = {
  key: 'month' | 'quarter' | 'half-year' | 'year';
  /** Consecutive training weeks this rung requires. */
  weeks: number;
  /** The badge — short, on the card. */
  label: string;
  /** One line under it, saying what was actually done. */
  blurb: string;
};

/** Ascending, and nothing reads the order — but a reader expects it. */
export const MILESTONES: Milestone[] = [
  {
    key: 'month',
    weeks: 4,
    label: 'A month, unbroken',
    blurb: 'Four weeks in a row with training in every one of them.',
  },
  {
    key: 'quarter',
    weeks: 13,
    label: 'Three months, unbroken',
    blurb: 'Thirteen weeks in a row. This is past the point most people stop.',
  },
  {
    key: 'half-year',
    weeks: 26,
    label: 'Half a year, unbroken',
    blurb: 'Twenty-six weeks in a row. Six months of showing up.',
  },
  {
    key: 'year',
    weeks: 52,
    label: 'A year, unbroken',
    blurb: 'Fifty-two weeks in a row. A full year without a week off.',
  },
];

/**
 * The milestone reached **this week**, or null.
 *
 * Exact equality against the rung, not `>=`, and that is the whole mechanism:
 * `weekStreak` counts the current week only once it holds a session, so the
 * streak is `26` for exactly the week that reaches twenty-six and `27` the week
 * after. A `>=` test would re-congratulate every week forever, which is a
 * counter wearing a congratulation's clothes and would land straight back in
 * the framing this avoids.
 *
 * Null is therefore the answer almost every week, and callers must render
 * nothing at all for it — not a placeholder, not a "next milestone in N weeks"
 * line. A countdown to the next rung is the same protectable number by another
 * name.
 *
 * **Bounded by what has synced**, exactly as `carriedTheStreak` is: history is
 * the server's, so a phone that has never reached the network sees a shorter
 * streak and stays quiet. Silence is not a claim; a congratulation for a
 * milestone that was not reached is.
 */
export function milestoneReached(days: HistoryDay[], from = today()): Milestone | null {
  // The current week must actually hold a session. `weekStreak` deliberately
  // steps back to last week when this one is still open, so that it does not
  // appear to reset every Monday morning — correct for a displayed figure, and
  // wrong here: it would re-report the rung reached last week every day of the
  // untrained week that follows. The only shipped caller cannot reach that
  // (`milestoneForSession` requires `carried`, which implies a session this
  // week), but the export invites it, and re-congratulating is the one failure
  // this module exists to prevent.
  const week = startOfWeek(from);
  if (!days.some((d) => d.sessions > 0 && startOfWeek(d.date) === week)) return null;

  const weeks = weekStreak(days, from);
  return MILESTONES.find((m) => m.weeks === weeks) ?? null;
}

/**
 * Did *this session* reach it, rather than merely happening inside the week?
 *
 * The card fires once, on the session that carried the streak into the new
 * rung. Train four times that week and the other three get nothing — they are
 * training, not milestones, and a card that opened four times would make the
 * fourth one meaningless.
 *
 * Same shape and same one-session rule as `carriedTheStreak`, which is passed
 * in rather than recomputed so both readings of "did this session carry it"
 * come from one place. Recomputing here is how the card and the chime end up
 * disagreeing about the same session.
 */
export function milestoneForSession(
  days: HistoryDay[],
  carried: boolean,
  from = today(),
): Milestone | null {
  return carried ? milestoneReached(days, from) : null;
}

/**
 * Should the milestone chime play, and does it outrank the others?
 *
 * **It outranks everything, including a personal record**, and that inverts the
 * precedence `celebratesStreak` documents. The reasoning there was frequency: a
 * PR is rare and an ordinary weekly streak recurs every week, so the streak
 * standing down was the right trade every time they coincided. A milestone is
 * on the other side of that same argument — the top rung happens at most once a
 * year and three of the four happen at most once ever, so it is rarer than any
 * PR and the trade reverses.
 *
 * It needs no `recordsSettled` gate for the same reason: nothing can outrank
 * it, so there is no race to lose. `celebratesStreak` gains a `milestone` input
 * instead, and stands down.
 */
export function celebratesMilestone(opts: { milestone: Milestone | null }): boolean {
  return opts.milestone !== null;
}
