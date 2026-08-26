import type { Proficiency } from './proficiency';
import type { Tag } from './bjjSession';

/**
 * The four-step reading `docs/decisions/bjj-tracking-design.md` calls the
 * technique funnel — taught → drilled → attempted-live → hit-live — collapsed
 * into one label a reflection screen can put next to a name.
 *
 * **Evidence, not a rating.** Same rule as everywhere else in this module:
 * nobody scores a technique 1–5, a state is read off the counts the athlete
 * already produced by drilling and rolling. `seen` is the floor — the library
 * knows the technique exists and nothing has been recorded yet — and each
 * later state requires strictly more than the one before it.
 */
export type LearningState = 'seen' | 'drilled' | 'live' | 'reliable';

export const LEARNING_STATE_LABEL: Record<LearningState, string> = {
  seen: 'Seen',
  drilled: 'Drilled',
  live: 'Used live',
  reliable: 'Reliable',
};

/** Total order, low to high — what lets two independent readings be combined
 *  by taking the better one rather than by adding them (see below). */
const RANK: Record<LearningState, number> = { seen: 0, drilled: 1, live: 2, reliable: 3 };

/**
 * Landed live, three separate times, is where "I can do this" stops being
 * hope and starts being a pattern. Not nine — that bar belongs to
 * `suggestion.ts`'s statistical gate over an *absence*; this is a positive
 * claim about a presence, and three repeated hits is already a real signal a
 * training log did not have before. A product call, not a derived constant —
 * see `suggestion.ts`'s own note on `MIN_DRILLED` for why that distinction is
 * worth keeping explicit.
 */
export const RELIABLE_MIN_SCORED = 3;

type Counts = Pick<Proficiency, 'drilled' | 'attempted' | 'scored'>;

/**
 * The state one technique's accumulated counts justify on their own.
 *
 * Mirrors `Proficiency.Tried()` on the backend: `attempted` and `scored` are
 * DISJOINT (attempted is "went for it and it did not land"), so their sum —
 * not `attempted` alone — is what "taken live at all" means.
 */
export function learningStateOfCounts(counts: Counts | null | undefined): LearningState {
  if (!counts) return 'seen';
  if (counts.scored >= RELIABLE_MIN_SCORED) return 'reliable';
  if (counts.attempted + counts.scored > 0) return 'live';
  if (counts.drilled > 0) return 'drilled';
  return 'seen';
}

/**
 * The state THIS SESSION'S own (not-yet-necessarily-synced) tags alone would
 * justify for one technique — reading only the rows belonging to `detail.tags`
 * on the reflection screen, never the cross-session funnel.
 */
export function sessionLearningFloor(tags: readonly Tag[], techniqueId: string): LearningState {
  let drilled = 0;
  let attempted = 0;
  let scored = 0;
  for (const t of tags) {
    if (t.technique_id !== techniqueId) continue;
    if (t.event === 'drilled') drilled += t.count;
    else if (t.event === 'attempted') attempted += t.count;
    else if (t.event === 'scored') scored += t.count;
  }
  return learningStateOfCounts({ drilled, attempted, scored });
}

/**
 * The state to SHOW on the reflection screen: the better of what the
 * cross-session funnel already knows (`proficiency`, from `GET
 * /v1/bjj/proficiency`) and what this session's own tags alone would justify.
 *
 * **The MAX of the two readings, deliberately never their SUM.** Summing would
 * double-count a technique whose tags from THIS session have already reached
 * the server: reopening an already-reflected-and-synced session and looking at
 * a technique added last time would add its local tag counts on top of a
 * funnel total that already includes them. Taking the max is safe in both
 * directions — a brand-new session (nothing synced yet) reads its state off
 * the local floor since the funnel cannot see it yet, and an old, synced
 * session reads it off the funnel since that already dominates. Neither path
 * inflates a count that already exists on the server.
 */
export function displayLearningState(
  proficiency: ReadonlyMap<string, Counts>,
  tags: readonly Tag[],
  techniqueId: string | null | undefined,
): LearningState {
  if (!techniqueId) return 'seen';
  const server = learningStateOfCounts(proficiency.get(techniqueId));
  const local = sessionLearningFloor(tags, techniqueId);
  return RANK[local] > RANK[server] ? local : server;
}
