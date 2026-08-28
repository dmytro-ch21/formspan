import { nextStep, type Curriculum, type CurriculumItem } from './curriculum';
import { roadmapMilestone } from './roadmapEntry';
import { MAX_AGE_DAYS, MIN_DRILLED } from './suggestion';
import type { Proficiency } from './proficiency';

/**
 * The payoff for the roadmap rework (#447) — what a scheduled BJJ class on
 * Today says beneath the log entry point: the roadmap's current focus, and up
 * to two roadmap steps worth trying tonight, each with a reason.
 *
 * ## Why this file, and not `curriculum.ts` or `suggestion.ts`
 *
 * `curriculum.go`'s own doc comment is explicit: "It is deliberately NOT a
 * suggestion engine. Following a curriculum says what you intend to learn;
 * the suggestion tiers in the mobile app say what your logs report about how
 * it is going." Folding evidence-reading into `lib/curriculum.ts` would put
 * exactly that shortcut on the client instead of the server, which is not an
 * improvement. And `lib/suggestion.ts`'s `funnelGap` is deliberately
 * roadmap-blind — it picks the single best gap across EVERY technique with
 * evidence, with no notion of a syllabus.
 *
 * So this is a third, small file that reads both without either reading the
 * other: it takes a working roadmap's own items (structure + progress, from
 * `curriculum`) and the technique funnel (evidence + recency, from
 * `suggestion`/`proficiency`) and combines them. Same shape as
 * `roadmapFocus.ts`, which already sits outside both of the modules it
 * bridges for the identical reason.
 *
 * ## Where the evidence comes from
 *
 * A roadmap item's own `progress` (returned by `GET /v1/curricula/working`,
 * already fetched for Today's roadmap strip) carries `drilled_sessions` and
 * `attempts` (`scored + attempted`) computed against THAT item's criteria —
 * exactly the two numbers `funnelGap`'s tier-1 rule reads, just scoped to one
 * technique instead of the whole funnel. What it does NOT carry is a
 * recency timestamp, so `last_seen` is read off the funnel (`Proficiency`)
 * for the same technique id — a second read of data Today already has in
 * memory, not a second network call.
 *
 * ## Determinism
 *
 * Ranked on the roadmap's own item `order` — the syllabus's authored
 * sequence, the same value `nextStep` reads — never on drilled count or
 * recency. `funnelGap` ranks by evidence strength because it has no
 * structure to lean on; a roadmap does, and two suggestions both drawn from
 * the athlete's own syllabus should surface in the order the syllabus puts
 * them, not re-sorted by whichever has more reps. Ties (which the schema does
 * not forbid) break on `technique_id` so the answer is total.
 */

/** At most this many suggestions in one card. Tighter than `MAX_FOCUS` (5) —
 *  "a few things to try tonight" is not "your whole working set". */
export const MAX_CLASS_SUGGESTIONS = 2;

export type ClassSuggestion = {
  techniqueId: string;
  name: string;
  /** Always present, and always evidence, never a bare instruction — "you
   *  have drilled this N times and never taken it live", not "try this". */
  reason: string;
};

export type ClassFocus = {
  /** "Milestone 3 of 11 · Mount: get out, then hold", or "Next up: <name>"
   *  when the roadmap has no phases. Matches `RoadmapLine`'s own wording so
   *  the two surfaces never disagree about how to describe the same roadmap. */
  focusLine: string;
  /** Zero to `MAX_CLASS_SUGGESTIONS`. Empty is legitimate — evidence is
   *  opportunistic, not guaranteed to exist every night. */
  suggestions: ClassSuggestion[];
};

/**
 * The roadmap the class card should talk about, or null.
 *
 * `roadmaps` is Today's own `listWorkingCurricula` result, in the order the
 * roadmap strip already renders it — the first one still IN PROGRESS
 * (`nextStep` non-null) is picked, so a finished roadmap ahead of an active
 * one in the list does not silently blank the card. Evidence, when supplied,
 * is scoped to that SAME roadmap — a milestone from one syllabus paired with
 * a suggestion from another would be a false pairing.
 *
 * `evidence` is null to mean "do not compute suggestions at all" — the
 * caller's job, not this function's: Today passes null while the funnel or
 * the athlete's dismissal set has not loaded yet, and null when the athlete
 * has switched suggestions off. Either way the FOCUS line still returns,
 * because a milestone is a fact the athlete committed to, not a suggestion,
 * and does not need the suggestions toggle's permission to be stated — same
 * rule `RoadmapLine` already follows.
 *
 * Returns null — the whole card degrades — only when no working roadmap has
 * anything left to focus on. That is AC4's "no roadmap active" case, and also
 * covers a roadmap that is fully mastered: there is nothing left to state as
 * "current focus" either way.
 */
