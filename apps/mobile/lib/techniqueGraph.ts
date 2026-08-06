import type { TechniqueSummary } from './techniques';

/**
 * The technique library as a traversable graph.
 *
 * The library has always stored edges — `setup_from` names what a technique
 * comes from — but only in the useless direction. "What is this set up from"
 * is a question nobody asks standing in a position; "what can I do from here"
 * is the entire question, and nothing could answer it.
 *
 * So this inverts the edge once over the list a client already holds. No new
 * column, no authoring: 495 of the 542 techniques are already touched by
 * `setup_from`, and its hubs are exactly the control positions — Seatbelt
 * Back Control has 18 techniques hanging off it, De La Riva Guard Control 11.
 * The graph was there; it just could not be walked.
 *
 * Deliberately client-side, matching how `function` and the position
 * cross-link already work: the summaries are fetched once and cached, so a
 * traversal costs no request and works with no signal — which is where this
 * gets used.
 */

/** Edges keyed by the id of the technique they lead FROM. */
export type TechniqueGraph = {
  /** techniqueId -> techniques that name it in their `setup_from`. */
  follows: Map<string, TechniqueSummary[]>;
  /**
   * Edges naming something the library does not contain.
   *
   * ~16% of `setup_from` values are concepts rather than techniques —
   * "Underhook", "Crossface", "Hand fight". They are the mechanic vocabulary
   * and will become their own nodes eventually; counted here so a caller can
   * report honest coverage rather than silently presenting a partial graph as
   * a complete one.
   */
  unresolved: number;
};

/**
 * Build the reverse index.
 *
 * Names, not ids: `setup_from` stores display names, and the library carries
 * aliases ("kesa gatame" for "Scarf Hold"), so both are indexed. A name
 * matching two techniques resolves to the first — the seed validates ids for
 * uniqueness but not names, so this cannot throw.
 *
 * O(n + e) over ~542 nodes and ~658 edges. Build it once per list, not per
 * render.
 */
export function buildTechniqueGraph(techniques: TechniqueSummary[]): TechniqueGraph {
  const byName = new Map<string, TechniqueSummary>();
  for (const t of techniques) {
    if (!byName.has(t.name)) byName.set(t.name, t);
  }
  // Aliases second, so a real name always wins over another entry's alias.
  for (const t of techniques) {
    for (const a of t.aliases ?? []) {
      if (!byName.has(a)) byName.set(a, t);
    }
  }

  const follows = new Map<string, TechniqueSummary[]>();
  let unresolved = 0;
  for (const t of techniques) {
    for (const from of t.setup_from ?? []) {
      const source = byName.get(from);
      if (!source) {
        unresolved++;
        continue;
      }
      // A technique that sets itself up is a data error, not a cycle worth
      // rendering — it would show the entry inside its own "leads to" list.
      if (source.id === t.id) continue;
      const list = follows.get(source.id);
      if (list) list.push(t);
      else follows.set(source.id, [t]);
    }
  }
  return { follows, unresolved };
}

/** What follows from a technique, in stable name order. */
export function follows(graph: TechniqueGraph, techniqueID: string): TechniqueSummary[] {
  const list = graph.follows.get(techniqueID);
  if (!list) return [];
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

/** The five verbs, in the order they are taught rather than alphabetically. */
export const FUNCTION_ORDER = ['advance', 'reverse', 'escape', 'control', 'finish'] as const;

export const FUNCTION_LABEL: Record<string, string> = {
  advance: 'Advance',
  reverse: 'Reverse',
  escape: 'Escape',
  control: 'Control',
  finish: 'Finish',
};

/**
 * Group techniques by what they DO.
 *
 * The payoff of the `function` column, and the first thing to read it. A
 * position's technique list is otherwise a flat alphabetical run of 138
 * entries; grouped, it answers the question a beginner actually has — from
 * here I can advance, reverse, escape, control or finish, and these are the
 * ways.
 *
 * Empty groups are omitted rather than rendered blank: "no way to escape from
 * here" is a claim about BJJ, and an absent group is honest about it being a
 * gap in the library instead.
 */
export function groupByFunction(
  techniques: TechniqueSummary[],
): { fn: string; label: string; techniques: TechniqueSummary[] }[] {
  const out: { fn: string; label: string; techniques: TechniqueSummary[] }[] = [];
  for (const fn of FUNCTION_ORDER) {
    const inGroup = techniques.filter((t) => t.function === fn);
    if (inGroup.length > 0) {
      out.push({ fn, label: FUNCTION_LABEL[fn], techniques: inGroup });
    }
  }
  // The movement fundamentals carry no function by design. They are library
  // content rather than techniques, so they get no group rather than an
  // "Other" bucket that would imply the taxonomy failed to classify them.
  return out;
}
