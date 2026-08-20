/**
 * The daily tracker, as a pure function of its record and its day's entries.
 *
 * **This file is the answer to "what does the second tracker have to write?"**
 * Nothing here mentions water. Coffee (N77) and an athlete's own tracker (N78)
 * are the same functions over a different row: a target of `null` is a count
 * with no ceiling, an increment equal to the target is a single dose, a target
 * of thirty doses is a bar rather than thirty glyphs. Every one of those is a
 * value, not a branch somebody has to add.
 *
 * Kept separate from `trackers.ts` (SQLite and the outbox) and from
 * `TrackerCard.tsx` (pixels) because this is the part with rules in it, and
 * rules are what a test can pin down.
 */

import { formatFluid, fluidUnit, type UnitSystem } from './units';

export type RenderStyle = 'auto' | 'glyphs' | 'bar' | 'dose';

/**
 * The units a tracker may count in. Mirrors the backend's closed set — an open
 * string would let an athlete author a tracker no screen knows how to render.
 */
export type TrackerUnit = '' | 'ml' | 'g' | 'mg' | 'cup' | 'dose' | 'count';

export type Tracker = {
  id: string;
  preset: string;
  name: string;
  icon: string;
  color_key: string;
  unit: TrackerUnit;
  /** How much one tap adds, in `unit`. */
  increment: number;
  /** `null` means a count with no goal — a real state, not a missing value. */
  target: number | null;
  render_style: RenderStyle;
  sort_order: number;
};

export type TrackerEntry = {
  id: string;
  tracker_id: string;
  logged_on: string;
  logged_at: string;
  /** The increment as it was when this was logged. See `lib/db.ts`. */
  amount: number;
};

/**
 * The most glyphs a row may ever draw.
 *
 * Twelve because that is roughly where a row stops being countable at a glance
 * and becomes a block you have to tally — the failure N78 names explicitly
 * ("thirty capsules is a wall of identical glyphs nobody can count"). Past it
 * the card switches to a bar with the number stated, because at that point the
 * number is what is being read anyway.
 */
export const MAX_GLYPHS = 12;

/**
 * How many taps make up the target, rounded UP.
 *
 * Up, not to nearest: a target of 2000 ml at 300 ml a glass is seven glasses,
 * because six leaves you short of the thing you said you wanted. `null` when
 * there is no target.
 */
export function targetCount(t: Tracker): number | null {
  if (t.target == null || !(t.increment > 0)) return null;
  return Math.max(1, Math.ceil(t.target / t.increment));
}

/** Total logged, in the tracker's unit. */
export function loggedAmount(entries: TrackerEntry[]): number {
  return entries.reduce((sum, e) => sum + e.amount, 0);
}

/**
 * How many taps have been logged.
 *
 * Counts ENTRIES, not amount/increment, and the difference is not academic: an
 * athlete who logged four cups and then changed the increment from 250 to 500
 * has still tapped four times, and dividing the stored amount by the new
 * increment would show two. The entries are the record of what happened.
 */
export function loggedCount(entries: TrackerEntry[]): number {
  return entries.length;
}

/**
 * How the card should draw itself, given how much is on it right now.
 *
 * The count is an argument rather than read off the tracker because a row that
 * would grow past `MAX_GLYPHS` has to become a bar — an athlete logging fifteen
 * of eight must not be handed an uncountable block. That is a property of the
 * day, not of the definition, so it cannot be resolved once at authoring time.
 *
 * An explicitly stored style always wins: the athlete's override is a decision,
 * not a hint.
 */
export function resolveRenderStyle(t: Tracker, count: number): Exclude<RenderStyle, 'auto'> {
  if (t.render_style !== 'auto') return t.render_style;
  const target = targetCount(t);
  if (target === 1) return 'dose';
  if (glyphSlots(t, count) > MAX_GLYPHS) return 'bar';
  return 'glyphs';
}

/**
 * How many glyphs a row would draw for this count.
 *
 * At least the target, at least what was logged. The second half is what lets
 * ten of eight render as ten cups rather than eight and a hidden remainder —
 * crossing a target is not an end state, and a row that stops at the target
 * would be telling the athlete their last two cups did not happen.
 */
export function glyphSlots(t: Tracker, count: number): number {
  const target = targetCount(t);
  return Math.max(target ?? 0, count, 1);
}

/**
 * The noun for one tap, singular.
 *
 * Derived from the unit rather than stored, so choosing a unit chooses the
 * word: `ml` and `cup` are glassfuls, `g`/`mg`/`dose` are doses, a bare count
 * has no noun at all and reads "4 of 8".
 *
 * **A known limitation rather than a hidden one:** an athlete tracking 30 g of
 * fibre in 5 g steps gets "6 doses", which is not what they would say. The fix
 * is an authored noun on the tracker, and that belongs to N78 (which is where
 * arbitrary trackers arrive) rather than being guessed at here.
 */
