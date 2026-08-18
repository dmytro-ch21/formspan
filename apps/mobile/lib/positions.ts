import { newTraceId, traceparent } from './trace';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';
import type { TechniqueSummary } from './techniques';

/**
 * One collator, built once — the same fix `library.tsx` documents.
 *
 * `String.prototype.localeCompare` re-enters ICU on every call. Open guard
 * cross-links 124 techniques, so sorting it is ~840 of those; a fresh
 * collator per comparison is what produced measurable lag on the Library's
 * merged list.
 */
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

/**
 * The BJJ position glossary — what the library's techniques happen *inside* of.
 *
 * Sibling of `techniques.ts` and deliberately simpler than it. Eleven entries at a
 * few KB total, so none of that module's three optimisations apply: no
 * summary/detail split (there is nothing to trim), no local search (a list of
 * ten does not need filtering), and the whole set is fetched at once.
 *
 * The one shape worth understanding is `family`, which is how a position finds
 * its techniques without a request — see `techniquesInPosition`.
 */

export type Position = {
  id: string;
  name: string;
  aliases: string[];
  /**
   * The join key back to the technique library. Prefix-matched, not compared —
   * see `inPositionFamily`. Note that back control's family is `Back`.
   */
  family: string;
  /**
   * Narrow the family match by `position_detail`. Includes is a whitelist,
   * excludes a blacklist applied after it; both empty means the whole family.
   *
   * BOTH must be applied or closed and open guard collapse into one list —
   * see `techniquesInPosition`.
   */
  detail_includes: string[];
  detail_excludes: string[];
  /** Pedagogical reading order. The server already sorts by it; do not re-sort. */
  order_index: number;
  /** What the position is, and how you end up in it. */
  description: string;
  /** What each player is trying to do there. Both sides, split by a blank line. */
  priorities: string;
};

async function authed<T>(
  path: string,
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<T> {
  const token = await getToken();

  const res = await netFetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, traceparent: traceparent(newTraceId()) },
    signal,
  });
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as T;
}

/**
 * The teaching map of a round, served on the same response as the glossary.
 *
 * Nodes are SIDED and positions are not — the glossary describes closed guard
 * once, for both players, which is right for a glossary and useless for a
 * route: "sweep" and "get swept" would be the same arrow. So a node carries
 * `position_id` (the glossary entry behind it) and `position` (the sided value,
 * an exact match against a summary's `position`). Two nodes may share a
 * `position_id` — being mounted and mounting are one position and opposite
 * places to be.
 */
export type RoundMapNode = {
  id: string;
  label: string;
  position_id: string;
  position: string;
  /**
   * What the position is worth FROM YOUR SIDE — 5 on their back, -3 with your
   * own back taken, 0 standing. ORDERING, NOT ARITHMETIC: the gap between two
   * tiers means nothing and several nodes share one. Sort descending; never
   * space anything proportionally to a difference of tiers.
   */
  tier: number;
  note: string;
};

export type RoundMapEdgeKind = 'route' | 'recover' | 'concede';

export type RoundMapEdge = {
  from: string;
  to: string;
  label: string;
  kind: RoundMapEdgeKind;
};

/**
 * `bands` is the reading key for the ladder, ordered top down. A node belongs
 * to the FIRST band whose `min_tier` it clears — see `bandOf`.
 */
export type RoundMapBand = { min_tier: number; label: string; note: string };

export type RoundMap = {
  title: string;
  intro: string;
  bands: RoundMapBand[];
  nodes: RoundMapNode[];
  edges: RoundMapEdge[];
};

/**
 * Positions, cached for the app's lifetime.
 *
 * Failures are not cached — a null cache retries, where an empty array would
 * render as a glossary with nothing in it. Same reasoning as `summaryCache`.
 *
 * The round map shares the request and the cache on purpose: its nodes name
 * positions, so two caches could hold two versions of one vocabulary and a node
 * would draw as a dead row.
 */
let positionCache: Position[] | null = null;
let roundMapCache: RoundMap | null = null;

