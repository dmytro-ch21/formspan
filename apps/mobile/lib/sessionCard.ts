/**
 * What the session card renders, and the words on it.
 *
 * A plain data type with no fetching, so the card can be mounted off-screen for
 * the PNG export. See `components/SessionCard.tsx`.
 */

import { hash32 } from './mountains';

/** Deliberately unrelated to PEAK_SEED — see headlineFor. */
const HEADLINE_SEED = 0x9e3779b1;

export type CardStat = {
  label: string;
  value: string;
  unit?: string;
};

export type CardData = {
  /** The session id — the deterministic mountain is keyed off it. */
  id: string;
  sport: string;
  /** The session's own name, e.g. "Lower — Squat & Hinge". */
  title: string;
  /** e.g. "STRENGTH" or "BJJ · GI". */
  eyebrow: string;
  dateLabel: string;
  stats: CardStat[];
  /** Earned things only — PRs, streaks. Empty is the common case. */
  badges: string[];
  handle?: string;
  /** Drives the headline. Absent when there is nothing notable to say. */
  highlight?: 'pr' | 'streak' | 'hardest';
  /**
   * The "what I did" band — exercises or techniques. Empty until the numbers
   * arrive, and empty is a legitimate resting state rather than a loading one:
   * the card is complete without it.
   */
  detail?: { name: string; figure?: string; outcome?: string; count?: number }[];
  /** How many rows `detail` omitted, for a "+4 more" line. */
  more?: number;
  /**
   * A local file URI, in place of the deterministic mountain (N449, #747).
   *
   * Never a remote URL — this never leaves the device. The picked photo is
   * rendered straight into the card and captured into the exported PNG by
   * `captureRef`, so there is nothing to upload and nowhere a server-hosted
   * URL would come from. See `SessionShare.tsx`'s `useSessionShare` for where
   * this gets set.
   *
   * Absent is the default and the common case: `SessionCard` falls back to
   * `mountainFor(id)`, exactly as before this existed.
   */
  backgroundUri?: string;
};

/**
 * The line across the middle of the card.
 *
 * ROTATES ON WHAT HAPPENED, not at random. A card that says "STRONGER EVERY
 * DAY" after a session the athlete knows was mediocre is the kind of praise
 * that teaches people to stop reading the card — the same reason this app
 * refuses to celebrate every session identically.
 *
 * Deterministic per session, so re-opening does not reword it.
 */
const ORDINARY = [
  'SHOWED\nUP.',
  'ONE MORE\nIN THE BANK.',
  'WORK\nDONE.',
  'ANOTHER\nBRICK.',
];

export function headlineFor(data: CardData): string {
  switch (data.highlight) {
    case 'pr':
      return 'NEW\nBEST.';
    case 'hardest':
      return 'HARDEST\nIN WEEKS.';
    case 'streak':
      return 'STILL\nGOING.';
    default:
      // A different seed from the peak's, so the phrase and the picture do not
      // correlate — otherwise every "WORK DONE." card would show the same
      // mountain, which is the template look the rotation exists to prevent.
      // Note this only works because `hash32` avalanches: with a bare FNV the
      // two seeds still shared low bits and half the combinations never
      // appeared. See its doc comment.
      return ORDINARY[hash32(data.id, HEADLINE_SEED) % ORDINARY.length];
  }
}

/**
 * A finished session, as the card wants it.
 *
 * Built from the SAME `SessionSummary` the celebration card already renders,
 * rather than from a second fetch. Two summaries of one session would drift —
 * the card would say four exercises while the screen behind it said five — and
 * this one is already the thing both completion screens compute.
 *
 * `stats` comes straight from `statsFor` so the card and the screen can never
 * disagree about which four numbers matter for a sport. That is also why the
 * caller passes them in rather than the adapter importing `celebration`:
 * `celebration` imports `records`, which imports the API client, and the card
 * has to stay free of anything that fetches so it can render off-screen.
 */
export function cardFromSummary(input: {
  id: string;
  summary: { title: string; sport: string; records: readonly unknown[] };
  stats: { label: string; value: string }[];
  /**
   * The server-derived numbers, once they arrive. Absent is the normal first
   * render and the permanent state offline.
   */
  numbers?: {
    calories: { kcal: number } | null;
    score: { value: number } | null;
    detail: { name: string; figure?: string; outcome?: string; count?: number }[];
    more: number;
  } | null;
  /** `carried` means this session is what kept the streak alive. */
  streak?: { weeks: number; carried: boolean } | null;
  /**
   * The PR badge's text, already formatted — e.g. "Back Squat · 152kg × 5
   * PR" — built by `lib/celebration`'s `prBadgeFor`. Pre-formatted for the
   * same reason `stats` is: naming the record needs an exercise-name lookup
   * and a unit-aware weight formatter, and this file stays free of both so
   * it can keep rendering off-screen for the export — see the file comment.
   *
   * Null or undefined is a real, common state — no record this session, or
   * one that could not be captioned (see `prBadgeFor`'s own doc) — and is
   * NOT the same as `hasRecord` below: a record with no resolvable caption
   * still earns the "NEW BEST." headline, it just gets no badge pill.
   */
  prBadge?: string | null;
  handle?: string;
  now?: Date;
}): CardData {
  const { id, summary, stats, streak, handle, prBadge } = input;
  const when = input.now ?? new Date();

  const badges: string[] = [];
  // Whether THIS session set a personal record at all — drives the headline
  // (see `highlight` below) independently of whether the badge could be
  // captioned. `prBadge` failing to resolve a name should not un-happen the
  // record.
  const hasRecord = summary.records.length > 0;
  // No bare-count fallback ("2 personal bests") any more (N447/#745): the
  // caller either has a real caption or it doesn't, and a count is exactly
  // the uninformative line the ticket's complaint was about.
  if (prBadge) badges.push(prBadge);
  // Only when THIS session carried it. "4 weeks" on a session that merely
  // happened during a streak claims credit the session did not earn.
  if (streak?.carried && streak.weeks > 1) {
    badges.push(`${streak.weeks} weeks unbroken`);
  }

  // THE STAT STRIP IS FOUR WIDE AND THAT IS A HARD CEILING — a fifth column
  // makes the digits too small to read at arm's length, which is the only
  // distance this card is ever read from. So calories and the score do not
  // add columns, they take them: the first two stats (time, and the sport's
  // own headline measure) stay, and the rest move down to the detail band
  // where the names are anyway.
  const numbers = input.numbers;
  let shown = stats.slice(0, 4).map((s) => ({ label: s.label, value: s.value }));
  if (numbers?.calories || numbers?.score) {
    shown = stats.slice(0, 2).map((s) => ({ label: s.label, value: s.value }));
    if (numbers.calories) {
      shown.push({ label: 'Calories', value: `≈${numbers.calories.kcal}` });
    }
    if (numbers.score) {
      shown.push({ label: 'VOLA score', value: String(numbers.score.value) });
    }
  }

  return {
    id,
    sport: summary.sport,
    title: summary.title,
    eyebrow: summary.sport === 'bjj' ? 'BJJ' : summary.sport.toUpperCase(),
    dateLabel: when
      .toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      .toUpperCase(),
    stats: shown,
    detail: numbers?.detail ?? [],
    more: numbers?.more ?? 0,
    badges,
    handle,
    highlight: hasRecord ? 'pr' : streak?.carried ? 'streak' : undefined,
  };
}
