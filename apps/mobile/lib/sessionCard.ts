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
  /** `carried` means this session is what kept the streak alive. */
  streak?: { weeks: number; carried: boolean } | null;
  handle?: string;
  now?: Date;
}): CardData {
  const { id, summary, stats, streak, handle } = input;
  const when = input.now ?? new Date();

  const badges: string[] = [];
  const prCount = summary.records.length;
  if (prCount > 0) {
    badges.push(prCount === 1 ? 'Personal best' : `${prCount} personal bests`);
  }
  // Only when THIS session carried it. "4 weeks" on a session that merely
  // happened during a streak claims credit the session did not earn.
  if (streak?.carried && streak.weeks > 1) {
    badges.push(`${streak.weeks} weeks unbroken`);
  }

  return {
    id,
    sport: summary.sport,
    title: summary.title,
    eyebrow: summary.sport === 'bjj' ? 'BJJ' : summary.sport.toUpperCase(),
    dateLabel: when
      .toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      .toUpperCase(),
    stats: stats.map((s) => ({ label: s.label, value: s.value })),
    badges,
    handle,
    highlight: prCount > 0 ? 'pr' : streak?.carried ? 'streak' : undefined,
  };
}