async function loadGlossary(getToken: TokenGetter, signal?: AbortSignal): Promise<void> {
  const body = await authed<{ positions: Position[]; round_map?: RoundMap }>(
    '/techniques/positions',
    getToken,
    signal,
  );
  positionCache = (body.positions ?? []).map(normalise);
  // Optional on the wire even though the contract requires it. An app pointed
  // at an API older than this build is the one case where it is absent, and
  // this app ships to phones that update on their own schedule — a screen that
  // throws would be a worse answer than one that says it has no map yet.
  roundMapCache = body.round_map ?? null;
}

export async function fetchPositions(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<Position[]> {
  if (positionCache) return positionCache;
  await loadGlossary(getToken, signal);
  return positionCache ?? [];
}

/** Null means the API did not send one — callers render the absence. */
export async function fetchRoundMap(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<RoundMap | null> {
  if (roundMapCache) return roundMapCache;
  await loadGlossary(getToken, signal);
  return roundMapCache;
}

/**
 * Which band a node belongs to: the FIRST whose `min_tier` it clears.
 *
 * A find, not a range check. Bands arrive ordered top down and are exhaustive
 * downward, so comparing against an upper bound too would reintroduce the gap
 * the server's shape exists to prevent.
 */
export function bandOf(bands: RoundMapBand[], tier: number): RoundMapBand | null {
  return bands.find((b) => tier >= b.min_tier) ?? null;
}

export async function fetchPosition(
  id: string,
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<Position> {
  // Served from the cached list when it is already loaded: opening a position
  // from the Library is then instant and offline-safe, since the list it was
  // tapped from is by definition already in memory.
  const cached = positionCache?.find((p) => p.id === id);
  if (cached) return cached;
  const raw = await authed<Position>(
    `/techniques/positions/${encodeURIComponent(id)}`,
    getToken,
    signal,
  );
  return normalise(raw);
}

/**
 * Guarantee the shape at the parse boundary, same discipline as
 * `techniques.ts`'s `normalise`: an app pointed at an API that predates this
 * feature would otherwise hand `undefined.length` to a render.
 */
function normalise(p: Partial<Position> & { id: string; name: string }): Position {
  return {
    ...(p as Position),
    aliases: p.aliases ?? [],
    family: p.family ?? '',
    detail_includes: p.detail_includes ?? [],
    detail_excludes: p.detail_excludes ?? [],
    order_index: p.order_index ?? 0,
    description: p.description ?? '',
    priorities: p.priorities ?? '',
  };
}

/**
 * Does a technique happen in this position family?
 *
 * Prefix rather than equality because technique rows are side-qualified —
 * "Guard - Bottom", "Back - Top (Back Control)" — while a family is the bare
 * stem. Equality matches almost nothing.
 *
 * The `- ` in the separator is what keeps "Guard" from swallowing "Half Guard":
 * `'Half Guard - Bottom'.startsWith('Guard - ')` is false.
 *
 * Duplicated from the Library screen rather than shared, matching how the same
 * helper is already duplicated between mobile and web. Consolidating all three
 * is its own change.
 */
export function inPositionFamily(position: string, family: string): boolean {
  return position === family || position.startsWith(`${family} - `);
}

/**
 * The techniques that happen in a position, resolved locally.
 *
 * This is why `family` exists and why there is no per-position endpoint: the
 * Library already holds all 542 summaries, so the cross-link costs a filter
 * rather than a request, and works with no connection.
 *
 * Sorted by name because the list endpoint orders by position first, which
 * within a single family is an arbitrary order to read in.
 */
export function techniquesInPosition(
  techniques: TechniqueSummary[],
  position: Pick<Position, 'family' | 'detail_includes' | 'detail_excludes'>,
): TechniqueSummary[] {
  const { family, detail_includes: includes, detail_excludes: excludes } = position;
  if (!family) return [];
  return techniques
    .filter((t) => {
      if (!inPositionFamily(t.position, family)) return false;
      // The second axis, and the one that stops Closed Guard and Open Guard
      // being the same 185 rows. `position` is only ever "Guard - Bottom";
      // `position_detail` is what knows which guard. Applying just one of the
      // two silently restores the bug for whichever entry uses the other.
      if (includes.length > 0 && !includes.includes(t.position_detail)) return false;
      return !excludes.includes(t.position_detail);
    })
    .sort((a, b) => collator.compare(a.name, b.name));
}
