import type { BeltKey } from '@/constants/Colors';

import type { Curriculum, CurriculumItem } from './curriculum';
import { groupByPhase } from './curriculumPhases';

/**
 * Everything the roadmap screen draws, derived from one curriculum.
 *
 * **In a module because the screen cannot be tested and this can.** The
 * roadmap redesign's last blocking finding was a display state derived from
 * the wrong field, sitting in the screen file where no test could reach it —
 * `lib/curriculumRow.ts` was split out for exactly that reason and this is the
 * same split, one level up. Everything here is a pure function of the payload.
 *
 * Three properties are load-bearing and each carries a test:
 *
 *  1. **Progress is DERIVED, every time.** `mastered` on an item is the
 *     server's reading of the athlete's own event stream; nothing here stores,
 *     caches or accepts a completion figure. Migration 000034 is explicit that
 *     there is deliberately no way to mark a technique mastered by hand, so a
 *     roadmap screen that offered a checkbox would be offering something the
 *     database refuses.
 *  2. **A milestone with nothing completable in it has NO progress — not 0%.**
 *     Concepts carry no criteria by design (a purple belt is mostly concepts,
 *     and two of its ten milestones are entirely so), and 0% on a milestone
 *     that can never move reads as failure rather than as "there is nothing to
 *     count here".
 *  3. **A lesson says how it is MEASURED.** That is the only honest answer at
 *     the level where an athlete asks "what do I have to do", and it is what
 *     replaces the checkbox the data model will not give them.
 */

/** One threshold, in the words an athlete would use for it. */
export type Measure = {
  /** "Landed live", "Classes drilled in" — the axis, not the number. */
  label: string;
  /** What it takes: "12", "30%". */
  need: string;
  /** Where they are, or null when not enrolled — nothing is being counted. */
  have: string | null;
  /** Cleared. Only ever true when enrolled, since `have` is the evidence. */
  met: boolean;
};

export type Lesson = {
  /** Stable within one curriculum: technique id, or `c<order>` for a concept. */
  key: string;
  kind: 'technique' | 'concept';
  /** Null on a concept — an idea points at nothing in the library. */
  techniqueID: string | null;
  name: string;
  notes: string;
  /**
   * Null when nothing measures this — a concept, or a technique carrying no
   * criteria. The screen reads null as *understand this*, never as an
   * unfinished measurable.
   */
  measures: Measure[] | null;
  mastered: boolean;
  /** Any evidence at all, including drilling. Weaker than any criterion. */
  started: boolean;
  /**
   * Why the numbers above have not moved, when the athlete HAS logged
   * something this item's criteria do not read. Null when there is nothing to
   * explain — no evidence, or evidence that already shows up as a measure.
   *
   * **This is the whole of N122's display half.** `drilled_sessions` arrives on
   * every item, and `measuresOf` draws it only where a drilled criterion reads
   * it — so on the 61 of 81 white-belt items measured on live rounds, an
   * athlete who had drilled a technique in ten classes saw ten classes of
   * evidence rendered as nothing, under a state line reading "Under way — your
   * record has evidence for this". Both statements were true and together they
   * read as a broken counter, which is what was reported.
   *
   * The honest answer at this level is #446's: say what WOULD count. Not a
   * checkbox, and not a softened threshold — the criteria are unchanged and
   * mastery stays derived.
   */
  evidenceNote: string | null;
};

export type Milestone = {
  /** 1-based, and it is the athlete's own numbering — "Milestone 3 of 11". */
  index: number;
  title: string;
  description: string;
  lessons: Lesson[];
  /** How many of `lessons` anything can complete. */
  countable: number;
  mastered: number;
  /** 0–1, or **null** when `countable` is 0. See property 2 above. */
  progress: number | null;
  /** Every countable lesson mastered. False when there are none to master. */
  complete: boolean;
};

