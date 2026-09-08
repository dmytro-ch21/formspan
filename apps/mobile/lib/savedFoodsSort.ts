/**
 * The Saved foods list's sort order (N532/#963) — the value set, the default,
 * and the one parser every reader of the stored preference goes through.
 *
 * A module of its own rather than a corner of `foodLog.ts`, because the
 * screen needs the value set and the parser WITHOUT the database: the screen
 * test mocks `@/lib/foodLog` wholesale, and a parser living there would be
 * mocked away with it — leaving the screen's default and its handling of a
 * stale stored value untested, which is the exact "unconstructible state"
 * trap this ticket named.
 */

import { dayString, shortDate } from './calendar';

export const SAVED_FOODS_SORTS = ['recent', 'name', 'used'] as const;
export type SavedFoodsSort = (typeof SAVED_FOODS_SORTS)[number];

/**
 * `recent`, deliberately. The user's complaint was "hard to find them", and
 * the thing you are looking for in a long saved list is almost always the
 * newest — what you just saved, or what a friend just sent. Alphabetical is
 * the right order for a dictionary and the wrong one for a list you add to.
 */
export const DEFAULT_SAVED_FOODS_SORT: SavedFoodsSort = 'recent';

/** Chip labels, in chip order. */
export const SAVED_FOODS_SORT_LABELS: Record<SavedFoodsSort, string> = {
  recent: 'Recent',
  name: 'Name',
  used: 'Most used',
};

/**
 * A stored preference back into a sort — or the default.
 *
 * Tolerant on purpose: a value written by a build that had a fourth sort, or
 * a hand-edited row, must open the list rather than break it. A stale value
 * is a preference nobody can act on, and the default is the honest answer.
 */
export function parseSavedFoodsSort(stored: string | null | undefined): SavedFoodsSort {
  return (SAVED_FOODS_SORTS as readonly string[]).includes(stored ?? '')
    ? (stored as SavedFoodsSort)
    : DEFAULT_SAVED_FOODS_SORT;
}

/**
 * How many days back "Recently shared" reaches. Thirty: long enough that a
 * food a friend sent last week is still spotlighted, short enough that the
 * section is genuinely "recent" rather than a permanent second list — the
 * search and the "from @handle" line on every row cover the older ones.
 */
export const RECENTLY_SHARED_DAYS = 30;

/**
 * The most rows the spotlight shows. The section sits ABOVE the full list,
 * so it has to stay a glance: ten is a screenful at the compact row height,
 * and a friend who sends more than that in a month is a search away.
 */
export const RECENTLY_SHARED_LIMIT = 10;

/**
 * The "from @handle · 3 Sep" line under a shared row, or null for a food that
 * was never shared.
 *
 * Keyed on `shared_at`, not `shared_by`: a sender who has since lost their
 * handle still shared it, and the row must still say so — "Shared with you"
 * rather than "from @" with nothing after it. The date is the share's, shown
 * as the LOCAL day it was accepted (the same `dayString` the whole app keys
 * days on), so a share accepted at 23:30 reads as tonight, not tomorrow.
 */
export function sharedFromLine(f: { shared_by?: string | null; shared_at?: string | null }): string | null {
  if (!f.shared_at) return null;
  const when = shortDate(dayString(new Date(f.shared_at)));
  return f.shared_by ? `from @${f.shared_by} · ${when}` : `Shared with you · ${when}`;
}
