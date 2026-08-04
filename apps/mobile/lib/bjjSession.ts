import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * The BJJ half of a session — client half of `internal/modules/bjj`'s session
 * files.
 *
 * A BJJ session is an ordinary session (`sport: 'bjj'`) plus this. The split
 * is not cosmetic: keeping the session row where every other sport's lives is
 * what makes mat time show up in training history, the consistency grid and
 * the cross-sport load picture instead of in a corner of the app labelled
 * BJJ.
 */

/** What the session actually was. */
export type Kind = 'class' | 'drilling' | 'positional' | 'rolling';

export const KINDS: {
  key: Kind;
  label: string;
  /** One line on what this is, shown under the label on the picker. */
  blurb: string;
}[] = [
  { key: 'class', label: 'Class', blurb: 'Taught session' },
  { key: 'drilling', label: 'Drilling', blurb: 'Reps with a partner' },
  { key: 'positional', label: 'Positional', blurb: 'Live from a start' },
  { key: 'rolling', label: 'Rolling', blurb: 'Free sparring' },
];

/**
 * What kind of action a tag records.
 *
 * Six, and only the six with a genuine symmetric opposite — you can hit a
 * sweep or be swept, but "transition" has no other side, so offering it would
 * put an unanswerable cell in a grid whose whole point is symmetry.
 */
export type Category = 'submission' | 'sweep' | 'pass' | 'escape' | 'takedown' | 'control';

/**
 * The outcome direction.
 *
 * `drilled → attempted → scored` is the technique funnel; `conceded` is the
 * symmetric half and the one that answers "where do I keep getting stuck".
 */
export type Event = 'drilled' | 'attempted' | 'scored' | 'conceded';

/**
 * The live grid, as rendered: one row per category, a scored column and a
 * conceded column. The labels are deliberately the words a grappler uses —
 * "got swept", not "sweep conceded" — because the grid has to be read at a
 * glance by someone who just came off the mat.
 */
/**
 * Five rows, not the full six categories: `control` is accepted by the API
 * but deliberately absent here.
 *
 * The other five are discrete events you can count — you hit a submission,
 * you got passed. Control is a *state* with a duration; "how many times did
 * you hold side control" is not a question a grappler can answer, and a
 * counter that invites a meaningless number is worse than no row. The
 * category stays in the vocabulary because position-time is a real thing to
 * record later, just not with a +/- button.
 */
export const LIVE_ROWS: { category: Category; label: string; scored: string; conceded: string }[] = [
  { category: 'submission', label: 'Submissions', scored: 'Hit', conceded: 'Caught in' },
  { category: 'sweep', label: 'Sweeps', scored: 'Swept them', conceded: 'Got swept' },
  { category: 'pass', label: 'Passes', scored: 'Passed', conceded: 'Got passed' },
  { category: 'escape', label: 'Escapes', scored: 'Escaped', conceded: 'Stayed stuck' },
  { category: 'takedown', label: 'Takedowns', scored: 'Took down', conceded: 'Taken down' },
];

/** Library category → tag vocabulary. Anything without a symmetric opposite
/** Library category → tag vocabulary. Anything without a symmetric opposite
 *  lands in `control`, which is honest rather than inventing a seventh. */
export function toCategory(libraryCategory: string): Category {
  switch (libraryCategory) {
    case 'Submission':
      return 'submission';
    case 'Sweep':
      return 'sweep';
    case 'Pass':
      return 'pass';
    case 'Escape':
      return 'escape';
    case 'Takedown':
      return 'takedown';
    default:
      return 'control';
  }
}

/** "Half Guard - Bottom" → "Half Guard". Mirrors the Library's own family
 *  matching so a tag and a filter chip mean the same thing. */
export function familyOf(position: string): string {
  const family = POSITIONS.find((p) => position === p || position.startsWith(`${p} - `));
  return family ?? '';
}

/**
 * Anything that can name a technique and supply its tag-vocabulary category
 * and position. A drilled `Tag` satisfies it; so does a focus entry once
 * `toCategory`/`familyOf` have been applied.
 */
export type TechniqueRef = Pick<Tag, 'technique_id' | 'category' | 'position'>;

/**
 * The live outcomes a technique can have, and the middle of the funnel.
 *
 * `drilled → attempted → scored` was designed into the schema from the first
 * migration, and for a long time only the first stage was captured: the live
 * grid records category+position with no technique, and NOTHING ever produced
 * an `attempted` row at all. So the drop-off the whole design calls the most
 * actionable number in the sport could not be computed.
 *
 * These two counters are the missing middle. They live on the LIVE STEP, one
 * row per focus technique, beside the category grid — not on the drilled step,
 * where an earlier version put them and created a second place to record the
 * same event. The focus list is what makes that affordable: it names three to
 * five techniques up front, so recording one costs a tap instead of a search
 * through 466 library entries.
 *
 * ATTEMPTED AND SCORED ARE DISJOINT, which the labels have to carry or the
 * numbers mean nothing. `attempted` is "went for it and it did not land" (see
 * the migration's own wording), not "total tries". Went for it four times and
 * hit one is `attempted: 3, scored: 1` — so attempts + scores is how often you
 * went for it, and scored/(attempted+scored) is the hit rate.
 */
