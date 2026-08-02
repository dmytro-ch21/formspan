import { newTraceId, traceparent } from './trace';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';
import type { TechniqueSummary } from './techniques';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

/**
 * The BJJ position glossary — what the library's techniques happen *inside* of.
 *
 * Sibling of `techniques.ts` and deliberately simpler than it. Ten entries at a
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
 * Positions, cached for the app's lifetime.
 *
 * Failures are not cached — a null cache retries, where an empty array would
 * render as a glossary with nothing in it. Same reasoning as `summaryCache`.
 */
let positionCache: Position[] | null = null;

export async function fetchPositions(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<Position[]> {
  if (positionCache) return positionCache;
  const body = await authed<{ positions: Position[] }>('/techniques/positions', getToken, signal);
  positionCache = (body.positions ?? []).map(normalise);
  return positionCache;
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
 * Library already holds all 466 summaries, so the cross-link costs a filter
 * rather than a request, and works with no connection.
 *
 * Sorted by name because the list endpoint orders by position first, which
 * within a single family is an arbitrary order to read in.
 */
export function techniquesInPosition(
  techniques: TechniqueSummary[],
  family: string,
): TechniqueSummary[] {
  if (!family) return [];
  return techniques
    .filter((t) => inPositionFamily(t.position, family))
    .sort((a, b) => a.name.localeCompare(b.name));
}
