import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * The position map — client half of `GET /v1/bjj/positions`.
 *
 * Named `positionStats` and not `positions` because `lib/positions.ts` already
 * exists and is a different thing: that one is the *glossary* (what a position
 * is, what each player wants there), this one is the athlete's own record in
 * each. Sibling of `proficiency.ts`, which answers the narrower "how is my
 * triangle going" — this answers "where am I losing the round", which is the
 * question a drilling plan actually gets written from.
 *
 * **The four event counts are disjoint**, the same trap `proficiency.ts`
 * documents: `attempted` is "went for it and it did not land", not total tries.
 * So the exchanges you initiated are `scored + attempted`, and the ones done to
 * you are `conceded + defended`.
 */
export type PositionStat = {
  position: string;
  /** You finished from here. */
  scored: number;
  /** You went for it here and missed. Disjoint from `scored`. */
  attempted: number;
  /** They finished you here. */
  conceded: number;
  /** You stopped them finishing you here. Disjoint from `conceded`. */
  defended: number;
  /** Practice, not a live outcome — excluded from every rate below. */
  drilled: number;
  /** How many separate sessions contributed. The honesty check on the rest. */
  sessions: number;
  last_seen: string;
};

export type PositionsSummary = {
  positions: number;
  /** Below this many live exchanges, a position gets no verdict. */
  min_live: number;
};

export type PositionMap = {
  positions: PositionStat[];
  summary: PositionsSummary;
};

/**
 * If the server omits `min_live`, fall back rather than divide by undefined.
 *
 * Matches the backend's `MinLiveExchanges`. Duplicated deliberately and only as
 * a fallback: the value travels on the response precisely so the two cannot
 * disagree, and this exists for a drifted or older server, which `bjjFocus.ts`
 * and `proficiency.ts` both take the same precaution against.
 */
export const FALLBACK_MIN_LIVE = 5;

/**
 * Read the map.
 *
 * Network-only, for the reason `fetchProficiency` records: this is an aggregate
 * over every session ever logged, including ones synced from another device, so
 * a local answer would be a different and quietly smaller number.
 */
