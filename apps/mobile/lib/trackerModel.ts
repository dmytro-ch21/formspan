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
  /**
   * The singular word for one tap, authored by the athlete. Empty means the
   * card reads "4 of 8" with no noun. See `unitNoun`.
   */
  count_noun: string;
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
 * ## The override is a preference among READABLE renderings, not a licence
 *
 * This used to open `if (t.render_style !== 'auto') return t.render_style;` —
 * "an explicitly stored style always wins: the athlete's override is a
 * decision, not a hint." That is the wrong shape, and F22 (#516) is the proof:
 * **the seeded water preset ships `glyphs`, not `auto`**, so the early return
 * fires for the row every athlete actually has, and a fifteen-glass day drew
 * fifteen identical glyphs — the exact uncountable block `MAX_GLYPHS` exists to
 * prevent. The fixture said `auto` and the assertion passed; green, covered,
 * and covering something that does not ship.
 *
 * N78's criterion is unconditional — *"Never render a row so long it wraps into
 * an uncountable block — that is the failure mode this criterion exists to
 * prevent"* — so the cap is a FLOOR the override cannot go under, and #516's
 * open question ("which wins") is answered here: the cap does.
 *
 * Two ways a stored style can ask for something untrue, and both yield:
 *
 * - **`glyphs` past the cap** becomes a bar. The athlete asked for countable;
 *   thirty glyphs is not countable, so the bar is closer to what they meant.
 * - **`dose` when one tap is NOT the whole day** becomes the ordinary
 *   glyphs-or-bar decision. A single glyph says "taken"; drawing it for a
 *   thirty-capsule tracker would report the day done after one capsule, which
 *   is not a rendering preference, it is a wrong number.
 *
 * Everything else the athlete chooses is honoured — `bar` for a two-cup target
 * is merely unusual, and unusual is theirs to pick.
 *
 * **What this does NOT do** is change any stored row. Nothing migrates
 * `render_style`, because nothing distinguishes "seeded default" from "athlete
 * chose this" — and with the cap enforced here that distinction stops mattering
 * for correctness. #516's remaining criteria are about the seed literal and its
 * fixture, and are left to it.
 */