export type RoadmapView = {
  /** "WHITE BELT" — the wide-tracked line at the top. */
  title: string;
  /** One line under the belt mark: "Learn the basic game". */
  thesis: string;
  /** The author's whole rationale, revealed when the header is expanded. */
  description: string;
  /** What the athlete will have. Drives the completion card's sentence. */
  goal: string;
  /** Null for an athlete's own list, which belongs to no belt. */
  beltKey: BeltKey | null;
  milestones: Milestone[];
  /** Milestones with at least one completable lesson — the ring's denominator. */
  countableMilestones: number;
  completedMilestones: number;
  /** 0–1 over `countableMilestones`, or null when none of them count. */
  progress: number | null;
};

const BELT_KEYS: Record<string, BeltKey> = {
  white: 'white',
  blue: 'blue',
  purple: 'purple',
  brown: 'brown',
  black: 'black',
};

export function beltKeyOf(c: Pick<Curriculum, 'belt'>): BeltKey | null {
  return (c.belt !== null && BELT_KEYS[c.belt]) || null;
}

/**
 * The wide-tracked line at the top.
 *
 * From the BELT rather than the name, because the name is a sentence — "White
 * belt: learn the basic game" — and the design's most distinctive type
 * treatment is two words in caps. A curriculum belonging to no belt keeps its
 * own name, which is the only thing that identifies it.
 */
export function titleOf(c: Pick<Curriculum, 'belt' | 'name'>): string {
  const key = beltKeyOf(c);
  return key ? `${key} belt`.toUpperCase() : c.name.toUpperCase();
}

/**
 * The one line under the belt mark.
 *
 * The tail of the name, which every authored curriculum writes as exactly this
 * — "White belt: **learn the basic game**". It is not invented copy and it is
 * not the description's first sentence, which is the *goal* and is wanted by
 * the completion card at the other end of the screen. A name with no colon
 * falls back to that goal rather than to nothing.
 */
export function thesisOf(c: Pick<Curriculum, 'name' | 'description'>): string {
  const colon = c.name.indexOf(':');
  if (colon >= 0) {
    const tail = c.name.slice(colon + 1).trim();
    if (tail !== '') return tail.charAt(0).toUpperCase() + tail.slice(1);
  }
  return goalOf(c);
}

/**
 * What the athlete will have when this is done — the completion card's line.
 *
 * The first sentence of the description, which every authored curriculum opens
 * with "Goal: …". The prefix is stripped because the card already says what it
 * is; leaving it in gives "White belt complete / Goal: understand…", which
 * reads as an aspiration rather than as an outcome.
 */
export function goalOf(c: Pick<Curriculum, 'description'>): string {
  const first = firstSentence(c.description);
  const m = /^goal:\s*/i.exec(first);
  if (!m) return first;
  const rest = first.slice(m[0].length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * Up to the first sentence terminator followed by a space.
 *
 * Deliberately not a split on every `.`: the descriptions contain "A-game",
 * decimals and arrows, and a naive split truncates mid-clause. A description
 * with no terminator at all is returned whole rather than emptied.
 */
function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim());
  return (m ? m[0] : text.trim()).trim();
}

/**
 * Every threshold on one item, as measures.
 *
 * Returns **null**, not `[]`, when nothing measures the item. The two are
 * different claims — "no criteria" is a fact about the content, "no thresholds
 * met" would be a fact about the athlete — and collapsing them is how a
 * concept ends up drawn as an unfinished technique.
 *
 * `have` is null for someone not enrolled, matching `criteriaChips`: counting
 * starts the day you enrol, so zero-filling would report a shortfall nobody
 * asked them to make up.
 */