export function fetchPositions(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<PositionMap> {
  // `?? []` and `?? {...}` for the same reason `proficiency.ts` has one: the
  // cast at a parse boundary is an assertion about a server, not a check, and
  // an absent field reaching a `.filter` inside a `useMemo` takes the render
  // down rather than degrading to an empty state.
  return apiRequest<Partial<PositionMap>>(getToken, '/bjj/positions', { signal }).then((r) => ({
    positions: r.positions ?? [],
    summary: {
      positions: r.summary?.positions ?? 0,
      min_live: r.summary?.min_live ?? FALLBACK_MIN_LIVE,
    },
  }));
}

/* -------------------------------------------------------------------------
 * Reading the map. Pure, so it can be tested without a server.
 * ---------------------------------------------------------------------- */

/** Live exchanges either direction. Mirrors the backend's `Live()`. */
export function liveOf(p: PositionStat): number {
  return p.scored + p.attempted + p.conceded + p.defended;
}

/**
 * How the exchanges here go for you, 0–1.
 *
 * **`scored + defended`, not `scored` alone.** Stopping a submission from side
 * control is a won exchange exactly as much as finishing one is, and counting
 * only offence would mark a pure defensive game as a total collapse — which is
 * both wrong and the reading most likely to make someone abandon a position
 * they are actually surviving fine in.
 *
 * `null` rather than 0 when nothing live has happened: a position you have only
 * drilled has no rate, and 0 would render as a 0% win rate.
 */
export function winShare(p: PositionStat): number | null {
  const live = liveOf(p);
  if (live === 0) return null;
  return (p.scored + p.defended) / live;
}

export type PositionVerdict = 'thin' | 'strong' | 'leaking' | 'even';

/**
 * What, if anything, this row is allowed to say.
 *
 * **`thin` is a refusal, not a category of position.** Below `minLive` a single
 * bad night dominates the numbers, so the row is still shown — hiding it would
 * lose the fact that the athlete has been there at all — but no verdict is
 * attached to it. The backend sends the threshold for this reason.
 *
 * The comparison is `scored + defended` against `conceded + attempted`: won
 * exchanges against lost ones. Anything else double-counts — comparing `scored`
 * to `conceded` alone ignores half of what happened in the position.
 */
export function classify(p: PositionStat, minLive: number): PositionVerdict {
  if (liveOf(p) < minLive) return 'thin';
  const won = p.scored + p.defended;
  const lost = p.conceded + p.attempted;
  if (won > lost) return 'strong';
  if (lost > won) return 'leaking';
  return 'even';
}

export type RankedPositions = {
  /** Verdict-worthy rows where more goes right than wrong, best first. */
  strong: PositionStat[];
  /** Verdict-worthy rows where more goes wrong than right, worst first. */
  leaking: PositionStat[];
  /** Everything the evidence cannot speak to yet, most live first. */
  thin: PositionStat[];
};

/**
 * Split the map into what it can and cannot support saying.
 *
 * `even` rows join `strong`: a position you break even in is not a problem, and
 * a third bucket for them would be a section heading over one row most weeks.
 *
 * Ordering inside each bucket is by win share, then by live count, then by
 * name. All three, because the first two tie constantly on small numbers — two
 * positions at 1-for-2 are common — and a list that reorders itself between
 * renders of unchanged data is the bug this app has already fixed twice.
 */
export function rankPositions(rows: PositionStat[], minLive: number): RankedPositions {
  const out: RankedPositions = { strong: [], leaking: [], thin: [] };
  for (const p of rows) {
    const verdict = classify(p, minLive);
    if (verdict === 'thin') out.thin.push(p);
    else if (verdict === 'leaking') out.leaking.push(p);
    else out.strong.push(p);
  }
  const share = (p: PositionStat) => winShare(p) ?? 0;
  out.strong.sort(
    (a, b) => share(b) - share(a) || liveOf(b) - liveOf(a) || a.position.localeCompare(b.position),
  );
  out.leaking.sort(
    (a, b) => share(a) - share(b) || liveOf(b) - liveOf(a) || a.position.localeCompare(b.position),
  );
  out.thin.sort((a, b) => liveOf(b) - liveOf(a) || a.position.localeCompare(b.position));
  return out;
}

/**
 * The one line worth putting at the top of the screen.
 *
 * **Descriptive, never prescriptive.** The backend's own note is explicit that
 * concessions from a position are equally consistent with a hole in the game
 * and with deliberately starting every round there, and that nothing in this
 * data can tell those apart. So this names where the exchanges are going worst
 * and stops — it does not say to drill it, avoid it, or that anything is wrong.
 * A recommendation here would be confidently wrong about a third of the time.
 */
export function headline(ranked: RankedPositions, minLive: number): string {
  /*
    Counted the same way `classify` counts, which it did NOT used to be: this
    named `conceded` and `scored` only, so a position leaking purely through
    missed attempts headlined as "0 conceded, 0 scored" — a sentence that
    contradicts the section it sits above. Won/lost over the live total covers
    all four outcomes and keeps the denominator visible, which is the property
    that matters: 8 of 12 is a finding, "67%" is a number nobody can argue with.
  */
  if (ranked.leaking.length > 0) {
    const worst = ranked.leaking[0];
    const lost = worst.conceded + worst.attempted;
    return `Most goes against you in ${worst.position} — ${lost} of ${liveOf(worst)} exchanges lost.`;
  }
  if (ranked.strong.length > 0) {
    const best = ranked.strong[0];
    const won = best.scored + best.defended;
    return `Your best position so far is ${best.position} — ${won} of ${liveOf(best)} exchanges won.`;
  }
  if (ranked.thin.length > 0) {
    return `Not enough live rounds yet — ${minLive} exchanges in a position before this says anything about it.`;
  }
  return 'No positions tagged yet. Tag where things happened when you log a session.';
}