export function resolveRenderStyle(t: Tracker, count: number): Exclude<RenderStyle, 'auto'> {
  const target = targetCount(t);
  const wanted: Exclude<RenderStyle, 'auto'> =
    t.render_style === 'auto' ? (target === 1 ? 'dose' : 'glyphs') : t.render_style;

  // A single dose glyph is only TRUE when one tap completes the day. `auto`
  // never picks it otherwise; a stored `dose` can, and must not.
  if (wanted === 'dose' && target !== 1) {
    return glyphSlots(t, count) > MAX_GLYPHS ? 'bar' : 'glyphs';
  }
  if (wanted === 'glyphs' && glyphSlots(t, count) > MAX_GLYPHS) return 'bar';
  return wanted;
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
 * The noun for one tap, singular — "cup", "capsule", "scoop", or nothing.
 *
 * **Read off the record, never computed.** N76 derived it from the unit and
 * wrote the failure down in the same breath: 30 g of fibre in 5 g steps read
 * *"6 doses"*, because `g` mapped to `dose`.
 *
 * The tempting repair is a bigger table, and it cannot work — the noun belongs
 * to the SUBSTANCE and the unit does not carry it. 5 g of creatine is a dose,
 * 5 g of fibre is a serving, 30 g of protein is a scoop; all three are `g`, so
 * no function of `{ml, g, mg, cup, dose, count}` can separate them. The
 * distinguishing fact was never in the input.
 *
 * So the athlete says it (N78), the column stores it, and the old table
 * survives below as `suggestedNoun` — the prefilled starting point in the
 * create form, which is what it always really was.
 *
 * Empty is a real answer, not a missing one: a tracker that counts cold showers
 * reads "4 of 8" and should.
 */
export function unitNoun(t: Tracker): string {
  return t.count_noun;
}

/**
 * What to PREFILL the noun field with when the athlete picks a unit.
 *
 * This is N76's derivation, kept exactly, and demoted to what it can actually
 * do: guess well enough that most athletes never touch the field. It is offered
 * at authoring time — where a wrong guess is one edit away from right — and
 * never consulted at render time, where a wrong guess is a card that lies.
 *
 * Deliberately NOT called from `unitNoun` as a fallback. A fallback would put
 * "6 doses" back on the fibre card for anyone whose stored noun is empty, and
 * empty is a choice the athlete is allowed to make.
 */
export function suggestedNoun(unit: TrackerUnit): string {
  switch (unit) {
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
 * The line under the row — the arithmetic, and when the last one was.
 *
 * **One line for both readings of a target, because there is only one target
 * column.** Water's 2 litres is a goal you are heading for; coffee's three cups
 * is a ceiling you would rather not cross. Distinguishing them in copy would
 * need a `target_kind` on the row, which is a migration — so instead every
 * phrasing here is true under both readings: `4 to go` states a remainder,
 * `2 past your target of 3` states a difference, and neither says whether that
 * is good.
 *
 * `last at 16:40` is appended whenever anything has been logged, for every
 * tracker rather than for coffee. It is the number N77 was written around —
 * what matters to somebody training in the evening is *when* the last cup was,
 * not that it happened — and it is equally true of water, so a branch on the
 * preset here would be the card learning what coffee is.
 *
 * Null when there is nothing to say at all: no target, nothing logged.
 */
export function footLine(t: Tracker, entries: TrackerEntry[]): string | null {
  const parts: string[] = [];
  const count = loggedCount(entries);
  const target = targetCount(t);
  if (target != null) {
    if (count > target) parts.push(`${count - target} past your target of ${target}`);
    else if (count === target) parts.push(`Target ${target} reached`);
    else parts.push(`${target - count} to go`);
  }
  const at = lastLoggedAt(entries);
  if (at) parts.push(`last at ${formatClock(at)}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * What one glyph in the row is.
 *
 * Three states rather than a boolean, and the third is N77's: a cup logged
 * PAST the target. It still happened, it is still removable, and it has to be
 * distinguishable at a glance from the ones inside the target — otherwise the
 * row tells an athlete with a three-cup ceiling that their fifth cup is the
 * same event as their first.
 *
 * `empty` and `over` never appear on the same row, which is arithmetic rather
 * than luck: `glyphSlots` draws `max(target, count)`, so the moment any glyph
 * is over the target every slot is filled. That is what lets the drawn
 * difference be subtractive (a smaller fill) without reading as "not logged".
 *
 * **Two render styles cannot show `over`, and both are deliberate rather than
 * missed.** `dose` draws a single glyph at index 0, and a one-dose target puts
 * the boundary at index 1 — so a second creatine scoop past a one-scoop target
 * looks like the first. `bar` clamps `progress` at 1 for the same reason a bar
 * cannot draw past its end. In both cases the FOOT LINE still states the fact
 * (`1 past your target of 1`), so the information is on the card; it is the
 * glyph channel that does not participate. Worth knowing before reading either
 * as a bug — N78's creatine is exactly the `dose` case.
 */
export type GlyphState = 'empty' | 'filled' | 'over';

export function glyphState(t: Tracker, index: number, count: number): GlyphState {
  if (index >= count) return 'empty';
  const target = targetCount(t);
  if (target != null && index >= target) return 'over';
  return 'filled';
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
  state: GlyphState,
): string {
  const noun = unitNoun(t) || 'item';
  // "filled, past your target" rather than a separate word, so a VoiceOver user
  // hears the same vocabulary the visible foot line uses — and so an over-target
  // cup is still announced as logged, which is what a double-tap will undo.
  const said = state === 'over' ? 'filled, past your target' : state;
  return `${t.name}, ${noun} ${index + 1} of ${total}, ${said}`;
}

/** What a double-tap on that glyph will do, spoken as a verb. */
export function glyphHint(state: GlyphState): string {
  return state === 'empty' ? 'Double tap to add it' : 'Double tap to remove it';
}

export function addLabel(t: Tracker): string {
  const noun = unitNoun(t) || 'one';
  return `Add a ${noun} of ${t.name}`;
}

/*
 * There was a `rowLabel` here — "Water, 4 of 8 cups" — for the glyph row's
 * container. It is GONE, and the reason is worth keeping so nobody re-adds it.
 *
 * A plain `View` without `accessible` is not an accessibility element on iOS,
 * so the label was never spoken by VoiceOver; and setting `accessible` would
 * collapse the row into ONE element, swallowing the per-glyph labels that make
 * the row navigable at all. So the container can be labelled or usable, not
 * both — and usable wins. The name and the value are already their own text
 * elements directly above the row.
 *
 * It had a passing test, which is exactly why this note exists: a tested
 * function that nothing can hear reads as load-bearing.
 */

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
