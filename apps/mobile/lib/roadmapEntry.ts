import { nextStep, type Curriculum } from './curriculum';
import { roadmapCurricula } from './syllabuses';

/**
 * The two decisions a roadmap ENTRY POINT has to make, out of the screens that
 * draw them.
 *
 * N96 — the user's report was "its very hidden and not noticable", and the
 * diagnosis behind this module is worth stating because it changes what the
 * fix is. Three surfaces were said to point at roadmaps. Only ONE of them ever
 * pointed at a roadmap the athlete was not already on:
 *
 *  - Today's `RoadmapLine` renders `listWorkingCurricula`, which is enrolled-
 *    only. On none, it drew nothing.
 *  - You's `RoadmapSummary` returns `null` when there is no working roadmap and
 *    no focus, with a comment declining to prompt.
 *  - Plan's `CurriculaStrip` is the only surface that shows an un-enrolled one,
 *    and it sits below a seven-day week grid on the tab you open to pick a
 *    template.
 *
 * So "three entry points" was one offer and two progress read-outs, and the
 * athlete reporting it had never enrolled — which made two of the three
 * structurally invisible to exactly the person who needed them. A fourth link
 * was never the answer; the missing thing was an offer on the screen the app
 * opens to, and a position you can read without navigating.
 *
 * Both decisions live here rather than in the screens for the reason
 * `todayDaySwitcher.test.tsx` gives: Today's own render pulls Clerk, sync,
 * SQLite and half the router through it, so a derivation left inline there is
 * one nothing can cover. What can go wrong in both of these is a filter, and a
 * filter is testable.
 */

/** Where the athlete is in a roadmap's own structure. */
export type RoadmapMilestone = {
  /** 1-based, counting the curriculum's phases in array order. */
  number: number;
  /** How many the roadmap has, so the caller can say "3 of 11". */
  of: number;
  /** The phase's authored title — "Mount: get out, then hold". */
  title: string;
};

/**
 * The milestone the next step falls in, or null when there is no such thing.
 *
 * **"Milestone" is a PHASE**, which is what the athlete counts when they scroll
 * the roadmap screen, and it is the vocabulary the authored curricula already
 * use ("Milestones complete from what you log live"). It does not collide with
 * `lib/milestones.ts`: that module's rungs are streak congratulations and never
 * say the word on screen — their labels are "A month, unbroken" and friends.
 *
 * Null in three genuinely different situations, and all three are the caller's
 * to phrase rather than this module's to paper over:
 *
 *  - **The roadmap has no phases.** Every curriculum predating phases is
 *    legally unphased, so this is not a defect. (Handled by the range check,
 *    not by an early-out — see the comment on it.)
 *  - **Nothing is left to work.** `nextStep` is null when every countable item
 *    is mastered, and "Milestone 11 of 11" for a finished roadmap would be a
 *    position in something that is over.
 *  - **The next step is unphased, or points outside the array.** `phase` is an
 *    index into `phases` by contract, and a dangling one has to read as "no
 *    milestone" rather than as milestone zero — the same fallback
 *    `groupByPhase` makes for the same reason.
 *
 * It is keyed on `nextStep`, NOT on the first unmastered item, and the
 * difference is load-bearing: a phase's reading items carry no criteria and
 * nothing can ever complete them, so counting them would pin an athlete to a
 * milestone they had actually finished. That is `countable_items` versus
 * `item_count` again, one level up.
 */
export function roadmapMilestone(c: Curriculum): RoadmapMilestone | null {
  const phases = c.phases ?? [];
  const next = nextStep(c);
  if (next === null) return null;

  // ONE range check, deliberately, and it subsumes the empty-phases case: on a
  // curriculum with no phases every index is out of range, so `i >= 0 &&
  // i < phases.length` is already false and there is nothing a separate
  // `phases.length === 0` early-out could reject that this does not. It was
  // written with both; mutation-testing found the first one survived deletion,
  // which is the definition of dead code and exactly the reading a redundant
  // guard invites.
  const i = next.phase;
  if (i === null || i < 0 || i >= phases.length) return null;

  return { number: i + 1, of: phases.length, title: phases[i].title };
}

/**
 * The one roadmap to offer an athlete who is on none, or null.
 *
 * `null` in, `null` out, and that is the whole reason this takes a nullable:
 * Today holds its lists as `null` until read precisely so that an offline read
 * is never mistaken for a fact about the athlete. An offer rendered from an
 * unknown list is a claim that they are on no roadmap, which is the same
 * mistake `refreshRoadmaps` documents itself avoiding.
 *
 * Three filters, and each one has already been a bug somewhere in this app:
 *
 *  - **`roadmapCurricula` decides eligibility**, never a hand-rolled predicate
 *    here. It is the function that knows a roadmap is `track` belt-or-
 *    foundations AND `official` — and `official` is the fix for F7, where a
 *    stranger publishing with `track: "belt"` and `belt: "white"` appeared
 *    wearing a belt word. An offer card is a stronger endorsement than a strip
 *    tile, so this is the last place to re-derive that by hand.
 *  - **Never one they are already on.** The caller only reaches this with an
 *    empty working list, but the working list excludes an enrollment with
 *    nothing completable in it, so the two can legitimately disagree.
 *  - **Never one with no countable items.** The card promises progress from
 *    logged sessions; a curriculum whose items carry no criteria completes
 *    nothing, and offering one is the reading-list-as-roadmap confusion that
 *    `countable_items` exists to prevent.
 *
 * Order comes from `roadmapCurricula`: foundations first — the authored entry
 * point, and the shortest — then the belts by rank. So a first-time athlete is
 * offered the beginner track rather than whichever row sorted first.
 */
export function roadmapToOffer(curricula: Curriculum[] | null): Curriculum | null {
  if (curricula === null) return null;
  return (
    roadmapCurricula(curricula).find((c) => !c.enrolled && c.countable_items > 0) ?? null
  );
}