export function measuresOf(item: CurriculumItem, enrolled: boolean): Measure[] | null {
  const c = item.criteria;
  if (item.kind === 'concept' || c === null) return null;
  const p = item.progress;
  const out: Measure[] = [];

  const volume = (label: string, have: number | undefined, need: number) => {
    const got = have ?? 0;
    out.push({
      label,
      need: String(need),
      have: enrolled ? String(got) : null,
      met: enrolled && got >= need,
    });
  };

  if (c.target_scored !== null) volume('Landed live', p?.scored, c.target_scored);
  if (c.target_defended !== null) volume('Stopped theirs', p?.defended, c.target_defended);
  if (c.target_sessions !== null) volume('Separate live sessions', p?.sessions, c.target_sessions);
  if (c.target_drilled_sessions !== null)
    volume('Classes drilled in', p?.drilled_sessions, c.target_drilled_sessions);

  if (c.min_hit_rate !== null) {
    const need = Math.round(c.min_hit_rate * 100);
    // `—`, never `0%`, exactly as `criteriaChips` argues: zero from zero is not
    // a rate, and the API sends null so a client cannot report a failure the
    // athlete has not had.
    const have = p?.hit_rate == null ? null : Math.round(p.hit_rate * 100);
    out.push({
      label: 'Hit rate',
      need: `${need}%`,
      have: enrolled ? (have === null ? '—' : `${have}%`) : null,
      met: enrolled && have !== null && have >= need,
    });
  }

  // An item whose criteria object carries nothing but nulls is not measurable
  // either, and it must take the concept path rather than draw an empty list.
  return out.length > 0 ? out : null;
}

/**
 * What this item's criteria would accept, in the words an athlete would use.
 *
 * Built from the criteria rather than written per curriculum, so it cannot
 * disagree with the thresholds beside it. The schema's
 * `curriculum_items_criteria_anchored` guarantees at least one of scored,
 * defended and drilled — but the fallback is here anyway rather than relying on
 * a constraint in another file, the same argument `Met` makes for its rate
 * branch.
 */
function whatWouldCount(c: NonNullable<CurriculumItem['criteria']>): string {
  if (c.target_scored !== null && c.target_defended !== null)
    return 'land it in a live round, or stop theirs';
  if (c.target_scored !== null) return 'land it in a live round';
  if (c.target_defended !== null) return 'stop theirs in a live round';
  return 'use it in a live round';
}

/**
 * The sentence that reconciles "you have logged this" with "these read zero".
 *
 * Returns null in every case where there is nothing to reconcile, and the
 * cases are worth naming because each is a claim this must NOT make:
 *
 *  - not enrolled — nothing is being counted at all, which the screen says
 *    once at the top rather than 93 times;
 *  - no criteria — a concept, and a concept is not a measurable that failed;
 *  - a drilled criterion WITH some drilled evidence — drilling counts here
 *    and `measuresOf` already draws it as "Classes drilled in", so an
 *    explanation would contradict the number directly above it;
 *  - no drilled evidence AND no live evidence either — there is nothing the
 *    athlete did that we are failing to show, and inventing a shortfall is
 *    what `have: null` exists to avoid.
 *
 * Note it is deliberately reported even when live evidence EXISTS. "Landed
 * live 2 / 12, drilled in 9 classes" is the athlete's real position, and
 * hiding the drilling once a single round has happened would make the note
 * flicker away at the moment it starts being encouraging.
 *
 * ## The drilled-criterion / live-only case (N206)
 *
 * A drilled criterion with ZERO drilled evidence but non-zero live evidence
 * (`scored`/`attempts`/`defended`) is not "nothing to reconcile" — it is the
 * one case this function most needs to cover. `bumpTechniqueOutcome` now
 * backfills a `drilled` tag itself, so this should be rare going forward, but
 * it still applies to sessions logged before that fix synced, and it is a
 * cheap second line of defence if another path ever bypasses the backfill.
 * Without it, the athlete sees a bare "0/6" beside a class they know they
 * logged, with nothing explaining why.
 */
