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
 * **`!editable` is a weaker guard than it looks, and the comment here used to
 * overstate it.** It means "not yours", NOT "VOLA's": `Editable` is computed as
 * owner-is-caller, so every other athlete's public curriculum is also
 * un-editable. A stranger publishing one on this track would appear here
 * wearing a belt word. The client cannot currently tell the difference —
 * `owner_user_id` is deliberately `json:"-"` — so this is as far as it goes;
 * see **F7** for the server-side fix, which would close the same hole on the
 * Plan strip.
 */
export function beltSyllabuses(curricula: Curriculum[]): Curriculum[] {
  return curricula
    .filter((c) => c.track === 'syllabus' && !c.editable)
    .sort((a, b) => rank(a) - rank(b));
}

function beltOf(belt: string | null): Belt | null {
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
