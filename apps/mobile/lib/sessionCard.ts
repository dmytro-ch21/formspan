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