export const FUNNEL_OUTCOMES: { event: Extract<Event, 'attempted' | 'scored'>; label: string }[] = [
  { event: 'attempted', label: 'Tried' },
  { event: 'scored', label: 'Landed' },
];

/**
 * How many live outcomes of one kind are recorded against a technique.
 *
 * The mirror of `tagCount` for the funnel: that one deliberately EXCLUDES
 * technique-tagged rows because the CATEGORY GRID cannot edit them, and this
 * one counts only technique-tagged rows for the same reason in reverse. Both
 * grids are on the live step now, so the distinction is between the two
 * halves of that screen rather than between two screens. The two
 * partition the tag list between them, so no event is displayed twice and
 * every displayed event has a control that can change it.
 */
export function techniqueOutcomeCount(
  tags: Tag[],
  techniqueID: string | null | undefined,
  event: Event,
): number {
  if (!techniqueID) return 0;
  return tags
    .filter((t) => t.technique_id === techniqueID && t.event === event)
    .reduce((n, t) => n + t.count, 0);
}

/**
 * Add or take back one live outcome for a technique that was drilled.
 *
 * The new row inherits `category` and `position` from the SOURCE rather than
 * recomputing them. The source is whichever row named the technique — a
 * drilled tag, or a focus entry translated into the tag vocabulary. Two reasons, and the second is the one that bites:
 * the funnel only joins if both ends agree on the position, and `familyOf()`
 * returns `''` for a family the hardcoded POSITIONS list has fallen behind on
 * — so deriving it twice could put the drilled row under "Half Guard" and the
 * attempted row under nothing, splitting one technique's evidence in half
 * with no error anywhere.
 */
export function bumpTechniqueOutcome(
  tags: Tag[],
  source: TechniqueRef,
  event: Extract<Event, 'attempted' | 'scored'>,
  delta: number,
): Tag[] {
  const techniqueID = source.technique_id;
  if (!techniqueID) return tags;

  const next = [...tags];
  const i = next.findIndex((t) => t.technique_id === techniqueID && t.event === event);
  if (i === -1) {
    if (delta < 0) return tags;
    next.push({
      category: source.category,
      event,
      position: source.position,
      technique_id: techniqueID,
      count: delta,
    });
    return next;
  }
  const count = next[i].count + delta;
  if (count <= 0) next.splice(i, 1);
  else next[i] = { ...next[i], count };
  return next;
}

/**
 * Drop a technique from the drilled list — and ONLY that.
 *
 * This used to take the technique's `attempted`/`scored` rows with it, which
 * was right while the drilled step owned the counters: leaving them behind
 * stranded evidence with no control able to edit it. Live outcomes now come
 * from the live step's focus rows, which are reachable whether or not the
 * technique was drilled today, so nothing is stranded — and "I did not
 * actually drill this" and "I did not hit this live" became different
 * statements. Un-saying one must not un-say the other.
 */
export function removeDrilledTechnique(tags: Tag[], techniqueID: string | null | undefined): Tag[] {
  // A nullish id matches every UNTAGGED row, and the API sends
  // `"technique_id": null` on every one of them (the Go field has no
  // omitempty). Without this guard, removing a drilled row that has lost its
  // technique — a state `ON DELETE SET NULL` is designed to produce when a
  // technique is retired — deletes the whole live grid's "You" column, and
  // `PUT /bjj/sessions/{id}` replaces the tag set wholesale, so it syncs.
  if (!techniqueID) return tags;
  // ONLY the drilled row now.
  //
  // It used to take `attempted` and `scored` with it, and that was right while
  // the drilled step was the only place they could be authored — leaving them
  // behind stranded evidence with no control to edit it. Live outcomes now come
  // from the focus rows in the live step, which are reachable whether or not
  // the technique was drilled today. So "I did not actually drill this" and "I
  // did not hit this live" are different statements, and un-saying one must not
  // un-say the other.
  return tags.filter((t) => !(t.technique_id === techniqueID && t.event === 'drilled'));
}

/**
 * Position families, matching the technique library's own filter granularity
 * so a tag and a library filter mean the same thing by the same name.
 *
 * Keep this in step with the glossary's families. It is a hardcoded list
 * rather than a fetch because the reflection wizard has to work with no
 * signal, but that also means it can silently fall behind — when leg
 * entanglement became its own position in the library, this list still
 * offered only the seven it had, so "got swept from 50/50" had nowhere to go.
 * North-South was missing for the same reason and is added here too — the
 * wizard's familyOf() returns '' on no match, so a technique in an unlisted
 * family records a tag with no position at all, silently.
 */
