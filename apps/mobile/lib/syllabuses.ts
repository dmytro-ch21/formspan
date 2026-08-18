import { BELTS, type Belt } from '@/lib/bjj';
import type { Curriculum } from '@/lib/curriculum';

/**
 * The VOLA-authored reference syllabuses, in rank order.
 *
 * **Why these are on the phone at all**, since #277 deliberately left them off
 * and this reverses that: the argument then was the platform rule — the roadmap
 * is the worked path and belongs here, the long-form reference is read at a
 * desk. It does not survive the obvious comparison. **This app already carries
 * the entire 542-technique library**, searchable, on the Library tab. A curated
 * 73-item belt list is smaller than that and better organised, so excluding it
 * while shipping the library was inconsistent rather than principled.
 *
 * They live in the Library's reference block beside the position glossary and
 * the round map — NOT on the Plan tab's Roadmaps strip. That distinction is the
 * part of #277's reasoning that does hold: Plan is what you are working, and a
 * list that finishes nothing is not that.
 *
 * Ordering and filtering are here rather than inline because both have a way of
 * being quietly wrong — belt rank is not alphabetical, and an unrecognised belt
 * has to sort LAST rather than lead the list a beginner opens first.
 *
 * **Filtered on `official`, which is the positive fact.** This used to read
 * `!editable`, and that is "not yours", NOT "VOLA's": `editable` is
 * owner-is-caller, so every other athlete's public curriculum is un-editable
 * too. Since `track` and `belt` are unvalidated hints, a stranger publishing
 * with `track: "syllabus"` and `belt: "white"` appeared here wearing a belt
 * word — F7. The client genuinely could not tell the difference at the time;
 * the server now answers it directly with `owner_user_id IS NULL`, and the
 * same field closed the same hole on the Plan tab's Roadmaps strip.
 *
 * **Do not "simplify" this back to `!editable`.** The two agree on every row
 * VOLA wrote, which is exactly why the bug survived review once already: the
 * difference only shows when somebody else's public curriculum exists.
 */
export function beltSyllabuses(curricula: Curriculum[]): Curriculum[] {
  return curricula
    .filter((c) => c.track === 'syllabus' && c.official)
    .sort((a, b) => rank(a) - rank(b));
}

/**
 * A belt string as a known belt, or null.
 *
 * Exported because `CurriculaStrip` carried a byte-identical private copy —
 * the duplicated-vocabulary shape `check:grip-parity` exists to police, one
 * language down. Two copies of "which belts exist" is two places to forget the
 * kids belts when 000023's enum edit finally happens.
 */
export function beltOf(belt: string | null): Belt | null {
  if (belt === null) return null;
  const b = belt.toLowerCase() as Belt;
  return BELTS.includes(b) ? b : null;
}

function rank(c: Curriculum): number {
  const belt = beltOf(c.belt);
  // Unranked last rather than first: -1 would float an unrecognised belt above
  // white, which is the one place a beginner is most likely to look.
  return belt === null ? BELTS.length : BELTS.indexOf(belt);
}

/** The belt word on its own, for a card that already says "the whole list". */
export function beltLabel(c: Curriculum): string {
  const b = beltOf(c.belt);
  return b === null ? c.name : b.charAt(0).toUpperCase() + b.slice(1);
}

/**
 * The Roadmaps strip: the belt track and foundations, VOLA's only.
 *
 * Lifted out of `CurriculaStrip` so it sits beside {@link beltSyllabuses}. The
 * two answer the same dangerous question — "may this be shown as VOLA
 * content?" — for two different strips, and keeping them apart is how they
 * came to disagree: this one was fixed for the caller's own curricula in one
 * review and still let every OTHER athlete's through, which is F7.
 *
 * **Filtered by TRACK, never by belt.** A reference syllabus carries a belt
 * too, so filtering on `belt` alone would put a 73-item list that finishes
 * nothing onto a strip labelled "Roadmaps", next to the roadmap it exists to
 * support. Foundations has no belt at all, deliberately — Novice Fundamentals
 * is the entry point, and filtering on belt made it invisible on the one
 * platform a novice actually holds.
 *
 * Order: what you are working leads, then foundations, then belts by rank.
 */
export function roadmapCurricula(curricula: Curriculum[]): Curriculum[] {
  return curricula
    .filter(
      (c) =>
        (c.track === 'belt' || c.track === 'foundations') &&
        (beltOf(c.belt) !== null || c.track === 'foundations') &&
        // The positive fact. See `beltSyllabuses` — `!editable` is "not
        // yours", which every stranger's public curriculum also satisfies.
        c.official,
    )
    .sort((a, b) => Number(b.enrolled) - Number(a.enrolled) || stripRank(a) - stripRank(b));
}

/**
 * Strip order within the un-enrolled: foundations first — the entry point, and
 * the one that finishes first — then belts in rank order.
 *
 * Deliberately NOT `rank` above, which sorts an unknown belt LAST. Here an
 * absent belt means foundations and must lead; there it means a belt this
 * build does not recognise and must not float above white.
 */
function stripRank(c: Curriculum): number {
  const belt = beltOf(c.belt);
  return belt === null ? -1 : BELTS.indexOf(belt);
}