export function classFocus(
  roadmaps: readonly Curriculum[],
  evidence: { funnel: readonly Proficiency[]; dismissed: ReadonlySet<string> } | null,
  now: Date,
): ClassFocus | null {
  const roadmap = roadmaps.find((c) => nextStep(c) !== null);
  if (!roadmap) return null;
  const next = nextStep(roadmap);
  if (!next) return null; // unreachable given the find() above; keeps this total.

  const milestone = roadmapMilestone(roadmap);
  const focusLine = milestone
    ? `Milestone ${milestone.number} of ${milestone.of} · ${milestone.title}`
    : `Next up: ${next.name}`;

  return {
    focusLine,
    suggestions: evidence ? roadmapSuggestions(roadmap, evidence, now) : [],
  };
}

function roadmapSuggestions(
  roadmap: Curriculum,
  evidence: { funnel: readonly Proficiency[]; dismissed: ReadonlySet<string> },
  now: Date,
): ClassSuggestion[] {
  const byTechnique = new Map(evidence.funnel.map((f) => [f.technique_id, f]));
  const cutoff = now.getTime() - MAX_AGE_DAYS * 86_400_000;

  const eligible = (roadmap.items ?? []).filter(
    (
      i,
    ): i is CurriculumItem & {
      technique_id: string;
      progress: NonNullable<CurriculumItem['progress']>;
    } =>
      i.kind === 'technique' &&
      !!i.technique_id &&
      i.criteria !== null &&
      i.progress !== null &&
      !i.progress.mastered &&
      !evidence.dismissed.has(i.technique_id),
  );

  // The tier-1 rule from `suggestion.ts`'s `funnelGap`, applied to ONE
  // technique's own roadmap-scoped counts rather than the whole funnel:
  // drilled enough, and never taken live. `attempts` is already
  // `scored + attempted` — see `Progress`'s own field comment — so this reads
  // it the same disjoint way `funnelGap` insists on, without re-deriving it.
  const candidates = eligible.filter(
    (i) => i.progress.drilled_sessions >= MIN_DRILLED && i.progress.attempts === 0,
  );

  // Recency lives on the funnel row, not on roadmap `Progress` — see the file
  // doc comment. A candidate with no funnel row at all (should not happen:
  // `drilled_sessions > 0` implies the funnel has a row for it) is dropped
  // rather than assumed recent, because asserting recency the app cannot see
  // is exactly the unfalsifiable claim `funnelGap`'s own doc warns about.
  const recent = candidates.filter((i) => {
    const row = byTechnique.get(i.technique_id);
    if (!row) return false;
    const seen = new Date(row.last_seen).getTime();
    return Number.isFinite(seen) && seen >= cutoff;
  });

  const ordered = [...recent].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.technique_id < b.technique_id ? -1 : a.technique_id > b.technique_id ? 1 : 0;
  });

  return ordered.slice(0, MAX_CLASS_SUGGESTIONS).map((i) => ({
    techniqueId: i.technique_id,
    name: i.name,
    // No singular/plural branch: `drilled_sessions` is always >= MIN_DRILLED
    // (6) for anything that reaches here, so "1 time" can never occur — a
    // grammar branch that can never fire is exactly the dead-guard trap
    // CLAUDE.md's "verify that a check can fail" warns about.
    reason: `drilled ${i.progress.drilled_sessions} times, never live`,
  }));
}

/**
 * The one line `UpNextCard.hint` shows — see that component's own doc
 * comment, which built the slot this fills.
 *
 * A plain sentence, never a list: the slot is two lines and the card is read
 * standing up before class, not studied. Suggestions, when there are any,
 * follow the focus line so the athlete reads "where I am" before "what to
 * try" — the same order `RoadmapLine` already puts milestone before next
 * step.
 */
export function classHintText(focus: ClassFocus): string {
  if (focus.suggestions.length === 0) return focus.focusLine;
  const tips = focus.suggestions.map((s) => `${s.name} — ${s.reason}`).join('; ');
  return `${focus.focusLine}. Try: ${tips}`;
}