export const POSITIONS = [
  'Guard',
  'Half Guard',
  'Side Control',
  'Mount',
  'Back',
  'Leg Entanglement',
  'North-South',
  'Turtle',
  'Standing',
] as const;

export type Tag = {
  category: Category;
  event: Event;
  /** Position family, or '' when the athlete didn't say. */
  position: string;
  technique_id?: string | null;
  count: number;
};

export type SessionDetail = {
  kind: Kind;
  /** null is "didn't say", which is not the same as no-gi. */
  gi: boolean | null;
  rounds: number | null;
  round_minutes: number | null;
  session_rpe: number | null;
  academy: string;
  note: string;
  body_note: string;
  tags: Tag[];
};

export const MAX_RPE = 10;

/**
 * How the RPE number reads back in words.
 *
 * A bare 1-10 is a number people calibrate differently every time; the label
 * is what makes today's 7 the same 7 as last week's. Boundaries follow the
 * Foster scale the load currency is built on.
 */
export function describeRPE(rpe: number): string {
  if (rpe <= 2) return 'Very easy';
  if (rpe <= 4) return 'Easy';
  if (rpe <= 6) return 'Moderate';
  if (rpe <= 7) return 'Hard';
  if (rpe <= 9) return 'Very hard';
  return 'All out';
}

/** Blank reflection for a kind, used as the starting point of a new log. */
export function emptyDetail(kind: Kind): SessionDetail {
  return {
    kind,
    gi: null,
    rounds: null,
    round_minutes: null,
    session_rpe: null,
    academy: '',
    note: '',
    body_note: '',
    tags: [],
  };
}

/**
 * Sparring volume in minutes, or 0 when rounds weren't recorded.
 *
 * Deliberately NOT the session's duration — that is `ended_at - started_at`
 * and stays the authority for load. This is the harder subset of it, which is
 * what "hard rounds this week" is actually asking about.
 */
export function rollingMinutes(d: Pick<SessionDetail, 'rounds' | 'round_minutes'>): number {
  if (!d.rounds || !d.round_minutes) return 0;
  return d.rounds * d.round_minutes;
}

/** A one-line summary of a reflection, for a session row or a detail header. */
export function describeDetail(d: SessionDetail): string {
  const bits: string[] = [KINDS.find((k) => k.key === d.kind)?.label ?? d.kind];
  if (d.gi !== null) bits.push(d.gi ? 'Gi' : 'No-gi');
  const mins = rollingMinutes(d);
  if (mins > 0) bits.push(`${d.rounds}×${d.round_minutes}m rolling`);
  if (d.session_rpe) bits.push(`RPE ${d.session_rpe}`);
  return bits.join(' · ');
}

/**
 * Total tag count for one cell of the live grid.
 *
 * Counts rather than rows: three armbars is one tag with count 3, so summing
 * `count` is the only correct way to read a cell.
 */
/**
 * How many of `category`/`event` are recorded, optionally scoped to one
 * position.
 *
 * The scoped form is what the live grid displays, and it has to be: the
 * +/- buttons only ever edit the row matching the currently selected
 * position, so an unscoped total would show a number the minus button
 * refuses to decrement — the athlete taps minus, nothing moves, and there
 * is no way to tell why. Pass the position to keep display and control
 * describing the same row.
 */
export function tagCount(
  tags: Tag[],
  category: Category,
  event: Event,
  position?: string,
): number {
  return tags
    .filter(
      (t) =>
        t.category === category &&
        t.event === event &&
        // Technique-tagged rows belong to the drilled step, not this grid.
        // `bump` already refuses to touch them; counting them here would
        // reintroduce the same mismatch the position argument exists to
        // fix, just on the other axis — a number long-press won't move.
        // Nothing in this app can currently produce a scored/conceded tag
        // with a technique, but the API accepts one, so a reflection
        // authored elsewhere and read back would hit it.
        !t.technique_id &&
        (position === undefined || t.position === position),
    )
    .reduce((n, t) => n + t.count, 0);
}

export function putDetail(
  getToken: TokenGetter,
  sessionID: string,
  detail: SessionDetail,
): Promise<{ detail: SessionDetail }> {
  return apiRequest<{ detail: SessionDetail }>(
    getToken,
    `/bjj/sessions/${encodeURIComponent(sessionID)}`,
    { method: 'PUT', body: JSON.stringify(detail) },
  );
}

export function getDetail(
  getToken: TokenGetter,
  sessionID: string,
): Promise<{ detail: SessionDetail }> {
  return apiRequest<{ detail: SessionDetail }>(
    getToken,
    `/bjj/sessions/${encodeURIComponent(sessionID)}`,
  );
}