export function evidenceNoteOf(item: CurriculumItem, enrolled: boolean): string | null {
  const c = item.criteria;
  const p = item.progress;
  // `item.kind === 'concept'` is checked HERE and not left to `c === null`,
  // for the reason `measuresOf` states one function up: a concept carries no
  // criteria BY DESIGN, and leaning on that makes this correct only while the
  // schema's `curriculum_items_kind_shape` holds. The docstring above promises
  // a concept is never explained; this is that promise being kept in code
  // rather than borrowed from a constraint in another file.
  if (!enrolled || item.kind === 'concept' || c === null || p == null) return null;
  if (c.target_drilled_sessions !== null) {
    if (p.drilled_sessions > 0) return null;
    if (p.scored <= 0 && p.attempts <= 0 && p.defended <= 0) return null;
    return 'You have live evidence for this, but it counts classes drilled — log it on "What did you drill?" to move it.';
  }
  if (p.drilled_sessions <= 0) return null;
  const classes = p.drilled_sessions === 1 ? '1 class' : `${p.drilled_sessions} classes`;
  return `Drilled in ${classes}. Drilling is not counted here — to move this one, ${whatWouldCount(c)}.`;
}

/** Any evidence at all — the same rule `hasEvidence` states, over one item. */
function startedOf(item: CurriculumItem): boolean {
  const p = item.progress;
  return (
    p != null && (p.attempts > 0 || p.defended > 0 || p.sessions > 0 || p.drilled_sessions > 0)
  );
}

/**
 * The whole screen, derived.
 *
 * Milestones are the curriculum's phases, in array order — the same arithmetic
 * `roadmapMilestone` does from the other end, so "Milestone 3 of 11" on Today
 * names the third card here. Items nobody assigned to a phase come first and
 * are numbered with the rest, because `groupByPhase` puts them first and
 * burying them is how they silently vanish.
 */
export function buildRoadmap(c: Curriculum): RoadmapView {
  const groups = groupByPhase(c.phases ?? [], c.items ?? []);

  const milestones = groups.map((g, i): Milestone => {
    const lessons = g.items.map((item): Lesson => {
      const measures = measuresOf(item, c.enrolled);
      return {
        key: item.technique_id ?? `c${item.order}`,
        kind: item.kind,
        techniqueID: item.technique_id ?? null,
        name: item.kind === 'concept' ? (item.title ?? item.name) : item.name,
        notes: item.notes,
        measures,
        mastered: item.progress?.mastered ?? false,
        started: startedOf(item),
        evidenceNote: evidenceNoteOf(item, c.enrolled),
      };
    });
    const countable = lessons.filter((l) => l.measures !== null).length;
    const mastered = lessons.filter((l) => l.measures !== null && l.mastered).length;
    return {
      index: i + 1,
      title: g.phase?.title ?? 'Unassigned',
      description: g.phase?.description ?? '',
      lessons,
      countable,
      mastered,
      progress: countable > 0 ? mastered / countable : null,
      complete: countable > 0 && mastered === countable,
    };
  });

  // Milestones with nothing to complete are out of BOTH halves of the fraction.
  // Counting them in the denominator caps a purple belt at 80% forever; counting
  // them as complete claims the athlete did something they never could.
  const countableMilestones = milestones.filter((m) => m.progress !== null).length;
  const completedMilestones = milestones.filter((m) => m.complete).length;

  return {
    title: titleOf(c),
    thesis: thesisOf(c),
    description: c.description,
    goal: goalOf(c),
    beltKey: beltKeyOf(c),
    milestones,
    countableMilestones,
    completedMilestones,
    progress: countableMilestones > 0 ? completedMilestones / countableMilestones : null,
  };
}

/** `0.34` → `34`. Rounded DOWN off both ends, so a roadmap is never reported
 *  finished or unstarted while it is neither. */
export function percent(fraction: number): number {
  const raw = fraction * 100;
  if (raw > 0 && raw < 1) return 1;
  if (raw < 100 && raw > 99) return 99;
  return Math.round(raw);
}