export function unitNoun(t: Tracker): string {
  switch (t.unit) {
    case 'ml':
    case 'cup':
      return 'cup';
    case 'g':
    case 'mg':
    case 'dose':
      return 'dose';
    default:
      return '';
  }
}

export function pluralise(noun: string, n: number): string {
  if (!noun) return '';
  return n === 1 ? noun : `${noun}s`;
}

/**
 * The value line — "4 of 8 cups", or "3 cups" when there is no target.
 *
 * **States the fact and nothing else.** No "great job", no "you are behind",
 * no exclamation mark, and specifically nothing different about ten of eight
 * than about four of eight: this project does not do shame-based messaging, and
 * praise is the same mechanism wearing a friendlier face. An athlete who wants
 * to know whether they are over can see that 10 is more than 8.
 */
export function valueLine(t: Tracker, entries: TrackerEntry[]): string {
  const count = loggedCount(entries);
  const target = targetCount(t);
  const noun = pluralise(unitNoun(t), target ?? count);
  const suffix = noun ? ` ${noun}` : '';
  if (target == null) return `${count}${suffix}`;
  return `${count} of ${target}${suffix}`;
}

/**
 * The amount line — the same day in the athlete's own unit, or null when the
 * tracker counts in something that has no display conversion.
 *
 * Volumes follow the unit preference (`ml` / `fl oz`) because that is a real
 * preference this app already holds and has ignored twice before (L4, L8).
 * Grams and milligrams do not convert — there is no imperial creatine — so
 * they are shown as they are stored rather than run through a transform that
 * would be the identity.
 */
export function amountLine(
  t: Tracker,
  entries: TrackerEntry[],
  units: UnitSystem,
): string | null {
  const total = loggedAmount(entries);
  switch (t.unit) {
    case 'ml':
      return formatFluid(total, units);
    case 'g':
    case 'mg':
      return `${trimNumber(total)} ${t.unit}`;
    default:
      // 'cup', 'dose', 'count' and '' are already the count, which the value
      // line states. Repeating it as "3 cup" would be noise.
      return null;
  }
}

/** The unit an amount is ENTERED in — what a target field should be labelled. */
export function inputUnitLabel(t: Tracker, units: UnitSystem): string {
  return t.unit === 'ml' ? fluidUnit(units) : t.unit;
}

/**
 * "last at 16:40" — the time of the newest entry, in the device's local zone.
 *
 * Unused by water and built now because N77 needs exactly this and nothing
 * else: the time of the last coffee is the number that matters to somebody
 * training in the evening. Formatted from the stored instant rather than from
 * `logged_on`, which is a day and has no time in it.
 */
export function lastLoggedAt(entries: TrackerEntry[]): Date | null {
  let newest: Date | null = null;
  for (const e of entries) {
    const at = new Date(e.logged_at);
    if (Number.isNaN(at.getTime())) continue;
    if (!newest || at > newest) newest = at;
  }
  return newest;
}

export function formatClock(at: Date): string {
  const h = String(at.getHours()).padStart(2, '0');
  const m = String(at.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * What VoiceOver reads for one glyph.
 *
 * **A row of eight identical shapes is an accessibility trap**, and the trap is
 * not that the shapes are unlabelled — it is that they are labelled the same.
 * Someone swiping through the row hears "cup, cup, cup" and cannot tell where
 * they are or what they are about to change. So each glyph states its position,
 * its total, its state, and the tracker it belongs to — a VoiceOver user can
 * land anywhere in the row and know exactly what a double-tap will do.
 */
export function glyphLabel(
  t: Tracker,
  index: number,
  total: number,
  filled: boolean,
): string {
  const noun = unitNoun(t) || 'item';
  const state = filled ? 'filled' : 'empty';
  return `${t.name}, ${noun} ${index + 1} of ${total}, ${state}`;
}

/** What a double-tap on that glyph will do, spoken as a verb. */
export function glyphHint(filled: boolean): string {
  return filled ? 'Double tap to remove it' : 'Double tap to add it';
}

export function addLabel(t: Tracker): string {
  const noun = unitNoun(t) || 'one';
  return `Add a ${noun} of ${t.name}`;
}

/**
 * The whole row, as one sentence, for the container.
 *
 * VoiceOver reads a container's label before its children, so this is what
 * orients somebody before they start swiping — and on a rotor jump it may be
 * the only thing they hear.
 */
export function rowLabel(t: Tracker, entries: TrackerEntry[]): string {
  return `${t.name}, ${valueLine(t, entries)}`;
}

/** 0..1, clamped for the bar. Over target is drawn full, never past the end. */
export function progress(t: Tracker, entries: TrackerEntry[]): number {
  const target = targetCount(t);
  if (!target) return 0;
  return Math.min(1, loggedCount(entries) / target);
}

/** Drops a trailing ".0" and rounds the float dust off a sum of doubles. */
function trimNumber(v: number): string {
  return String(Math.round(v * 100) / 100);
}
